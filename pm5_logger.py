"""Record a Concept2 PM5 over Bluetooth, force curves included, with a live dashboard.

The Concept2 Logbook and apps like Strava keep only stroke-level summaries (time, distance,
pace, rate, heart rate). The PM5 also streams, for every stroke, drive length and time,
recovery time, peak and average force, work, power and the full force curve. This script
saves all of it and shows it live in a browser.

    python pm5_logger.py --scan            # is a PM5 advertising nearby?
    python pm5_logger.py --info            # model, serial, firmware, then disconnect
    python pm5_logger.py                   # record a session; dashboard at http://localhost:8750
    python pm5_logger.py --replay examples/sample_row.jsonl --loop   # try the dashboard, no rower needed
    python pm5_logger.py --reparse data/raw/<start>.jsonl            # rebuild a session file

Before recording: close ErgData (or any other rowing app) and wake the PM5. The PM5 accepts
one app connection at a time and stops advertising while anything holds it.

On macOS, run it from Terminal (or iTerm). macOS kills a process that uses Bluetooth under an
app without Bluetooth permission (you'll see exit code 134, "abort"); Terminal asks for the
permission the first time. --replay and --reparse don't use Bluetooth.

Output (in ./data unless --out is given):
    raw/<start>.jsonl       every notification as hex plus the time it arrived: the source of
                            truth. Keep it, and a better parser can rebuild the session later.
    sessions/<start>.json   one record per stroke, with both force curves.

Byte layouts follow Concept2's "PM Bluetooth Smart Communication Interface Definition",
revision 1.30 (multi-byte values little-endian). Force-curve points are in pounds of force:
each curve's peak equals the peak force the PM5 reports for that stroke.
"""
import argparse
import asyncio
import json
import os
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DASHBOARD = ROOT / "pm5_dashboard.html"
OUT = ROOT / "data"
PORT = 8750

BASE = "ce06{:04x}-43e5-11e4-916c-0800200c9a66"
UUID = lambda short: BASE.format(short)
ROWING_SERVICE = UUID(0x0030)
DEVICE_INFO = {0x0011: "model", 0x0012: "serial", 0x0013: "hardware_rev",
               0x0014: "firmware_rev", 0x0015: "manufacturer"}
IDLE_STOP_S = 300          # stop after 5 min with no notifications
AFTER_END_S = 75           # the PM5 re-sends its summary with recovery HR after 1 min of rest

WORKOUT_STATE = {0: "wait_to_begin", 1: "workout_row", 10: "workout_end", 11: "terminate",
                 12: "workout_logged", 13: "rearm"}


def u16(b, i):
    return b[i] | b[i + 1] << 8


def u24(b, i):
    return b[i] | b[i + 1] << 8 | b[i + 2] << 16


def parse(short: int, b: bytes) -> dict | None:
    """Decode the characteristics we understand; anything else stays raw only."""
    try:
        if short == 0x0031 and len(b) >= 19:
            return {"elapsed_s": u24(b, 0) / 100, "distance_m": u24(b, 3) / 10, "workout_type": b[6],
                    "workout_state": WORKOUT_STATE.get(b[8], b[8]), "rowing_state": b[9],
                    "stroke_state": b[10], "drag_factor": b[18]}
        if short == 0x0032 and len(b) >= 16:
            return {"elapsed_s": u24(b, 0) / 100, "speed_ms": u16(b, 3) / 1000,
                    "stroke_rate": b[5], "hr": None if b[6] == 255 else b[6],
                    "pace_s": u16(b, 7) / 100, "avg_pace_s": u16(b, 9) / 100}
        if short == 0x0033 and len(b) >= 14:
            return {"elapsed_s": u24(b, 0) / 100, "avg_power_w": u16(b, 4),
                    "calories_total": u16(b, 6), "split_avg_pace_s": u16(b, 8) / 100}
        if short == 0x0035 and len(b) >= 20:
            return {"elapsed_s": u24(b, 0) / 100, "distance_m": u24(b, 3) / 10,
                    "drive_length_m": b[6] / 100, "drive_time_s": b[7] / 100,
                    "recovery_time_s": u16(b, 8) / 100, "stroke_distance_m": u16(b, 10) / 100,
                    "peak_force_lbf": u16(b, 12) / 10, "avg_force_lbf": u16(b, 14) / 10,
                    "work_j": u16(b, 16) / 10, "stroke_count": u16(b, 18)}
        if short == 0x0036 and len(b) >= 9:
            out = {"elapsed_s": u24(b, 0) / 100, "power_w": u16(b, 3),
                   "cal_per_hr": u16(b, 5), "stroke_count": u16(b, 7)}
            if len(b) >= 15:
                out.update(projected_time_s=u24(b, 9), projected_distance_m=u24(b, 12))
            return out
        if short == 0x003A and len(b) >= 12:
            return {"split_type": b[4], "split_size": u16(b, 5), "split_count": b[7],
                    "calories_total": u16(b, 8), "avg_watts": u16(b, 10)}
        if short == 0x0039 and len(b) >= 20:
            return {"elapsed_s": u24(b, 4) / 100, "distance_m": u24(b, 7) / 10,
                    "avg_stroke_rate": b[10], "ending_hr": b[11], "avg_hr": b[12],
                    "min_hr": b[13], "max_hr": b[14], "drag_factor_avg": b[15],
                    "recovery_hr": b[16], "workout_type": b[17], "avg_pace_s": u16(b, 18) / 10}
    except IndexError:
        return None
    return None


class ForceCurve:
    """Reassemble a force curve sent across several notifications (0x003D, and 0x0043 alike):
    byte 0 = (total packets << 4) | 16-bit points in this packet, byte 1 = sequence number."""

    def __init__(self):
        self.parts, self.expected = [], None

    def add(self, b: bytes) -> list[int] | None:
        if len(b) < 2:
            return None
        total, words = b[0] >> 4, b[0] & 0x0F
        if b[1] == 0:            # a new curve always starts at sequence 0
            self.parts, self.expected = [], total
        if self.expected is None:
            return None          # joined mid-curve; wait for the next one
        self.parts.append([u16(b, 2 + 2 * k) for k in range(words) if 3 + 2 * k < len(b)])
        if len(self.parts) >= self.expected:
            curve = [v for p in self.parts for v in p]
            self.parts, self.expected = [], None
            return curve
        return None


class Session:
    """Turns a stream of (arrival time, characteristic, bytes) into one record per stroke.

    Stroke data (0x0035) arrives twice per stroke: at the end of the drive, and again at the end
    of the recovery with that stroke's recovery time (the first copy carries the previous
    stroke's). Records are keyed on stroke count; count 0 is the reset at a workout's start or
    end and is dropped. Force curves come on two channels: 0x003D (documented; time-stepped, so
    each reading repeats 2-3 times, with leading zeros) and 0x0043 (not in spec rev 1.30, sent by
    2026 firmware just after 0x003D; same packet scheme, one point per reading).
    `emit(kind, data)` feeds the live dashboard."""

    CURVES = {0x003D: "force_curve", 0x0043: "force_curve_v2"}

    def __init__(self, echo=False, emit=None):
        self.strokes, self.unmatched, self.summary, self.status = {}, [], {}, {}
        self.fc = {k: ForceCurve() for k in self.CURVES}
        self.end_at, self.echo, self.emit = None, echo, emit or (lambda kind, data: None)

    def feed(self, t: float, short: int, b: bytes):
        if short in self.CURVES:
            curve = self.fc[short].add(b)
            if curve:
                self._attach_curve(t, self.CURVES[short], curve)
            return
        p = parse(short, b)
        if not p:
            return
        if short == 0x0035:
            n = p["stroke_count"]
            if n == 0:
                return
            if n in self.strokes:
                self.strokes[n]["recovery_time_s"] = p["recovery_time_s"]
                self.emit("stroke_update", {"stroke_count": n, "recovery_time_s": p["recovery_time_s"]})
                return
            self.strokes[n] = {"t": round(t, 3), **p, "hr": self.status.get("hr"),
                               "spm": self.status.get("stroke_rate"), "pace_s": self.status.get("pace_s"),
                               "recovery_time_s": None}   # filled by this stroke's second copy
            self.emit("stroke", self.strokes[n])
            if self.echo:
                print(f"stroke {n:4d}  {p['distance_m']:7.1f} m  peak {p['peak_force_lbf']:5.1f} lbf  "
                      f"drive {p['drive_length_m']:.2f} m / {p['drive_time_s']:.2f} s", flush=True)
            return
        if short == 0x0036:
            if p["stroke_count"] in self.strokes:
                self.strokes[p["stroke_count"]]["power_w"] = p["power_w"]
                self.emit("stroke_update", {"stroke_count": p["stroke_count"], "power_w": p["power_w"]})
            self.status.update(power_w=p["power_w"], projected_time_s=p.get("projected_time_s"),
                               projected_distance_m=p.get("projected_distance_m"))
        elif short == 0x0032:
            self.status.update(hr=p["hr"], stroke_rate=p["stroke_rate"], pace_s=p["pace_s"],
                               avg_pace_s=p["avg_pace_s"], elapsed_s=p["elapsed_s"])
        elif short == 0x0031:
            self.status.update(drag_factor=p["drag_factor"], workout_state=p["workout_state"],
                               workout_type=p["workout_type"], elapsed_s=p["elapsed_s"],
                               distance_m=p["distance_m"])
        elif short == 0x0033:
            self.status.update(avg_power_w=p["avg_power_w"], calories_total=p["calories_total"])
        elif short == 0x003A:
            self.summary.update(p)
            self.emit("summary", self.summary)
            return
        elif short == 0x0039:
            self.summary.update(p)
            self.summary.setdefault("received_at", round(t, 3))  # the Logbook dates a row by its end
            self.end_at = self.end_at or t
            self.emit("summary", self.summary)
            if self.echo:
                print(f"end of workout: {p['distance_m']} m in {p['elapsed_s']} s, "
                      f"drag {p['drag_factor_avg']}, recovery HR {p['recovery_hr']}", flush=True)
            return
        self.emit("status", self.status)

    def _attach_curve(self, t, key, points):
        # each curve arrives just after its drive, beside that stroke's first 0x0035
        free = [s for s in self.strokes.values() if key not in s and abs(s["t"] - t) < 3]
        if free:
            s = min(free, key=lambda s: abs(s["t"] - t))
            s[key] = points
            self.emit("curve", {"stroke_count": s["stroke_count"], "key": key, "points": points})
        else:
            self.unmatched.append({"kind": key, "t": t, "points": points})

    def snapshot(self) -> dict:
        return {"status": self.status, "summary": self.summary,
                "strokes": [self.strokes[k] for k in sorted(self.strokes)]}

    def result(self, meta: dict) -> dict:
        return {**meta, "last_status": self.status, "summary": self.summary,
                "strokes": [self.strokes[k] for k in sorted(self.strokes)],
                "unmatched_curves": self.unmatched}


class Hub:
    """Fan-out of dashboard events to every open browser tab (server-sent events)."""

    def __init__(self):
        self.clients, self.session = set(), None

    def publish(self, kind, data):
        msg = f"data: {json.dumps({'kind': kind, 'data': data})}\n\n".encode()
        for q in list(self.clients):
            q.put_nowait(msg)

    async def handle(self, reader, writer):
        try:
            request = (await reader.readline()).split()
            path = request[1].decode() if len(request) > 1 else "/"
            while (await reader.readline()) not in (b"\r\n", b"\n", b""):
                pass
            if path.startswith("/events"):
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                             b"Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n")
                q = asyncio.Queue()
                self.clients.add(q)
                if self.session:  # a tab opened mid-row catches up from the snapshot
                    q.put_nowait(f"data: {json.dumps({'kind': 'snapshot', 'data': self.session.snapshot()})}\n\n".encode())
                try:
                    while True:
                        writer.write(await q.get())
                        await writer.drain()
                finally:
                    self.clients.discard(q)
            else:
                body = DASHBOARD.read_bytes()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                             b"Cache-Control: no-cache\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()


async def start_dashboard(hub: Hub, open_browser: bool):
    server = await asyncio.start_server(hub.handle, "127.0.0.1", PORT)
    url = f"http://localhost:{PORT}"
    print(f"dashboard: {url}", flush=True)
    if open_browser:
        webbrowser.open(url)
    return server


def is_pm5(d, ad) -> bool:
    """macOS often leaves d.name empty and puts the name only in the advertisement,
    so match on either name, or on the Concept2 base UUID in the advertised services."""
    names = [n for n in (d.name, getattr(ad, "local_name", None)) if n]
    uuids = [u.lower() for u in (getattr(ad, "service_uuids", None) or [])]
    return any(n.startswith("PM5") for n in names) or any(u.startswith("ce06") for u in uuids)


async def find_pm5(tries=10, window=8.0):
    """Full discovery passes: BleakScanner.find_device_by_filter has missed a PM5 that a
    discovery pass had just seen, so this repeats plain discovery instead."""
    from bleak import BleakScanner
    for attempt in range(1, tries + 1):
        seen = await BleakScanner.discover(timeout=window, return_adv=True)
        hits = sorted((x for x in seen.values() if is_pm5(*x)), key=lambda x: -(x[1].rssi or -999))
        if hits:
            d, ad = hits[0]
            print(f"found {d.name or ad.local_name} (rssi {ad.rssi}) on pass {attempt}", flush=True)
            return d
        print(f"pass {attempt}: no PM5 yet", flush=True)
    return None


async def read_info(client) -> dict:
    info = {}
    for short, key in DEVICE_INFO.items():
        try:
            info[key] = (await client.read_gatt_char(UUID(short))).decode(errors="replace").strip("\x00 ")
        except Exception as e:  # not every PM5 exposes every field
            info[key] = f"unreadable ({type(e).__name__})"
    return info


def rel(p: Path) -> str:
    try:
        return str(p.relative_to(Path.cwd()))
    except ValueError:
        return str(p)


def save(sess_path: Path, data: dict) -> None:
    if sess_path.exists():  # keep the Logbook id across a --reparse
        old = json.loads(sess_path.read_text())
        if old.get("logbook_id"):
            data["logbook_id"] = old["logbook_id"]
    sess_path.parent.mkdir(parents=True, exist_ok=True)
    sess_path.write_text(json.dumps(data, indent=1))
    n = sum(1 for s in data["strokes"] if "force_curve" in s)
    print(f"saved {len(data['strokes'])} strokes ({n} with force curves) -> {rel(sess_path)}")


def upload_configured() -> bool:
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass
    return bool(os.environ.get("CONCEPT2_REFRESH_TOKEN"))


def post(sess_path: Path, data: dict) -> None:
    if not upload_configured():
        print("Concept2 Logbook upload not set up (see concept2.py); the row is saved locally.")
        return
    if not data["summary"]:
        print("no end-of-workout summary (the piece wasn't ended on the PM5, or was too short to keep), "
              "so nothing posted to the Logbook")
        return
    try:
        from pm5_upload import upload_session
        upload_session(sess_path)
    except Exception as e:  # the session file is safe on disk
        print(f"Logbook upload failed ({e}); the row is saved. Retry: python pm5_upload.py {rel(sess_path)}")


async def log_session(minutes: float | None, upload: bool = True, open_browser: bool = True):
    from bleak import BleakClient
    hub = Hub()
    server = await start_dashboard(hub, open_browser)
    dev = await find_pm5()
    if not dev:
        server.close()
        sys.exit("No PM5 advertising. Wake it (press a button) and close ErgData or any other rowing app.")
    start = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    raw_path, sess_path = OUT / "raw" / f"{start}.jsonl", OUT / "sessions" / f"{start}.json"
    session, last = Session(echo=True, emit=hub.publish), {"t": time.time()}
    hub.session = session
    raw = raw_path.open("a")

    def on_notify(short):
        def handler(_char, data: bytearray):
            now = time.time()
            last["t"] = now
            raw.write(json.dumps({"t": round(now, 3), "uuid": f"{short:04x}", "hex": bytes(data).hex()}) + "\n")
            session.feed(now, short, bytes(data))
        return handler

    async with BleakClient(dev) as client:
        info = await read_info(client)
        raw.write(json.dumps({"t": round(time.time(), 3), "device": {"name": dev.name, **info}}) + "\n")
        hub.publish("device", {"name": dev.name, **info})
        print(f"connected to {dev.name}: firmware {info.get('firmware_rev')}", flush=True)
        service = client.services.get_service(ROWING_SERVICE)
        subscribed = []
        for ch in service.characteristics:  # everything, including characteristics newer than the spec
            if "notify" in ch.properties:
                short = int(ch.uuid[4:8], 16)
                await client.start_notify(ch, on_notify(short))
                subscribed.append(f"{short:04x}")
        print("subscribed:", " ".join(subscribed), "| row when ready; end the piece on the PM5 (Menu)",
              flush=True)
        deadline = time.time() + minutes * 60 if minutes else None
        try:
            while client.is_connected:
                await asyncio.sleep(1)
                now = time.time()
                if session.end_at and now - session.end_at > AFTER_END_S:
                    break
                if now - last["t"] > IDLE_STOP_S or (deadline and now > deadline):
                    break
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
    raw.close()
    hub.publish("ended", {"session": start})
    data = session.result({"started": start, "device": {"name": dev.name, **info}})
    save(sess_path, data)
    if upload:
        post(sess_path, data)
    server.close()


def read_raw(raw_path: Path):
    meta, events = {"started": raw_path.stem}, []
    for line in raw_path.open():
        r = json.loads(line)
        if "device" in r:
            meta["device"] = r["device"]
        elif "uuid" in r:
            events.append((r["t"], int(r["uuid"], 16), bytes.fromhex(r["hex"])))
    return meta, events


def reparse(raw_path: Path) -> None:
    meta, events = read_raw(raw_path)
    session = Session()
    for t, short, b in events:
        session.feed(t, short, b)
    save(OUT / "sessions" / f"{raw_path.stem}.json", session.result(meta))


async def replay(raw_path: Path, speed: float, loop: bool, open_browser: bool):
    """Play a saved row through the dashboard at its original pace (x speed). No Bluetooth."""
    meta, events = read_raw(raw_path)
    hub = Hub()
    server = await start_dashboard(hub, open_browser)
    await asyncio.sleep(2)  # let a freshly opened tab connect before the first stroke
    while True:
        hub.session = Session(emit=hub.publish)
        hub.publish("reset", {"replay": raw_path.stem, **meta.get("device", {})})
        prev = events[0][0] if events else 0
        for t, short, b in events:
            await asyncio.sleep(max(0.0, (t - prev) / speed))
            prev = t
            hub.session.feed(t, short, b)
        hub.publish("ended", {"session": raw_path.stem})
        if not loop:
            break
        await asyncio.sleep(3)
    await asyncio.sleep(1)
    server.close()


async def main():
    global OUT, PORT
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scan", action="store_true", help="list advertising PM5s and exit")
    ap.add_argument("--info", action="store_true", help="read device info (firmware) and exit")
    ap.add_argument("--minutes", type=float, help="stop recording after this many minutes")
    ap.add_argument("--no-upload", action="store_true", help="don't post the row to the Concept2 Logbook")
    ap.add_argument("--no-browser", action="store_true", help="don't open the dashboard automatically")
    ap.add_argument("--reparse", type=Path, help="rebuild a session file from its raw log")
    ap.add_argument("--replay", type=Path, help="play a raw log through the dashboard")
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed multiplier")
    ap.add_argument("--loop", action="store_true", help="repeat the replay")
    ap.add_argument("--out", type=Path, help="where to write raw/ and sessions/ (default ./data)")
    ap.add_argument("--port", type=int, default=PORT, help="dashboard port (default 8750)")
    a = ap.parse_args()
    OUT, PORT = (a.out or OUT).resolve(), a.port
    if a.reparse:
        reparse(a.reparse)
        return
    if a.replay:
        await replay(a.replay, a.speed, a.loop, not a.no_browser)
        return
    from bleak import BleakClient, BleakScanner
    if a.scan:
        seen = await BleakScanner.discover(timeout=15, return_adv=True)
        for d, ad in sorted(seen.values(), key=lambda x: -(x[1].rssi or -999)):
            name = d.name or ad.local_name
            if name or is_pm5(d, ad):
                print(f"{'PM5 ->' if is_pm5(d, ad) else '      '} {name or '(no name)'}  rssi {ad.rssi}  "
                      f"services {[u[:8] for u in ad.service_uuids]}")
        if not any(is_pm5(d, ad) for d, ad in seen.values()):
            print(f"no PM5 advertising ({len(seen)} Bluetooth devices seen)")
        return
    if a.info:
        dev = await find_pm5()
        if not dev:
            sys.exit("No PM5 advertising. Wake it and close ErgData or any other rowing app.")
        async with BleakClient(dev) as client:
            print(json.dumps({"name": dev.name, **await read_info(client)}, indent=1))
        return
    await log_session(a.minutes, upload=not a.no_upload, open_browser=not a.no_browser)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

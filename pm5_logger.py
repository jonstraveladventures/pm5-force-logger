"""Record a Concept2 PM5 over Bluetooth, force curves included, with a live dashboard.

The Concept2 Logbook and apps like Strava keep only stroke-level summaries (time, distance,
pace, rate, heart rate). The PM5 also streams, for every stroke, drive length and time,
recovery time, peak and average force, work, power and the full force curve. This script
saves all of it and shows it live in a browser.

    python pm5_logger.py --scan            # is a PM5 advertising nearby?
    python pm5_logger.py --info            # model, serial, firmware, then disconnect
    python pm5_logger.py                   # record a session; dashboard at http://localhost:8750
    python pm5_logger.py --workout 4x4:00/3:00r   # program the piece on the PM5 first (see pm5_workouts.py)
                                           # (the dashboard has the same controls, so no terminal typing is needed)
    python pm5_logger.py --replay examples/sample_row.jsonl --loop   # try the dashboard, no rower needed
    python pm5_logger.py --reparse data/raw/<start>.jsonl            # rebuild a session file
    python pm5_vo2.py data/sessions/*.json                           # watts at a set heart rate, VO2max estimate

Before recording: close ErgData (or any other rowing app) and wake the PM5. The PM5 accepts
one app connection at a time and stops advertising while anything holds it.

Recording stops 75 s after the PM5's end-of-workout summary (which it re-sends with the
recovery heart rate after a minute), 10 min after the last stroke, when a second piece is
started on the monitor, or on Ctrl+C. Every stop saves the session. One piece per run: if a
second piece starts, the first is saved and the logger exits; run it again for the next.

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
import signal
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
IDLE_STOP_S = 600          # stop 10 min after the last stroke (the PM5 sends status every second while awake)
AFTER_END_S = 75           # the PM5 re-sends its summary with recovery HR after 1 min of rest
CURVE_MATCH_S = 3.0        # a force curve belongs to the stroke record within this many seconds
MAX_BODY_BYTES = 64 * 1024  # reject oversized request bodies to the local dashboard API

WORKOUT_STATE = {0: "wait_to_begin", 1: "workout_row", 2: "countdown_pause", 3: "interval_rest",
                 4: "interval_work_time", 5: "interval_work_distance",
                 6: "interval_rest_end_to_work_time", 7: "interval_rest_end_to_work_distance",
                 8: "interval_work_time_to_rest", 9: "interval_work_distance_to_rest",
                 10: "workout_end", 11: "terminate", 12: "workout_logged", 13: "rearm"}


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
                    "stroke_rate": b[5], "hr": None if b[6] in (0, 255) else b[6],
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

    A session holds one piece. Stroke counts restart at 1 when a new piece starts on the
    monitor, so a count that has already been recorded and is below the latest one means a new
    piece: `new_piece_at` is set and further strokes are ignored (the raw log still has them).
    A count equal to the latest, however late, is the second copy of that stroke: a rower who
    pauses mid-piece produces exactly that. `emit(kind, data)` feeds the live dashboard."""

    CURVES = {0x003D: "force_curve", 0x0043: "force_curve_v2"}

    def __init__(self, echo=False, emit=None):
        self.strokes, self.unmatched, self.summary, self.status = {}, [], {}, {}
        self.fc = {k: ForceCurve() for k in self.CURVES}
        self.max_count, self.last_stroke_t, self.end_at, self.new_piece_at = 0, None, None, None
        self.echo, self.emit = echo, emit or (lambda kind, data: None)

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
            self._stroke(t, p)
            return
        if short == 0x0036:
            if p["stroke_count"] in self.strokes and self.new_piece_at is None:
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

    def _stroke(self, t: float, p: dict):
        n = p["stroke_count"]
        if n == 0 or self.new_piece_at is not None:
            return
        self.last_stroke_t = t
        if n in self.strokes:
            if n < self.max_count - 1:   # counts went backwards: the PM5 started a new piece
                self.new_piece_at = t
                self.emit("new_piece", {"t": round(t, 3)})
                if self.echo:
                    print("a new piece started on the PM5. This run records one piece, so the first is "
                          "being saved now; run the logger again for the next.", flush=True)
                return
            self.strokes[n]["recovery_time_s"] = p["recovery_time_s"]
            self.emit("stroke_update", {"stroke_count": n, "recovery_time_s": p["recovery_time_s"]})
            return
        self.max_count = max(self.max_count, n)
        s = self.strokes[n] = {"t": round(t, 3), **p, "hr": self.status.get("hr"),
                               "spm": self.status.get("stroke_rate"), "pace_s": self.status.get("pace_s"),
                               "recovery_time_s": None}   # filled by this stroke's second copy
        for c in list(self.unmatched):   # a curve that arrived just before its stroke record
            if c["kind"] not in s and abs(c["t"] - t) < CURVE_MATCH_S:
                s[c["kind"]] = c["points"]
                self.unmatched.remove(c)
        self.emit("stroke", s)
        if self.echo:
            print(f"stroke {n:4d}  {p['distance_m']:7.1f} m  peak {p['peak_force_lbf']:5.1f} lbf  "
                  f"drive {p['drive_length_m']:.2f} m / {p['drive_time_s']:.2f} s", flush=True)

    def _attach_curve(self, t, key, points):
        if self.new_piece_at is not None:
            return
        # each curve arrives just after its drive, beside that stroke's first 0x0035
        free = [s for s in self.strokes.values() if key not in s and abs(s["t"] - t) < CURVE_MATCH_S]
        if free:
            s = min(free, key=lambda s: abs(s["t"] - t))
            s[key] = points
            self.emit("curve", {"stroke_count": s["stroke_count"], "key": key, "points": points})
        else:
            self.unmatched.append({"kind": key, "t": round(t, 3), "points": points})

    def snapshot(self) -> dict:
        return {"status": self.status, "summary": self.summary,
                "strokes": [self.strokes[k] for k in sorted(self.strokes)]}

    def result(self, meta: dict) -> dict:
        return {**meta, "last_status": self.status, "summary": self.summary,
                "strokes": [self.strokes[k] for k in sorted(self.strokes)],
                "unmatched_curves": self.unmatched,
                "new_piece_started": self.new_piece_at is not None}


class Hub:
    """Fan-out of dashboard events to every open browser tab (server-sent events), plus the
    small JSON API the dashboard uses to program the PM5: GET /workouts lists the named pieces,
    POST /program {"spec": "4x4:00/3:00r"} programs one (or {"terminate": true} clears it)
    through the logger's own Bluetooth connection, so nothing has to be typed in a terminal."""

    def __init__(self):
        self.clients, self.session = set(), None
        self.programmer = None   # async fn(spec text or None) -> description; set while a PM5 is connected

    def publish(self, kind, data):
        msg = f"data: {json.dumps({'kind': kind, 'data': data})}\n\n".encode()
        for q in list(self.clients):
            q.put_nowait(msg)

    def _json(self, writer, status: int, payload: dict):
        body = json.dumps(payload).encode()
        reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 502: "Bad Gateway", 503: "Service Unavailable"}
        writer.write(f"HTTP/1.1 {status} {reason.get(status, 'OK')}\r\nContent-Type: application/json\r\n"
                     f"Cache-Control: no-cache\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)

    async def program(self, body: bytes) -> tuple[int, dict]:
        try:
            req = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, {"error": "the request was not JSON"}
        if not self.programmer:
            return 503, {"error": "no PM5 connected: this is a replay, or the logger has not connected yet"}
        try:
            if req.get("terminate"):
                await self.programmer(None)
                return 200, {"ok": True, "workout": None}
            spec = str(req.get("spec") or "").strip()
            if not spec:
                return 400, {"error": "choose a workout or type one, e.g. 4x4:00/3:00r"}
            desc = await self.programmer(spec)
            return 200, {"ok": True, "workout": desc}
        except ValueError as e:
            return 400, {"error": str(e)}
        except (RuntimeError, TimeoutError) as e:
            return 502, {"error": str(e)}

    async def handle(self, reader, writer):
        try:
            request = (await reader.readline()).split()
            method = request[0].decode() if request else "GET"
            path = request[1].decode() if len(request) > 1 else "/"
            length = 0
            while (line := await reader.readline()) not in (b"\r\n", b"\n", b""):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":", 1)[1])
            if length > MAX_BODY_BYTES:
                self._json(writer, 400, {"error": "request body too large"})
                return
            body = await reader.readexactly(length) if length else b""
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
            elif path == "/workouts":
                from pm5_workouts import describe, load_named
                self._json(writer, 200, {"workouts": [{"name": n, "description": describe(w)}
                                                      for n, w in load_named().items()]})
                await writer.drain()
            elif path == "/program" and method == "POST":
                status, payload = await self.program(body)
                self._json(writer, status, payload)
                await writer.drain()
            elif path in ("/", "/index.html"):
                page = DASHBOARD.read_bytes()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                             b"Cache-Control: no-cache\r\nContent-Length: %d\r\n\r\n" % len(page) + page)
                await writer.drain()
            else:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
        except Exception:  # a dropped tab or a malformed request; nothing to report
            pass
        finally:
            writer.close()


async def start_dashboard(hub: Hub, open_browser: bool):
    try:
        server = await asyncio.start_server(hub.handle, "127.0.0.1", PORT)
    except OSError as e:
        sys.exit(f"can't open the dashboard on port {PORT} ({e.strerror}). "
                 f"Is another logger still running? Use --port to pick another port.")
    url = f"http://localhost:{PORT}"
    print(f"dashboard: {url}", flush=True)
    if open_browser:
        webbrowser.open(url)
    return server


def install_stop_signal(stop: asyncio.Event) -> None:
    """Make Ctrl+C set `stop` so the session is saved on the way out. Not available on Windows,
    where Ctrl+C raises KeyboardInterrupt at the current await instead (handled in main)."""
    try:
        asyncio.get_running_loop().add_signal_handler(signal.SIGINT, stop.set)
    except (NotImplementedError, RuntimeError):
        pass


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


def fitness(sess_path: Path, data: dict) -> None:
    """Watts at a fixed heart rate and a VO2max estimate, printed when PM5_MASS_KG and PM5_HRMAX
    are set in .env (see pm5_vo2.py). Nothing is stored or uploaded."""
    try:
        import pm5_vo2
        pm5_vo2.load_env()
        cfg = pm5_vo2.settings()
        if cfg:
            print(pm5_vo2.report([(sess_path.stem, data)], cfg), flush=True)
    except Exception as e:
        print(f"fitness estimate skipped ({e})", flush=True)


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


async def log_session(minutes: float | None, upload: bool = True, open_browser: bool = True,
                      workout: dict | None = None):
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
    session, stop = Session(echo=True, emit=hub.publish), asyncio.Event()
    hub.session = session
    raw = raw_path.open("a")

    def on_notify(short):
        def handler(_char, data: bytearray):
            if raw.closed:
                return
            now = time.time()
            raw.write(json.dumps({"t": round(now, 3), "uuid": f"{short:04x}", "hex": bytes(data).hex()}) + "\n")
            session.feed(now, short, bytes(data))
        return handler

    install_stop_signal(stop)
    try:
        async with BleakClient(dev) as client:
            info = await read_info(client)
            meta = {"device": {"name": dev.name, **info}}
            print(f"connected to {dev.name}: firmware {info.get('firmware_rev')}", flush=True)
            if workout:
                from pm5_workouts import describe, program
                try:
                    await program(client, workout)
                    meta["workout"] = describe(workout)
                except (RuntimeError, TimeoutError, ValueError) as e:
                    print(f"{e}\nThe workout was not set; recording anyway. Set it on the monitor by hand.",
                          flush=True)
            raw.write(json.dumps({"t": round(time.time(), 3), **meta}) + "\n")
            hub.publish("device", {**meta["device"], "workout": meta.get("workout")})

            async def programmer(spec_text):
                """Called by the dashboard's Send / Clear buttons (Hub.program)."""
                from pm5_workouts import describe, parse_spec, program, terminate
                if spec_text is None:
                    await terminate(client)
                    desc = None
                else:
                    spec = parse_spec(spec_text)
                    await program(client, spec)
                    desc = describe(spec)
                meta["workout"] = desc
                raw.write(json.dumps({"t": round(time.time(), 3), "workout": desc}) + "\n")
                hub.publish("device", {**meta["device"], "workout": desc})
                return desc
            hub.programmer = programmer
            service = client.services.get_service(ROWING_SERVICE)
            if service is None:
                sys.exit(f"{dev.name} does not offer the Concept2 rowing service; is it a PM5?")
            subscribed = []
            for ch in service.characteristics:  # everything, including characteristics newer than the spec
                if "notify" in ch.properties:
                    short = int(ch.uuid[4:8], 16)
                    await client.start_notify(ch, on_notify(short))
                    subscribed.append(f"{short:04x}")
            print("subscribed:", " ".join(subscribed), "| row when ready; end the piece on the PM5 (Menu)",
                  flush=True)
            connected_at = time.time()
            deadline = connected_at + minutes * 60 if minutes else None
            try:
                while client.is_connected and not stop.is_set():
                    await asyncio.sleep(1)
                    now = time.time()
                    if session.end_at and now - session.end_at > AFTER_END_S:
                        break
                    if session.new_piece_at:
                        break
                    if now - (session.last_stroke_t or connected_at) > IDLE_STOP_S:
                        print("no strokes for 10 minutes; stopping", flush=True)
                        break
                    if deadline and now > deadline:
                        break
            except (KeyboardInterrupt, asyncio.CancelledError):
                pass
    finally:
        hub.programmer = None
        raw.close()
    hub.publish("ended", {"session": start})
    await asyncio.sleep(0.3)   # let the dashboard receive it before the server goes
    data = session.result({"started": start, **{k: v for k, v in meta.items() if v is not None}})
    save(sess_path, data)
    fitness(sess_path, data)
    if upload:
        post(sess_path, data)
    server.close()


def read_raw(raw_path):
    raw_path = Path(raw_path)
    meta, events = {"started": raw_path.stem}, []
    with raw_path.open() as f:
        for line in f:
            r = json.loads(line)
            if "device" in r:
                meta["device"] = r["device"]
            if "workout" in r:           # programmed at connect, or later from the dashboard
                if r["workout"]:
                    meta["workout"] = r["workout"]
                else:
                    meta.pop("workout", None)
            if "uuid" in r:
                events.append((r["t"], int(r["uuid"], 16), bytes.fromhex(r["hex"])))
    return meta, events


def reparse(raw_path: Path) -> None:
    meta, events = read_raw(raw_path)
    session = Session()
    for t, short, b in events:
        session.feed(t, short, b)
    sess_path, data = OUT / "sessions" / f"{raw_path.stem}.json", session.result(meta)
    save(sess_path, data)
    fitness(sess_path, data)


async def replay(raw_path: Path, speed: float, loop: bool, open_browser: bool):
    """Play a saved row through the dashboard at its original pace (x speed). No Bluetooth."""
    meta, events = read_raw(raw_path)
    hub, stop = Hub(), asyncio.Event()
    server = await start_dashboard(hub, open_browser)
    install_stop_signal(stop)
    await asyncio.sleep(2)  # let a freshly opened tab connect before the first stroke
    while not stop.is_set():
        hub.session = Session(emit=hub.publish)
        hub.publish("reset", {"replay": raw_path.stem, **meta.get("device", {})})
        prev = events[0][0] if events else 0
        for t, short, b in events:
            if stop.is_set():
                break
            await asyncio.sleep(max(0.0, (t - prev) / speed))
            prev = t
            hub.session.feed(t, short, b)
        hub.publish("ended", {"session": raw_path.stem})
        if not loop:
            break
        await asyncio.sleep(3)
    await asyncio.sleep(0.5)
    server.close()


async def main():
    global OUT, PORT
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scan", action="store_true", help="list advertising PM5s and exit")
    ap.add_argument("--info", action="store_true", help="read device info (firmware) and exit")
    ap.add_argument("--workout", metavar="SPEC",
                    help="program this piece on the PM5 before recording: 2000m, 20:00/4:00, 4x4:00/3:00r, "
                         "or a name from workouts.json (python pm5_workouts.py --list)")
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
    workout = None
    if a.workout:   # check the syntax before touching Bluetooth
        from pm5_workouts import build, parse_spec
        try:
            workout = parse_spec(a.workout)
            build(workout)
        except ValueError as e:
            sys.exit(str(e))
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
                      f"services {[u[:8] for u in (ad.service_uuids or [])]}")
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
    await log_session(a.minutes, upload=not a.no_upload, open_browser=not a.no_browser, workout=workout)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

"""Program a workout on a Concept2 PM5 over Bluetooth, the way ErgData does.

    python pm5_workouts.py 2000m                 # single distance (5 splits by default)
    python pm5_workouts.py 5000m/1000m           # single distance, 1000 m splits
    python pm5_workouts.py 20:00/4:00            # single time, 4:00 splits
    python pm5_workouts.py 4x4:00/3:00r          # 4 intervals of 4:00 with 3:00 rest
    python pm5_workouts.py 8x500m/1:00r@1:45     # 8 x 500 m, 1:00 rest, target pace 1:45
    python pm5_workouts.py 500m/0:30r            # fixed intervals, repeating until you stop
    python pm5_workouts.py 4:00/3:00r,500m/1:00r # a variable list: any mix, up to 50
    python pm5_workouts.py 6x1000m               # intervals with undefined (rower-ended) rest
    python pm5_workouts.py just_row              # Just Row with 500 m splits
    python pm5_workouts.py pyramid               # a name from workouts.json
    python pm5_workouts.py --list                # the names in workouts.json
    python pm5_workouts.py --frame 4x4:00/3:00r  # print the CSAFE frame, no Bluetooth
    python pm5_workouts.py --terminate           # end the current workout on the PM5

pm5_logger.py --workout SPEC programs the piece and then records it in the same connection.

The PM5 accepts CSAFE frames on its control service (0x0020): commands are written to 0x0021
in 20-byte pieces and the response comes back on 0x0022. Everything here follows Concept2's
"PM CSAFE Communication Definition" (rev 0.27), whose worked examples are reproduced in
tests/test_workouts.py byte for byte. Multi-byte values in these commands are big-endian,
unlike the rowing-data characteristics the logger decodes.
"""
import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKOUTS_FILE = ROOT / "workouts.json"

BASE = "ce06{:04x}-43e5-11e4-916c-0800200c9a66"
CONTROL_SERVICE = BASE.format(0x0020)
PM_RECEIVE = BASE.format(0x0021)      # host -> PM
PM_TRANSMIT = BASE.format(0x0022)     # PM -> host
CHUNK = 20                            # the receive characteristic takes up to 20 bytes per write

# CSAFE framing
EXT_START, START, STOP, STUFF = 0xF0, 0xF1, 0xF2, 0xF3
PM_WRAPPER = 0x76                     # CSAFE_SETPMCFG_CMD: "one or more C2 proprietary commands"

# C2 proprietary long set commands (inside the 0x76 wrapper)
SET_WORKOUTTYPE, SET_WORKOUTDURATION, SET_RESTDURATION = 0x01, 0x03, 0x04
SET_SPLITDURATION, SET_TARGETPACETIME, SET_SCREENSTATE = 0x05, 0x06, 0x13
CONFIGURE_WORKOUT, SET_INTERVALTYPE, SET_WORKOUTINTERVALCOUNT = 0x14, 0x17, 0x18

DUR_TIME, DUR_CALORIES, DUR_DISTANCE = 0x00, 0x40, 0x80   # duration identifiers
WT = {"just_row_nosplits": 0, "just_row": 1, "distance_nosplits": 2, "distance": 3, "time_nosplits": 4,
      "time": 5, "time_interval": 6, "distance_interval": 7, "variable": 8, "variable_undefined_rest": 9,
      "calorie": 10, "wattminute": 11, "calorie_interval": 12}
IT = {"time": 0, "distance": 1, "rest": 2, "time_undefined_rest": 3, "distance_undefined_rest": 4,
      "undefined_rest": 5, "calorie": 6, "calorie_undefined_rest": 7}
SCREEN_WORKOUT = 1
PREPARE_TO_ROW, TERMINATE_WORKOUT = 1, 2
MAX_INTERVALS = 50

STATE = {0: "error", 1: "ready", 2: "idle", 3: "have id", 5: "in use", 6: "pause", 7: "finish",
         8: "manual", 9: "off line"}
PREV = {0x00: "ok", 0x10: "rejected", 0x20: "bad", 0x30: "not ready"}


# ---------------------------------------------------------------------------- framing

def checksum(contents: bytes) -> int:
    c = 0
    for b in contents:
        c ^= b
    return c


def stuff(data: bytes) -> bytes:
    out = bytearray()
    for b in data:
        if EXT_START <= b <= STUFF:
            out += bytes([STUFF, b & 0x03])
        else:
            out.append(b)
    return bytes(out)


def unstuff(data: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(data):
        if data[i] == STUFF and i + 1 < len(data):
            out.append(0xF0 | (data[i + 1] & 0x03))
            i += 2
        else:
            out.append(data[i])
            i += 1
    return bytes(out)


def frame(contents: bytes) -> bytes:
    """A standard CSAFE frame: start flag, stuffed contents and checksum, stop flag."""
    return bytes([START]) + stuff(contents + bytes([checksum(contents)])) + bytes([STOP])


def unframe(raw: bytes) -> tuple[int, bytes]:
    """(status byte, command responses) from a response frame; raises on a bad frame."""
    if len(raw) < 4 or raw[0] not in (START, EXT_START) or raw[-1] != STOP:
        raise ValueError(f"not a CSAFE frame: {raw.hex()}")
    body = unstuff(raw[1:-1])
    if raw[0] == EXT_START:
        body = body[2:]               # destination and source addresses
    contents, check = body[:-1], body[-1]
    if checksum(contents) != check:
        raise ValueError(f"checksum mismatch in {raw.hex()}")
    return contents[0], contents[1:]


def describe_status(status: int) -> str:
    return f"{PREV.get(status & 0x30, '?')}, state {STATE.get(status & 0x0F, status & 0x0F)}"


def long_cmd(cmd: int, data: bytes) -> bytes:
    return bytes([cmd, len(data)]) + data


def wrap(*cmds: bytes) -> bytes:
    body = b"".join(cmds)
    if len(body) > 255:
        raise ValueError("workout too long for one frame")
    return bytes([PM_WRAPPER, len(body)]) + body


def be(value: int, n: int) -> bytes:
    return int(round(value)).to_bytes(n, "big")


# ---------------------------------------------------------------------------- workouts

def _duration(iv: dict) -> bytes:
    if "distance_m" in iv:
        return bytes([DUR_DISTANCE]) + be(iv["distance_m"], 4)
    if "calories" in iv:
        return bytes([DUR_CALORIES]) + be(iv["calories"], 4)
    return bytes([DUR_TIME]) + be(iv["time_s"] * 100, 4)   # 0.01 s units


def _interval_type(iv: dict, undefined_rest: bool) -> int:
    base = "distance" if "distance_m" in iv else "calorie" if "calories" in iv else "time"
    return IT[f"{base}_undefined_rest" if undefined_rest else base]


def normalise(spec: dict) -> dict:
    """Fill in defaults and check a workout dict. Kinds: just_row, distance, time, calories,
    interval (one work/rest pair repeated until stopped), variable (a list, optional repeat)."""
    s = dict(spec)
    if s.get("just_row") or s.get("kind") == "just_row":
        s = {"kind": "just_row", "split_m": s.get("split_m", 500)}
    elif "intervals" in s:
        ivs = [dict(iv) for iv in s["intervals"]] * int(s.get("repeat", 1))
        if not ivs:
            raise ValueError("an interval workout needs at least one interval")
        if len(ivs) > MAX_INTERVALS:
            raise ValueError(f"the PM5 takes at most {MAX_INTERVALS} intervals ({len(ivs)} given)")
        for iv in ivs:
            if not any(k in iv for k in ("distance_m", "time_s", "calories")):
                raise ValueError(f"interval without distance_m/time_s/calories: {iv}")
        s = {"kind": "variable", "intervals": ivs}
    elif "interval" in s:
        iv = dict(s["interval"])
        if "rest_s" not in iv:
            raise ValueError("a repeating interval needs rest_s (or give a count: NxWORK for undefined rest)")
        s = {"kind": "interval", "interval": iv}
    elif "distance_m" in s:
        d = int(s["distance_m"])
        s = {"kind": "distance", "distance_m": d, "split_m": int(s.get("split_m") or default_split_m(d))}
    elif "time_s" in s:
        t = int(s["time_s"])
        s = {"kind": "time", "time_s": t, "split_s": int(s.get("split_s") or default_split_s(t))}
    elif "calories" in s:
        c = int(s["calories"])
        s = {"kind": "calories", "calories": c, "split_cal": int(s.get("split_cal") or max(1, round(c / 5)))}
    else:
        raise ValueError(f"can't make a workout out of {spec}")
    if "pace_s" in spec and s["kind"] in ("variable", "interval"):
        for iv in (s["intervals"] if s["kind"] == "variable" else [s["interval"]]):
            iv.setdefault("pace_s", spec["pace_s"])
    return s


def default_split_m(distance_m: int) -> int:
    """Five splits, rounded to a sensible size (the PM5 wants at least 100 m)."""
    step = 500 if distance_m >= 5000 else 100
    return max(100, int(round(distance_m / 5 / step)) * step or 100)


def default_split_s(time_s: int) -> int:
    step = 60 if time_s >= 600 else 30
    return max(30, int(round(time_s / 5 / step)) * step or 30)


def build(spec: dict) -> bytes:
    """The CSAFE frame that programs `spec` (see normalise) and puts the PM5 on its
    'prepare to row' screen. Matches the examples in Concept2's spec byte for byte."""
    s = normalise(spec)
    kind = s["kind"]
    cmds = []
    if kind == "just_row":
        cmds += [long_cmd(SET_WORKOUTTYPE, bytes([WT["just_row"]])),
                 long_cmd(SET_SPLITDURATION, bytes([DUR_DISTANCE]) + be(s["split_m"], 4))]
    elif kind in ("distance", "time", "calories"):
        dur = {"distance": ("distance_m", "split_m", DUR_DISTANCE, 1),
               "time": ("time_s", "split_s", DUR_TIME, 100),
               "calories": ("calories", "split_cal", DUR_CALORIES, 1)}[kind]
        total, split, ident, scale = dur
        cmds += [long_cmd(SET_WORKOUTTYPE, bytes([WT[kind]])),
                 long_cmd(SET_WORKOUTDURATION, bytes([ident]) + be(s[total] * scale, 4)),
                 long_cmd(SET_SPLITDURATION, bytes([ident]) + be(s[split] * scale, 4))]
    elif kind == "interval":
        iv = s["interval"]
        wt = WT["distance_interval" if "distance_m" in iv else "calorie_interval" if "calories" in iv else "time_interval"]
        cmds += [long_cmd(SET_WORKOUTTYPE, bytes([wt])),
                 long_cmd(SET_WORKOUTDURATION, _duration(iv)),
                 long_cmd(SET_RESTDURATION, be(iv["rest_s"], 2))]
        if iv.get("pace_s"):
            cmds.append(long_cmd(SET_TARGETPACETIME, be(iv["pace_s"] * 100, 4)))
    elif kind == "variable":
        ivs = s["intervals"]
        undefined = any("rest_s" not in iv for iv in ivs)
        for n, iv in enumerate(ivs):
            cmds.append(long_cmd(SET_WORKOUTINTERVALCOUNT, bytes([n])))
            if n == 0:
                cmds.append(long_cmd(SET_WORKOUTTYPE, bytes([WT["variable"]])))
            cmds += [long_cmd(SET_INTERVALTYPE, bytes([_interval_type(iv, "rest_s" not in iv)])),
                     long_cmd(SET_WORKOUTDURATION, _duration(iv)),
                     long_cmd(SET_RESTDURATION, be(iv.get("rest_s", 0), 2))]
            if iv.get("pace_s"):
                cmds.append(long_cmd(SET_TARGETPACETIME, be(iv["pace_s"] * 100, 4)))
            cmds.append(long_cmd(CONFIGURE_WORKOUT, bytes([1])))
        if undefined:
            # the spec: a variable workout with any undefined rest must set the workout type to
            # "variable, undefined rest" and a zero split distance, or the PM5 treats it as a
            # Biathlon (which adds penalty distance)
            cmds += [long_cmd(SET_WORKOUTTYPE, bytes([WT["variable_undefined_rest"]])),
                     long_cmd(SET_SPLITDURATION, bytes([DUR_DISTANCE]) + be(0, 4))]
        cmds.append(long_cmd(SET_SCREENSTATE, bytes([SCREEN_WORKOUT, PREPARE_TO_ROW])))
        return frame(wrap(*cmds))
    if kind != "just_row":
        cmds.append(long_cmd(CONFIGURE_WORKOUT, bytes([1])))
    cmds.append(long_cmd(SET_SCREENSTATE, bytes([SCREEN_WORKOUT, PREPARE_TO_ROW])))
    return frame(wrap(*cmds))


def terminate_frame() -> bytes:
    return frame(wrap(long_cmd(SET_SCREENSTATE, bytes([SCREEN_WORKOUT, TERMINATE_WORKOUT]))))


# ---------------------------------------------------------------------------- the mini-syntax

_TIME = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})$")
_DIST = re.compile(r"^(\d+(?:\.\d+)?)(m|km)$")
_CAL = re.compile(r"^(\d+)cal$")


def parse_amount(text: str) -> dict:
    """'500m', '2.5km', '4:00', '1:00:00', '100cal' -> {distance_m|time_s|calories: value}."""
    t = text.strip().lower()
    if m := _DIST.match(t):
        v = float(m.group(1)) * (1000 if m.group(2) == "km" else 1)
        return {"distance_m": int(round(v))}
    if m := _TIME.match(t):
        h, mi, s = (int(x) if x else 0 for x in m.groups())
        return {"time_s": h * 3600 + mi * 60 + s}
    if m := _CAL.match(t):
        return {"calories": int(m.group(1))}
    raise ValueError(f"'{text}' is not a distance (500m, 2.5km), a time (4:00, 1:00:00) or calories (100cal)")


def parse_time_s(text: str) -> int:
    v = parse_amount(text)
    if "time_s" not in v:
        raise ValueError(f"'{text}' should be a time like 3:00")
    return v["time_s"]


def parse_spec(text: str) -> dict:
    """The command-line syntax (see the module docstring) -> a workout dict for normalise().
    A name in workouts.json wins over the syntax."""
    text = text.strip()
    named = load_named().get(text)
    if named is not None:
        return named
    if text.lower() in ("just_row", "justrow", "jr"):
        return {"just_row": True}
    pace = None
    if "@" in text:
        text, p = text.split("@", 1)
        pace = parse_time_s(p)
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if len(parts) > 1:
        ivs = [_parse_interval(p) for p in parts]
        return {"intervals": ivs, **({"pace_s": pace} if pace else {})}
    p = parts[0]
    if m := re.match(r"^(\d+)\s*[x×]\s*(.+)$", p, re.I):
        count, rest = int(m.group(1)), m.group(2)
        return {"intervals": [_parse_interval(rest)], "repeat": count, **({"pace_s": pace} if pace else {})}
    if p.lower().endswith("r") and "/" in p:
        return {"interval": _parse_interval(p), **({"pace_s": pace} if pace else {})}
    if "/" in p:
        total, split = p.split("/", 1)
        work, sp = parse_amount(total), parse_amount(split)
        key = next(iter(work))
        if next(iter(sp)) != key:
            raise ValueError(f"the split in '{p}' must be the same kind as the piece")
        split_key = {"distance_m": "split_m", "time_s": "split_s", "calories": "split_cal"}[key]
        return {**work, split_key: next(iter(sp.values())), **({"pace_s": pace} if pace else {})}
    return {**parse_amount(p), **({"pace_s": pace} if pace else {})}


def _parse_interval(text: str) -> dict:
    """'4:00/3:00r' -> {time_s: 240, rest_s: 180}; '500m' -> {distance_m: 500} (undefined rest)."""
    t = text.strip()
    if "/" in t:
        work, rest = t.split("/", 1)
        rest = rest.strip()
        if not rest.lower().endswith("r"):
            raise ValueError(f"'{text}': rest must end in r, e.g. 4:00/3:00r")
        return {**parse_amount(work), "rest_s": parse_time_s(rest[:-1])}
    return parse_amount(t)


def load_named() -> dict:
    if not WORKOUTS_FILE.exists():
        return {}
    try:
        data = json.loads(WORKOUTS_FILE.read_text())
    except json.JSONDecodeError as e:
        sys.exit(f"{WORKOUTS_FILE.name} is not valid JSON: {e}")
    return {k: v for k, v in data.items() if not k.startswith("_")}


def describe(spec: dict) -> str:
    s = normalise(spec)
    k = s["kind"]
    if k == "just_row":
        return f"Just Row, {s['split_m']} m splits"
    if k == "distance":
        return f"{s['distance_m']} m, {s['split_m']} m splits"
    if k == "time":
        return f"{fmt_time(s['time_s'])}, {fmt_time(s['split_s'])} splits"
    if k == "calories":
        return f"{s['calories']} cal, {s['split_cal']} cal splits"
    if k == "interval":
        return f"intervals of {fmt_iv(s['interval'])} until stopped"
    ivs = s["intervals"]
    if len(set(json.dumps(iv, sort_keys=True) for iv in ivs)) == 1:
        return f"{len(ivs)} x {fmt_iv(ivs[0])}"
    return f"{len(ivs)} intervals: " + ", ".join(fmt_iv(iv) for iv in ivs)


def fmt_time(s: int) -> str:
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def fmt_iv(iv: dict) -> str:
    work = (f"{iv['distance_m']} m" if "distance_m" in iv else f"{iv['calories']} cal" if "calories" in iv
            else fmt_time(iv["time_s"]))
    rest = f"{fmt_time(iv['rest_s'])} rest" if "rest_s" in iv else "rest until you row"
    pace = f" @ {fmt_time(int(iv['pace_s']))}/500m" if iv.get("pace_s") else ""
    return f"{work} / {rest}{pace}"


# ---------------------------------------------------------------------------- Bluetooth

async def send(client, data: bytes, timeout: float = 3.0) -> tuple[int, bytes]:
    """Write one CSAFE frame to the PM5 in 20-byte pieces and return (status, responses)."""
    got, done = bytearray(), asyncio.Event()

    def on_reply(_char, chunk: bytearray):
        got.extend(chunk)
        if got and got[-1] == STOP:
            done.set()

    tx = client.services.get_characteristic(PM_TRANSMIT)
    notify = tx is not None and "notify" in tx.properties
    if notify:
        await client.start_notify(PM_TRANSMIT, on_reply)
    try:
        for i in range(0, len(data), CHUNK):
            await client.write_gatt_char(PM_RECEIVE, data[i:i + CHUNK], response=True)
        if notify:
            try:
                await asyncio.wait_for(done.wait(), timeout)
            except asyncio.TimeoutError:
                raise TimeoutError(f"no reply from the PM5 within {timeout} s (got {bytes(got).hex() or 'nothing'})")
        else:   # older firmware: the reply is read back from the characteristic
            deadline = asyncio.get_running_loop().time() + timeout
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.2)
                got = bytearray(await client.read_gatt_char(PM_TRANSMIT))
                if got and got[-1] == STOP:
                    break
    finally:
        if notify:
            try:
                await client.stop_notify(PM_TRANSMIT)
            except Exception:
                pass
    return unframe(bytes(got))


async def program(client, spec: dict, log=print) -> int:
    """Program `spec` on a connected PM5. Returns the CSAFE status byte; raises if the PM5
    rejected the frame."""
    data = build(spec)
    log(f"programming: {describe(spec)}")
    status, replies = await send(client, data)
    if status & 0x30:
        raise RuntimeError(f"the PM5 did not accept the workout ({describe_status(status)}); "
                           f"is it on the main menu? Frame: {data.hex()}")
    log(f"PM5 accepted it ({describe_status(status)}). It is on the 'prepare to row' screen.")
    return status


async def terminate(client, log=print) -> int:
    status, _ = await send(client, terminate_frame())
    log(f"terminate sent ({describe_status(status)})")
    return status


async def with_pm5(fn):
    """Connect to the first PM5 found and run fn(client)."""
    from bleak import BleakClient
    from pm5_logger import find_pm5
    dev = await find_pm5()
    if not dev:
        sys.exit("No PM5 advertising. Wake it (press a button) and close ErgData or any other rowing app.")
    async with BleakClient(dev) as client:
        if client.services.get_service(CONTROL_SERVICE) is None:
            sys.exit(f"{dev.name} has no C2 PM control service; is it a PM5?")
        return await fn(client)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("spec", nargs="?", help="a workout: 2000m, 20:00/4:00, 4x4:00/3:00r, a name from workouts.json")
    ap.add_argument("--frame", action="store_true", help="print the CSAFE frame for SPEC and exit (no Bluetooth)")
    ap.add_argument("--list", action="store_true", help="list the named workouts in workouts.json")
    ap.add_argument("--terminate", action="store_true", help="end the current workout on the PM5")
    a = ap.parse_args()
    if a.list:
        for name, spec in load_named().items():
            print(f"{name:16} {describe(spec)}")
        return
    if a.terminate:
        asyncio.run(with_pm5(terminate))
        return
    if not a.spec:
        ap.error("give a workout, e.g. 4x4:00/3:00r (or --list)")
    try:
        spec = parse_spec(a.spec)
        data = build(spec)
    except ValueError as e:
        sys.exit(str(e))
    if a.frame:
        print(describe(spec))
        print(data.hex(" "))
        return
    asyncio.run(with_pm5(lambda client: program(client, spec)))


if __name__ == "__main__":
    main()

"""Write the fixtures the JavaScript tests compare against, using the Python code as the oracle.

    python web/tests/make_fixtures.py

Everything here is synthetic (the sample row, hand-built packets, made-up steady rows), so the
fixtures can live in the repository. Re-run after changing the Python decoder, the CSAFE
builder or the fitness estimate, and the JS tests will say whether the port still agrees.
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
OUT = Path(__file__).resolve().parent / "fixtures"

import pm5_logger as L      # noqa: E402
import pm5_vo2 as V         # noqa: E402
import pm5_workouts as W    # noqa: E402


def le(v, n):
    return int(round(v)).to_bytes(n, "little")


def sample_session():
    meta, events = L.read_raw(ROOT / "examples" / "sample_row.jsonl")
    session = L.Session()
    for t, short, b in events:
        session.feed(t, short, b)
    return session.result(meta)


def curve_frame(points, status=0x05):
    """A reply to CSAFE_PM_GET_FORCEPLOTDATA as the spec's example lays it out: the 0x1A wrapper,
    the command, 33 bytes (bytes read, then 32 bytes of points least significant byte first, zero
    padded)."""
    data = b"".join(le(v, 2) for v in points)
    data += bytes(32 - len(data))
    return W.frame(bytes([status, 0x1A, 35, 0x6B, 33, 2 * len(points)]) + data)


def state_frame(state, status=0x05):
    return W.frame(bytes([status, 0x1A, 3, 0xBF, 1, state]))


def command_row():
    """The sample row as a PM5 that sends no curve would give it to the browser version: no 0x003D
    or 0x0043, and each 0x003D curve fetched by command instead, logged as the page logs it (uuid
    0022: a stroke-state reply when the state changes, then the force-plot replies). Some strokes
    carry the cases both decoders must agree on:
      3: exactly 32 points, so two full reads and an empty one;
      5: cut off after one full read by the next drive, so it gets no curve;
      7: a reply with a bad checksum, a refusal with no responses, and another command's reply among its reads;
      9: values 241 and 498, whose bytes need CSAFE stuffing."""
    rows = [json.loads(line) for line in (ROOT / "examples" / "sample_row.jsonl").open()]
    out, fc, n = [], L.ForceCurve(), 0
    add = lambda t, raw: out.append({"t": round(t, 3), "uuid": "0022", "hex": raw.hex()})
    for r in rows:
        if r.get("uuid") == "0043":
            continue
        if r.get("uuid") != "003d":
            out.append(r)
            continue
        curve = fc.add(bytes.fromhex(r["hex"]))
        if not curve:
            continue
        n += 1
        t = r["t"]
        if n == 3:
            curve = (curve + [5] * 32)[:32]
        if n == 9:
            curve = curve[:10] + [241, 498] + curve[12:]
        add(t - 0.4, state_frame(2))
        add(t + 0.04, state_frame(4))
        reads = [curve[i:i + 16] for i in range(0, len(curve), 16)]
        if len(curve) % 16 == 0:
            reads.append([])
        if n == 5:
            reads = reads[:1]
        k = 0
        for k, pts in enumerate(reads):
            if n == 7 and k == 1:
                bad = bytearray(curve_frame(pts))
                bad[-2] ^= 0x01
                add(t + 0.07, bytes(bad))
                add(t + 0.075, W.frame(bytes([0x15])))                   # a refusal: status only
                add(t + 0.078, W.frame(bytes([0x05, 0x7E, 9, 0x57, 7, 0, 1, 120, 0x12, 0x34, 0x56, 0x78])))   # a heart-rate belt reply
            add(t + 0.08 + 0.04 * k, curve_frame(pts))
    out.sort(key=lambda r: r["t"])   # stable: the sample's own order is kept at equal times
    return out


def command_session():
    meta, events = {}, []
    for r in command_row():
        if "device" in r:
            meta["device"] = r["device"]
        if "uuid" in r:
            events.append((r["t"], int(r["uuid"], 16), bytes.fromhex(r["hex"])))
    session = L.Session()
    for t, short, b in events:
        session.feed(t, short, b)
    return session.result(meta)


def packets():
    """Hand-built packets for every layout parse() knows, plus ones it must refuse."""
    cases = [
        (0x0035, le(12345, 3) + le(4567, 3) + bytes([142, 85]) + le(210, 2) + le(987, 2) + le(2105, 2) + le(1203, 2) + le(6502, 2) + le(42, 2)),
        (0x0031, le(2700, 3) + le(1234, 3) + bytes([1, 255, 1, 1, 2]) + le(0, 3) + le(0, 3) + bytes([0x80, 116])),
        (0x0031, le(2700, 3) + le(1234, 3) + bytes([3, 255, 3, 1, 2]) + le(0, 3) + le(0, 3) + bytes([0x80, 120])),
        (0x0031, le(2700, 3) + le(1234, 3) + bytes([5, 0, 1, 1, 2]) + le(0, 3) + le(180000, 3) + bytes([0x00, 113])),
        (0x0032, le(6000, 3) + le(4500, 2) + bytes([22, 131]) + le(13010, 2) + le(13500, 2) + bytes([0, 0, 0, 0, 0])),
        (0x0032, le(6000, 3) + le(4500, 2) + bytes([22, 0]) + le(13010, 2) + le(13500, 2) + bytes([0, 0, 0, 0, 0])),
        (0x0032, le(6000, 3) + le(4500, 2) + bytes([22, 255]) + le(13010, 2) + le(13500, 2) + bytes([0, 0, 0, 0, 0])),
        (0x0033, le(6000, 3) + bytes([0]) + le(180, 2) + le(55, 2) + le(12800, 2) + bytes([0, 0, 0, 0])),
        (0x0036, le(6000, 3) + le(163, 2) + le(900, 2) + le(12, 2)),
        (0x0036, le(6000, 3) + le(163, 2) + le(900, 2) + le(12, 2) + le(75000, 3) + le(5000, 3)),
        (0x003A, bytes([0, 0, 0, 0, 1]) + le(1000, 2) + bytes([5]) + le(316, 2) + le(159, 2)),
        (0x0039, bytes([0, 0, 0, 0]) + le(130000, 3) + le(50000, 3) + bytes([15, 149, 0, 0, 0, 116, 0, 3]) + le(1300, 2)),
        (0x0037, bytes.fromhex("3675002a2c00b80b006a0400000000000001")),   # split 1 of 2026-09-18, as the PM5 sent it
        (0x0038, bytes.fromhex("367500107c002f0545002e03b60e9600750100")),
        (0x003E, bytes([2, 0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 78, 0, 0, 0, 0, 0, 0])),
        (0x003B, bytes([1, 120, 0x78, 0x56, 0x34, 0x12])),
        (0x0035, le(12345, 3) + le(4567, 3)),      # too short
        (0x0080, bytes(19)),                        # not decoded: the multiplexed characteristic
    ]
    return [{"short": s, "hex": b.hex(), "expected": L.parse(s, b)} for s, b in cases]


def frames():
    named = W.load_named()
    specs = ["2000m", "5000m/1000m", "20:00/4:00", "1:00:00", "100cal", "4x4:00/3:00r", "8x500m/1:00r@1:45",
             "500m/0:30r", "4:00/3:00r,500m/1:00r", "6x1000m", "just_row", "2k", "5k", "4x4", "pyramid", "8x500",
             "just_row", "250m/1:00r,500m,750m/2:00r", "12:00/4:00r@2:00", "300cal/50cal"]
    out = []
    for text in specs:
        spec = W.parse_spec(text)
        out.append({"text": text, "spec": spec, "normalised": W.normalise(spec), "description": W.describe(spec),
                    "hex": W.build(spec).hex()})
    bad = ["", "abc", "2000m/4:00", "51x500m/1:00r", "4:00/x", "4x", "0x500m/1:00r"]
    return {"named": named, "frames": out, "terminate_hex": W.terminate_frame().hex(), "bad": bad}


def row(minutes=20, watts=150, hr=140, spm=16, sprint_last=False, jitter=0.0, seed=1):
    rnd = random.Random(seed)
    strokes, t, n = [], 0.0, 0
    while t < minutes * 60:
        n += 1
        w = watts * (1.6 if sprint_last and t > minutes * 60 - 30 else 1) + (rnd.uniform(-jitter, jitter) if jitter else 0)
        h = hr if t > 180 else 90 + (hr - 90) * t / 180
        strokes.append({"elapsed_s": round(t, 2), "power_w": round(w), "hr": round(h), "spm": spm, "stroke_count": n})
        t += 60 / spm
    return {"strokes": strokes, "summary": {"drag_factor_avg": 118}}


def step_row(stages=(110, 130, 150, 170), stage_s=240, warm_s=300, count_s=90, seed=4, balanced=None):
    """A step test as the browser saves it: the strokes, and the guided result holding each finished
    stage's mean power and heart rate over its last count_s. Heart rate climbs towards each new
    stage's level rather than jumping, so a steady window across the row would not match."""
    rnd = random.Random(seed)
    strokes, t, n, hr = [], 0.0, 0, 90.0
    plan = [(warm_s, stages[0])] + [(stage_s, w) for w in stages]
    ends = []
    for dur, w in plan:
        end = t + dur
        target = 50 + 0.55 * w
        while t < end:
            n += 1
            hr += (target - hr) * 0.08
            strokes.append({"elapsed_s": round(t, 2), "power_w": round(w + rnd.uniform(-6, 6)), "hr": round(hr),
                            "spm": 18, "stroke_count": n})
            t += 60 / 18
        ends.append(end)
    done = []
    for (dur, w), end in list(zip(plan, ends))[1:]:
        last = [x for x in strokes if end - count_s <= x["elapsed_s"] <= end]
        done.append({"key": w, "watts": sum(x["power_w"] for x in last) / len(last),
                     "hr": sum(x["hr"] for x in last) / len(last), "n": len(last)})
    return {"strokes": strokes, "summary": {"drag_factor_avg": 118},
            "guided": {"kind": "step", "title": f"Step test from {stages[0]} W",
                       "step": {"stages": done, **({"balanced": balanced} if balanced is not None else {})}}}


def vo2():
    cfg = {"mass_kg": 85.0, "hrmax": 190.0, "hr_rest": 50.0, "zone_hr": 145.0, "efficiency": V.DEFAULT_EFFICIENCY, "notes": []}
    rows = [("a", row(watts=120, hr=120, jitter=12, seed=1)), ("b", row(watts=160, hr=140, jitter=15, seed=2, sprint_last=True)),
            ("c", row(watts=200, hr=160, jitter=20, seed=3)), ("short", row(minutes=5)), ("low", row(watts=60, hr=60))]
    settings_cases = [{"PM5_MASS_KG": "80", "PM5_AGE": "40"}, {"PM5_MASS_KG": "80", "PM5_HRMAX": "190", "PM5_HR_REST": "45",
                      "PM5_ZONE_HR": "150", "PM5_NET_EFFICIENCY": "0.23"}, {"PM5_MASS_KG": "80"}, {}]
    return {"cfg": cfg, "rows": rows,
            "estimates": {name: V.estimate(sess, cfg) for name, sess in rows},
            "points": {name: V.row_point(sess) for name, sess in rows},
            "pooled": V.pooled([e for e in (V.estimate(s, cfg) for _, s in rows) if e and "error" not in e], cfg),
            "report": V.report(rows, cfg),
            "report_two": V.report(rows[:2], {**cfg, "notes": ["HRmax is 220 - age"]}),
            "settings": [{"env": env, "expected": V.settings(env)} for env in settings_cases],
            "step": {"row": step_row(), "short": step_row(stages=(110, 130)),
                     "points": V.step_points(step_row()),
                     "report_alone": V.report([("step", step_row())], cfg),
                     "report_short": V.report([("short", step_row(stages=(110, 130)))], cfg),
                     "report_mixed": V.report(rows[:2] + [("step", step_row())], cfg),
                     "balanced": step_row(stages=(110, 140, 170, 170, 140, 110), stage_s=200, balanced=True),
                     "report_balanced": V.report([("up and down", step_row(stages=(110, 140, 170, 170, 140, 110),
                                                                            stage_s=200, balanced=True))], cfg)},
            "vo2_300w_85kg": V.vo2(300, 85), "watts_at": V.watts_at(148, 150, 146, 42)}


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    (OUT / "sample_session.json").write_text(json.dumps(sample_session()))
    (OUT / "command_row.jsonl").write_text("".join(json.dumps(r) + "\n" for r in command_row()))
    (OUT / "command_session.json").write_text(json.dumps(command_session()))
    (OUT / "packets.json").write_text(json.dumps(packets(), indent=1))
    (OUT / "frames.json").write_text(json.dumps(frames(), indent=1))
    (OUT / "vo2.json").write_text(json.dumps(vo2()))
    print("fixtures written to", OUT)

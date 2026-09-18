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
            "vo2_300w_85kg": V.vo2(300, 85), "watts_at": V.watts_at(148, 150, 146, 42)}


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    (OUT / "sample_session.json").write_text(json.dumps(sample_session()))
    (OUT / "packets.json").write_text(json.dumps(packets(), indent=1))
    (OUT / "frames.json").write_text(json.dumps(frames(), indent=1))
    (OUT / "vo2.json").write_text(json.dumps(vo2()))
    print("fixtures written to", OUT)

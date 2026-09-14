"""Generate examples/sample_row.jsonl: a SYNTHETIC PM5 session for trying the dashboard.

No real rower data is in it. It encodes made-up but plausible values in the same packet
formats a PM5 sends (spec rev 1.30 layouts, plus the 0x0043 force-curve channel), so
`python pm5_logger.py --replay examples/sample_row.jsonl` exercises the full parsing path.
About 3 minutes of rowing at ~22 strokes/min: the peak drifts later and a small dip at the
leg-to-back handover appears as the rower "tires", so the shape measures have something to show.

    python examples/make_sample.py
"""
import json
import math
import random
from pathlib import Path

random.seed(7)
OUT = Path(__file__).resolve().parent / "sample_row.jsonl"
T0 = 1767225600.0          # 2026-01-01 00:00 UTC; any epoch works, only differences matter
N_STROKES = 66
DRAG = 120


def le(v, n):
    return int(round(v)).to_bytes(n, "little")


def curve(peak_pos, blip, peak):
    """Smooth single hump with its peak at peak_pos (0-1); optional dip before the peak."""
    pts = []
    for i in range(34):
        x = i / 33
        a = 2.2
        b = a * (1 - peak_pos) / peak_pos                     # mode of x^a (1-x)^b sits at peak_pos
        f = (x / peak_pos) ** a * ((1 - x) / (1 - peak_pos)) ** b if 0 < x < 1 else 0.0
        if blip:
            f -= blip * math.exp(-((x - (peak_pos - 0.12)) / 0.04) ** 2)
        pts.append(max(0, round(peak * min(f, 1.0) + random.uniform(-1.5, 1.5))))
    return pts


def packets(points, per=9):
    chunks = [points[i:i + per] for i in range(0, len(points), per)]
    return [bytes([(len(chunks) << 4) | len(c), seq]) + b"".join(le(v, 2) for v in c)
            for seq, c in enumerate(chunks)]


def main():
    lines = [{"t": T0, "device": {"name": "PM5 000000000 Row", "model": "PM5", "serial": "000000000",
                                  "hardware_rev": "sample", "firmware_rev": "synthetic", "manufacturer": "Concept2"}}]
    t, dist, cal, work_total, hr, prev_rec = 0.0, 0.0, 0.0, 0.0, 95.0, 0.0
    pace_hist = []

    def emit(dt, short, payload):
        lines.append({"t": round(T0 + dt, 3), "uuid": f"{short:04x}", "hex": payload.hex()})

    def status(now, spm, power, pace):
        avg_pace = sum(pace_hist) / len(pace_hist) if pace_hist else pace
        emit(now, 0x0031, le(now * 100, 3) + le(dist * 10, 3) + bytes([0, 1, 1, 1, 1]) + le(dist, 3)
             + le(0, 3) + bytes([0, DRAG]))
        emit(now, 0x0032, le(now * 100, 3) + le(500 / pace * 1000, 2) + bytes([spm, int(hr)])
             + le(pace * 100, 2) + le(avg_pace * 100, 2) + le(0, 2) + le(0, 3) + bytes([0]))
        emit(now, 0x0033, le(now * 100, 3) + bytes([0]) + le(power, 2) + le(cal, 2) + le(avg_pace * 100, 2)
             + le(power, 2) + le(0, 2) + le(0, 3) + le(0, 3))

    for n in range(1, N_STROKES + 1):
        tired = n / N_STROKES
        power = random.gauss(165 - 10 * tired, 6)
        pace = 500 * (2.80 / power) ** (1 / 3)
        spm = int(round(random.gauss(22, 0.6)))
        cycle = 60 / spm
        drive_t = random.gauss(0.82, 0.03)
        rec_t = cycle - drive_t
        peak = random.gauss(112 - 8 * tired, 3)
        pts = curve(peak_pos=0.36 + 0.14 * tired + random.gauss(0, 0.02),
                    blip=0.10 * max(0, tired - 0.5) * 2, peak=peak)
        avg_f = sum(pts) / len(pts)
        stroke_dist = random.gauss(9.6, 0.2)
        # drive: status ticks, then end-of-drive stroke data, power and the two curves
        for k in range(2):
            status(t + k * drive_t / 2, spm, power, pace)
        t += drive_t
        dist += stroke_dist * 0.35
        work = power * cycle
        emit(t, 0x0035, le(t * 100, 3) + le(dist * 10, 3) + bytes([int(random.gauss(144, 2)), int(drive_t * 100)])
             + le(prev_rec * 100, 2) + le(stroke_dist * 100, 2) + le(peak * 10, 2) + le(avg_f * 10, 2)
             + le(work * 10, 2) + le(n, 2))
        emit(t, 0x0036, le(t * 100, 3) + le(power, 2) + le(power * 4 + 300, 2) + le(n, 2) + le(0, 3) + le(0, 3))
        v1 = [0, 0, 0] + [v for v in pts for _ in range(random.choice((1, 2)))]   # time-stepped: readings repeat
        for p in packets(v1):
            emit(t + 0.01, 0x003D, p)
        for p in packets([v for v in pts if v > 0]):
            emit(t + 0.05, 0x0043, p)
        # recovery: status ticks, then the second copy of the stroke data with this recovery time
        for k in range(1, 4):
            status(t + k * rec_t / 4, spm, power, pace)
        t += rec_t
        dist += stroke_dist * 0.65
        cal += power * cycle / 4184 * 4 + 0.05
        hr = min(162, hr + (150 - hr) * 0.06 + random.uniform(-0.5, 0.8))
        pace_hist.append(pace)
        prev_rec = rec_t
        emit(t, 0x0035, le(t * 100, 3) + le(dist * 10, 3) + bytes([144, int(drive_t * 100)])
             + le(rec_t * 100, 2) + le(stroke_dist * 100, 2) + le(peak * 10, 2) + le(avg_f * 10, 2)
             + le(work * 10, 2) + le(n, 2))
    avg_pace = sum(pace_hist) / len(pace_hist)
    emit(t + 0.5, 0x0039, le(0, 2) + le(0, 2) + le(t * 100, 3) + le(dist * 10, 3)
         + bytes([22, int(hr), 138, 95, int(hr), DRAG, 0, 0]) + le(avg_pace * 10, 2))
    emit(t + 0.6, 0x003A, le(0, 2) + le(0, 2) + bytes([0]) + le(0, 2) + bytes([0]) + le(cal, 2)
         + le(160, 2) + le(0, 3) + le(0, 2) + le(900, 2))
    OUT.write_text("".join(json.dumps(l) + "\n" for l in lines))
    print(f"wrote {OUT.name}: {N_STROKES} strokes, {dist:.0f} m, {t:.0f} s, {len(lines)} lines")


if __name__ == "__main__":
    main()

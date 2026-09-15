"""Post a pm5_logger session to the Concept2 Logbook.

When pm5_logger.py holds the PM5's Bluetooth connection, ErgData can't, so nothing else sends
the row to your Logbook. pm5_logger.py calls this at the end of a row if a Concept2 token is
set up (see concept2.py); it also runs by hand:

    python pm5_upload.py data/sessions/<start>.json [--dry-run]

A posted session is stamped with its Logbook id and never posted twice, and the Logbook itself
refuses a duplicate (same date, time and distance) with 409. Interval workouts are skipped: the
Logbook wants an intervals structure the session file doesn't hold yet.

Set CONCEPT2_WEIGHT_CLASS in .env to L if you row lightweight (default H).
"""
import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

try:  # .env holds CONCEPT2_WEIGHT_CLASS; load it before any payload is built
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

# PM5 workout-type enum (BLE spec rev 1.30 appendix) -> Logbook workout_type
WORKOUT_TYPES = {0: "JustRow", 1: "JustRow", 2: "FixedDistanceSplits", 3: "FixedDistanceSplits",
                 4: "FixedTimeSplits", 5: "FixedTimeSplits"}


def local_tz() -> str | None:
    """tz-database name of this computer's timezone, or None if it can't be found.

    Read the /etc/localtime link itself: on macOS it resolves onward to
    /usr/share/zoneinfo.default/<zone>, which a plain "zoneinfo/" match misses."""
    if os.environ.get("TZ") and "/" in os.environ["TZ"]:
        return os.environ["TZ"].lstrip(":")
    for reader in (lambda: os.readlink("/etc/localtime"), lambda: str(Path("/etc/localtime").resolve())):
        try:
            m = re.search(r"zoneinfo[^/]*/(.+)$", reader())
            if m:
                return m.group(1)
        except OSError:
            continue
    return None


def pace_from_power(watts):
    return 500 * (2.80 / watts) ** (1 / 3) if watts else None


def build_payload(sess: dict) -> dict:
    s, strokes = sess.get("summary") or {}, sess.get("strokes") or []
    if not s.get("distance_m") or not s.get("elapsed_s"):
        raise ValueError("no end-of-workout summary: the piece wasn't ended on the PM5, so there is nothing to post")
    if s.get("workout_type") not in WORKOUT_TYPES:
        raise ValueError(f"workout type {s.get('workout_type')} is an interval or unsupported type; post it from ErgData")
    end = s.get("received_at") or (strokes[-1]["t"] if strokes else None)
    if end is None:
        raise ValueError("no timestamp to date the row by")
    data = []
    for st in strokes:
        row = {"t": round(st["elapsed_s"] * 10), "d": round(st["distance_m"] * 10)}
        pace = st.get("pace_s") or pace_from_power(st.get("power_w"))
        if pace:
            row["p"] = round(pace * 10)
        if st.get("spm"):
            row["spm"] = st["spm"]
        if st.get("hr") and st["hr"] != 255:
            row["hr"] = st["hr"]
        data.append(row)
    hr = {k: v for k, v in (("average", s.get("avg_hr")), ("min", s.get("min_hr")), ("max", s.get("max_hr")),
                            ("ending", s.get("ending_hr")), ("recovery", s.get("recovery_hr"))) if v and v != 255}
    # The PM5's end-of-workout summary leaves average/min/max HR at 0 even when a belt or watch
    # broadcast was paired (only the ending HR is filled), so take them from the strokes instead.
    beats = [st["hr"] for st in strokes if st.get("hr") and st["hr"] != 255]
    if beats:
        hr.setdefault("average", round(sum(beats) / len(beats)))
        hr.setdefault("min", min(beats))
        hr.setdefault("max", max(beats))
    tz = local_tz()   # unknown zone: send UTC time labelled UTC, never local time labelled UTC
    when = datetime.fromtimestamp(end) if tz else datetime.fromtimestamp(end, timezone.utc)
    payload = {
        "type": "rower",
        "date": when.strftime("%Y-%m-%d %H:%M:%S"),   # the Logbook dates a row by its END
        "timezone": tz or "UTC",
        "distance": round(s["distance_m"]),
        "time": round(s["elapsed_s"] * 10),                                   # tenths of a second
        "weight_class": os.environ.get("CONCEPT2_WEIGHT_CLASS", "H"),
        "workout_type": WORKOUT_TYPES[s["workout_type"]],
        "stroke_data": data,
        "comments": "Recorded with pm5-force-logger.",
    }
    for key, val in (("stroke_rate", s.get("avg_stroke_rate")), ("drag_factor", s.get("drag_factor_avg")),
                     ("calories_total", s.get("calories_total")),
                     ("stroke_count", strokes[-1].get("stroke_count") if strokes else None)):
        if val:
            payload[key] = val
    if hr:
        payload["heart_rate"] = hr
    return payload


def upload_session(path, dry_run: bool = False):
    path = Path(path)
    sess = json.loads(path.read_text())
    if sess.get("logbook_id"):
        print(f"already in the Logbook as result {sess['logbook_id']}")
        return sess["logbook_id"]
    if sess.get("new_piece_started"):
        print("note: a second piece started during this run; only the first piece is in this file")
    payload = build_payload(sess)
    print(f"Logbook: {payload['distance']} m in {payload['time'] / 10:.1f} s, "
          f"{len(payload['stroke_data'])} strokes, dated {payload['date']} {payload['timezone']}")
    if dry_run:
        print(json.dumps({k: v for k, v in payload.items() if k != "stroke_data"}, indent=1))
        print("first strokes:", payload["stroke_data"][:3])
        return None
    import concept2
    status, body = concept2.post_result(payload)
    if status == 201:
        sess["logbook_id"] = body["data"]["id"]
        path.write_text(json.dumps(sess, indent=1))
        print(f"posted to the Logbook as result {sess['logbook_id']}")
        return sess["logbook_id"]
    if status == 409:
        print("the Logbook already has this row (same date, time and distance); nothing posted")
        return None
    raise RuntimeError(f"Logbook rejected the row (HTTP {status}): {body}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("session")
    ap.add_argument("--dry-run", action="store_true", help="build and show the payload without posting")
    a = ap.parse_args()
    upload_session(a.session, a.dry_run)

"""Watts at a fixed heart rate, and a VO2max estimate, from pm5_logger sessions.

Every stroke record carries power and, with a belt or a watch broadcast paired to the PM5,
heart rate: the two inputs the submaximal fitness tests use. This reads the steady part of a
row and reports two things:

  * the watts you hold at a chosen heart rate (say the top of zone 2), the number to track for
    a "faster at the same heart rate" goal;
  * an estimate of VO2max, made by extending the heart-rate/power relation to your maximum
    heart rate and converting the power there to oxygen uptake.

    python pm5_vo2.py data/sessions/*.json          # one line per row, plus a fit across rows

pm5_logger.py prints the same at the end of a row (and after --reparse) when the settings
below are in .env. Nothing here is stored in the session file or uploaded anywhere.

Settings (.env or the environment):
    PM5_MASS_KG          body mass; without it no ml/kg/min
    PM5_HRMAX            maximum heart rate. A measured one is much better than 220 - age;
                         given only PM5_AGE, 220 - age is used and the output says so
    PM5_HR_REST          resting heart rate (default 60)
    PM5_ZONE_HR          the fixed heart rate to report watts at (default 75% of PM5_HRMAX)
    PM5_NET_EFFICIENCY   the fraction of the metabolic energy above rest that reaches the
                         handle (default 0.21, see below)

Method. The steady window is the row after its first five minutes (heart rate lags power at
the start), without its last minute and without sprint strokes (over 1.3x the window's median
watts) or pauses (under half of it). Within one row the heart rate drifts upward while a rower
holding a heart-rate target eases the power off, so no line can be fitted to a single row.
The per-row estimate instead takes the window's mean power and heart rate and assumes that the
fraction of heart-rate reserve in use equals the fraction of oxygen-uptake reserve (Swain and
Leutholtz 1997), which for a linear power-to-oxygen relation puts the power at heart rate H on
the line through rest:

    W(H) = W_mean x (H - HR_rest) / (HR_mean - HR_rest)

Given several rows at different intensities, a line HR = a + b W is fitted through their
window means (three or more rows spanning at least 40 W), which replaces the resting-heart-
rate assumption with data. Power becomes oxygen uptake as 3.5 ml/kg/min at rest plus the work
above it at a net efficiency of 0.21 (20.9 kJ per litre of oxygen); at 300 W for an 85 kg rower
that is 4.4 l/min, the figure Concept2's calculator (Hagerman's data) gives a fitness rower
with a 7:00 2k.

Heart-rate estimates of VO2max are usually reported within 10 to 15% of a laboratory value; this
one has not been checked against one. The maximum heart
rate (an age estimate is typically 10 bpm out), wrist-optical heart rate while rowing, cardiac
drift, and rowing economy at an unusual stroke rate all feed straight into it. The watts at a
fixed heart rate near the one you rowed at need almost no extrapolation and are the sturdier
number.
"""
import argparse
import json
import os
import statistics
from pathlib import Path

SKIP_S, TAIL_S = 300, 60           # the steady window: after the first 5 min, before the last 1 min
MIN_WINDOW_S, MIN_STROKES = 240, 40
SPRINT_FACTOR, PAUSE_FACTOR = 1.3, 0.5
VO2_REST = 3.5                     # ml/kg/min, the resting oxygen uptake (one MET)
O2_KJ_PER_L = 20.9                 # energy released per litre of oxygen
DEFAULT_EFFICIENCY = 0.21
POOL_MIN_ROWS, POOL_MIN_SPREAD_W = 3, 40
HR_MARGIN = 15                     # a window this close to resting heart rate can't be extrapolated


def load_env() -> None:
    """Read .env next to this file, or one folder up (a layout where the scripts sit in a subfolder)."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    here = Path(__file__).resolve().parent
    for p in (here / ".env", here.parent / ".env"):
        if p.exists():
            load_dotenv(p)


def settings(env=None) -> dict | None:
    """The estimate's inputs from the environment, or None when mass or maximum heart rate is missing."""
    env = os.environ if env is None else env

    def num(key):
        v = env.get(key)
        if v in (None, ""):
            return None
        try:
            return float(v)
        except ValueError:
            raise ValueError(f"{key}={v!r} is not a number") from None

    mass, hrmax, notes = num("PM5_MASS_KG"), num("PM5_HRMAX"), []
    if hrmax is None and num("PM5_AGE") is not None:
        hrmax = 220 - num("PM5_AGE")
        notes.append(f"HRmax {hrmax:.0f} is 220 - age; set PM5_HRMAX to a measured maximum if you have one")
    if mass is None or hrmax is None:
        return None
    rest = num("PM5_HR_REST")
    if rest is None:
        rest, notes = 60.0, notes + ["PM5_HR_REST not set; using a resting heart rate of 60"]
    if not rest < hrmax:
        raise ValueError(f"PM5_HR_REST {rest:g} must be below PM5_HRMAX {hrmax:g}")
    zone = num("PM5_ZONE_HR") or round(0.75 * hrmax)
    eff = num("PM5_NET_EFFICIENCY") or DEFAULT_EFFICIENCY
    return {"mass_kg": mass, "hrmax": hrmax, "hr_rest": rest, "zone_hr": zone, "efficiency": eff,
            "notes": notes}


def steady_window(strokes: list, skip_s: float = SKIP_S, tail_s: float = TAIL_S) -> list:
    """Strokes with power and heart rate after the warm-up and before the finish, sprints and
    pauses dropped (the window's median power sets what counts as either)."""
    usable = [s for s in strokes if s.get("power_w") and s.get("hr") and s["hr"] != 255]
    if not usable:
        return []
    end = max(s["elapsed_s"] for s in usable) - tail_s
    window = [s for s in usable if skip_s <= s["elapsed_s"] <= end]
    if not window:
        return []
    median = statistics.median(s["power_w"] for s in window)
    return [s for s in window if PAUSE_FACTOR * median <= s["power_w"] <= SPRINT_FACTOR * median]


def row_point(sess: dict) -> dict | None:
    """One row's steady window as mean power and heart rate, or None when the row is too short."""
    window = steady_window(sess.get("strokes") or [])
    if len(window) < MIN_STROKES or window[-1]["elapsed_s"] - window[0]["elapsed_s"] < MIN_WINDOW_S:
        return None
    spm = [s["spm"] for s in window if s.get("spm")]
    return {"watts": statistics.fmean(s["power_w"] for s in window),
            "hr": statistics.fmean(s["hr"] for s in window),
            "spm": statistics.fmean(spm) if spm else None,
            "strokes": len(window), "from_s": window[0]["elapsed_s"], "to_s": window[-1]["elapsed_s"],
            "drag": (sess.get("summary") or {}).get("drag_factor_avg")}


def step_points(sess: dict) -> list | None:
    """A guided step test's stages as points, or None for any other row. The browser saves each
    stage's mean power and heart rate over its last minute and a half, once heart rate has caught
    up with the new power. A steady window across the whole row would average the stages together
    and throw away the spread in power, which is the reason for doing a step test."""
    g = sess.get("guided") or {}
    if g.get("kind") != "step":
        return None
    stages = (g.get("step") or {}).get("stages") or []
    return [{"watts": st["watts"], "hr": st["hr"]} for st in stages if st.get("watts") and st.get("hr")]


def vo2(watts: float, mass_kg: float, efficiency: float = DEFAULT_EFFICIENCY) -> float:
    """Oxygen uptake in ml/kg/min at a steady power: rest plus the work above it at the net efficiency."""
    return VO2_REST + watts * 60 / (efficiency * O2_KJ_PER_L) / mass_kg


def watts_at(hr: float, watts_mean: float, hr_mean: float, hr_rest: float) -> float:
    """Power at heart rate hr on the line through (0 W, resting heart rate) and the row's mean."""
    return watts_mean * (hr - hr_rest) / (hr_mean - hr_rest)


def fit_line(points: list) -> dict | None:
    """Least-squares HR = a + b W through per-row means; None without 3 rows spanning 40 W, or
    if heart rate does not rise with power across them."""
    if len(points) < POOL_MIN_ROWS:
        return None
    ws, hs = [p["watts"] for p in points], [p["hr"] for p in points]
    if max(ws) - min(ws) < POOL_MIN_SPREAD_W:
        return None
    b, a = statistics.linear_regression(ws, hs)
    if b <= 0:
        return None
    return {"a": a, "b": b, "rows": len(points), "watts_min": min(ws), "watts_max": max(ws)}


def estimate(sess: dict, cfg: dict) -> dict | None:
    """Per-row: watts at the zone heart rate and a VO2max estimate; None when the row is too short."""
    p = row_point(sess)
    if p is None:
        return None
    if p["hr"] - cfg["hr_rest"] < HR_MARGIN:
        return {**p, "error": f"mean heart rate {p['hr']:.0f} is too close to resting {cfg['hr_rest']:g}"}
    w_zone = watts_at(cfg["zone_hr"], p["watts"], p["hr"], cfg["hr_rest"])
    w_max = watts_at(cfg["hrmax"], p["watts"], p["hr"], cfg["hr_rest"])
    return {**p, "watts_at_zone": w_zone, "watts_at_hrmax": w_max,
            "vo2max": vo2(w_max, cfg["mass_kg"], cfg["efficiency"])}


def pooled(points: list, cfg: dict) -> dict | None:
    """The across-rows fit, with the same two numbers read off it."""
    line = fit_line(points)
    if line is None:
        return None
    w_zone, w_max = (cfg["zone_hr"] - line["a"]) / line["b"], (cfg["hrmax"] - line["a"]) / line["b"]
    return {**line, "watts_at_zone": w_zone, "watts_at_hrmax": w_max,
            "vo2max": vo2(w_max, cfg["mass_kg"], cfg["efficiency"])}


def mmss(seconds: float) -> str:
    return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"


def report(sessions: list, cfg: dict) -> str:
    """Text for a list of (name, session dict): a per-row block each, then the pooled fit."""
    lines, points, n_rows, n_tests, n_stages = [], [], 0, 0, 0
    for name, sess in sessions:
        stages = step_points(sess)
        if stages is not None:
            lines.append(f"{name}: step test, " + (", ".join(f"{p['watts']:.0f} W at {p['hr']:.0f} bpm" for p in stages)
                                                    or "no stage finished"))
            own = pooled(stages, cfg)
            if own:
                lines.append(f"   its own line: HR = {own['a']:.0f} + {own['b']:.2f} x W;  watts at {cfg['zone_hr']:.0f} bpm: "
                             f"{own['watts_at_zone']:.0f};  VO2max ~{own['vo2max']:.0f} ml/kg/min")
            elif stages:
                lines.append(f"   too few stages for a line of its own ({POOL_MIN_ROWS} spanning {POOL_MIN_SPREAD_W} W); "
                             f"they still count in the fit across rows")
            if stages and ((sess.get("guided") or {}).get("step") or {}).get("balanced") is not True:
                lines.append("   only the way up was rowed, so heart-rate drift steepens the line and reads fitness low")
            points += stages
            n_tests += bool(stages)
            n_stages += len(stages)
            continue
        est = estimate(sess, cfg)
        if est is None:
            lines.append(f"{name}: too short for a steady window ({MIN_WINDOW_S // 60} min needed after the "
                         f"first {SKIP_S // 60}, with heart rate)")
            continue
        head = (f"{name}: steady {mmss(est['from_s'])}-{mmss(est['to_s'])}, {est['strokes']} strokes, "
                f"{est['watts']:.0f} W at {est['hr']:.0f} bpm")
        if est.get("spm"):
            head += f", {est['spm']:.1f} spm"
        if est.get("drag"):
            head += f", drag {est['drag']}"
        lines.append(head)
        if "error" in est:
            lines.append(f"   no estimate: {est['error']}")
            continue
        points.append(est)
        n_rows += 1
        lines.append(f"   watts at {cfg['zone_hr']:.0f} bpm: {est['watts_at_zone']:.0f}   "
                     f"VO2max ~{est['vo2max']:.0f} ml/kg/min ({est['watts_at_hrmax']:.0f} W at HRmax "
                     f"{cfg['hrmax']:.0f}, line through resting {cfg['hr_rest']:.0f})")
    fit = pooled(points, cfg)
    if fit and n_rows + n_tests > 1:   # one step test alone has already given its own line above
        what = " and ".join(x for x in (f"{n_rows} rows" if n_rows else "",
                                         f"{n_stages} stages of {n_tests} step test{'s' if n_tests > 1 else ''}" if n_tests else "") if x)
        lines.append(f"fit across {what} ({fit['watts_min']:.0f}-{fit['watts_max']:.0f} W): "
                     f"HR = {fit['a']:.0f} + {fit['b']:.2f} x W;  watts at {cfg['zone_hr']:.0f} bpm: "
                     f"{fit['watts_at_zone']:.0f};  VO2max ~{fit['vo2max']:.0f} ml/kg/min")
    elif not fit and len(points) > 1 and n_rows + n_tests > 1:
        lines.append(f"no fit across rows yet: it needs {POOL_MIN_ROWS} or more rows whose steady power spans "
                     f"{POOL_MIN_SPREAD_W} W, or a guided step test, which spans that on its own")
    for note in cfg["notes"]:
        lines.append(f"note: {note}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("sessions", nargs="+", type=Path, help="session files from pm5_logger (data/sessions/*.json)")
    a = ap.parse_args()
    load_env()
    cfg = settings()
    if cfg is None:
        raise SystemExit("set PM5_MASS_KG and PM5_HRMAX (or PM5_AGE) in .env or the environment; see pm5_vo2.py")
    sessions = [(p.stem, json.loads(p.read_text())) for p in sorted(a.sessions)]
    print(report(sessions, cfg))


if __name__ == "__main__":
    main()

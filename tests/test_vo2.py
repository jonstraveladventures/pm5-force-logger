"""Unit tests for the fixed-heart-rate watts and VO2max estimate (pm5_vo2.py). No real rows."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pm5_vo2 as V    # noqa: E402

CFG = {"mass_kg": 85.0, "hrmax": 190.0, "hr_rest": 50.0, "zone_hr": 145.0,
       "efficiency": V.DEFAULT_EFFICIENCY, "notes": []}


def row(minutes=20, watts=150, hr=140, spm=16, sprint_last=False, hr_lag=True):
    """A steady synthetic session: heart rate climbs to its plateau over the first 3 minutes."""
    strokes, t, n = [], 0.0, 0
    while t < minutes * 60:
        n += 1
        w = watts
        if sprint_last and t > minutes * 60 - 30:
            w = watts * 1.6
        h = hr if not hr_lag or t > 180 else 90 + (hr - 90) * t / 180
        strokes.append({"elapsed_s": round(t, 2), "power_w": w, "hr": round(h), "spm": spm, "stroke_count": n})
        t += 60 / spm
    return {"strokes": strokes, "summary": {"drag_factor_avg": 118}}


class WindowTests(unittest.TestCase):
    def test_skips_warm_up_and_finish_and_needs_heart_rate_and_power(self):
        sess = row(minutes=12, sprint_last=True)
        sess["strokes"][100]["hr"] = None          # a dropout
        sess["strokes"][101]["power_w"] = 0        # the PM5 sent no power for that stroke
        win = V.steady_window(sess["strokes"])
        self.assertGreaterEqual(min(s["elapsed_s"] for s in win), V.SKIP_S)
        self.assertLessEqual(max(s["elapsed_s"] for s in win), 12 * 60 - V.TAIL_S)
        self.assertTrue(all(s["hr"] and s["power_w"] for s in win))
        self.assertTrue(all(s["power_w"] == 150 for s in win), "sprint strokes and pauses are dropped")

    def test_sprints_and_pauses_inside_the_window_are_dropped(self):
        sess = row(minutes=12)
        sess["strokes"][120]["power_w"] = 400      # a burst
        sess["strokes"][121]["power_w"] = 20       # a paddle
        self.assertEqual({s["power_w"] for s in V.steady_window(sess["strokes"])}, {150})

    def test_short_row_gives_no_point(self):
        self.assertIsNone(V.row_point(row(minutes=6)))       # 6 min leaves under 4 min of window
        self.assertIsNone(V.row_point({"strokes": []}))
        self.assertIsNone(V.row_point({"strokes": [{"elapsed_s": 400, "power_w": 150, "hr": None}] * 100}))

    def test_point_carries_means_and_drag(self):
        p = V.row_point(row(minutes=20, watts=160, hr=142))
        self.assertAlmostEqual(p["watts"], 160)
        self.assertAlmostEqual(p["hr"], 142)
        self.assertEqual((p["spm"], p["drag"]), (16, 118))
        self.assertGreaterEqual(p["to_s"] - p["from_s"], V.MIN_WINDOW_S)


class ArithmeticTests(unittest.TestCase):
    def test_oxygen_cost_matches_the_concept2_fitness_rower_line(self):
        # 300 W for 85 kg: 4.4 l/min is what Concept2's calculator gives a fitness rower's 7:00 2k
        self.assertAlmostEqual(V.vo2(300, 85) * 85 / 1000, 4.40, places=1)
        self.assertAlmostEqual(V.vo2(0, 85), V.VO2_REST)

    def test_watts_at_a_heart_rate_lies_on_the_line_through_rest(self):
        self.assertAlmostEqual(V.watts_at(148, 150, 146, 42), 150 * (148 - 42) / (146 - 42))
        self.assertAlmostEqual(V.watts_at(146, 150, 146, 42), 150)    # the row's own heart rate

    def test_single_row_estimate(self):
        est = V.estimate(row(minutes=20, watts=150, hr=140), CFG)
        w_max = 150 * (190 - 50) / (140 - 50)
        self.assertAlmostEqual(est["watts_at_zone"], 150 * (145 - 50) / (140 - 50), places=6)
        self.assertAlmostEqual(est["watts_at_hrmax"], w_max, places=6)
        self.assertAlmostEqual(est["vo2max"], V.vo2(w_max, 85), places=6)

    def test_estimate_refuses_a_heart_rate_near_resting(self):
        est = V.estimate(row(minutes=20, watts=60, hr=60), CFG)
        self.assertIn("error", est)
        self.assertNotIn("vo2max", est)


class PooledTests(unittest.TestCase):
    def points(self, watts):
        return [{"watts": w, "hr": 60 + 0.5 * w} for w in watts]

    def test_fit_recovers_the_line_and_reads_off_both_numbers(self):
        fit = V.pooled(self.points([120, 160, 200]), CFG)
        self.assertAlmostEqual(fit["a"], 60)
        self.assertAlmostEqual(fit["b"], 0.5)
        self.assertAlmostEqual(fit["watts_at_zone"], (145 - 60) / 0.5)
        self.assertAlmostEqual(fit["watts_at_hrmax"], (190 - 60) / 0.5)
        self.assertAlmostEqual(fit["vo2max"], V.vo2((190 - 60) / 0.5, 85))

    def test_fit_needs_rows_spread_and_a_rising_slope(self):
        self.assertIsNone(V.fit_line(self.points([120, 200])))
        self.assertIsNone(V.fit_line(self.points([150, 160, 170])))
        falling = [{"watts": w, "hr": 200 - 0.5 * w} for w in (120, 160, 200)]
        self.assertIsNone(V.fit_line(falling))


class SettingsTests(unittest.TestCase):
    def test_missing_mass_or_hrmax_means_no_estimate(self):
        self.assertIsNone(V.settings({}))
        self.assertIsNone(V.settings({"PM5_MASS_KG": "80"}))
        self.assertIsNone(V.settings({"PM5_HRMAX": "185"}))

    def test_defaults_and_age_fallback(self):
        cfg = V.settings({"PM5_MASS_KG": "80", "PM5_AGE": "40"})
        self.assertEqual((cfg["hrmax"], cfg["hr_rest"], cfg["zone_hr"], cfg["efficiency"]),
                         (180, 60, 135, V.DEFAULT_EFFICIENCY))
        self.assertEqual(len(cfg["notes"]), 2)
        cfg = V.settings({"PM5_MASS_KG": "80", "PM5_HRMAX": "190", "PM5_HR_REST": "45", "PM5_ZONE_HR": "150",
                          "PM5_NET_EFFICIENCY": "0.23"})
        self.assertEqual((cfg["hrmax"], cfg["hr_rest"], cfg["zone_hr"], cfg["efficiency"]), (190, 45, 150, 0.23))
        self.assertEqual(cfg["notes"], [])

    def test_bad_values_are_named(self):
        with self.assertRaises(ValueError):
            V.settings({"PM5_MASS_KG": "eighty", "PM5_HRMAX": "190"})
        with self.assertRaises(ValueError):
            V.settings({"PM5_MASS_KG": "80", "PM5_HRMAX": "150", "PM5_HR_REST": "160"})


class ReportTests(unittest.TestCase):
    def test_report_has_a_line_per_row_and_a_fit_when_the_rows_allow_one(self):
        rows = [("a", row(watts=120, hr=120)), ("b", row(watts=160, hr=140)), ("c", row(watts=200, hr=160)),
                ("short", row(minutes=5))]
        text = V.report(rows, CFG)
        self.assertEqual(text.count("watts at 145 bpm"), 4)     # three rows and the fit
        self.assertIn("fit across 3 rows (120-200 W)", text)
        self.assertIn("short: too short", text)
        self.assertNotIn("note:", text)

    def test_report_without_enough_rows_says_why(self):
        text = V.report([("a", row(watts=120, hr=120)), ("b", row(watts=125, hr=122))], CFG)
        self.assertIn("no fit across rows yet", text)
        text = V.report([("a", row())], {**CFG, "notes": ["HRmax is 220 - age"]})
        self.assertIn("note: HRmax is 220 - age", text)


class StepTestTests(unittest.TestCase):
    """A guided step test holds its own spread in power, so one of them is enough for a fitted
    line, where steady rows at one power never are."""

    @staticmethod
    def step(stages):
        return {"strokes": row(watts=140, hr=130)["strokes"],
                "guided": {"kind": "step", "step": {"stages": [{"key": w, "watts": w, "hr": hr} for w, hr in stages]}}}

    def test_its_stages_are_the_points_not_its_strokes(self):
        sess = self.step([(110, 115), (130, 126), (150, 137), (170, 148)])
        self.assertEqual(V.step_points(sess), [{"watts": 110, "hr": 115}, {"watts": 130, "hr": 126},
                                               {"watts": 150, "hr": 137}, {"watts": 170, "hr": 148}])
        # the strokes underneath are an ordinary steady row; they must not be read as one
        self.assertNotIn("steady", V.report([("step", sess)], CFG))
        self.assertIsNone(V.step_points(row()))
        self.assertIsNone(V.step_points({"guided": {"kind": "rate"}}))

    def test_one_step_test_gives_the_line_steady_rows_cannot(self):
        steady = [(f"r{i}", row(watts=153, hr=147)) for i in range(4)]
        self.assertIn("no fit across rows yet", V.report(steady, CFG))
        sess = self.step([(110, 115), (130, 126), (150, 137), (170, 148)])
        alone = V.report([("step", sess)], CFG)
        # 11 bpm per 20 W through (110, 115): slope 0.55, and 145 bpm at (145 - 54.5) / 0.55 = 164.5 W
        self.assertIn("+ 0.55 x W", alone)
        self.assertIn("watts at 145 bpm: 165", alone)
        both = V.report(steady + [("step", sess)], CFG)
        self.assertIn("fit across 4 rows and 4 stages of 1 step test", both)

    def test_an_unfinished_step_test_says_so(self):
        text = V.report([("s", self.step([(110, 115), (130, 126)]))], CFG)
        self.assertIn("too few stages for a line of its own", text)
        self.assertNotIn("no fit across rows yet", text)
        self.assertIn("no stage finished", V.report([("s", self.step([]))], CFG))


if __name__ == "__main__":
    unittest.main()

"""The splits posted to the Logbook: rebuilt from the strokes at the PM5's own split size."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pm5_upload as U    # noqa: E402


def session(split_type, split_size, total_t, total_d, n=200, hr=140):
    strokes = [{"elapsed_s": total_t * k / n, "distance_m": total_d * k / n, "spm": 18, "hr": hr}
               for k in range(1, n + 1)]
    return {"summary": {"split_type": split_type, "split_size": split_size, "elapsed_s": total_t,
                        "distance_m": total_d, "workout_type": 1, "avg_stroke_rate": 18,
                        "received_at": 1.7e9}, "strokes": strokes}


class SplitTests(unittest.TestCase):
    def test_time_splits_add_up_to_the_piece(self):
        sp = U.build_splits(session(0, 300, 1626.4, 5988))
        self.assertEqual(len(sp), 6)
        self.assertEqual([x["time"] for x in sp[:5]], [3000] * 5)
        self.assertEqual(sum(x["time"] for x in sp), 16264)
        self.assertEqual(sum(x["distance"] for x in sp), 5988)

    def test_distance_splits(self):
        sp = U.build_splits(session(1, 1000, 1300.0, 5000))
        self.assertEqual([x["distance"] for x in sp], [1000] * 5)
        self.assertEqual(sum(x["time"] for x in sp), 13000)
        self.assertEqual(sp[0]["heart_rate"]["average"], 140)
        self.assertEqual(sp[0]["stroke_rate"], 18)

    def test_stroke_rate_is_the_median(self):
        s = session(0, 300, 600, 2400)
        for st in s["strokes"][-5:]:
            st["spm"] = 95                      # nudging the handle while resting
        self.assertEqual(U.build_splits(s)[-1]["stroke_rate"], 18)

    def test_no_split_info_means_no_splits(self):
        s = session(0, 300, 600, 2400)
        del s["summary"]["split_size"]
        self.assertEqual(U.build_splits(s), [])
        self.assertNotIn("workout", U.build_payload(s))

    def test_payload_carries_splits(self):
        p = U.build_payload(session(0, 300, 1626.4, 5988))
        self.assertEqual(len(p["workout"]["splits"]), 6)

    def test_rest_at_the_end_is_left_out(self):
        s = session(0, 300, 1500, 5700, n=380)
        for st in s["strokes"]:
            st["power_w"] = 155
        last = s["strokes"][-1]
        s["strokes"] += [{"elapsed_s": last["elapsed_s"] + k * 5, "distance_m": last["distance_m"] + k,
                          "spm": 90, "hr": 120, "power_w": 8} for k in range(1, 13)]
        s["summary"].update(elapsed_s=1562.4, distance_m=5712)
        trimmed, cut = U.trim_rest(s)
        self.assertAlmostEqual(cut, 62.4, places=1)
        self.assertEqual(trimmed["summary"]["distance_m"], 5700)
        p = U.build_payload(s)
        self.assertEqual((p["time"], p["distance"]), (15000, 5700))
        self.assertEqual(sum(x["time"] for x in p["workout"]["splits"]), 15000)
        self.assertIn("62 s of rest", p["comments"])

    def test_fixed_pieces_are_not_trimmed(self):
        s = session(1, 1000, 1300, 5000)
        s["summary"]["workout_type"] = 3
        self.assertEqual(U.trim_rest(s)[1], 0.0)


if __name__ == "__main__":
    unittest.main()

"""Unit tests for workout programming: CSAFE framing and the workout syntax.

The example frames are copied from Concept2's "PM CSAFE Communication Definition" rev 0.27,
"Proprietary CSAFE Workout Configuration". Two of the document's examples print a wrong
checksum (the fixed-time-interval one repeats the fixed-distance example's, and the terminate
example's differs from the XOR of its own bytes); those are checked against the XOR rule instead.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pm5_workouts as W    # noqa: E402


def hx(s: str) -> bytes:
    return bytes.fromhex(s.replace(" ", ""))


class FramingTests(unittest.TestCase):
    def test_stuffing_round_trip(self):
        raw = bytes([0x01, 0xF0, 0xF1, 0xF2, 0xF3, 0x7F])
        stuffed = W.stuff(raw)
        self.assertEqual(stuffed, bytes([0x01, 0xF3, 0x00, 0xF3, 0x01, 0xF3, 0x02, 0xF3, 0x03, 0x7F]))
        self.assertEqual(W.unstuff(stuffed), raw)

    def test_checksum_that_needs_stuffing(self):
        # contents chosen so the XOR checksum is 0xF2 (the stop flag): it must be stuffed
        contents = bytes([0x76, 0x84])
        self.assertEqual(W.checksum(contents), 0xF2)
        self.assertEqual(W.frame(contents), bytes([0xF1, 0x76, 0x84, 0xF3, 0x02, 0xF2]))

    def test_unframe_response(self):
        # the spec's response to the just-row example: status, wrapper echo, checksum
        status, body = W.unframe(hx("F1 81 76 02 01 13 E7 F2"))
        self.assertEqual(status, 0x81)
        self.assertEqual(body, hx("76 02 01 13"))
        self.assertEqual(W.describe_status(0x81), "ok, state ready")
        self.assertEqual(W.describe_status(0x15), "rejected, state in use")

    def test_unframe_rejects_bad_checksum(self):
        with self.assertRaises(ValueError):
            W.unframe(hx("F1 81 76 02 01 13 00 F2"))


class SpecExampleTests(unittest.TestCase):
    def check(self, spec, want):
        self.assertEqual(W.build(W.parse_spec(spec)).hex(" ").upper(), want)

    def test_fixed_distance_with_splits(self):
        self.check("2000m/400m", "F1 76 18 01 01 03 03 05 80 00 00 07 D0 05 05 80 00 00 01 90 14 01 01 13 02 01 01 28 F2")

    def test_fixed_time_with_splits(self):
        self.check("20:00/4:00", "F1 76 18 01 01 05 03 05 00 00 01 D4 C0 05 05 00 00 00 5D C0 14 01 01 13 02 01 01 E0 F2")

    def test_fixed_distance_interval(self):
        self.check("500m/0:30r", "F1 76 15 01 01 07 03 05 80 00 00 01 F4 04 02 00 1E 14 01 01 13 02 01 01 0A F2")

    def test_fixed_time_interval(self):
        # the document prints checksum 0A here (copied from the example above); XOR gives B0
        self.check("2:00/0:30r", "F1 76 15 01 01 06 03 05 00 00 00 2E E0 04 02 00 1E 14 01 01 13 02 01 01 B0 F2")

    def test_variable_intervals_with_target_pace(self):
        want = ("F1 76 6F 18 01 00 01 01 08 17 01 01 03 05 80 00 00 01 F4 04 02 00 3C 06 04 00 00 27 10 14 01 01 "
                "18 01 01 17 01 00 03 05 00 00 00 46 50 04 02 00 00 06 04 00 00 27 10 14 01 01 "
                "18 01 02 17 01 01 03 05 80 00 00 03 E8 04 02 00 00 06 04 00 00 27 10 14 01 01 "
                "18 01 03 17 01 00 03 05 00 00 00 75 30 04 02 00 78 06 04 00 00 27 10 14 01 01 13 02 01 01 09 F2")
        got = W.build(W.parse_spec("500m/1:00r,3:00/0:00r,1000m/0:00r,5:00/2:00r@1:40")).hex(" ").upper()
        self.assertEqual(got[:-5], want[:-5])                      # every byte but the checksum is the spec's
        self.assertEqual(W.checksum(W.unstuff(hx(want)[1:-2])), 0x09)   # the document prints C6

    def test_variable_intervals_undefined_rest(self):
        want = ("F1 76 45 18 01 00 01 01 08 17 01 04 03 05 80 00 00 00 64 04 02 00 00 06 04 00 00 32 C8 14 01 01 "
                "18 01 01 17 01 03 03 05 00 00 00 2E E0 04 02 00 00 06 04 00 00 32 C8 14 01 01 "
                "01 01 09 05 05 80 00 00 00 00 13 02 01 01 8F F2")
        got = W.build({"intervals": [{"distance_m": 100}, {"time_s": 120}], "pace_s": 130}).hex(" ").upper()
        self.assertEqual(got, want)

    def test_terminate(self):
        self.assertEqual(W.terminate_frame().hex(" ").upper(), "F1 76 04 13 02 01 02 60 F2")

    def test_just_row_with_splits(self):
        got = W.build(W.parse_spec("just_row"))
        self.assertEqual(got[:6], hx("F1 76 0E 01 01 01"))             # wrapper, JUSTROW_SPLITS
        self.assertIn(hx("05 05 80 00 00 01 F4"), got)                   # 500 m splits
        self.assertTrue(got.endswith(hx("13 02 01 01") + bytes([W.checksum(W.unstuff(got[1:-2])), 0xF2])))


class SyntaxTests(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(W.parse_amount("500m"), {"distance_m": 500})
        self.assertEqual(W.parse_amount("2.5km"), {"distance_m": 2500})
        self.assertEqual(W.parse_amount("4:00"), {"time_s": 240})
        self.assertEqual(W.parse_amount("1:00:00"), {"time_s": 3600})
        self.assertEqual(W.parse_amount("100cal"), {"calories": 100})
        with self.assertRaises(ValueError):
            W.parse_amount("fast")

    def test_default_splits(self):
        self.assertEqual(W.normalise({"distance_m": 5000})["split_m"], 1000)
        self.assertEqual(W.normalise({"distance_m": 2000})["split_m"], 400)
        self.assertEqual(W.normalise({"time_s": 1200})["split_s"], 240)
        self.assertEqual(W.normalise({"time_s": 300})["split_s"], 60)

    def test_repeats_and_lists(self):
        s = W.normalise(W.parse_spec("4x4:00/3:00r"))
        self.assertEqual(s["kind"], "variable")
        self.assertEqual(s["intervals"], [{"time_s": 240, "rest_s": 180}] * 4)
        s = W.normalise(W.parse_spec("8x500m/1:00r@1:45"))
        self.assertEqual(s["intervals"][0], {"distance_m": 500, "rest_s": 60, "pace_s": 105})
        s = W.normalise(W.parse_spec("4:00/3:00r,500m/1:00r"))
        self.assertEqual([iv.get("rest_s") for iv in s["intervals"]], [180, 60])
        s = W.normalise(W.parse_spec("6x1000m"))
        self.assertNotIn("rest_s", s["intervals"][0])          # rest until the rower starts again
        s = W.normalise(W.parse_spec("500m/0:30r"))
        self.assertEqual(s["kind"], "interval")                  # no count: repeats until stopped

    def test_limits_and_errors(self):
        with self.assertRaises(ValueError):
            W.normalise({"intervals": [{"time_s": 60, "rest_s": 30}], "repeat": 51})
        with self.assertRaises(ValueError):
            W.parse_spec("500m/1:00")                            # a split, but of a different kind
        # without the trailing r the second amount is a split, not a rest
        self.assertEqual(W.normalise(W.parse_spec("4:00/3:00")), {"kind": "time", "time_s": 240, "split_s": 180})

    def test_named_workouts_file_parses(self):
        named = W.load_named()
        self.assertIn("4x4", named)
        for name, spec in named.items():
            W.build(spec)      # every shipped workout must build

    def test_describe(self):
        self.assertEqual(W.describe(W.parse_spec("4x4:00/3:00r")), "4 x 4:00 / 3:00 rest")
        self.assertEqual(W.describe(W.parse_spec("5000m")), "5000 m, 1000 m splits")
        self.assertEqual(W.describe(W.parse_spec("just_row")), "Just Row, 500 m splits")


if __name__ == "__main__":
    unittest.main()

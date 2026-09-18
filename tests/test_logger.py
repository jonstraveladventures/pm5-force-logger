"""Unit tests for the PM5 decoding, session assembly and Logbook payload.

    python -m unittest discover -s tests -v

No Bluetooth or network: packets are built by hand from the spec layouts, and the synthetic
sample in examples/ is run through the same parser the logger uses live.
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pm5_logger as L    # noqa: E402
import pm5_upload as U    # noqa: E402


def le(v, n):
    return int(round(v)).to_bytes(n, "little")


def stroke_packet(n, elapsed_s, dist_m, recovery_s=0.0, peak=100.0, drive_m=1.40, drive_s=0.80):
    """0x0035: elapsed(3) distance(3) drive len(1) drive time(1) recovery(2) stroke dist(2)
    peak force(2) avg force(2) work(2) count(2), spec rev 1.30."""
    return (le(elapsed_s * 100, 3) + le(dist_m * 10, 3) + bytes([round(drive_m * 100), round(drive_s * 100)])
            + le(recovery_s * 100, 2) + le(950, 2) + le(peak * 10, 2) + le(peak * 5, 2) + le(4000, 2) + le(n, 2))


def curve_packets(points, per=9):
    chunks = [points[i:i + per] for i in range(0, len(points), per)]
    return [bytes([(len(chunks) << 4) | len(c), seq]) + b"".join(le(v, 2) for v in c) for seq, c in enumerate(chunks)]


class ParseTests(unittest.TestCase):
    def test_stroke_data_layout_and_units(self):
        b = (le(12345, 3) + le(4567, 3) + bytes([142, 85]) + le(210, 2) + le(987, 2) + le(2105, 2)
             + le(1203, 2) + le(6502, 2) + le(42, 2))
        p = L.parse(0x0035, b)
        self.assertEqual(p, {"elapsed_s": 123.45, "distance_m": 456.7, "drive_length_m": 1.42,
                             "drive_time_s": 0.85, "recovery_time_s": 2.1, "stroke_distance_m": 9.87,
                             "peak_force_lbf": 210.5, "avg_force_lbf": 120.3, "work_j": 650.2, "stroke_count": 42})

    def test_general_status_layout(self):
        b = le(2700, 3) + le(1234, 3) + bytes([1, 255, 1, 1, 2]) + le(0, 3) + le(0, 3) + bytes([0x80, 116])
        p = L.parse(0x0031, b)
        self.assertEqual((p["elapsed_s"], p["distance_m"], p["workout_type"], p["workout_state"], p["drag_factor"]),
                         (27.0, 123.4, 1, "workout_row", 116))
        self.assertEqual((p["piece_type"], p["piece_length"]), ("distance", 0))

    def test_general_status_reports_the_programmed_piece(self):
        # a 30:00 piece, as 2026-09-18's row reported it: 180000 in 0.01 s, type 0 (time)
        b = le(2700, 3) + le(1234, 3) + bytes([5, 0, 1, 1, 2]) + le(0, 3) + le(180000, 3) + bytes([0x00, 113])
        p = L.parse(0x0031, b)
        self.assertEqual((p["piece_type"], p["piece_length"], p["drag_factor"]), ("time", 1800.0, 113))
        b = le(0, 3) + le(0, 3) + bytes([3, 0, 0, 1, 1]) + le(0, 3) + le(5000, 3) + bytes([0x80, 116])
        self.assertEqual((L.parse(0x0031, b)["piece_type"], L.parse(0x0031, b)["piece_length"]), ("distance", 5000))

    def test_additional_status_reads_hr_pace_and_rate(self):
        b = le(1000, 3) + le(3850, 2) + bytes([24, 150]) + le(12990, 2) + le(13120, 2) + le(0, 2) + le(0, 3) + bytes([0])
        p = L.parse(0x0032, b)
        self.assertEqual((p["speed_ms"], p["stroke_rate"], p["hr"], p["pace_s"], p["avg_pace_s"]),
                         (3.85, 24, 150, 129.9, 131.2))
        b = b[:6] + bytes([255]) + b[7:]
        self.assertIsNone(L.parse(0x0032, b)["hr"], "255 means no heart-rate source")

    def test_end_of_workout_summary_layout(self):
        b = (le(0, 2) + le(0, 2) + le(131930, 3) + le(50090, 3)
             + bytes([22, 155, 142, 67, 162, 115, 0, 0]) + le(1300, 2))
        p = L.parse(0x0039, b)
        self.assertEqual((p["elapsed_s"], p["distance_m"], p["avg_stroke_rate"], p["ending_hr"], p["avg_hr"],
                          p["min_hr"], p["max_hr"], p["drag_factor_avg"], p["workout_type"], p["avg_pace_s"]),
                         (1319.3, 5009.0, 22, 155, 142, 67, 162, 115, 0, 130.0))

    def test_truncated_packets_are_ignored(self):
        for short, n in ((0x31, 18), (0x32, 15), (0x33, 13), (0x35, 19), (0x36, 8), (0x39, 19), (0x3A, 11)):
            self.assertIsNone(L.parse(short, bytes(n)), f"0x{short:04x} with {n} bytes")

    def test_unknown_characteristic_is_ignored(self):
        self.assertIsNone(L.parse(0x0080, bytes(19)))   # the multiplexed characteristic, which the logger leaves raw


class DocumentedInRev036Tests(unittest.TestCase):
    """Characteristics documented in revision 0.36 of Concept2's CSAFE definition (August 2026),
    checked against packets a PM5 sent on 2026-09-18."""
    SPLIT = bytes.fromhex("3675002a2c00b80b006a0400000000000001")
    SPLIT_AVGS = bytes.fromhex("367500107c002f0545002e03b60e9600750100")

    def test_split_and_its_averages_merge_by_split_number(self):
        s = L.Session()
        s.feed(300.1, 0x0037, self.SPLIT)
        s.feed(300.2, 0x0038, self.SPLIT_AVGS)
        (sp,) = s.result({})["splits"]
        self.assertEqual((sp["split_number"], sp["split_time_s"], sp["split_distance_m"]), (1, 300.0, 1130))
        self.assertEqual((sp["split_spm"], sp["split_hr"], sp["split_power_w"], sp["split_drag"]), (16, 124, 150, 117))
        self.assertAlmostEqual(sp["split_pace_s"], 132.7)

    def test_additional_status_3_carries_the_battery(self):
        p = L.parse(0x003E, bytes([2, 0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 78] + [0] * 6))
        self.assertEqual((p["op_state"], p["screen"], p["battery_pct"]), (2, 259, 78))
        s = L.Session(); s.feed(1.0, 0x003E, bytes([2, 0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 78] + [0] * 6))
        self.assertEqual(s.status["battery_pct"], 78)

    def test_heart_rate_belt_id_is_32_bits_little_endian(self):
        self.assertEqual(L.parse(0x003B, bytes([1, 120, 0x78, 0x56, 0x34, 0x12])), {"hrm_mfg": 1, "hrm_type": 120, "hrm_id": 0x12345678})


class ForceCurveTests(unittest.TestCase):
    def test_reassembles_a_curve_across_packets(self):
        pts = list(range(10, 230, 10))
        fc, out = L.ForceCurve(), None
        for pk in curve_packets(pts):
            out = fc.add(pk) or out
        self.assertEqual(out, pts)

    def test_ignores_a_curve_joined_mid_stream(self):
        fc = L.ForceCurve()
        pk1, pk2 = curve_packets(list(range(1, 15)))
        self.assertIsNone(fc.add(pk2), "a packet with sequence 1 and no sequence 0 before it")
        self.assertIsNone(fc.add(pk1))                # the next curve starts cleanly
        self.assertEqual(fc.add(pk2), list(range(1, 15)))

    def test_a_new_sequence_zero_restarts(self):
        fc = L.ForceCurve()
        pk1, _ = curve_packets(list(range(1, 15)))
        fc.add(pk1)
        pk1b, pk2b = curve_packets(list(range(21, 35)))
        self.assertIsNone(fc.add(pk1b))
        self.assertEqual(fc.add(pk2b), list(range(21, 35)))

    def test_malformed_headers_do_not_crash(self):
        fc = L.ForceCurve()
        self.assertFalse(fc.add(bytes([0x00, 0x00])))
        self.assertIsNone(fc.add(b"\x11"))


class SessionTests(unittest.TestCase):
    def test_two_copies_become_one_record_with_the_right_recovery(self):
        s = L.Session()
        s.feed(10.0, 0x0035, stroke_packet(1, 1.2, 2.1, recovery_s=0.0))       # end of drive
        s.feed(11.0, 0x0035, stroke_packet(1, 1.9, 3.7, recovery_s=0.6))       # end of recovery
        s.feed(12.0, 0x0035, stroke_packet(2, 2.8, 5.9, recovery_s=0.6))       # carries stroke 1's recovery
        strokes = s.result({})["strokes"]
        self.assertEqual([x["stroke_count"] for x in strokes], [1, 2])
        self.assertEqual(strokes[0]["recovery_time_s"], 0.6)
        self.assertIsNone(strokes[1]["recovery_time_s"], "stroke 2's recovery has not ended yet")

    def test_count_zero_is_dropped(self):
        s = L.Session()
        s.feed(1.0, 0x0035, stroke_packet(0, 0, 0))
        s.feed(2.0, 0x0035, stroke_packet(1, 1.2, 2.1))
        s.feed(60.0, 0x0035, stroke_packet(0, 0, 0))
        self.assertEqual(len(s.result({})["strokes"]), 1)

    def test_curves_attach_to_the_stroke_they_arrived_with(self):
        s = L.Session()
        s.feed(10.0, 0x0035, stroke_packet(1, 1.2, 2.1, peak=64))
        for pk in curve_packets([0, 0, 59, 63, 64, 61, 40, 0]):
            s.feed(10.01, 0x003D, pk)
        for pk in curve_packets([59, 63, 64, 61, 40]):
            s.feed(10.05, 0x0043, pk)
        st = s.result({})["strokes"][0]
        self.assertEqual(max(st["force_curve"]), st["peak_force_lbf"])
        self.assertEqual(st["force_curve_v2"], [59, 63, 64, 61, 40])

    def test_a_curve_arriving_before_its_stroke_still_attaches(self):
        s = L.Session()
        for pk in curve_packets([10, 50, 90, 50, 10]):
            s.feed(9.9, 0x003D, pk)
        s.feed(10.0, 0x0035, stroke_packet(1, 1.2, 2.1, peak=90))
        r = s.result({})
        self.assertEqual(r["strokes"][0]["force_curve"], [10, 50, 90, 50, 10])
        self.assertEqual(r["unmatched_curves"], [])

    def test_status_values_ride_along_on_each_stroke(self):
        s = L.Session()
        b = le(1000, 3) + le(3850, 2) + bytes([24, 150]) + le(12990, 2) + le(13120, 2) + le(0, 2) + le(0, 3) + bytes([0])
        s.feed(9.5, 0x0032, b)
        s.feed(10.0, 0x0035, stroke_packet(1, 1.2, 2.1))
        s.feed(10.0, 0x0036, le(120, 3) + le(163, 2) + le(950, 2) + le(1, 2) + le(0, 3) + le(0, 3))
        st = s.result({})["strokes"][0]
        self.assertEqual((st["hr"], st["spm"], st["pace_s"], st["power_w"]), (150, 24, 129.9, 163))

    def test_a_pause_is_not_mistaken_for_a_new_piece(self):
        s = L.Session()
        s.feed(10.0, 0x0035, stroke_packet(1, 1.2, 2.1))
        s.feed(11.0, 0x0035, stroke_packet(1, 1.9, 3.7, recovery_s=0.6))
        s.feed(12.0, 0x0035, stroke_packet(2, 2.8, 5.9, recovery_s=0.6))
        s.feed(75.0, 0x0035, stroke_packet(2, 65.0, 7.0, recovery_s=62.0))   # the rower stopped for a minute
        s.feed(76.0, 0x0035, stroke_packet(3, 66.0, 9.0, recovery_s=62.0))
        r = s.result({})
        self.assertFalse(r["new_piece_started"])
        self.assertEqual([x["stroke_count"] for x in r["strokes"]], [1, 2, 3])
        self.assertEqual(r["strokes"][1]["recovery_time_s"], 62.0)

    def test_a_second_piece_is_detected_and_kept_out(self):
        s = L.Session()
        for n in range(1, 6):
            s.feed(10.0 + n, 0x0035, stroke_packet(n, n * 1.0, n * 2.0))
        s.feed(100.0, 0x0035, stroke_packet(1, 1.2, 2.1))       # counts restart: a new piece
        s.feed(101.0, 0x0035, stroke_packet(2, 2.4, 4.2))
        r = s.result({})
        self.assertTrue(r["new_piece_started"])
        self.assertEqual([x["stroke_count"] for x in r["strokes"]], [1, 2, 3, 4, 5])
        self.assertEqual(r["strokes"][0]["distance_m"], 2.0, "the first piece's stroke 1 is untouched")

    def test_summary_sets_end_time_once(self):
        s = L.Session()
        b = (le(0, 2) + le(0, 2) + le(131930, 3) + le(50090, 3) + bytes([22, 155, 142, 67, 162, 115, 0, 0]) + le(1300, 2))
        s.feed(500.0, 0x0039, b)
        s.feed(560.0, 0x0039, b[:16] + bytes([95]) + b[17:])   # re-sent with recovery HR
        self.assertEqual(s.end_at, 500.0)
        self.assertEqual(s.summary["recovery_hr"], 95)
        self.assertEqual(s.summary["received_at"], 500.0)


class SampleRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        meta, events = L.read_raw(ROOT / "examples" / "sample_row.jsonl")
        cls.session = L.Session()
        for t, short, b in events:
            cls.session.feed(t, short, b)
        cls.result = cls.session.result(meta)

    def test_every_stroke_has_both_curves_and_matching_peaks(self):
        strokes = self.result["strokes"]
        self.assertEqual(len(strokes), 66)
        self.assertEqual(self.result["unmatched_curves"], [])
        for st in strokes:
            self.assertIn("force_curve", st)
            self.assertIn("force_curve_v2", st)
            self.assertAlmostEqual(max(st["force_curve_v2"]), st["peak_force_lbf"], delta=0.5)
        self.assertTrue(all(st["recovery_time_s"] for st in strokes[:-1]))

    def test_logbook_payload_has_the_right_units(self):
        p = U.build_payload(self.result)
        self.assertEqual(p["type"], "rower")
        self.assertEqual(p["distance"], round(self.result["summary"]["distance_m"]))
        self.assertEqual(p["time"], round(self.result["summary"]["elapsed_s"] * 10))
        self.assertRegex(p["date"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
        self.assertTrue(p["timezone"])
        self.assertEqual(len(p["stroke_data"]), 66)
        first = p["stroke_data"][0]
        self.assertEqual(first["t"], round(self.result["strokes"][0]["elapsed_s"] * 10))
        self.assertEqual(first["d"], round(self.result["strokes"][0]["distance_m"] * 10))
        self.assertIn("p", first)
        self.assertEqual(p["workout_type"], "JustRow")
        self.assertIn(p["weight_class"], ("H", "L"))

    def test_unfinished_piece_cannot_be_posted(self):
        with self.assertRaises(ValueError):
            U.build_payload({"summary": {}, "strokes": self.result["strokes"]})


if __name__ == "__main__":
    unittest.main()

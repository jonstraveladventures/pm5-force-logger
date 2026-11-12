"""What the logger writes survives a crash, a guided report sent after the row is saved still
reaches the session file, and nothing waits forever on the network or the browser."""
import asyncio
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pm5_logger as L    # noqa: E402


class SessionFiles(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "2026-09-18_171111.json"

    def test_a_failed_write_leaves_the_old_file(self):
        L.write_json(self.path, {"started": "old"})
        with mock.patch("json.dump", side_effect=OSError("disk full")), self.assertRaises(OSError):
            L.write_json(self.path, {"started": "new"})
        self.assertEqual(json.loads(self.path.read_text()), {"started": "old"})
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [self.path.name], "no temporary file left behind")

    def test_a_cut_short_session_file_is_written_afresh(self):
        self.path.write_text('{"started": "2026-09-18_171111", "strokes": [')
        with mock.patch("builtins.print"):
            L.save(self.path, {"started": "2026-09-18_171111", "strokes": []})
        self.assertEqual(json.loads(self.path.read_text())["strokes"], [])


class GuidedAfterTheRow(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.sess = self.dir / "row.json"
        self.raw = (self.dir / "row.jsonl").open("a", buffering=1, encoding="utf-8")

    def tearDown(self):
        self.raw.close()

    def run_async(self, coro):
        return asyncio.run(coro)

    def test_readiness_feel_reaches_the_saved_file(self):
        async def go():
            meta = {}
            g = L.GuidedReports(meta, self.raw, self.sess)
            report = {"kind": "rate", "readiness": {"adj_hr": 120, "rpe": None, "soreness": None, "note": None}}
            g.take(report)                                   # the session ends on the page, mid-row
            self.raw.close()
            L.write_json(self.sess, {"started": "row", "guided": meta["guided"]})
            stop = asyncio.Event()
            self.assertTrue(g.waiting_for_feel(stop), "a readiness check with no answer yet is waited for")
            answered = {**report, "readiness": {**report["readiness"], "rpe": 3, "soreness": "none"}}
            asyncio.get_running_loop().call_later(0.05, g.take, answered)   # the rower answers on the page
            self.assertTrue(await g.wait_for_feel(stop, timeout_s=5))
            return json.loads(self.sess.read_text())
        saved = self.run_async(go())
        self.assertEqual(saved["guided"]["readiness"]["rpe"], 3)
        raw = [json.loads(l) for l in (self.dir / "row.jsonl").read_text().splitlines()]
        self.assertEqual(len(raw), 1, "the report sent while recording went into the raw log")

    def test_no_wait_without_a_readiness_check_and_none_after_ctrl_c(self):
        async def go():
            g = L.GuidedReports({}, self.raw, self.sess)
            stop = asyncio.Event()
            self.assertFalse(g.waiting_for_feel(stop), "no guided session")
            g.take({"kind": "rate"})
            self.assertFalse(g.waiting_for_feel(stop), "a session without a readiness check")
            g.take({"kind": "rate", "readiness": {"rpe": None}})
            self.assertTrue(g.waiting_for_feel(stop))
            asyncio.get_running_loop().call_later(0.05, stop.set)    # Ctrl+C
            self.assertFalse(await g.wait_for_feel(stop, timeout_s=5))
            self.assertFalse(g.waiting_for_feel(stop))
            stop.clear()
            self.assertFalse(await g.wait_for_feel(stop, timeout_s=0.05), "and it gives up when the time is up")
        self.run_async(go())


class NothingWaitsForever(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault("CONCEPT2_CLIENT_ID", "test")
        os.environ.setdefault("CONCEPT2_CLIENT_SECRET", "test")
        import concept2
        self.c2 = concept2

    def test_concept2_requests_have_a_timeout(self):
        seen = []

        class Reply:
            status = 200
            def read(self): return b'{"access_token": "a", "refresh_token": "r"}'
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def urlopen(req, timeout=None):
            seen.append(timeout)
            return Reply()
        with mock.patch.dict(os.environ, {"CONCEPT2_REFRESH_TOKEN": "r"}), mock.patch("urllib.request.urlopen", urlopen):
            self.c2._request("GET", "/users/me")
        self.assertEqual(len(seen), 2, "the token exchange and the request")
        self.assertTrue(all(t == self.c2.NET_TIMEOUT_S for t in seen), seen)

    def test_sign_in_gives_up_when_the_browser_never_comes_back(self):
        with socket.socket() as s:
            s.bind(("localhost", 0))
            port = s.getsockname()[1]
        with mock.patch.object(self.c2, "REDIRECT", f"http://localhost:{port}"), mock.patch.object(self.c2, "AUTH_WAIT_S", 0.2), \
                mock.patch("webbrowser.open"), mock.patch("builtins.print"), self.assertRaises(SystemExit):
            self.c2.auth()


if __name__ == "__main__":
    unittest.main()

"""The dashboard's JSON API on the logger's HTTP server: GET /workouts and POST /program.
No Bluetooth: the programmer is a stub, as it is during a replay (where it is absent)."""
import asyncio
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pm5_logger as L    # noqa: E402


async def http(port, method, path, body=None):
    r, w = await asyncio.open_connection("127.0.0.1", port)
    data = json.dumps(body).encode() if body is not None else b""
    w.write(f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
    await w.drain()
    head = await r.readuntil(b"\r\n\r\n")
    status = int(head.split()[1])
    length = int(re.search(rb"Content-Length: (\d+)", head).group(1))
    payload = await r.readexactly(length)
    w.close()
    return status, payload


async def raw(port, request: bytes):
    """Send a request written out by hand, for the headers the helper above cannot produce."""
    r, w = await asyncio.open_connection("127.0.0.1", port)
    w.write(request)
    await w.drain()
    head = await r.readuntil(b"\r\n\r\n")
    w.close()
    return int(head.split()[1])


class HubApiTests(unittest.TestCase):
    def test_workouts_and_program(self):
        async def run():
            hub = L.Hub()
            server = await asyncio.start_server(hub.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                s, body = await http(port, "GET", "/workouts")
                self.assertEqual(s, 200)
                names = [w["name"] for w in json.loads(body)["workouts"]]
                self.assertIn("4x4", names)

                s, body = await http(port, "POST", "/program", {"spec": "4x4"})
                self.assertEqual(s, 503)                      # no PM5: a replay, or not connected yet
                self.assertIn("no PM5", json.loads(body)["error"])

                calls = []

                async def fake(spec):
                    calls.append(spec)
                    if spec == "bad":
                        raise ValueError("not a workout")
                    if spec == "busy":
                        raise RuntimeError("the PM5 did not accept the workout")
                    return f"programmed {spec}"
                hub.programmer = fake

                s, body = await http(port, "POST", "/program", {"spec": "4x4"})
                self.assertEqual((s, json.loads(body)), (200, {"ok": True, "workout": "programmed 4x4"}))
                s, body = await http(port, "POST", "/program", {"terminate": True})
                self.assertEqual((s, json.loads(body)["workout"], calls[-1]), (200, None, None))
                s, body = await http(port, "POST", "/program", {"spec": "bad"})
                self.assertEqual(s, 400)
                s, body = await http(port, "POST", "/program", {"spec": "busy"})
                self.assertEqual(s, 502)
                s, body = await http(port, "POST", "/program")
                self.assertEqual(s, 400)                      # empty body is not JSON with a spec... it is {}: no spec
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())

    def test_index_and_404(self):
        async def run():
            hub = L.Hub()
            server = await asyncio.start_server(hub.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                await w.drain()
                head = await r.readuntil(b"\r\n\r\n")
                self.assertTrue(head.startswith(b"HTTP/1.1 200"))
                w.close()
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(b"GET /nothing HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                await w.drain()
                head = await r.readuntil(b"\r\n\r\n")
                self.assertTrue(head.startswith(b"HTTP/1.1 404"))
                w.close()
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())

    def test_serves_the_web_page_and_nothing_else(self):
        """The dashboard is web/, the browser version: its top-level files are served with types a
        module script will load, and no path reaches the rest of the repository."""
        async def get(port, path):
            r, w = await asyncio.open_connection("127.0.0.1", port)
            w.write(b"GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n" % path)
            await w.drain()
            head = await r.readuntil(b"\r\n\r\n")
            w.close()
            ctype = re.search(rb"Content-Type: ([^\r;]+)", head)
            return int(head.split()[1]), ctype and ctype.group(1).decode()

        async def run():
            hub = L.Hub(replay="2026-09-22_164718")
            server = await asyncio.start_server(hub.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                self.assertEqual(await get(port, b"/"), (200, "text/html"))
                self.assertEqual(await get(port, b"/?fresh=1"), (200, "text/html"))
                self.assertEqual(await get(port, b"/app.js"), (200, "text/javascript"))
                self.assertEqual(await get(port, b"/logger-feed.js"), (200, "text/javascript"))
                self.assertEqual(await get(port, b"/workouts.json"), (200, "application/json"))
                for path in (b"/../pm5_logger.py", b"/%2e%2e/pm5_logger.py", b"/pm5_logger.py", b"/tests/fit.test.js",
                             b"/examples/sample_row.jsonl", b"/.git", b"/package.json/", b"//etc/passwd"):
                    self.assertEqual((await get(port, path))[0], 404, path)
                s, page = await http(port, "GET", "/")
                self.assertIn(b'<meta name="pm5-logger" content="{&quot;replay&quot;: &quot;2026-09-22_164718&quot;}">', page)
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())


class GuidedTests(unittest.TestCase):
    """A guided session run on the dashboard keeps its report with the row the logger records,
    as the browser version does; the readiness check reads earlier reports back."""

    def test_report_goes_to_the_row_and_comes_back(self):
        import tempfile
        report = {"kind": "step", "step": {"balanced": True, "stages": [{"w": 110, "hr": 120}]}}

        async def run(out):
            hub = L.Hub()
            server = await asyncio.start_server(hub.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                s, body = await http(port, "POST", "/guided", {"guided": report})
                self.assertEqual(s, 503)                  # nothing recording: a replay, or the row is over
                kept = []
                hub.take_guided = kept.append
                self.assertEqual((await http(port, "POST", "/guided", {"nothing": 1}))[0], 400)
                s, body = await http(port, "POST", "/guided", {"guided": report})
                self.assertEqual((s, kept), (200, [report]))
                (out / "sessions").mkdir()
                (out / "sessions" / "2026-09-20_080000.json").write_text(json.dumps({"strokes": []}))
                (out / "sessions" / "2026-09-21_080000.json").write_text(json.dumps({"guided": report}))
                (out / "sessions" / "2026-09-22_080000.json").write_text("not json")
                s, body = await http(port, "GET", "/guided")
                self.assertEqual(json.loads(body), {"sessions": [{"started": "2026-09-21_080000", "guided": report}]})
            finally:
                server.close()
                await server.wait_closed()

        with tempfile.TemporaryDirectory() as d:
            old, L.OUT = L.OUT, Path(d)
            try:
                asyncio.run(run(Path(d)))
                raw = Path(d) / "row.jsonl"
                raw.write_text(json.dumps({"t": 1, "device": {"name": "PM5"}}) + "\n" + json.dumps({"t": 2, "guided": report}) + "\n")
                self.assertEqual(L.read_raw(raw)[0]["guided"], report)   # so --reparse keeps it
            finally:
                L.OUT = old


class ContentLengthTests(unittest.TestCase):
    """A Content-Length the server will not honour is answered, not read. Without this the
    handler waits in readexactly for a body that is never sent."""

    def test_header_is_read_defensively(self):
        self.assertEqual(L.content_length(b"Content-Length: 12\r\n"), 12)
        self.assertEqual(L.content_length(b"content-length:0\r\n"), 0)
        self.assertEqual(L.content_length(b"Content-Length: %d\r\n" % L.MAX_BODY_BYTES), L.MAX_BODY_BYTES)
        for bad in (b"Content-Length: %d\r\n" % (L.MAX_BODY_BYTES + 1), b"Content-Length: -5\r\n",
                    b"Content-Length: 99999999999\r\n", b"Content-Length: twelve\r\n",
                    b"Content-Length:\r\n", b"Content-Length"):
            self.assertIsNone(L.content_length(bad), bad)

    def test_the_server_answers_rather_than_waits(self):
        async def run():
            hub = L.Hub()
            server = await asyncio.start_server(hub.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                for header in (b"Content-Length: 99999999999", b"Content-Length: -5", b"Content-Length: twelve"):
                    request = b"POST /program HTTP/1.1\r\nHost: 127.0.0.1\r\n" + header + b"\r\n\r\n"
                    status = await asyncio.wait_for(raw(port, request), 2)
                    self.assertEqual(status, 400, header)
                # a body within the limit still goes through
                s, body = await http(port, "POST", "/program", {"spec": "4x4"})
                self.assertEqual(s, 503)                      # no PM5, which means the body was read
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())


class OriginTests(unittest.TestCase):
    """Only pages on this machine may use the API. Any website open in the browser can send a
    plain-text POST to localhost without asking first; without this check it could stop or
    change the workout on the PM5."""

    def test_which_requests_count_as_local(self):
        ok = L.from_this_machine
        self.assertTrue(ok(b" 127.0.0.1:8750\r\n", None))
        self.assertTrue(ok(b" localhost:8750\r\n", b" http://localhost:8750\r\n"))
        self.assertTrue(ok(b" [::1]:8750\r\n", b" http://127.0.0.1:8750\r\n"))
        self.assertTrue(ok(b" LOCALHOST:8750\r\n", None), "host names are not case-sensitive")
        self.assertFalse(ok(None, None), "HTTP/1.1 requires a Host")
        self.assertFalse(ok(b" evil.example:8750\r\n", None), "DNS rebinding: an outside name pointed at us")
        self.assertFalse(ok(b" localhost.evil.example\r\n", None))
        self.assertFalse(ok(b" 127.0.0.1:8750\r\n", b" https://evil.example\r\n"), "a page on another site")
        self.assertFalse(ok(b" 127.0.0.1:8750\r\n", b" null\r\n"), "a sandboxed frame or a file")
        self.assertFalse(ok(b" 127.0.0.1:8750\r\n", b" http://localhost.evil.example\r\n"))
        # another page on this machine is not the dashboard: the port and scheme must match too
        self.assertFalse(ok(b" localhost:8750\r\n", b" http://localhost:9999\r\n"), "a page on another local port")
        self.assertFalse(ok(b" localhost:8750\r\n", b" https://localhost:8750\r\n"), "the dashboard is plain http")
        self.assertFalse(ok(b" localhost:8750\r\n", b" http://localhost\r\n"), "port 80 is not 8750")
        self.assertFalse(ok(b" localhost:8750\r\n", b" http://localhost:bad\r\n"))
        self.assertTrue(ok(b" localhost\r\n", b" http://127.0.0.1\r\n"), "both on port 80")

    def test_a_stalled_request_is_dropped(self):
        """A request whose headers never finish is closed after HEAD_TIMEOUT_S, not held open."""
        async def run():
            old, L.HEAD_TIMEOUT_S = L.HEAD_TIMEOUT_S, 0.2
            server = await asyncio.start_server(L.Hub().handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(b"POST /program HTTP/1.1\r\nHost: 127.0.0.1\r\n")   # and never the blank line
                await w.drain()
                self.assertEqual(await asyncio.wait_for(r.read(), 2), b"")    # the server hung up
                w.close()
            finally:
                L.HEAD_TIMEOUT_S = old
                server.close()
                await server.wait_closed()
        asyncio.run(run())

    def test_a_foreign_page_cannot_stop_the_workout(self):
        async def run():
            hub = L.Hub()
            calls = []

            async def fake(spec):
                calls.append(spec)
                return "done"
            hub.programmer = fake
            server = await asyncio.start_server(hub.handle, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                body = b'{"terminate": true}'
                # what another site's page sends: text/plain, so the browser does not ask first
                attack = (b"POST /program HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nOrigin: https://evil.example\r\n"
                          b"Content-Type: text/plain\r\nContent-Length: %d\r\n\r\n" % (port, len(body)) + body)
                self.assertEqual(await asyncio.wait_for(raw(port, attack), 2), 403)
                rebound = (b"GET /events HTTP/1.1\r\nHost: evil.example:%d\r\n\r\n" % port)
                self.assertEqual(await asyncio.wait_for(raw(port, rebound), 2), 403)
                self.assertEqual(calls, [], "the PM5 was never told anything")
                # the dashboard's own request still works
                own = (b"POST /program HTTP/1.1\r\nHost: localhost:%d\r\nOrigin: http://localhost:%d\r\n"
                       b"Content-Type: application/json\r\nContent-Length: %d\r\n\r\n" % (port, port, len(body)) + body)
                self.assertEqual(await asyncio.wait_for(raw(port, own), 2), 200)
                self.assertEqual(calls, [None])
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

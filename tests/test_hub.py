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
    w.write(f"{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
    await w.drain()
    head = await r.readuntil(b"\r\n\r\n")
    status = int(head.split()[1])
    length = int(re.search(rb"Content-Length: (\d+)", head).group(1))
    payload = await r.readexactly(length)
    w.close()
    return status, payload


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
                w.write(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
                await w.drain()
                head = await r.readuntil(b"\r\n\r\n")
                self.assertTrue(head.startswith(b"HTTP/1.1 200"))
                w.close()
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(b"GET /nothing HTTP/1.1\r\nHost: x\r\n\r\n")
                await w.drain()
                head = await r.readuntil(b"\r\n\r\n")
                self.assertTrue(head.startswith(b"HTTP/1.1 404"))
                w.close()
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

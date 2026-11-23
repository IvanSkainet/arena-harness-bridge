"""Offline HTTP-to-DSH acceptance test using the extension's public wire protocol."""
import base64
import json
import random
import secrets
import struct
import tempfile
import threading
import time
import unittest
import zlib
from http.client import HTTPConnection
from pathlib import Path
from uuid import uuid4

from arena_terminal.harness import Harness, ToolLoop
from arena_terminal.journal import Journal
from arena_terminal.transport import Endpoint, ExtensionHandler


def project_png():
    """Create an image whose actual transfer is larger than a 64 KiB RPC line."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rng = random.Random(721)
    rows = b"".join(b"\0" + rng.randbytes(192 * 3) for _ in range(128))
    header = struct.pack(">IIBBBBB", 192, 128, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


class HttpHarnessSession(unittest.TestCase):
    origin = "chrome-extension://" + "a" * 32

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        self.root = directory / "project"
        self.root.mkdir()
        self.file = self.root / "sample.txt"
        self.file.write_bytes(b"before\n")
        self.image = project_png()
        (self.root / "capture.png").write_bytes(self.image)
        self.marker = "local-fixture-" + uuid4().hex
        (self.root / "project.test.mjs").write_text(
            "import test from 'node:test'\nimport assert from 'node:assert/strict'\n"
            "import {readFileSync} from 'node:fs'\n"
            f"test('{self.marker}', () => assert.equal(readFileSync('sample.txt','utf8'), 'after\\n'))\n",
            encoding="utf-8",
        )
        for name, restriction in [("only-user", "disable-model-invocation: true"), ("only-model", "user-invocable: false")]:
            path = self.root / ".agents" / "skills" / name / "SKILL.md"
            path.parent.mkdir(parents=True)
            path.write_text(f"---\nname: {name}\ndescription: Local test skill\n{restriction}\n---\n{self.marker}-{name}\n", encoding="utf-8")

        self.db = Journal(directory / "journal.sqlite", self.root)
        self.addCleanup(self.db.close)
        self.adapter = Harness(self.root)
        self.addCleanup(self.adapter.close)
        self.loop = ToolLoop(self.db, self.adapter)
        self.loop.thread.start()
        self.addCleanup(self.stop_tools)
        self.auth = "Bearer " + secrets.token_urlsafe(32)
        self.server = Endpoint(("127.0.0.1", 0), ExtensionHandler)
        self.addCleanup(self.server.server_close)
        self.server.auth = self.auth.encode("ascii")
        self.server.journal = self.db
        self.server.adapter = self.adapter
        self.listener = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.025}, daemon=True)
        self.listener.start()
        self.addCleanup(self.stop_http)

    def stop_http(self):
        self.server.shutdown()
        self.listener.join(timeout=3)
        self.assertFalse(self.listener.is_alive())

    def stop_tools(self):
        self.loop.stop.set()
        self.loop.thread.join(timeout=18)
        self.assertFalse(self.loop.thread.is_alive())

    def post(self, path, body, expected=200, **headers):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        try:
            connection.request("POST", "/v1/" + path, json.dumps(body).encode(),
                               {"Content-Type": "application/json", "Origin": self.origin, "Authorization": self.auth, **headers})
            response = connection.getresponse()
            result = json.load(response)
            self.assertEqual(response.status, expected, result)
            return result
        finally:
            connection.close()

    def event(self, kind, **fields):
        event_id = uuid4().hex
        self.post("event", {**self.address, "id": event_id, "kind": kind, **fields})
        if kind == "user":
            self.delivery = event_id
        elif kind == "sent":
            self.delivery = fields["job"]

    def tool_request(self, name, arguments, verified=True):
        frame = json.dumps({"$harness":"tool_call", "turn_id":self.delivery, "name":name, "arguments":arguments})
        fence = "json" if verified else "text"
        self.event("assistant", text=f"Описание операции.\n\n```{fence}\n{frame}\n```",
                   toolFrame=True, replyTo=self.delivery)

    def wait_until(self, observe, description):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = observe()
            if result:
                return result
            time.sleep(0.025)
        self.fail(f"Timed out waiting for {description}. Outstanding deliveries: {self.db.issues()}")

    def poll(self):
        return self.post("poll", {**self.address, "ready": True})["job"]

    def receive_job(self):
        job = self.wait_until(self.poll, "extension delivery")
        self.event("sent", job=job["id"])
        return job

    def result(self, name, state):
        job = self.receive_job()
        header, body = job["text"].split("\n", 1)
        self.assertTrue(header.startswith("Local DeepSeek Harness result:"))
        self.assertIn('"$harness":"tool_call"',header)
        self.assertIn("first",header)
        self.assertIn("fenced text",header)
        data = json.loads(body)
        self.assertEqual((data["tool"], data["state"]), (name, state), data)
        return job, data

    def approval(self):
        def observe():
            with self.loop.guard:
                return next(iter(self.loop.approvals.items()), None)
        return self.wait_until(observe, "private operator confirmation")

    def test_bound_browser_conversation_uses_real_profile_and_private_operator(self):
        bind = {"chat": "https://arena.ai/agent/offline-fixture", "tab": 42}
        self.post("bind", bind, 401, Authorization="Bearer wrong")
        self.post("bind", bind, 403, Origin="https://arena.ai")
        self.post("bind", bind, 403, Host="foreign.invalid")
        self.address = {**bind, "binding": self.post("bind", bind)["binding"]}
        self.post("poll", {**self.address, "ready": True, "tab": 43}, 400)

        # Exercise an ordinary operator catalog request. It goes to the paired
        # browser like any other terminal delivery, followed by the browser ack.
        self.db.queue(self.adapter.instructions())
        catalog = self.receive_job()["text"]
        self.assertIn("only-model", catalog)
        self.assertNotIn("only-user", catalog)
        self.assertNotIn(self.marker, catalog)
        self.assertNotIn("arena/decide", catalog)
        self.assertIn('"$harness":"tool_call"',catalog)
        self.assertNotIn("arena.harness.v1",catalog)
        self.event("assistant", text="Ready")

        explicit = self.post("skill", {**self.address, "name": "only-user"})
        self.assertIn(self.marker + "-only-user", explicit["content"])
        self.post("skill", {**self.address, "name": "only-model"}, 400)
        self.event("user", text="Show an example formatted as code.")
        self.tool_request("read", {"file_path": "sample.txt"}, verified=False)
        self.assertEqual(self.db.issues(), [])
        self.assertIsNone(self.poll())

        self.event("user", text="Read, edit and test the sample.")
        self.tool_request("skill", {"name": "only-user"})
        job, _ = self.result("skill", "failed")
        self.assertNotIn(self.marker + "-only-user", job["text"])
        self.tool_request("read", {"file_path": "sample.txt"})
        _, data = self.result("read", "succeeded")
        self.assertIn("1: before", data["content"][0]["text"])

        edit = {"file_path": "sample.txt", "old_string": "before", "new_string": "after"}
        for allow, state in [(False, "denied"), (True, "succeeded")]:
            self.tool_request("edit", edit)
            op, request = self.approval()
            self.assertIn("sample.txt", request["detail"])
            self.assertIn('- "before"', request["detail"])
            self.assertIn('+ "after"', request["detail"])
            self.post("decide", {**self.address, "id": op, "approvalId": request["id"], "allow": True}, 404)
            self.assertEqual(self.file.read_text(encoding="utf-8"), "before\n")
            self.loop.decide(op, allow)
            _, data = self.result("edit", state)
            self.assertEqual(data["id"], op)
            self.assertEqual(self.file.read_text(encoding="utf-8"), "after\n" if allow else "before\n")

        self.tool_request("project_test", {})
        op, request = self.approval()
        self.assertIn("--test", request["detail"])
        self.loop.decide(op, True)
        _, data = self.result("project_test", "succeeded")
        self.assertIn(self.marker, data["content"][0]["text"])

        self.tool_request("read_image", {"file_path": "capture.png"})
        job, data = self.result("read_image", "succeeded")
        self.assertEqual(data["attachment"], "image/png")
        self.assertEqual(data["content"], [])
        self.assertNotIn("iVBOR", job["text"])
        self.assertEqual(base64.b64decode(job["png"], validate=True), self.image)
        self.event("assistant", text="Image received.")
        self.assertIsNone(self.poll())


if __name__ == "__main__":
    unittest.main()

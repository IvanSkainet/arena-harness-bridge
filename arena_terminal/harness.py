"""Keep operator approvals on the terminal's private MCP subprocess connection."""
import json
import secrets
import queue
import subprocess
import threading
import time
from pathlib import Path

from .journal import Problem, TOOL_REPLY_GUIDANCE, new_id


class Harness:
    def __init__(self, root):
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.responses = queue.Queue()
        server = Path(__file__).resolve().parents[1] / "harness-adapter" / "server.mjs"
        self.proc = subprocess.Popen(["node", str(server), "--root", str(root), "--profile", "project"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8",
                                     errors="strict", bufsize=1)
        self.reader = threading.Thread(target=self.read_responses, daemon=True)
        self.reader.start()
        try:
            self.rpc("initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name":"arena-terminal","version":"0.1"},
                                    "capabilities": {}, "_meta": {"arenaOperatorToken": self.token}})
            self.tools = self.rpc("tools/list", {})["tools"]
        except BaseException:
            self.close()
            raise

    def read_responses(self):
        try:
            for line in self.proc.stdout:
                self.responses.put(line)
        finally:
            self.responses.put(None)

    def rpc(self, method, params):
        with self.lock:
            rid = new_id()
            request = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
            deadline = threading.Timer(15, self.proc.kill)
            deadline.daemon = True
            deadline.start()
            try:
                self.proc.stdin.write(json.dumps(request) + "\n")
                self.proc.stdin.flush()
                raw = self.responses.get(timeout=15)
            except queue.Empty:
                self.proc.kill()
                raise Problem("Local adapter did not acknowledge the request within 15 seconds")
            finally:
                deadline.cancel()
            if not raw:
                raise Problem("DeepSeek Harness subprocess disconnected")
            response = json.loads(raw)
            if response.get("id") != rid:
                raise Problem("Unexpected MCP response ID")
            if "error" in response:
                raise Problem(response["error"]["message"])
            return response["result"]

    def instructions(self):
        skills = self.rpc("arena/catalog", {})["skills"]
        return ("Local project context from DeepSeek Harness. Follow the operator's task below. "
                "For local project tasks use this bridge. " + TOOL_REPLY_GUIDANCE +
                " Wait for the tool result in the next message. The operator decides approval in the terminal. "
                "Tool catalog: " + json.dumps(self.tools, ensure_ascii=False) + "\nLocal skill catalog: "
                + json.dumps(skills, ensure_ascii=False))

    def skill(self, name):
        result = self.rpc("arena/explicitSkill", {"token": self.token, "name": name})
        if not result.get("content"):
            raise Problem("Skill is unavailable for explicit invocation")
        return result["content"]

    def decide(self, id, approval, allow):
        return self.rpc("arena/decide", {"token": self.token, "id": id, "approvalId": approval, "allow": allow})

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.reader.join(timeout=2)
        self.proc.stdout.close()


class ToolLoop:
    def __init__(self, db, adapter):
        self.db, self.adapter = db, adapter
        self.approvals = {}
        self.guard = threading.RLock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        running = set()
        refresh = time.monotonic() + 5
        while not self.stop.wait(0.2):
            if time.monotonic() >= refresh:
                try:
                    self.db.use_catalog(self.adapter.instructions())
                except (OSError, ValueError, KeyError) as error:
                    self.db.notice("offline", f"Cannot refresh local tool catalog: {error}")
                refresh = time.monotonic() + 15
            for call in self.db.pending_calls():
                if not self.db.claim(call["id"]):
                    continue
                running.add(call["id"])
                try:
                    args = json.loads(call["args"])
                    self.adapter.rpc("tools/call", dict(args, _meta={"arenaCallId": call["id"]}))
                except (OSError, ValueError, KeyError) as error:
                    self.db.mark_unknown(call["id"], str(error))
                    running.discard(call["id"])
            for id in list(running):
                try:
                    result = self.adapter.rpc("arena/status", {"id": id})
                    state = result["state"]
                    if state == "approval":
                        with self.guard:
                            if id not in self.approvals:
                                self.approvals[id] = result["approval"]
                                self.db.notice("approval", f"{id} {result['approval']['detail']}")
                    elif state in ("succeeded","denied","failed"):
                        content = result.get("content", [])
                        png = next((b.get("data") for b in content if b.get("type") == "image" and b.get("mimeType") == "image/png"), None)
                        payload = {"id":id,"tool":result["tool"],"state":state,"content":[b for b in content if b.get("type") == "text"]}
                        if png is not None:
                            payload["attachment"] = "image/png"
                        text = json.dumps(payload, ensure_ascii=False)
                        if len(text) > 160000:
                            self.db.retain_result(id,text)
                            text = json.dumps({"id": id, "state": state, "summary": "Output truncated for chat; full original retained in terminal (/export-text ID).", "preview":text[:60000]},ensure_ascii=False)
                        self.db.call_result(id, "Local DeepSeek Harness result: " + TOOL_REPLY_GUIDANCE + "\n" + text, png)
                        running.remove(id)
                except (OSError, ValueError, KeyError) as error:
                    self.db.mark_unknown(id, str(error))
                    running.discard(id)
                if id not in running:
                    with self.guard:
                        self.approvals.pop(id, None)

    def decide(self, id, allow):
        with self.guard:
            request = self.approvals.get(id)
            if not request:
                raise Problem("No pending approval with that ID")
            self.adapter.decide(id, request["id"], allow)
            del self.approvals[id]

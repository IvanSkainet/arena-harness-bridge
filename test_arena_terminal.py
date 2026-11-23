import json
import tempfile
import unittest
from pathlib import Path

from arena_terminal.journal import Journal, Problem, tool_frame


class Conversations(unittest.TestCase):
    def test_late_generated_image_for_skipped_delivery_does_not_block_next_job(self):
        first = self.db.queue("Generate a picture")
        self.db.poll(self.address, True)
        self.event("sent-first", "sent", job=first)
        self.db.resolve(first, "skip")
        second = self.db.queue("Next task")
        image = {"mediaType":"image/png", "data":"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII="}
        for _ in range(2):
            self.event("late", "assistant", replyTo=first, images=[image])
        self.assertEqual(self.db.generated_images(first), [])
        self.assertEqual(self.db.poll(self.address, True)["id"], second)

    def test_manual_browser_image_is_retained_for_terminal_export(self):
        from base64 import b64decode
        from contextlib import redirect_stdout
        from io import StringIO
        from arena_terminal.__main__ import submit

        item = {"mediaType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII="}
        self.event("user-event", "user", text="Generate an illustration")
        job = self.db.one("SELECT id FROM jobs WHERE state='waiting'")["id"]
        self.event("reply-event", "assistant", replyTo="user-event", images=[item])
        self.assertEqual(self.db.generated_images(job), [item])
        self.assertTrue(any("/export-image" in e["text"] for e in self.db.log()))
        self.db.close()
        self.db = Journal(self.path, self.path.parent)
        with redirect_stdout(StringIO()):
            submit(f"/export-image {job}-1", (self.path.parent, self.db, None, None, None))
        exported, = self.path.parent.glob("arena-image-*.png")
        self.assertEqual(exported.read_bytes(), b64decode(item["data"]))

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "state.sqlite"
        self.db = Journal(self.path, temp.name)
        self.addCleanup(lambda: self.db.close())
        self.chat = "https://arena.ai/agent/example"
        self.binding = self.db.bind(self.chat, 4)
        self.address = dict(binding=self.binding, chat=self.chat, tab=4)

    def event(self, id, kind, **fields):
        return self.db.event(dict(self.address, id=id, kind=kind, **fields))

    def test_reserve_once_until_confirmed_and_answer(self):
        first = self.db.queue("hello")
        second = self.db.queue("hello")
        self.assertIsNone(self.db.poll(self.address, False))
        self.assertEqual(self.db.poll(self.address, True)["id"], first)
        self.assertIsNone(self.db.poll(self.address, True))
        with self.assertRaises(Problem):
            self.db.poll(dict(self.address, tab=9), True)
        self.event("sent-1", "sent", job=first)
        self.event("answer-1", "assistant", text="reply")
        self.event("answer-1", "assistant", text="reply")
        self.assertEqual(self.db.poll(self.address, True)["id"], second)
        self.assertEqual(len([e for e in self.db.log() if e["kind"] == "assistant"]), 1)

    def test_restart_or_ambiguous_does_not_resend(self):
        first = self.db.queue("do it")
        self.db.poll(self.address, True)
        self.db.close()
        self.db = Journal(self.path, self.path.parent)
        self.assertIsNone(self.db.poll(self.address, True))
        self.assertEqual(self.db.state(first), "uncertain")
        with self.assertRaises(Problem):
            self.db.bind("https://arena.ai/agent/other", 4)

    def test_tool_is_actionable_only_in_final_assistant_reply(self):
        user = "a" * 32
        frame = '```json\n' + json.dumps({
            "$harness":"tool_call", "name":"read", "turn_id":user,
            "arguments":{"file_path":"sample.txt"}}) + '\n```'
        self.event(user, "user", text=frame)
        self.assertEqual(self.db.pending_calls(), [])
        self.event("a", "assistant", text=frame, toolFrame=True, replyTo=user)
        self.assertEqual(len(self.db.pending_calls()), 1)
        self.event("a", "assistant", text=frame, toolFrame=True, replyTo=user)
        call = self.db.pending_calls()[0]
        self.assertTrue(self.db.claim(call["id"]))
        self.event("u2", "user", text="new question")
        self.db.call_result(call["id"], "sample")
        self.assertTrue(self.db.held())
        self.assertIsNone(self.db.poll(self.address, True))

    def test_wrong_context_and_bare_agent_are_rejected(self):
        for chat in ["https://arena.ai/agent", "https://arena.ai.example/agent/chat/1", "http://arena.ai/agent/chat/1"]:
            with self.assertRaises(Problem):
                self.db.bind(chat, 4)
        with self.assertRaises(Problem):
            self.db.poll(dict(self.address, chat=self.chat + "2"), True)

    def test_plain_or_quoted_display_is_not_a_tool(self):
        self.event("u", "user", text="give an example")
        self.event("q", "assistant", text='```arenatool\n{"name":"read","arguments":{}}\n```')
        self.assertEqual(self.db.pending_calls(), [])

    def test_marked_call_without_turn_id_is_closed_with_diagnostic(self):
        job = self.db.queue("Read")
        self.db.poll(self.address, True)
        self.event("sent", "sent", job=job)
        frame = '```json\n{"$harness":"tool_call","name":"read","arguments":{}}\n```'
        self.event("missing", "assistant", text=frame, toolFrame=True, replyTo=job)
        self.assertEqual(self.db.pending_calls(), [])
        self.assertEqual(self.db.state(job), "done")
        diagnostic = self.db.log()[-1]
        self.assertEqual(diagnostic["kind"], "protocol")
        self.assertIn("turn_id", diagnostic["text"])
        self.assertNotIn("$harness", diagnostic["text"])

    def test_call_key_must_be_first_in_source_and_belong_to_the_current_delivery(self):
        delivery = "a" * 32
        obj = '{"$harness":"tool_call","name":"edit","arguments":{},"turn_id":"' + delivery + '"}'
        block = "```json\n" + obj + "\n```"
        self.assertEqual(tool_frame("Opening the editor.\n\n" + block + "\n\nThen I can continue.", delivery),
                         {"name":"edit","arguments":{},"text":"Opening the editor.\n\nThen I can continue."})
        self.assertEqual(tool_frame(block, delivery), {"name":"edit","arguments":{}})
        self.assertEqual(tool_frame(block.replace('"name":"edit","arguments":{}','"arguments":{},"name":"edit"'),
                                    delivery), {"name":"edit","arguments":{}})
        for missing in (None, "", "old-legacy-event"):
            self.assertIsNone(tool_frame(block, missing))
        for invalid in ("null", "123", '""', json.dumps("b" * 32)):
            with self.subTest(turn_id=invalid):
                with self.assertRaisesRegex(Problem, "turn_id"):
                    tool_frame(block.replace(json.dumps(delivery), invalid), delivery)
        for rejected in (block.replace("```json","```text"),
                         block.replace('"$harness":"tool_call",', ""),
                         block.replace('"$harness":"tool_call","name":"edit"', '"name":"edit","$harness":"tool_call"'),
                         block.replace('"$harness":"tool_call",','"protocol":"arena.harness.v1",'),
                         block.replace('"$harness":"tool_call"', '"$harness":"example"'),
                         block.replace('"$harness":"tool_call",','').replace('"arguments":{}','"arguments":{"$harness":"tool_call"}'),
                         "Arena-Harness-Call " + delivery + "\n" + block,
                         block + "\n" + block, "> " + block, "    " + block,
                         "````markdown\n" + block + "\n````",
                         block.replace('"$harness":"tool_call"', '"$harness":"tool_call","$harness":"tool_call"'),
                         block.replace('"arguments":{}', '"arguments":{},"arguments":{}'),
                         block.replace('"arguments":{}', '"arguments":{},"turn_id":"copy"'),
                         block.replace('"arguments":{}', '"arguments":{"nested":{"a":0,"a":1}}'),
                         block.replace('"arguments":{}', '"arguments":{"n":NaN}'),
                         block.replace('"arguments":{}', '"arguments":{"n":1e9999}'),
                         block.replace('"edit"', '"absent"'), block.replace('"arguments":{}','"arguments":{},"extra":1')):
            with self.subTest(rejected=rejected):
                self.assertIsNone(tool_frame(rejected, delivery))

    def test_late_marked_tool_cannot_close_or_execute_for_new_manual_turn(self):
        old, new = "d"*32, "e"*32
        self.event(old, "user", text="First request")
        self.event(new, "user", text="Replacement")
        frame = ("```json\n"
                 '{"$harness":"tool_call","name":"read","arguments":{},"turn_id":"' + old + '"}\n```')
        self.event("late", "assistant", text=frame, toolFrame=True, replyTo=old)
        self.assertFalse(self.db.pending_calls())
        row = self.db.one("SELECT job FROM browser_inputs WHERE event=?", (new,))
        self.assertEqual("waiting", self.db.state(row["job"]))
        self.event("current", "assistant", text="Ordinary reply", replyTo=new)
        self.assertEqual("done", self.db.state(row["job"]))

    def test_operator_can_inspect_recover_and_replace_tab(self):
        id = self.db.queue("hello")
        self.db.poll(self.address, True)
        self.db.resolve(id, "sent")
        self.assertEqual(self.db.state(id), "waiting")
        self.db.resolve(id, "skip")
        self.db.release()
        new = self.db.bind(self.chat, 5)
        self.assertNotEqual(new, self.binding)
        with self.assertRaises(Problem):
            self.db.poll(self.address, True)

    def test_catalog_accompanies_only_the_next_real_user_turn(self):
        self.db.use_catalog("project tools")
        self.assertIsNone(self.db.poll(self.address, True))
        job = self.db.queue("first task")
        self.assertEqual(self.db.poll(self.address, True)["text"], "project tools\n\nfirst task")
        self.event("sent", "sent", job=job)
        self.db.use_catalog("project tools")
        self.assertIsNone(self.db.context())
        self.event("answer", "assistant", text="ok")
        self.db.queue("second")
        self.assertEqual(self.db.poll(self.address, True)["text"], "second")

    def test_visible_quota_after_echo_pauses_delivery(self):
        job = self.db.queue("first")
        self.db.poll(self.address, True)
        self.event("sent", "sent", job=job)
        self.event("quota", "limited", job=job, text="Rate limit reached")
        self.assertEqual(self.db.state(job), "limited")
        self.db.queue("second")
        self.assertIsNone(self.db.poll(self.address, True))
        self.db.resolve(job, "skip")
        self.assertIsNone(self.db.poll(self.address, True))
        self.db.resume()
        self.assertEqual(self.db.poll(self.address, True)["text"], "second")

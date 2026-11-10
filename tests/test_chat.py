"""Public JSONL bridge tests against an independent canonical Hermes transport peer.

Run with Hermes's Python: python -m unittest discover -s tests -p test_chat.py.
No engine, model, credentials, or live user gateway is involved.
"""
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import unittest

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from gateway.session_contract import CANONICAL_GATEWAY_PROTOCOL

SCRIPT = Path(__file__).resolve().parents[1] / "chat" / "hermes_shepherd_chat.py"


class Peer:
    """Fake remote authority, not a fake bridge/client: real bootstrap and WS wire."""
    def __init__(self, root, profile="coordinator"):
        self.root = root
        self.home = root / "profiles" / profile
        self.home.mkdir(parents=True, mode=0o700)
        (self.home / "SOUL.md").write_text("Private protocol fixture")
        self.root.chmod(0o700)
        self.calls, self.responses, self.sockets = [], [], set()
        self.sequence, self.generation, self.running = 0, 0, False
        self.events, self.prompts, self.messages = [], [], []
        self.display_messages, self.pending = None, []
        self.session = "session-one"
        self.mismatch = False
        self.drop_submit = False
        self.replay_gap = False
        self.live_sessions, self.missing_sessions = [], set()
        self.next_snapshot = None
        self.wake = asyncio.Event()

    async def start(self):
        self.ws = await serve(self.websocket, "127.0.0.1", 0,
                              subprotocols=[CANONICAL_GATEWAY_PROTOCOL])
        self.port = self.ws.sockets[0].getsockname()[1]
        self.control = await asyncio.start_unix_server(self.bootstrap, str(self.home / "gateway.sock"))
        (self.home / "gateway.sock").chmod(0o600)

    async def close(self):
        self.control.close()
        await self.control.wait_closed()
        self.ws.close()
        await self.ws.wait_closed()

    async def bootstrap(self, reader, writer):
        request = json.loads(await reader.readline())
        identity = dict(profile_id=str(self.home), instance_id="fixture-owner", runtime_protocol=1)
        if request["verb"] == "session-ticket":
            self.calls.append(("bootstrap.ticket", request["params"]))
            result = dict(identity, ticket="private-fixture-ticket")
        else:
            result = dict(identity, served_profiles=[dict(home=str(self.home), profile_id=str(self.home))],
                          state="ready", capabilities=["session-authority-v1"], authority_epoch=1,
                          api_origin=f"http://127.0.0.1:{self.port}", supervisor="external")
        writer.write((json.dumps(dict(ok=True, protocol=1, id=1, result=result)) + "\n").encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    def snapshot(self):
        if self.next_snapshot is not None:
            result, self.next_snapshot = self.next_snapshot, None
            return result
        return dict(session_id=self.session, stored_session_id=self.session, messages=self.messages,
                    display_messages=self.messages if self.display_messages is None else self.display_messages,
                    message_count=len(self.messages), running=self.running,
                    authority_epoch=1, replay_epoch="epoch-one", last_sequence=self.sequence,
                    subscription_id="subscription-" + self.session, revision=1,
                    execution_generation=self.generation, pending=self.pending, prompts=self.prompts,
                    info=dict(profile_id=str(self.home), title="Fixture conversation", model="fixture-model"),
                    open_requests=[])

    async def websocket(self, socket):
        self.sockets.add(socket)
        try:
            async for raw in socket:
                frame = json.loads(raw)
                if "method" not in frame:
                    self.responses.append(frame)
                    self.wake.set()
                    continue
                method, params = frame["method"], frame.get("params", {})
                self.calls.append((method, params))
                self.wake.set()
                if method == "runtime.describe":
                    result = dict(profile_id="wrong-profile" if self.mismatch else str(self.home),
                                  instance_id="fixture-owner", authority_epoch=1,
                                  capabilities=["session-authority-v1"],
                                  session_create=dict(sources=["tui", "cli"], parameters=["cwd", "source", "request_id"]))
                elif method == "session.list":
                    result = dict(scope=params["scope"], sessions=self.live_sessions if params["scope"] == "live" else
                                  [dict(id="session-one", title="First", running=self.running, last_active_at=2),
                                   dict(id="session-two", title="Second", running=False, last_active_at=1)])
                elif method == "session.resume":
                    if params["session_id"] in self.missing_sessions:
                        await socket.send(json.dumps(dict(jsonrpc="2.0", id=frame["id"],
                                                          error=dict(code=-32000, message="not_found"))))
                        continue
                    self.session = params["session_id"]
                    result = self.snapshot()
                elif method == "session.create":
                    self.session = "new-session"
                    result = self.snapshot()
                elif method == "session.events.since":
                    result = dict(events=self.events if not self.replay_gap else [], latest_seq=self.sequence,
                                  last_sequence=self.sequence, replay_epoch="epoch-one", epoch="epoch-one",
                                  truncated=self.replay_gap, snapshot_required=self.replay_gap, count=len(self.events))
                elif method == "prompt.submit":
                    if self.drop_submit:
                        await socket.close()
                        continue
                    result = dict(admission_id="admission-one", submission_id=params["submission_id"],
                                  status="queued", session_id=self.session)
                elif method in {"approval.respond", "clarify.respond"}:
                    self.prompts = [p for p in self.prompts if p["prompt_id"] != params["prompt_id"]]
                    result = dict(status="resolved", prompt_id=params["prompt_id"])
                elif method in {"session.interrupt", "session.detach"}:
                    result = {}
                else:
                    await socket.send(json.dumps(dict(jsonrpc="2.0", id=frame["id"], error=dict(code=-32601, message="unknown_method"))))
                    continue
                await socket.send(json.dumps(dict(jsonrpc="2.0", id=frame["id"], result=result)))
        except ConnectionClosed:
            pass  # Tests deliberately terminate viewers to exercise reconnect.
        finally:
            self.sockets.discard(socket)

    async def emit(self, kind, payload, admission="admission-one"):
        self.sequence += 1
        event = dict(type=kind, payload=payload, session_id=self.session, seq=self.sequence,
                     replay_epoch="epoch-one", execution_generation=self.generation, admission_id=admission)
        self.events.append(event)
        await self.broadcast(dict(jsonrpc="2.0", method="event", params=event))
        return event

    async def broadcast(self, frame):
        for socket in tuple(self.sockets):
            await socket.send(json.dumps(frame))


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shepherd-chat-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.peer = Peer(self.root / "hermes")
        await self.peer.start()
        self.addAsyncCleanup(self.peer.close)
        self.state_dir = self.root / "viewer-state"
        self.env = dict(os.environ, HERMES_HOME=str(self.peer.root), HOME=str(self.root),
                        HERMES_TUI_GATEWAY_URL="ws://127.0.0.1:1/never-use-this")
        self.processes, self.writers = [], []
        self.addAsyncCleanup(self.close_viewers_and_processes)
        self.registration = await self.launch()
        self.reader, self.writer = await self.viewer()
        await self.until(lambda f: f.get("type") == "state" and f["connected"])

    async def close_viewers_and_processes(self):
        for writer in self.writers:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()
        for process in self.processes:
            if process.returncode is None:
                process.terminate()
            await process.wait()

    async def launch(self, profile="coordinator", home=None):
        home = home or self.peer.home
        process = await asyncio.create_subprocess_exec(sys.executable, str(SCRIPT), "--serve", "--profile", profile,
                    "--state-dir", str(self.state_dir), env=self.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.processes.append(process)
        path = self.state_dir / hashlib.sha256(str(home).encode()).hexdigest()[:24] / "registry.json"
        async with asyncio.timeout(8):
            while not path.exists() or json.loads(path.read_text()).get("pid") != process.pid:
                if process.returncode is not None:
                    self.fail((await process.stderr.read()).decode())
                await asyncio.sleep(0.02)
        result = json.loads(path.read_text())
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        return result

    async def viewer(self, token=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.registration["port"], limit=8 * 1024 * 1024)
        self.writers.append(writer)
        writer.write((json.dumps(dict(op="hello", token=token or self.registration["token"])) + "\n").encode())
        await writer.drain()
        return reader, writer

    async def until(self, predicate, reader=None):
        reader = reader or self.reader
        async with asyncio.timeout(8):
            while raw := await reader.readline():
                frame = json.loads(raw)
                if predicate(frame):
                    return frame
        self.fail("Bridge closed before expected protocol frame")

    async def request(self, op, **params):
        identity = "request-" + str(len(self.peer.calls)) + "-" + op
        self.writer.write((json.dumps(dict(id=identity, op=op, **params)) + "\n").encode())
        await self.writer.drain()
        return await self.until(lambda f: f.get("type") == "reply" and f["id"] == identity)

    async def resume(self, sid="session-one"):
        result = await self.request("resume", session_id=sid)
        self.assertTrue(result["ok"], result)

    async def test_authentication_and_no_implicit_selection(self):
        reader, writer = await self.viewer("wrong-token")
        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
        self.assertFalse(any(m == "session.resume" for m, _ in self.peer.calls))
        result = await self.request("sessions")
        self.assertEqual([r["id"] for r in result["sessions"]], ["session-one", "session-two"])
        self.assertFalse(any(m == "session.resume" for m, _ in self.peer.calls))
        ticket = next(p for m, p in self.peer.calls if m == "bootstrap.ticket")
        self.assertEqual(ticket["profile_id"], str(self.peer.home))

    async def test_exact_session_send_identity_and_stale_refusal(self):
        await self.resume()
        result = await self.request("send", session_id="session-two", text="wrong", request_id="durable-wrong")
        self.assertFalse(result["ok"])
        self.assertFalse(any(m == "prompt.submit" for m, _ in self.peer.calls))
        result = await self.request("send", session_id="session-one", text="Please inspect the board", request_id="durable-one")
        self.assertTrue(result["ok"])
        submitted = next(p for m, p in self.peer.calls if m == "prompt.submit")
        self.assertEqual(submitted, dict(session_id="session-one", text="Please inspect the board", submission_id="durable-one"))
        await self.resume("session-two")
        self.assertTrue(any(m == "session.detach" and p["session_id"] == "session-one" for m, p in self.peer.calls))
        self.assertFalse(any(m == "session.interrupt" for m, _ in self.peer.calls))

    async def test_stream_tools_replay_fencing_and_authoritative_settlement(self):
        self.peer.generation, self.peer.running = 7, True
        self.peer.messages = [dict(row_id=1, role="user", text="Inspect")]
        await self.peer.emit("message.delta", dict(text="Already streaming"))
        await self.resume()
        await self.request("refresh")
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        self.assertEqual([r["text"] for r in frame["items"] if r["kind"] == "assistant"], ["Already streaming"])
        # Replayed old frames on the live socket must not append the same text twice.
        await self.peer.broadcast(dict(jsonrpc="2.0", method="event", params=self.peer.events[0]))
        await self.peer.emit("tool.start", dict(tool_call_id="call-1", tool_name="terminal", args={"command": "pwd"}))
        await self.peer.emit("tool.complete", dict(tool_call_id="call-1", tool_name="terminal", args={"command": "pwd"}, result="/home/fixture"))
        frame = await self.until(lambda f: f.get("type") == "state" and any(r.get("status") == "done" for r in f["items"]))
        tool = next(r for r in frame["items"] if r["kind"] == "tool")
        self.assertEqual(tool["text"], "/home/fixture")
        self.peer.running = False
        self.peer.messages.append(dict(row_id=2, role="assistant", text="Authoritative final reply"))
        await self.peer.emit("message.complete", dict(text="Authoritative final reply", status="completed"))
        frame = await self.until(lambda f: f.get("type") == "state" and not f["running"] and any(r["text"] == "Authoritative final reply" for r in f["items"]))
        self.assertEqual([r["text"] for r in frame["items"] if r["kind"] == "assistant"], ["Authoritative final reply"])

    async def test_generation_fenced_stop_and_exact_prompt_answers(self):
        self.peer.generation, self.peer.running = 4, True
        self.peer.prompts = [dict(kind="approval", prompt_id="approve-1", execution_generation=4,
                                  command="git status", choices=["once", "deny"]),
                             dict(kind="clarify", prompt_id="clarify-1", execution_generation=4,
                                  question="Which targets?", choices=["staging", "production"], multi_select=True)]
        await self.resume()
        self.assertFalse((await self.request("stop", session_id="session-one", generation=3))["ok"])
        self.assertFalse((await self.request("answer", session_id="session-one", generation=4, prompt_id="approve-1", choice="always"))["ok"])
        self.assertTrue((await self.request("answer", session_id="session-one", generation=4, prompt_id="approve-1", choice="once"))["ok"])
        self.assertFalse((await self.request("answer", session_id="session-one", generation=4, prompt_id="approve-1", choice="once"))["ok"])
        answer = '["staging","production"]'
        self.assertTrue((await self.request("answer", session_id="session-one", generation=4, prompt_id="clarify-1", answer=answer))["ok"])
        params = next(p for m, p in self.peer.calls if m == "clarify.respond")
        self.assertEqual(params, dict(session_id="session-one", execution_generation=4, prompt_id="clarify-1", answer=answer))
        self.assertTrue((await self.request("stop", session_id="session-one", generation=4))["ok"])
        self.assertEqual(sum(m == "session.interrupt" for m, _ in self.peer.calls), 1)

    async def test_viewer_disconnect_keeps_work_and_selection_on_reconnect(self):
        await self.resume()
        self.writer.close()
        await self.writer.wait_closed()
        self.reader, self.writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state")
        self.assertEqual(frame["session_id"], "session-one")
        self.assertFalse(any(m == "session.interrupt" for m, _ in self.peer.calls))
        process = self.processes[-1]
        process.terminate()
        await process.wait()
        self.registration = await self.launch()
        self.reader, self.writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state" and f["connected"] and f["session_id"] == "session-one")
        self.assertEqual(frame["title"], "Fixture conversation")

    async def test_ambiguous_submit_is_not_retried(self):
        await self.resume()
        self.peer.drop_submit = True
        result = await self.request("send", session_id="session-one", text="Work", request_id="durable-ambiguous")
        self.assertFalse(result["ok"])
        self.assertFalse(result["acknowledged"])
        self.assertIn("unknown", result["error"].lower())
        await asyncio.sleep(0.1)
        self.assertEqual(sum(m == "prompt.submit" for m, _ in self.peer.calls), 1)

    async def test_unsupported_server_request_receives_explicit_error(self):
        await self.resume()
        await self.peer.broadcast(dict(jsonrpc="2.0", id="srq-private", method="secret", params=dict(session_id="session-one", name="fixture")))
        async with asyncio.timeout(3):
            while not self.peer.responses:
                self.peer.wake.clear()
                await self.peer.wake.wait()
        self.assertEqual(self.peer.responses[0]["error"]["code"], -32601)
        self.assertNotIn("result", self.peer.responses[0])

    async def test_runtime_profile_mismatch_is_never_used(self):
        self.peer.mismatch = True
        for socket in tuple(self.peer.sockets):
            await socket.close()
        frame = await self.until(lambda f: f.get("type") == "state" and "identity mismatch" in (f.get("error") or ""))
        self.assertFalse(frame["connected"])
        result = await self.request("send", session_id="session-one", text="No", request_id="never")
        self.assertFalse(result["ok"])
        self.assertFalse(any(m == "prompt.submit" for m, _ in self.peer.calls))

    async def test_missing_profile_fails_without_gateway_or_state_creation(self):
        process = await asyncio.create_subprocess_exec(sys.executable, str(SCRIPT), "--connect", "--profile", "missing",
                  "--state-dir", str(self.root / "missing-state"), env=self.env,
                  stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, error = await process.communicate()
        self.assertEqual(process.returncode, 1)
        self.assertEqual(out, b"")
        self.assertIn(b"Profile does not exist", error)
        self.assertFalse((self.root / "missing-state").exists())

    async def test_profile_selection_and_registry_are_isolated(self):
        await self.resume()
        research = Peer(self.peer.root, "research")
        await research.start()
        try:
            first = self.registration
            self.registration = await self.launch("research", research.home)
            self.assertNotEqual(first["port"], self.registration["port"])
            self.assertNotEqual(first["token"], self.registration["token"])
            self.reader, self.writer = await self.viewer()
            frame = await self.until(lambda f: f.get("type") == "state" and f["connected"])
            self.assertEqual(frame["profile_id"], str(research.home))
            self.assertIsNone(frame["session_id"])
            self.assertTrue((await self.request("resume", session_id="research-conversation"))["ok"])
            self.assertFalse(any(m == "session.resume" and p.get("session_id") == "research-conversation" for m, p in self.peer.calls))
            self.registration = first
            self.reader, self.writer = await self.viewer()
            frame = await self.until(lambda f: f.get("type") == "state")
            self.assertEqual(frame["session_id"], "session-one")
        finally:
            await research.close()

    async def test_concurrent_connect_reuses_authenticated_viewer(self):
        async def connect():
            process = await asyncio.create_subprocess_exec(sys.executable, str(SCRIPT), "--connect", "--profile", "coordinator",
                      "--state-dir", str(self.state_dir), env=self.env,
                      stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, error = await process.communicate()
            self.assertEqual(process.returncode, 0, error.decode())
            return json.loads(out)
        first, second = await asyncio.gather(connect(), connect())
        self.assertEqual(first, second)
        self.assertEqual(first, {k: self.registration[k] for k in ("host", "port", "token")})

    async def test_replay_gap_is_visible_and_new_uses_safe_creation_policy(self):
        self.peer.running, self.peer.generation, self.peer.replay_gap = True, 9, True
        await self.resume()
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        self.assertTrue(any("unavailable" in row["text"] for row in frame["items"]))
        self.assertTrue((await self.request("new"))["ok"])
        created = next(p for m, p in self.peer.calls if m == "session.create")
        self.assertEqual(created["source"], "tui")
        self.assertEqual(created["cwd"], str(self.root))
        self.assertNotIn("yolo", created)
        self.assertNotIn("safe_mode", created)

    async def test_pending_user_text_is_authoritative_and_not_duplicated_after_commit(self):
        await self.resume()
        self.peer.pending = [dict(admission_id="admission-one", input_id="durable-pending", text="Remote admitted text",
                                  status="queued", execution_generation=None)]
        result = await self.request("send", session_id="session-one", text="Typed composer text", request_id="durable-pending")
        self.assertTrue(result["ok"])
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        self.assertEqual([r["text"] for r in frame["items"] if r["kind"] == "user"], ["Remote admitted text"])
        self.peer.messages = [dict(row_id=10, role="user", content="Remote admitted text",
                                   display_metadata=dict(submission_id="durable-pending"))]
        await self.request("refresh")
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        self.assertEqual([r["text"] for r in frame["items"] if r["kind"] == "user"], ["Remote admitted text"])

    async def test_tool_projection_keeps_canonical_raw_result_and_arguments(self):
        self.peer.messages = [dict(row_id=3, role="tool", tool_call_id="persisted-call", tool_name="terminal",
                                   content='{"output":"retained output","exit_code":0}')]
        self.peer.display_messages = [dict(role="tool", tool_call_id="persisted-call", name="terminal",
                                           context="pwd", args=dict(command="pwd"))]
        await self.resume()
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        tool = next(r for r in frame["items"] if r["kind"] == "tool")
        self.assertEqual(tool["text"], '{"output":"retained output","exit_code":0}')
        self.assertEqual(tool["input"], '{"command": "pwd"}')
        self.assertEqual(tool["id"], "row:3")

    async def test_history_merges_live_and_stored_canonical_identities(self):
        self.peer.live_sessions = [dict(id="session-one", title="Live first", running=True, last_active_at=4),
                                   dict(id="physical-segment", resolved_id="canonical-owner", title="Active", last_active_at=3)]
        result = await self.request("sessions")
        self.assertEqual([r["id"] for r in result["sessions"]], ["session-one", "canonical-owner", "session-two"])
        self.assertEqual(result["sessions"][0]["title"], "Live first")
        self.assertTrue(result["sessions"][0]["running"])
        self.assertFalse(any(m == "session.resume" for m, _ in self.peer.calls))

    async def test_deleted_remembered_session_leaves_explicit_selection_available(self):
        await self.resume()
        self.processes[-1].terminate()
        await self.processes[-1].wait()
        self.peer.missing_sessions.add("session-one")
        self.registration = await self.launch()
        self.reader, self.writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state" and f["connected"] and f["items"])
        self.assertIsNone(frame["session_id"])
        self.assertIsNone(frame["error"])
        self.assertIn("not_found", frame["items"][0]["text"])
        self.assertTrue((await self.request("sessions"))["ok"])
        self.assertTrue((await self.request("new"))["ok"])
        self.assertFalse(any(m == "prompt.submit" for m, _ in self.peer.calls))

    async def test_profile_authenticated_history_may_remap_a_messaging_lineage(self):
        snapshot = self.peer.snapshot()
        snapshot["info"] = {"desktop_protocol": CANONICAL_GATEWAY_PROTOCOL}
        self.peer.next_snapshot = snapshot
        await self.resume("legacy-segment")
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        self.assertEqual(frame["session_id"], "session-one")
        self.assertTrue((await self.request("send", session_id="session-one", text="Continue", request_id="mapped"))["ok"])
        snapshot = self.peer.snapshot()
        snapshot["info"]["profile_id"] = "/wrong/profile"
        self.peer.next_snapshot = snapshot
        self.assertFalse((await self.request("resume", session_id="other"))["ok"])

    async def test_interim_commentary_survives_replay_without_duplicating_streamed_text(self):
        self.peer.generation, self.peer.running = 5, True
        await self.peer.emit("message.delta", dict(text="Streamed"))
        await self.peer.emit("message.interim", dict(text="Streamed", already_streamed=True))
        await self.peer.emit("message.interim", dict(text="Inspecting records", already_streamed=False))
        await self.peer.emit("message.delta", dict(text="Next segment"))
        await self.resume()
        reader, writer = await self.viewer()
        frame = await self.until(lambda f: f.get("type") == "state", reader)
        self.assertEqual([r["text"] for r in frame["items"] if r["kind"] == "assistant"],
                         ["Streamed", "Inspecting records", "Next segment"])
        await self.peer.emit("message.interim", dict(text="Waiting for the tool", already_streamed=False))
        frame = await self.until(lambda f: f.get("type") == "state" and any(r["text"] == "Waiting for the tool" for r in f["items"]))
        self.assertEqual([r["text"] for r in frame["items"] if r["kind"] == "assistant"],
                         ["Streamed", "Inspecting records", "Next segment", "Waiting for the tool"])


if __name__ == "__main__":
    unittest.main()

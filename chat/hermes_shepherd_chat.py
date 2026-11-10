#!/usr/bin/env python3
"""Profile-bound, viewer-only Hermes gateway adapter for the native Shepherd panel."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import subprocess
import sys
import time
import uuid

MAX_FRAME = 1024 * 1024
MAX_ITEMS = 400
MAX_TEXT = 12000


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    node = path.lstat()
    if not stat.S_ISDIR(node.st_mode) or node.st_uid != os.getuid() or node.st_mode & 0o077:
        raise ValueError("State directory must be owned by you and mode 0700")


def atomic_json(path, value):
    temp = path.with_name(path.name + "." + secrets.token_hex(8))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(encode(value))
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r") as stream:
        node = os.fstat(stream.fileno())
        if not stat.S_ISREG(node.st_mode) or node.st_uid != os.getuid() or node.st_mode & 0o077:
            raise ValueError("Unsafe bridge state file permissions")
        return json.loads(stream.read(MAX_FRAME))


def resolve_profile(name):
    from hermes_cli.profiles import normalize_profile_name, validate_profile_name, get_profile_dir, profile_exists
    name = normalize_profile_name(name)
    validate_profile_name(name)
    home = get_profile_dir(name).resolve()
    if not profile_exists(name) or not home.is_dir():
        raise ValueError("Profile does not exist; use hermes profile list")
    return name, home


def text(value):
    result = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return result if len(result) <= MAX_TEXT else result[:MAX_TEXT] + "\n[Content truncated]"


class Bridge:
    def __init__(self, profile, home, directory, token):
        self.profile, self.home, self.directory, self.token = profile, home, directory, token
        self.client = None
        self.description = {}
        self.lock = asyncio.Lock()
        self.viewers = set()
        self.wake = asyncio.Event()
        self.last_viewer_at = time.monotonic()
        self.epoch, self.sequence, self.subscription = None, 0, None
        self.live = {}
        self.segments = {}
        self.persisted_tools = set()
        self.state = dict(type="state", profile=profile, profile_id=str(home), connected=False,
                          error=None, session_id=None, title="Choose a conversation", model=None,
                          running=False, generation=0, items=[], prompts=[])
        try:
            saved = read_private(directory / "selection.json")
            if saved.get("profile_id") == str(home) and isinstance(saved.get("session_id"), str):
                self.state["session_id"] = saved["session_id"]
        except FileNotFoundError:
            pass

    def publish(self):
        self.render_live()
        data = encode(self.state)
        if len(data) > MAX_FRAME:
            self.state.update(prompts=[], error="Prompt display exceeds the native panel limit; answer in Hermes.")
            data = encode(self.state)
        for queue in tuple(self.viewers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(data)

    def notice(self, message, key="notice"):
        items = [row for row in self.state["items"] if row["id"] != key]
        items.append(dict(id=key, kind="notice", text=message))
        self.state["items"] = items[-MAX_ITEMS:]

    def render_live(self):
        while len(self.live) > MAX_ITEMS:
            self.live.pop(next(iter(self.live)))
        items = [row for row in self.state["items"] if not row["id"].startswith("live:") and row["id"] != "omitted"]
        items.extend(self.live.values())
        omitted = len(items) > MAX_ITEMS or any(row["id"] == "omitted" for row in self.state["items"])
        items = items[-MAX_ITEMS:]
        size = sum(len(encode(row)) for row in items)
        while items and size > MAX_FRAME // 2:
            size -= len(encode(items.pop(0)))
            omitted = True
        if omitted:
            items = items[-(MAX_ITEMS - 1):]
            items.insert(0, dict(id="omitted", kind="notice", text="Older transcript items omitted."))
        self.state["items"] = items

    def prompt(self, value, kind=None):
        return dict(id=value["prompt_id"], kind=kind or value["kind"],
                    generation=value["execution_generation"], choices=value.get("choices", []),
                    **{k: value[k] for k in ("question", "command", "description", "multi_select") if value.get(k) is not None})

    async def unsupported(self, frame):
        # These are JSON-RPC requests, not shared approval/clarify events.
        if "id" in frame:
            await self.client.websocket.send(json.dumps(dict(jsonrpc="2.0", id=frame["id"],
                error=dict(code=-32601, message="unsupported_method"))))

    async def snapshot(self, snapshot):
        # The authenticated authority resolves legacy/compression IDs to their canonical owner.
        sid = snapshot.get("stored_session_id")
        info = snapshot.get("info") or {}
        if not isinstance(sid, str) or not sid:
            raise ValueError("Gateway returned no canonical session identity")
        if info.get("profile_id") not in (None, str(self.home)):
            raise ValueError("Session profile identity mismatch")
        self.epoch = snapshot["replay_epoch"]
        self.sequence = snapshot["last_sequence"]
        self.subscription = snapshot["subscription_id"]
        self.live = {}
        self.segments = {}
        items = []
        raw_rows = snapshot.get("messages", [])
        raw_tools = {r.get("tool_call_id"): r for r in raw_rows if r.get("role") == "tool"}
        self.persisted_tools = set(raw_tools) - {None}
        known_inputs = {(r.get("display_metadata") or {}).get("submission_id") for r in raw_rows}
        rows = snapshot.get("display_messages", raw_rows)
        for index, projected in enumerate(rows):
            row = {**raw_tools.get(projected.get("tool_call_id"), {}), **projected} if projected.get("role") == "tool" else projected
            if row.get("display_kind") == "hidden" or (row.get("display_metadata") or {}).get("model_only"):
                continue
            role = row.get("role")
            if role not in {"user", "assistant", "tool"}:
                continue
            key = "row:" + str(row.get("row_id", row.get("tool_call_id") or index))
            if row.get("reasoning"):
                items.append(dict(id=key + ":thinking", kind="thinking", text=text(row["reasoning"])))
            content = row.get("text") or row.get("content") or ""
            if content or role == "tool":
                item = dict(id=key, kind=role, text=text(content))
                if role == "tool":
                    item.update(name=row.get("name") or row.get("tool_name") or "Tool",
                                status="error" if row.get("is_error") else "done",
                                input=text(row.get("args") or row.get("context") or ""))
                items.append(item)
        for pending in snapshot.get("pending", []):
            if pending.get("input_id") not in known_inputs and pending.get("text"):
                items.append(dict(id="pending:" + pending["admission_id"], kind="user",
                                  text=text(pending["text"]), status="running"))
        if len(items) > MAX_ITEMS:
            items = [dict(id="omitted", kind="notice", text="Older transcript items omitted.")] + items[-(MAX_ITEMS - 1):]
        if sid != self.state["session_id"]:
            atomic_json(self.directory / "selection.json", dict(profile_id=str(self.home), session_id=sid))
        self.state.update(session_id=sid, title=info.get("title") or sid, model=info.get("model"),
                          running=bool(snapshot.get("running")), generation=snapshot["execution_generation"],
                          items=items, prompts=[self.prompt(p) for p in snapshot.get("prompts", [])], error=None)
        if any(p.get("status") == "unknown" for p in snapshot.get("pending", [])):
            self.state["error"] = "Execution outcome unknown. Inspect this session in Hermes; do not resend the work."
        # Resume's watermark covers persisted history and prompt state, but not an in-flight
        # assistant segment. Recover only its current tail; prior tool boundaries are durable history.
        if snapshot.get("running"):
            replay = await self.client.rpc("session.events.since", session_id=sid,
                                           replay_epoch=self.epoch, last_sequence=0)
            if replay.get("snapshot_required"):
                self.notice("Earlier live output is unavailable; authoritative history will refresh when the turn settles.", "replay-gap")
            else:
                events = [e for e in replay.get("events", []) if e.get("seq", 0) <= self.sequence
                          and e.get("execution_generation") == self.state["generation"]]
                boundary = max((i for i, e in enumerate(events) if e.get("type") in {"tool.start", "message.complete"}), default=0)
                for event in events[boundary:]:
                    if event.get("type") in {"message.delta", "message.interim", "reasoning.delta", "tool.start", "tool.complete"}:
                        self.project(event)
        for request in snapshot.get("open_requests") or []:
            await self.unsupported(request)
        self.render_live()
        self.publish()

    def project(self, event):
        kind, payload = event.get("type"), event.get("payload") or {}
        admission = str(event.get("admission_id") or payload.get("admission_id") or self.state["generation"])
        if kind in {"message.delta", "reasoning.delta"}:
            if kind == "message.delta" and "text" in payload and payload["text"] is None:
                self.segments[admission] = event.get("seq", 0)
                return
            thinking = kind == "reasoning.delta"
            key = "live:" + admission + (":thinking:" if thinking else ":assistant:") + str(self.segments.get(admission, 0))
            delta = payload.get("text") or payload.get("delta") or payload.get("content")
            if not isinstance(delta, str):
                return
            row = self.live.setdefault(key, dict(id=key, kind="thinking" if thinking else "assistant", text=""))
            row["text"] = text(row["text"] + delta)
            self.state["running"] = True
        elif kind == "message.interim":
            if not payload.get("already_streamed") and isinstance(payload.get("text"), str):
                key = "live:" + admission + ":interim:" + str(event.get("seq", 0))
                self.live[key] = dict(id=key, kind="assistant", text=text(payload["text"]))
            self.segments[admission] = event.get("seq", 0)
        elif kind in {"tool.start", "tool.complete"}:
            call_id = payload.get("tool_call_id") or payload.get("tool_id")
            if kind == "tool.start":
                self.segments[admission] = event.get("seq", 0)
            if call_id in self.persisted_tools:
                return
            key = "live:tool:" + str(call_id or event.get("seq"))
            row = self.live.setdefault(key, dict(id=key, kind="tool", text=""))
            row.update(name=payload.get("tool_name") or payload.get("name") or "Tool",
                       input=text(payload.get("args") or ""), text=text(payload.get("result") or ""),
                       status="running" if kind == "tool.start" else "error" if payload.get("is_error") else "done")
        elif kind in {"approval.request", "clarify.request"}:
            p = self.prompt(payload, kind.split(".")[0])
            self.state["prompts"] = [x for x in self.state["prompts"] if x["id"] != p["id"]] + [p]
        elif kind in {"approval.settled", "clarify.settled"}:
            self.state["prompts"] = [p for p in self.state["prompts"] if p["id"] != payload.get("prompt_id")]
        elif kind == "session.info":
            for source, target in (("running", "running"), ("execution_generation", "generation"), ("model", "model"), ("title", "title")):
                if source in payload:
                    self.state[target] = payload[source]
            if any(p.get("status") == "unknown" for p in payload.get("pending", [])):
                self.state["error"] = "Execution outcome unknown; inspect in Hermes before resending."
        elif kind in {"status.update", "notification.show"} and payload.get("text"):
            self.notice(text(payload["text"]), "notice:" + str(event.get("seq")))
        elif kind == "message.complete":
            status = payload.get("status") or payload.get("outcome") or payload.get("finish_reason")
            if payload.get("error") or status in {"error", "failed", "cancelled", "interrupted", "unknown"}:
                self.notice("Turn " + str(status or "failed") + ".", "terminal")
        self.render_live()

    async def resume(self, sid):
        snapshot = await self.client.rpc("session.resume", session_id=sid, display_projection=True)
        await self.snapshot(snapshot)

    async def events(self):
        while True:
            frame = await self.client.events.get()
            if isinstance(frame, Exception):
                raise frame
            async with self.lock:
                if frame.get("method") != "event":
                    await self.unsupported(frame)
                    continue
                event = frame.get("params") or {}
                if event.get("session_id") != self.state["session_id"]:
                    continue
                if event.get("type") == "session.replay_gap" or event.get("replay_epoch") != self.epoch:
                    await self.resume(self.state["session_id"])
                    continue
                sequence = event.get("seq", 0)
                if sequence <= self.sequence:
                    continue
                if sequence != self.sequence + 1:
                    await self.resume(self.state["session_id"])
                    continue
                self.sequence = sequence
                self.state["generation"] = event.get("execution_generation", self.state["generation"])
                self.project(event)
                if event.get("type") == "message.complete":
                    terminal = next((x for x in self.state["items"] if x["id"] == "terminal"), None)
                    await self.resume(self.state["session_id"])
                    if terminal:
                        self.notice(terminal["text"], "terminal")
                self.publish()

    async def gateway_loop(self):
        from hermes_cli.gateway_client import connect_gateway, GatewayRPCError
        from hermes_cli.gateway_runtime import discover_gateway_endpoint
        while True:
            try:
                discovered = await asyncio.to_thread(discover_gateway_endpoint, self.home)
                endpoint = discovered.endpoint
                if discovered.state != "ready" or endpoint is None:
                    raise ValueError("Gateway unavailable (" + discovered.state + "). Start this profile's gateway outside Shepherd, then Retry.")
                if endpoint.profile_id != str(self.home):
                    raise ValueError("Discovered gateway profile identity mismatch")
                async with connect_gateway(endpoint=endpoint) as client:
                    async with self.lock:
                        description = await client.rpc("runtime.describe")
                        if any(description.get(k) != getattr(endpoint, k) for k in ("profile_id", "instance_id", "authority_epoch")):
                            raise ValueError("Runtime profile/authority identity mismatch")
                        self.description, self.client = description, client
                        self.state.update(connected=True, error=None)
                        if self.state["session_id"]:
                            try:
                                await self.resume(self.state["session_id"])
                            except GatewayRPCError as exc:
                                atomic_json(self.directory / "selection.json", dict(profile_id=str(self.home), session_id=None))
                                self.epoch, self.sequence, self.subscription = None, 0, None
                                self.live.clear()
                                self.state.update(session_id=None, title="Choose a conversation", model=None,
                                                  running=False, generation=0, items=[], prompts=[], error=None)
                                self.notice(f"Saved conversation unavailable ({exc}). Choose New or History.", "selection-unavailable")
                        self.publish()
                    await self.events()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # GatewayClient errors are bounded reason codes; never expose raw peer diagnostics.
                safe = str(exc) if isinstance(exc, ValueError) else "Gateway disconnected; execution outcome unknown. Reconnect before resending."
                async with self.lock:
                    self.client = None
                    self.state.update(connected=False, error=safe[:500])
                    self.publish()
            self.wake.clear()
            try:
                await asyncio.wait_for(self.wake.wait(), 3)
            except TimeoutError:
                pass

    async def request(self, request):
        async with self.lock:
            op = request.get("op")
            if op == "refresh" and self.client is None:
                self.wake.set()
                return {}
            if self.client is None:
                raise ValueError("Gateway disconnected; reconnect before sending. Nothing was sent.")
            if op == "sessions":
                sessions = {}
                for scope in ("stored", "live"):
                    result = await self.client.rpc("session.list", scope=scope, limit=200, picker=True)
                    for row in result.get("sessions", []):
                        sid = row.get("resolved_id") or row.get("session_id") or row["id"]
                        sessions[sid] = {**row, "id": sid}
                rows = sorted(sessions.values(), key=lambda r: r.get("last_active_at") or r.get("started_at") or 0, reverse=True)[:200]
                return dict(sessions=[dict(id=r["id"], title=r.get("title") or r["id"], running=bool(r.get("running"))) for r in rows])
            if op in {"resume", "new", "refresh"}:
                old_sid, old_sub = self.state["session_id"], self.subscription
                if op == "new":
                    contract = self.description.get("session_create") or {}
                    source = next((s for s in ("tui", "cli") if s in contract.get("sources", [])), None)
                    if source is None or "cwd" not in contract.get("parameters", []):
                        raise ValueError("Gateway cannot create a home-directory tui/cli session; update Hermes.")
                    snapshot = await self.client.rpc("session.create", source=source, cwd=str(Path.home()), request_id=uuid.uuid4().hex)
                    await self.snapshot(snapshot)
                else:
                    sid = request.get("session_id") if op == "resume" else old_sid
                    if sid is not None:
                        if not isinstance(sid, str) or not sid:
                            raise ValueError("A session id is required")
                        await self.resume(sid)
                if old_sid and old_sub and old_sid != self.state["session_id"]:
                    await self.client.rpc("session.detach", session_id=old_sid, subscription_id=old_sub)
                return {}
            if not request.get("session_id") or request["session_id"] != self.state["session_id"]:
                raise ValueError("Stale session selection; nothing was sent")
            sid = self.state["session_id"]
            if op == "send":
                body, identity = request.get("text"), request.get("request_id")
                if not isinstance(body, str) or not body.strip() or not isinstance(identity, str) or not identity or len(identity) > 200:
                    raise ValueError("Nonempty text and durable request_id are required")
                await self.client.rpc("prompt.submit", session_id=sid, text=body, submission_id=identity)
                # Admission is acknowledged already. Refresh only the read side, never re-submit.
                try:
                    await self.resume(sid)
                except Exception:
                    self.state["error"] = "Message accepted; history refresh unavailable. Reconnect without resending."
                    self.publish()
            elif op in {"stop", "answer"}:
                generation = request.get("generation")
                if type(generation) is not int or generation != self.state["generation"]:
                    raise ValueError("Stale execution generation; refresh before answering")
                if op == "stop":
                    await self.client.rpc("session.interrupt", session_id=sid, execution_generation=generation)
                else:
                    prompt = next((p for p in self.state["prompts"] if p["id"] == request.get("prompt_id") and p["generation"] == generation), None)
                    if prompt is None:
                        raise ValueError("Prompt is no longer open; refresh")
                    kind = prompt["kind"]
                    if kind == "approval":
                        value = request.get("choice")
                        if value not in prompt["choices"]:
                            raise ValueError("Choose an offered approval response")
                        answer = dict(choice=value)
                    else:
                        value = request.get("answer", request.get("choice"))
                        if not isinstance(value, str):
                            raise ValueError("A clarify answer is required")
                        answer = dict(answer=value)
                    result = await self.client.rpc(kind + ".respond", session_id=sid, prompt_id=prompt["id"], execution_generation=generation, **answer)
                    if result.get("status") in {"resolved", "already_resolved"}:
                        self.state["prompts"] = [p for p in self.state["prompts"] if p["id"] != prompt["id"]]
                        self.publish()
            else:
                raise ValueError("Unknown operation")
            return {}

    async def viewer(self, reader, writer):
        from hermes_cli.gateway_client import GatewayClientError, GatewayRPCError
        queue = asyncio.Queue(maxsize=2)
        sender = None
        async def states():
            try:
                while True:
                    writer.write(await queue.get())
                    await asyncio.wait_for(writer.drain(), 5)
            finally:
                writer.close()
        try:
            raw = await asyncio.wait_for(reader.readline(), 5)
            hello = json.loads(raw)
            if not isinstance(hello, dict):
                return
            supplied = hello.get("token")
            if hello.get("op") != "hello" or not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), self.token.encode()):
                return
            self.last_viewer_at = time.monotonic()
            writer.write(encode(self.state))
            await writer.drain()
            self.viewers.add(queue)
            sender = asyncio.create_task(states())
            while raw := await reader.readline():
                request = json.loads(raw)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                    raise ValueError("Invalid request")
                try:
                    result = await self.request(request)
                    reply = dict(type="reply", id=request["id"], ok=True, **result)
                except Exception as exc:
                    refused = isinstance(exc, GatewayRPCError) or (isinstance(exc, ValueError) and not isinstance(exc, GatewayClientError))
                    safe = str(exc) if refused else "Gateway request outcome unknown. Refresh; do not resend automatically."
                    reply = dict(type="reply", id=request["id"], ok=False, acknowledged=refused, error=safe[:500])
                writer.write(encode(reply))
                await asyncio.wait_for(writer.drain(), 5)
        except (ValueError, OSError, TimeoutError, asyncio.LimitOverrunError):
            pass
        finally:
            self.viewers.discard(queue)
            self.last_viewer_at = time.monotonic()
            if sender:
                sender.cancel()
                with contextlib.suppress(asyncio.CancelledError, OSError, TimeoutError):
                    await sender
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()


async def serve(profile, home, directory):
    token = secrets.token_urlsafe(32)
    bridge = Bridge(profile, home, directory, token)
    server = await asyncio.start_server(bridge.viewer, "127.0.0.1", 0, limit=MAX_FRAME)
    registration = dict(host="127.0.0.1", port=server.sockets[0].getsockname()[1], token=token,
                        profile_id=str(home), pid=os.getpid())
    atomic_json(directory / "registry.json", registration)
    task = asyncio.create_task(bridge.gateway_loop())
    try:
        async with server:
            while bridge.viewers or time.monotonic() - bridge.last_viewer_at < 60:
                await asyncio.sleep(1)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        with contextlib.suppress(OSError, ValueError):
            if read_private(directory / "registry.json").get("token") == token:
                (directory / "registry.json").unlink()


def registry_alive(directory, home):
    try:
        result = read_private(directory / "registry.json")
        if result.get("host") != "127.0.0.1" or result.get("profile_id") != str(home) or type(result.get("port")) is not int:
            return None
        if not isinstance(result.get("token"), str) or not result["token"]:
            return None
        with socket.create_connection(("127.0.0.1", result["port"]), timeout=0.4) as peer:
            peer.sendall(encode(dict(op="hello", token=result["token"])))
            with peer.makefile("rb") as stream:
                answer = json.loads(stream.readline(MAX_FRAME))
            if answer.get("type") != "state" or answer.get("profile_id") != str(home):
                return None
        return {k: result[k] for k in ("host", "port", "token")}
    except (OSError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--connect", action="store_true")
    mode.add_argument("--serve", action="store_true")
    parser.add_argument("--profile", default="coordinator")
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        profile, home = resolve_profile(args.profile)
        os.environ["HERMES_HOME"] = str(home)
        os.environ.pop("HERMES_TUI_GATEWAY_URL", None)
        root = args.state_dir.expanduser().resolve()
        private_dir(root)
        directory = root / hashlib.sha256(str(home).encode()).hexdigest()[:24]
        private_dir(directory)
        if args.serve:
            # A lifetime lock prevents manual --serve from replacing a registered viewer.
            fd = os.open(directory / "serve.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            asyncio.run(serve(profile, home, directory))
            return
        fd = os.open(directory / "connect.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            registration = registry_alive(directory, home)
            if registration is None:
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--serve", "--profile", profile,
                                          "--state-dir", str(root)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    registration = registry_alive(directory, home)
                    if registration:
                        break
                    if child.poll() is not None:
                        raise ValueError("Viewer bridge could not start; run --serve for diagnostics")
                    time.sleep(0.05)
                if registration is None:
                    raise ValueError("Viewer bridge did not become ready; run --serve for diagnostics")
            print(json.dumps(registration), flush=True)
    except (ValueError, OSError) as exc:
        print("Shepherd chat: " + str(exc), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()

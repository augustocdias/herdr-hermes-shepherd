import { div } from "gpui-kit";
import { v_flex, h_flex, Button, TextView, TextareaState, Textarea, InputState, Input, SliderState, Slider, SliderTrack, SliderIndicator, SliderThumb } from "gpui-base";
import { exec, appHome, shared, setShared, theme, run, nextCommand, openOverlay } from "herdr";
import { connect } from "net";
import { Buffer } from "buffer";

const DRAFT = "hermes-shepherd.chat-draft:";
const MAX_FRAME = 8 * 1024 * 1024;
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const message = (e) => e?.message ?? String(e);
const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const plain = (id, text) => TextView.html(id, `<pre>${escape(text)}</pre>`).selectable(true).text_size(12);
const control = (t, id, label, click, enabled = true, primary = false) => Button.new(id).tab_index(0)
  .flex().items_center().justify_center().h(28).px(9).flex_none().rounded(6).border_1().border_color(primary ? t.accent : t.input)
  .bg(primary ? t.accent : t.chrome).text_color(primary ? t.accent_foreground : t.foreground).text_size(12)
  .disabled(!enabled).when(!enabled, (el) => el.opacity(0.5)).on_click(click).child(label);

// All live state belongs to this viewer. The bridge owns conversation selection and work;
// shared storage holds drafts and durable send identities across copies and App restarts.
export class ShepherdChat {
  constructor(profile, logo) { this.getProfile = profile; this.logo = logo; }

  init(cx) {
    this.open = true; this.epoch = 0; this.pending = new Map(); this.answers = new Map();
    this.profile = this.getProfile(); this.state = null; this.socket = null; this.error = "";
    this.connecting = false; this.history = false; this.sessions = []; this.at = 0; this.mutation = false;
    this.expandedTools = new Set();
    this.scrollTop = 0; this.contentHeight = 0; this.viewportHeight = 0; this.followLatest = true;
    this.scrollPosition = SliderState.new({ min: 0, max: 1, step: 0.0001, value: 0 });
    this.scrollPosition.on("change", (value, cx) => this.scrollTimeline((1 - value) * this.scrollLimit(), cx));
    this.handle = cx.focus_handle();
    this.composer = TextareaState.new({ value: this.draft().text, placeholder: "Message Shepherd…", rows: 3 });
    this.composer.set_auto_grow(3, 7);
    this.composer.on("change", (_e, cx) => { this.saveDraft({ ...this.draft(), text: this.composer.value() }); cx.notify(); });
    cx.bind_keys([
      { keystroke: "enter", action: "shepherd-chat-send", context: "ShepherdChatComposer > Input" },
      { keystroke: "shift-enter", action: "shepherd-chat-newline", context: "ShepherdChatComposer > Input" },
    ]);
    this.start(cx);
    cx.spawn(async (cx) => {
      while (this.open) {
        const command = await nextCommand();
        if (!this.open) return;
        if (command === "focus") this.composer.focus();
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      while (this.open) {
        await cx.sleep(250);
        if (!this.open) return;
        const profile = this.getProfile();
        if (profile !== this.profile) {
          this.detach(); this.profile = profile; this.state = null; this.sessions = []; this.history = false;
          this.releaseAnswers(); this.composer.set_value(this.draft().text); this.start(cx);
        } else {
          const draft = this.draft(), version = JSON.stringify(draft);
          if (version !== this.draftVersion) {
            this.draftVersion = version;
            if (this.composer.value() !== draft.text) this.composer.set_value(draft.text);
            cx.notify();
          }
        }
      }
    });
  }

  draft() { return shared(DRAFT + this.profile) ?? { text: "", pending: null }; }
  saveDraft(draft) { setShared(DRAFT + this.profile, draft); }
  toggleTool(id) {
    this.followLatest = false;
    if (!this.expandedTools.delete(id)) this.expandedTools.add(id);
  }
  scrollLimit() { return Math.max(0, this.contentHeight - this.viewportHeight); }
  scrollTimeline(top, cx) {
    this.scrollTop = Math.max(0, Math.min(this.scrollLimit(), top));
    this.followLatest = this.scrollTop >= this.scrollLimit() - 1;
    const position = this.scrollLimit() ? 1 - this.scrollTop / this.scrollLimit() : 0;
    if (Math.abs(this.scrollPosition.value() - position) > 0.00001) this.scrollPosition.set_value(position);
    cx.notify();
  }
  measureTimeline(field, height, cx) {
    if (this[field] === height) return;
    this[field] = height;
    this.scrollTimeline(this.followLatest && !this.history ? this.scrollLimit() : this.scrollTop, cx);
  }
  releaseAnswers() { for (const value of this.answers.values()) value.input.release(); this.answers.clear(); }
  close() { this.open = false; this.detach(); this.composer.release(); this.scrollPosition.release(); this.releaseAnswers(); }

  detach() {
    ++this.epoch;
    this.socket?.close(); this.socket = null; this.connecting = false;
    if (this.state) this.state = { ...this.state, connected: false };
    for (const request of this.pending.values()) request.reject(new Error("Connection closed. The request may already have reached Hermes."));
    this.pending.clear();
  }

  start(cx) {
    this.detach(); this.error = ""; this.connecting = true; this.state = null;
    const epoch = this.epoch, profile = this.profile;
    cx.spawn(async (cx) => {
      let socket;
      try {
        const result = await exec("hermes-shepherd-chat", ["--connect", "--profile", profile, "--state-dir", `${appHome()}/data/hermes-shepherd-chat`]);
        if (!this.open || epoch !== this.epoch) return;
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Cannot connect to the chat bridge.");
        const endpoint = JSON.parse(result.stdout);
        if (endpoint.host !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== "string" || !endpoint.token)
          throw new Error("The chat bridge returned an invalid local endpoint.");
        socket = await connect(endpoint.host, endpoint.port);
        if (!this.open || epoch !== this.epoch) { socket.close(); return; }
        this.socket = socket;
        await socket.write(JSON.stringify({ op: "hello", token: endpoint.token }) + "\n");
        cx.spawn(async (cx) => {
          await cx.sleep(15000);
          if (this.open && epoch === this.epoch && this.connecting) { this.error = "The chat bridge did not provide a session state. Retry to reconnect."; socket.close(); cx.notify(); }
        });
        let buffer = new Uint8Array(0);
        while (this.open && epoch === this.epoch) {
          let chunk;
          try { chunk = await socket.read(65536); }
          catch (e) {
            // Native socket reads time out while an otherwise healthy chat is idle.
            if (/temporarily unavailable|WouldBlock|timed out|os error (11|35)/i.test(message(e))) continue;
            throw e;
          }
          if (epoch !== this.epoch || !this.open) return;
          if (chunk === null) throw new Error("Disconnected. Gateway work continues; Retry reconnects without resending messages.");
          const merged = new Uint8Array(buffer.length + chunk.length);
          merged.set(buffer); merged.set(chunk, buffer.length); buffer = merged;
          let start = 0;
          for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] !== 10) continue;
            if (i - start > MAX_FRAME) throw new Error("The chat bridge sent an oversized frame.");
            const line = Buffer.from(buffer.subarray(start, i)).toString("utf8");
            start = i + 1;
            if (line.trim()) this.receive(JSON.parse(line));
          }
          buffer = buffer.slice(start);
          if (buffer.length > MAX_FRAME) throw new Error("The chat bridge sent an oversized frame.");
          cx.notify();
        }
      } catch (e) {
        if (this.open && epoch === this.epoch) { this.error ||= message(e); this.detach(); cx.notify(); }
      } finally { socket?.close(); }
    });
    cx.notify();
  }

  receive(event) {
    if (event.type === "state") {
      if (event.profile !== this.profile) throw new Error("Refused state from a different Hermes profile.");
      if (event.session_id !== this.state?.session_id) { this.expandedTools.clear(); this.followLatest = true; }
      const tools = new Set((event.items ?? []).filter((item) => item.kind === "tool").map((item) => item.id));
      for (const id of this.expandedTools) if (!tools.has(id)) this.expandedTools.delete(id);
      this.state = event; this.connecting = false;
      const prompts = new Set((event.prompts ?? []).map((p) => p.id));
      for (const [id, value] of this.answers) if (!prompts.has(id)) { value.input.release(); this.answers.delete(id); }
      for (const prompt of event.prompts ?? []) {
        const current = this.answers.get(prompt.id);
        if (current?.generation === prompt.generation) continue;
        current?.input.release();
        this.answers.set(prompt.id, { generation: prompt.generation, input: InputState.new({ placeholder: "Your answer…" }), selected: [] });
      }
    } else if (event.type === "reply") {
      const request = this.pending.get(event.id);
      if (!request) return;
      this.pending.delete(event.id);
      if (event.ok) request.resolve(event);
      else request.reject(Object.assign(new Error(event.error || "Hermes refused the request."), { acknowledged: event.acknowledged === true }));
    } else if (event.type === "error") throw new Error(event.error || "Chat bridge error.");
  }

  request(op, fields, cx) {
    if (!this.socket || this.connecting) return Promise.reject(new Error("Not connected. Retry before acting."));
    const id = uid(), socket = this.socket;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      cx.spawn(async (cx) => {
        try { await socket.write(JSON.stringify({ id, op, ...fields }) + "\n"); }
        catch (e) { if (this.pending.delete(id)) reject(e); return; }
        await cx.sleep(30000);
        if (this.pending.delete(id)) reject(new Error("No acknowledgement. The request may already have reached Hermes; reconnect before deciding what to do."));
      });
    });
  }

  ready() { return Boolean(this.socket && !this.connecting && this.state?.connected && !this.state.error && !this.error); }

  action(op, fields, cx) {
    if (this.mutation || !this.ready()) return;
    this.mutation = true; this.error = "";
    const epoch = this.epoch;
    cx.spawn(async (cx) => {
      try {
        const reply = await this.request(op, fields, cx);
        if (epoch !== this.epoch) return;
        if (op === "sessions") { this.sessions = reply.sessions ?? []; this.at = 0; this.history = true; this.scrollTimeline(0, cx); this.handle.focus(); }
        if (op === "new" || op === "resume") { this.history = false; this.scrollTimeline(this.scrollLimit(), cx); this.composer.focus(); }
      } catch (e) { if (epoch === this.epoch) this.error = message(e); }
      finally { this.mutation = false; if (this.open) cx.notify(); }
    });
    cx.notify();
  }

  send(cx, retry = false) {
    const draft = this.draft();
    if (this.mutation || !this.ready() || !this.state.session_id || (!retry && draft.pending)) return;
    if (!retry && !draft.text.trim()) return;
    const pending = retry ? draft.pending : { request_id: uid(), text: draft.text, session_id: this.state.session_id };
    if (!pending || pending.session_id !== this.state.session_id) return;
    const profile = this.profile, epoch = this.epoch, key = DRAFT + profile;
    this.saveDraft({ ...draft, pending }); this.mutation = true;
    cx.spawn(async (cx) => {
      try {
        await this.request("send", pending, cx);
        const current = shared(key);
        if (current?.pending?.request_id === pending.request_id) setShared(key, { text: current.text === pending.text ? "" : current.text, pending: null });
        if (epoch === this.epoch) this.composer.set_value(this.draft().text);
      } catch (e) {
        // Never infer rejection from a lost acknowledgement, nor automatically resend.
        if (e.acknowledged) {
          const current = shared(key);
          if (current?.pending?.request_id === pending.request_id) setShared(key, { ...current, pending: null });
        }
        if (epoch === this.epoch) this.error = message(e);
      } finally { this.mutation = false; if (this.open) cx.notify(); }
    });
    cx.notify();
  }

  answer(prompt, cx, choice) {
    const value = this.answers.get(prompt.id);
    if (!value) return;
    const fields = { session_id: this.state.session_id, prompt_id: prompt.id, generation: prompt.generation };
    if (prompt.kind === "approval") fields.choice = choice;
    else fields.answer = choice ?? (value.input.value().trim() || (prompt.multi_select ? JSON.stringify(value.selected) : ""));
    this.action("answer", fields, cx);
  }

  render(cx) {
    const t = theme(), state = this.state, ready = this.ready(), draft = this.draft();
    const pending = draft.pending;
    const note = (text, error = false) => div().text_size(12).text_color(error ? t.blocked : t.muted).child(text);
    const item = (entry) => {
      const tool = entry.kind === "tool", expanded = !tool || this.expandedTools.has(entry.id);
      const label = `${entry.name || ({ user: "You", assistant: "Shepherd", thinking: "Thinking", tool: "Tool", notice: "Notice" }[entry.kind] ?? entry.kind)}${entry.status ? ` · ${entry.status}` : ""}`;
      return v_flex().id(`chat-item-${entry.id}`).flex_none().min_w(0).p(tool ? 6 : 10).gap(5).rounded(7)
        .bg(entry.kind === "user" ? t.raised : t.background).border_1().border_color(t.border)
        .child(tool
          ? Button.new(`chat-tool-${entry.id}`).tab_index(0).flex().w_full().min_w(0).items_center().gap(6).h(24).px(4)
            .text_size(11).text_color(entry.status === "error" ? t.blocked : t.muted)
            .tooltip(`${expanded ? "Collapse" : "Expand"} tool details: ${entry.name || "Tool"}`)
            .on_click((_e, cx) => { this.toggleTool(entry.id); cx.notify(); })
            .child(div().flex_none().child(expanded ? "▾" : "▸"))
            .child(div().flex_1().min_w(0).truncate().child(entry.name || "Tool"))
            .when(Boolean(entry.status), (el) => el.child(div().flex_none().child(entry.status)))
          : div().text_size(11).font_semibold().text_color(entry.status === "error" ? t.blocked : t.muted).child(label))
        .when(expanded, (el) => el
          .when(Boolean(entry.input), (el) => el.child(plain(`chat-input-${entry.id}`, entry.input)))
          .child(entry.kind === "assistant" || entry.kind === "user"
            ? TextView.markdown(`chat-text-${entry.id}`, entry.text || "…").selectable(true).text_size(13)
            : plain(`chat-text-${entry.id}`, entry.text || (entry.status === "running" ? "Working…" : ""))));
    };
    const promptCard = (prompt) => {
      const answer = this.answers.get(prompt.id);
      return v_flex().id(`chat-prompt-${prompt.id}`).flex_none().p(10).gap(8).rounded(7).border_1().border_color(t.accent)
        .child(note(prompt.kind === "approval" ? "Approval required" : "Clarification required"))
        .when(Boolean(prompt.question || prompt.description), (el) => el.child(note(prompt.question || prompt.description)))
        .when(Boolean(prompt.question && prompt.description && prompt.question !== prompt.description), (el) => el.child(note(prompt.description)))
        .when(Boolean(prompt.command), (el) => el.child(plain(`chat-command-${prompt.id}`, prompt.command)))
        .child(h_flex().flex_wrap().gap(6).children((prompt.choices ?? []).map((choice, i) => control(t, `chat-choice-${prompt.id}-${i}`,
          `${answer?.selected.includes(choice) ? "Selected: " : ""}${choice}`, (_e, cx) => {
            if (prompt.kind === "clarify" && prompt.multi_select) {
              answer.selected = answer.selected.includes(choice) ? answer.selected.filter((c) => c !== choice) : [...answer.selected, choice]; cx.notify();
            } else this.answer(prompt, cx, choice);
          }, ready && !this.mutation))))
        .when(prompt.kind === "clarify" && Boolean(answer), (el) => el
          .child(Input.new(answer.input).h(30).px(8).border_1().border_color(t.input).rounded(6).bg(t.chrome))
          .child(control(t, `chat-answer-${prompt.id}`, "Answer", (_e, cx) => this.answer(prompt, cx), ready && !this.mutation)));
    };
    const items = state?.items ?? [];
    return v_flex().id("shepherd-panel").track_focus(this.handle).size_full().min_h(0).min_w(0).bg(t.canvas).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (!this.history || !this.handle.is_focused()) return;
        if (e.key === "down" || e.key === "up") this.at = Math.max(0, Math.min(this.sessions.length - 1, this.at + (e.key === "down" ? 1 : -1)));
        else if (e.key === "enter" && this.sessions[this.at]) this.action("resume", { session_id: this.sessions[this.at].id }, cx);
        else if (e.key === "escape") { this.history = false; this.scrollTimeline(this.scrollLimit(), cx); this.composer.focus(); }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(v_flex().flex_none().p(10).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .when(Boolean(this.logo), (el) => el.child(this.logo(24)))
          .child(div().font_semibold().text_size(13).child("Shepherd"))
          .child(Button.new("chat-profile").tab_index(0).flex().items_center().flex_1().min_w(0).h(28).px(6).rounded(6).text_color(t.muted).text_size(12)
            .tooltip("Change Hermes profile in Settings")
            .on_click(() => openOverlay({ mod: "hermes-shepherd", kind: "dialog", modal: true, width: 860, height: 0.85, props: { settings: true } }))
            .child(div().min_w(0).truncate().child(this.profile)))
          .child(control(t, "shepherd-hide", "Hide", () => run("layout.hide", { id: "shepherd" }))))
        .child(h_flex().gap(6).items_center()
          .child(control(t, "chat-new", "New", (_e, cx) => this.action("new", {}, cx), ready && !this.mutation))
          .child(control(t, "chat-history", this.history ? "Back" : "History", (_e, cx) => {
            if (this.history) { this.history = false; this.scrollTimeline(this.scrollLimit(), cx); this.composer.focus(); }
            else this.action("sessions", {}, cx);
          }, ready && !this.mutation))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.connecting ? "Connecting…" : !state?.connected ? "Disconnected" : state.running ? "Running" : "Connected")))
        .when(Boolean(state?.session_id), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(`${state.title || state.session_id}${state.model ? ` · ${state.model}` : ""}`))))
      // Own the offset because native overflow containers expose no scroll-to-bottom control.
      .child(div().id("chat-timeline").relative().flex_1().min_h(0).min_w(0).overflow_hidden()
        .on_size_change((size, cx) => this.measureTimeline("viewportHeight", size.height, cx))
        .on_scroll_wheel((event, cx) => { this.scrollTimeline(this.scrollTop - event.delta.y, cx); cx.stop_propagation(); })
        .child(v_flex().id("chat-content").absolute().top(-(this.followLatest && !this.history ? this.scrollLimit() : this.scrollTop))
          .left(0).right(14).p(10).gap(10)
          .on_size_change((size, cx) => this.measureTimeline("contentHeight", size.height, cx))
        .when(Boolean(this.error || state?.error || (state && !state.connected)), (el) => el.child(v_flex().gap(8).child(note(this.error || state?.error || "The profile's gateway is disconnected. Retry reconnects without starting it.", true))
          .child(control(t, "chat-retry", "Retry connection", (_e, cx) => this.start(cx), !this.connecting))))
        .when(this.history, (el) => el.child(v_flex().gap(6).child(note("Choose a conversation. ↑ ↓ and Enter resume; Esc returns."))
          .when(!this.sessions.length, (el) => el.child(note("No stored conversations in this profile.")))
          .children(this.sessions.map((session, i) => Button.new(`chat-session-${session.id}`).tab_index(0).w_full().min_w(0).px(9).py(7)
            .rounded(6).border_1().border_color(i === this.at ? t.accent : t.input).bg(t.chrome).disabled(!ready || this.mutation).tooltip(session.id)
            .on_click((_e, cx) => this.action("resume", { session_id: session.id }, cx))
            .child(div().min_w(0).truncate().text_size(12).child(`${session.title || session.id}${session.running ? " · running" : ""}`))))))
        .when(!this.history, (el) => el
          .when(Boolean(state?.connected && !state.session_id), (el) => el.child(note("Choose History or New to start a conversation. No recent session is selected automatically.")))
          .when(items.length > 250, (el) => el.child(note(`${items.length - 250} older entries omitted from this view.`)))
          .children(items.slice(-250).map(item)).children((state?.prompts ?? []).map(promptCard))))
        .when(this.scrollLimit() > 0, (el) => el.child(Slider.new(this.scrollPosition).axis("vertical").absolute().top(16).bottom(16).right(2).w(10)
          .child(SliderTrack.new(this.scrollPosition).axis("vertical").size_full()
            .child(SliderIndicator.new(this.scrollPosition).axis("vertical").relative().size_full().rounded(5).bg(t.chrome)
              .child(SliderThumb.new(this.scrollPosition).axis("vertical").tab_index(0).w(8).h(24).mb(-12).rounded(4).bg(t.muted).tooltip("Scroll conversation")))))))
      .child(v_flex().flex_none().p(10).gap(7).border_t(1).border_color(t.border)
        .when(!this.history && !this.followLatest, (el) => el.child(control(t, "chat-latest", "↓ Latest", (_e, cx) => this.scrollTimeline(this.scrollLimit(), cx))))
        .when(Boolean(pending), (el) => el.child(note(`A send to ${pending.session_id} is awaiting acknowledgement or its outcome is uncertain. Reconnect and inspect that conversation before explicitly retrying the same request.`, true))
          .child(control(t, "chat-retry-send", "Retry same send", (_e, cx) => this.send(cx, true), ready && !this.mutation && pending.session_id === state?.session_id)))
        .child(v_flex().key_context("ShepherdChatComposer")
          .on_action("shepherd-chat-send", (_e, cx) => { this.send(cx); cx.stop_propagation(); })
          .on_action("shepherd-chat-newline", (_e, cx) => { this.composer.replace("\n"); cx.stop_propagation(); })
          .child(Textarea.new(this.composer).w_full().h(84).p(8).rounded(7).border_1().border_color(t.input).bg(t.chrome).text_color(t.foreground).text_size(13)))
        .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).text_size(10).text_color(t.muted).child("Enter sends · Shift+Enter newline"))
          .child(control(t, "chat-stop", "Stop", (_e, cx) => this.action("stop", { session_id: state.session_id, generation: state.generation }, cx), ready && Boolean(state?.running) && !this.mutation))
          .child(control(t, "chat-send", this.mutation ? "Waiting…" : "Send", (_e, cx) => this.send(cx), ready && Boolean(state?.session_id) && !this.mutation && !pending && Boolean(draft.text.trim()), true))));
  }
}

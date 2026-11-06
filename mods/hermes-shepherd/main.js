// Hermes Shepherd: a view of a Hermes kanban board, opened as a tab.
// The board is the one named like the tab (slug or display name); otherwise Hermes's
// default board, and the toolbar says so. Repository and spec filters are global.
// Opened as a popup with props { menu } it is the board's own filter picker; with props { cron }
// it is the read-only cron jobs dialog; as a dialog with props { task } it is that task's details (TaskDetails);
// with props { settings } it is the session rules dialog (SessionSettings).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { spaces, panes, terminals, exec, hc, home, appHome, readTextFile, writeTextFile, run, watchFolder, theme, shared, setShared, props, openOverlay, closeOverlay, nextCommand } from "herdr";

const MOD = "hermes-shepherd";
// Herdr App draws nothing for an SVG that is a symlink (Home Manager installs files as store symlinks),
// so the icons live here and are written as real files on load; unchanged files are left alone.
const SVG = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
const ICONS = {
  icon: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v9"/>'),
  coordinator: SVG('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  cron: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  settings: SVG('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
};
(async () => {
  for (const [name, text] of Object.entries(ICONS)) {
    const path = `${appHome()}/mods/${MOD}/${name}.svg`;
    try {
      // The mod API cannot stat or unlink, and writeTextFile writes through a symlink, so `test -L` and `rm` do.
      const link = (await exec("test", ["-L", path])).code === 0;
      if (link) await exec("rm", ["-f", path]);
      const current = link ? null : await readTextFile(path);
      if (current !== text) await writeTextFile(path, text, current);
    } catch (e) { console.log(`hermes-shepherd: cannot write ${path}: ${e}`); }
  }
})();
const HELPER = "hermes-shepherd-board";
const FILTERS = "hermes-shepherd.filters";
const CARD = 248;
const POLL_MS = 30000;
// Hermes stores `scheduled`; Shepherd shows it as Parked. Nothing else is renamed.
const DISPLAY = { scheduled: "Parked" };
const MARKER = { triage: "ansi5", todo: "idle", scheduled: "unknown", ready: "ansi4", running: "working", blocked: "blocked", review: "ansi6", done: "ansi2" };

const label = (column) => DISPLAY[column.key] ?? column.label;
const short = (path) => path.split("/").filter(Boolean).pop() || path;
// null: every task. "": tasks without that metadata. Any other value: exactly that value.
const matches = (value, filter) => filter == null || (filter === "" ? !value : value === filter);
const describe = (filter) => filter == null ? "All" : filter === "" ? "None" : short(filter);
const count = (cols) => cols.reduce((n, c) => n + c.tasks.length, 0);
const activeTab = () => spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;

// One coordinator serves every Shepherd tab in every space: the user's own `hermes -p coordinator`,
// started once in Core through the `hermes` on PATH, so the user's wrapper and jail apply.
// Each Shepherd tab shows it in a right split running `hc attach`; closing or hiding that split
// never ends the coordinator, and an exited coordinator is restarted only by the person.
const COORDINATOR = "hermes-shepherd.coordinator"; // shared: { address, error, hidden }
const COORDINATOR_NAME = "hermes-coordinator";
const COORDINATOR_ARGV = ["hermes", "-p", "coordinator"];
const ATTACH = "hermes-shepherd.attach"; // label on a tab's attach terminal: the coordinator it shows
const coordinator = () => shared(COORDINATOR) ?? {};
// Controls show the coordinator's visibility, so publish them with every change to it.
const setCoordinator = (patch) => { setShared(COORDINATOR, { ...coordinator(), ...patch }); publishControls(); };
// `hc --json` prints its reply on stdout, or `{ error: { message, hint } }` on stderr.
const hcReply = (result) => { for (const text of [result.stdout, result.stderr]) { try { return JSON.parse(text); } catch {} } return null; };
const hcError = (result, reply) => reply?.error?.message ?? (result.stderr.trim() || `hc exited with code ${result.code}`);
const CRON_HELPER = "hermes-shepherd-cron";
const stamp = (iso) => { const d = iso && new Date(iso); return d && !isNaN(d) ? d.toLocaleString() : "—"; };

// Top-right tab-bar controls, published as herdr-navigation's `tab-controls:hermes-shepherd`.
// Add a control with one entry: Smart Tabs runs `hermes-shepherd.<id>`, which reaches `run` in the shown copy.
// Published from init and whenever the coordinator state changes, not on every render.
const CONTROLS = [
  { id: "coordinator", label: "Coordinator", icon: `mods/${MOD}/coordinator.svg`,
    active: () => !coordinator().hidden, run: () => setCoordinator({ hidden: !coordinator().hidden }) },
  { id: "cron", label: "Cron jobs", icon: `mods/${MOD}/cron.svg`,
    run: () => openOverlay({ mod: MOD, kind: "dialog", width: 640, height: 560, props: { cron: true } }) },
  { id: "settings", label: "Settings", icon: `mods/${MOD}/settings.svg`,
    run: () => openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 860, height: 0.85, props: { settings: true } }) },
];
const publishControls = () => {
  const list = CONTROLS.map(({ id, label, icon, active }) => ({ id, label, icon, command: `${MOD}.${id}`, active: Boolean(active?.()) }));
  const key = `tab-controls:${MOD}`;
  if (JSON.stringify(shared(key)) !== JSON.stringify(list)) setShared(key, list);
};

export default class Shepherd extends View {
  init(_props, cx) {
    if (props()?.task) { this.details = new TaskDetails(); this.details.init(cx); return; }
    if (props()?.settings) { this.details = new SessionSettings(); this.details.init(cx); return; }
    this.handle = cx.focus_handle();
    if (props()?.menu) { this.at = 0; this.handle.focus(); return; }
    if (props()?.cron) { this.jobs = null; this.error = ""; this.loadCron(cx); this.handle.focus(); return; }
    this.data = null; this.error = ""; this.loading = false; this.queued = false; this.updated = null;
    this.sel = null; this.tab = null; this.requested = undefined; this.watches = 0;
    cx.timer.every(POLL_MS, (cx) => { if (this.requested !== undefined) this.refresh(cx); });
    this.busy = false; this.attaching = null; this.zoomedFor = undefined; this.tail = null;
    publishControls();
    cx.spawn(async (cx) => {
      for (;;) { const id = await nextCommand(); CONTROLS.find((c) => c.id === id)?.run(this, cx); cx.notify(); }
    });
  }

  // The coordinator as Core sees it: none yet, live, ended (exited or gone), unknown, or failed to start.
  // terminals() lists live terminals only, and a new one shows up a little after `hc run` returns,
  // so an unlisted coordinator is asked about with `hc get` (readEnd) before it counts as ended.
  coordinatorStatus() {
    const { address, error } = coordinator();
    if (error) return { kind: "failed" };
    if (!address) return { kind: "none" };
    if (terminals().some((t) => t.address === address && t.state === "live")) return { kind: "live" };
    const end = this.tail?.address === address ? this.tail : null;
    return { kind: end?.gone || (end?.term && end.term.state !== "live") ? "ended" : "unknown" };
  }

  // Runs in the shown copy on every render; each step is idempotent and does nothing while one is in flight.
  ensureCoordinator(cx) {
    if (!this.tab || this.tab !== activeTab() || this.busy) return;
    const { address, hidden } = coordinator();
    const status = this.coordinatorStatus();
    if (status.kind === "none") { if (!hidden) this.launchCoordinator(cx); return; }
    if (status.kind === "unknown" && this.tail?.address !== address) this.readEnd(address, cx);
    if (status.kind !== "live") return;
    const live = terminals().filter((t) => t.state === "live");
    const attach = live.find((t) => t.labels?.[ATTACH] === address && t.labels?.["herdr.tab"] === this.tab);
    // An attach just started may not be listed yet; give it a few seconds before starting another.
    // Attach terminals run with --rm, so an ended one is never listed again.
    const pending = this.attaching && Date.now() - this.attaching.at < 5000 && !terminals().some((t) => t.address === this.attaching.address);
    // A failed attach waits for the person (the banner's button) instead of retrying on every render.
    if (!attach && !pending && !hidden && !this.attachError) this.attachCoordinator(address, cx);
    // Hiding zooms the board pane, so the split and its width stay for the next show. Applied once per change.
    const pane = panes().find((p) => p.mod === MOD && p.tab === this.tab);
    if (attach && pane && this.zoomedFor !== Boolean(hidden)) {
      this.zoomedFor = Boolean(hidden);
      if (pane.zoomed !== Boolean(hidden)) run("pane.zoom", { pane: pane.pane });
    }
  }

  launchCoordinator(cx) {
    this.busy = true;
    cx.spawn(async (cx) => {
      // A live terminal with the coordinator's name is ours already (e.g. after shared state was lost).
      const adopt = () => terminals().find((t) => t.state === "live" && t.name === COORDINATOR_NAME);
      try {
        if (adopt()) { setCoordinator({ address: adopt().address, error: null }); return; }
        let result;
        try { result = await hc(["run", "--bg", "--json", "--no-parent", "--name", COORDINATOR_NAME, "--cwd", home(), "--", ...COORDINATOR_ARGV]); }
        catch (e) { throw new Error(`Cannot run hc: ${e?.message ?? e}`); }
        const reply = hcReply(result);
        if (result.code === 0 && reply?.address) { setCoordinator({ address: reply.address, error: null }); return; }
        if (adopt()) { setCoordinator({ address: adopt().address, error: null }); return; }
        throw new Error(hcError(result, reply));
      } catch (e) {
        setCoordinator({ address: null, error: e?.message ?? String(e) });
      } finally { this.busy = false; cx.notify(); }
    });
  }

  attachCoordinator(address, cx) {
    const space = spaces().find((s) => s.tabs.some((t) => t.id === this.tab));
    if (!space) return;
    if (space.machine) { this.attachError = "The coordinator runs on this computer, so a Shepherd tab in a space on another machine cannot show it."; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const result = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--label", `herdr.space=${space.id}`,
          "--label", `herdr.tab=${this.tab}`, "--label", `${ATTACH}=${address}`, "--", "hc", "attach", address]);
        const reply = hcReply(result);
        this.attaching = reply?.address ? { address: reply.address, at: Date.now() } : null;
        this.attachError = result.code === 0 ? "" : hcError(result, reply);
      } catch (e) {
        this.attachError = e?.message ?? String(e);
      } finally { this.busy = false; this.zoomedFor = undefined; cx.notify(); }
    });
  }

  // How an unlisted coordinator finished, and the last lines it printed, which usually say why (e.g. a missing profile).
  // Still live (not listed yet): ask again in a second rather than call it ended.
  readEnd(address, cx) {
    const tail = this.tail = { address, text: "", term: null, gone: false };
    cx.spawn(async (cx) => {
      try {
        const got = await hc(["get", address, "--json"]);
        if (got.code !== 0) tail.gone = true;
        else tail.term = JSON.parse(got.stdout);
        if (tail.term?.state === "live") {
          cx.timer.after(1000, (cx) => { if (this.tail === tail) { this.tail = null; cx.notify(); } });
          return;
        }
        const read = await hc(["read", address, "--lines", "8"]);
        if (read.code === 0) tail.text = read.stdout.trimEnd();
      } catch { tail.gone = true; }
      cx.notify();
    });
  }

  // A deliberate restart: remove the ended terminal's record (`hc rm` refuses a live one), then launch again.
  restartCoordinator(cx) {
    const { address } = coordinator();
    if (address) cx.spawn(async () => { try { await hc(["rm", address]); } catch {} });
    this.tail = null; this.attachError = "";
    setCoordinator({ address: null, error: null, hidden: false });
  }

  coordinatorBanner(t) {
    const status = this.coordinatorStatus();
    const { error } = coordinator();
    if (status.kind !== "failed" && status.kind !== "ended" && !this.attachError) return null;
    const term = this.tail?.term;
    const title = status.kind === "failed" ? "Cannot start the Hermes coordinator."
      : status.kind === "ended" ? (term ? `The Hermes coordinator ${term.reason ?? "ended"}${term.exit_code != null ? ` with code ${term.exit_code}` : term.signal ? ` on signal ${term.signal}` : ""}.`
        : `The Hermes coordinator terminal ${coordinator().address} is gone; Core no longer has it.`)
      : "Cannot show the Hermes coordinator in this tab.";
    const detail = status.kind === "failed" ? error : status.kind === "ended" ? this.tail?.text : this.attachError;
    return v_flex().flex_none().mx(12).mt(10).p(10).gap(4).rounded(7).border(1).border_color(t.blocked).bg(t.surface)
      .child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(title))
      .when(Boolean(detail), (el) => el.child(div().text_size(12).text_color(t.foreground).child(detail)))
      .child(div().text_size(12).text_color(t.muted).child(`Shepherd runs \`${COORDINATOR_ARGV.join(" ")}\` and does not restart it on its own.`))
      .child(h_flex().id("coordinator-restart").mt(4).h(24).px(9).flex_none().self_start().items_center().rounded(6).bg(t.solid)
        .text_size(12).text_color(t.solid_foreground).hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => this.restartCoordinator(cx)).child(status.kind === "ended" ? "Restart coordinator" : "Try again"));
  }

  loadCron(cx) {
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let result;
        try { result = await exec(CRON_HELPER, []); }
        catch (e) { throw new Error(`Cannot run ${CRON_HELPER}: ${e?.message ?? e}. Install it on PATH (see the Hermes Shepherd README).`); }
        let reply = null;
        try { reply = JSON.parse(result.stdout); } catch {}
        if (result.code !== 0 || !reply || reply.error) throw new Error(reply?.error || result.stderr.trim() || `${CRON_HELPER} exited with code ${result.code}`);
        this.jobs = reply; this.error = "";
      } catch (e) { this.error = e?.message ?? String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  renderCron() {
    const t = theme();
    const button = (id, text, action) => h_flex().id(id).h(26).px(9).flex_none().items_center().rounded(6).text_size(12)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(text);
    const jobs = this.jobs?.jobs ?? [];
    const job = (j) => {
      const failed = j.last_status && !["ok", "delivery_queued"].includes(j.last_status);
      const state = j.running ? "running" : j.state ?? (j.enabled ? "scheduled" : "paused");
      const repeat = j.repeat_times ? ` · run ${j.repeat_completed ?? 0} of ${j.repeat_times}` : "";
      return v_flex().id(`job-${j.profile}-${j.id}`).flex_none().p(10).gap(4).rounded(8).border(1).border_color(t.border).bg(t.background)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(j.name || j.id))
          .child(div().flex_none().px(6).rounded(5).bg(t.surface).text_size(11.5).text_color(state === "scheduled" || state === "running" ? t.foreground : t.muted).child(state)))
        .child(div().text_size(12).text_color(t.muted).child(`${j.schedule_display ?? "?"}${repeat} · profile ${j.profile}`))
        .child(div().text_size(12).text_color(t.muted).child(`Next run: ${state === "paused" || state === "completed" ? "—" : stamp(j.next_run_at)}`))
        .child(div().text_size(12).text_color(t.muted).child(`Last run: ${j.last_run_at ? `${stamp(j.last_run_at)} · ${j.last_status ?? "unknown"}` : "never"}`))
        .when(Boolean(failed && (j.last_error || j.last_delivery_error)), (el) => el.child(div().text_size(12).text_color(t.blocked)
          .child(String(j.last_error || j.last_delivery_error).split("\n")[0])));
    };
    return v_flex().id("shepherd-cron").track_focus(this.handle).size_full().bg(t.popover)
      .on_key_down((e, cx) => { if (e.key === "escape") closeOverlay(props().overlay); else if (e.key === "f5") this.loadCron(cx); else return; cx.stop_propagation(); })
      .child(h_flex().flex_none().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Cron jobs"))
          .child(div().text_size(11.5).text_color(t.dim).child("Read-only. Hermes runs these on their schedules; change them with `hermes cron`. Parked cards are not cron jobs.")))
        .child(button("cron-refresh", this.loading ? "Loading…" : "Refresh", (_e, cx) => this.loadCron(cx)))
        .child(button("cron-close", "Close", () => closeOverlay(props().overlay))))
      .child(v_flex().id("cron-list").flex_1().min_h(0).p(12).gap(8).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(v_flex().p(10).gap(4).rounded(7).border(1).border_color(t.blocked).bg(t.surface)
          .child(div().text_size(12.5).font_semibold().text_color(t.blocked).child("Cannot read Hermes cron jobs."))
          .child(div().text_size(12).text_color(t.foreground).child(this.error))))
        .children((this.jobs?.errors ?? []).map((e) => div().text_size(12).text_color(t.blocked).child(`Profile ${e.profile}: ${e.error}`)))
        .when(Boolean(this.jobs && !jobs.length), (el) => el.child(div().text_size(12.5).text_color(t.muted).child("No cron jobs in any Hermes profile.")))
        .children(jobs.map(job)));
  }

  // Mod panes get no pane id, so a copy learns its tab when it is first laid out: only a
  // shown copy is laid out, and a shown tab pane belongs to the active tab.
  // Until a layout finds the copy's tab (e.g. Smart Tabs switched away first), it shows the default board.
  claim(cx) {
    if (this.tab) return;
    const tab = activeTab();
    if (panes().some((p) => p.mod === MOD && p.tab === tab)) this.tab = tab;
    this.sync(cx);
  }

  // A named tab asks for the board of that name; renaming it switches boards.
  tabName() {
    const tab = this.tab && spaces().flatMap((s) => s.tabs).find((t) => t.id === this.tab);
    return tab?.named ? tab.name : null;
  }

  sync(cx) {
    const name = this.tabName();
    if (name === this.requested) return;
    this.requested = name; this.data = null; this.error = ""; this.sel = null; this.watched = null; this.watches++;
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) { this.queued = true; return; }
    this.loading = true;
    const name = this.requested;
    cx.spawn(async (cx) => {
      try {
        let result;
        try { result = await exec(HELPER, name ? [name] : []); }
        catch (e) { throw new Error(`Cannot run ${HELPER}: ${e?.message ?? e}. Install it on PATH (see the Hermes Shepherd README).`); }
        let reply = null;
        try { reply = JSON.parse(result.stdout); } catch {}
        if (name !== this.requested) return;
        if (result.code !== 0 || !reply || reply.error)
          throw new Error(reply?.error || result.stderr.trim() || `${HELPER} exited with code ${result.code}`);
        this.data = reply; this.error = ""; this.updated = new Date();
        this.watch(reply.db, cx);
      } catch (e) {
        if (name === this.requested) this.error = e?.message ?? String(e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.queued || name !== this.requested) { this.queued = false; this.refresh(cx); }
      }
    });
  }

  // Every read, ours included, creates and deletes kanban.db-wal/-shm, so only a change to
  // kanban.db itself (a writer's checkpoint on close) triggers a read; that ends read->event loops.
  // shortcut: a writer that keeps the board open and never checkpoints shows up on the next poll;
  // upgrade if Hermes gains a change feed.
  watch(db, cx) {
    if (!db || this.watched === db) return;
    this.watched = db;
    const loop = ++this.watches;
    const folder = db.slice(0, db.lastIndexOf("/")) || "/";
    cx.spawn(async (cx) => {
      try {
        while (loop === this.watches) {
          const changed = await watchFolder(folder);
          if (loop === this.watches && changed.includes(db)) this.refresh(cx);
        }
      } catch { if (loop === this.watches) this.watched = null; }
    });
  }

  options(kind) {
    const current = (shared(FILTERS) ?? {})[kind];
    const values = new Set((this.data?.tasks ?? []).map((t) => t[kind]).filter(Boolean));
    if (current) values.add(current);
    return [{ value: null, label: "All" }, ...[...values].sort().map((v) => ({ value: v, label: v })), { value: "", label: "None" }];
  }

  openMenu(kind) {
    const options = this.options(kind);
    openOverlay({ mod: MOD, kind: "popup", width: 320, height: Math.min(420, 12 + options.length * 31),
      props: { menu: { kind, options, current: (shared(FILTERS) ?? {})[kind] ?? null } } });
  }

  columns() {
    const filters = shared(FILTERS) ?? {};
    const tasks = (this.data?.tasks ?? []).filter((t) => matches(t.repository, filters.repository) && matches(t.spec, filters.spec));
    return (this.data?.columns ?? []).map((c) => ({ ...c, tasks: tasks.filter((t) => t.status === c.key) }));
  }

  move(key, cols) {
    let { col, row } = this.sel ?? { col: Math.max(0, cols.findIndex((c) => c.tasks.length)), row: -1 };
    if (key === "left" || key === "right") {
      const step = key === "left" ? -1 : 1;
      for (let c = col + step; c >= 0 && c < cols.length; c += step)
        if (cols[c].tasks.length) { col = c; row = Math.min(Math.max(row, 0), cols[c].tasks.length - 1); break; }
    } else row = Math.min(Math.max(row + (key === "down" ? 1 : -1), 0), (cols[col]?.tasks.length ?? 1) - 1);
    this.sel = cols[col]?.tasks.length ? { col, row: Math.max(row, 0) } : null;
  }

  close() { this.details?.close(); }

  // Opens the task's details over the board; works for any task on the board, archived ones too.
  openTask(task) {
    openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 760, height: 0.85,
      props: { task: { board: this.data.board, id: task.id, db: this.data.db } } });
  }

  render(cx) {
    if (this.details) return this.details.render(cx);
    if (props()?.menu) return this.renderMenu(props().menu);
    if (props()?.cron) return this.renderCron();
    if (this.requested !== undefined) this.sync(cx);
    this.ensureCoordinator(cx);
    const t = theme();
    const filters = shared(FILTERS) ?? {};
    const cols = this.columns();
    const chip = (id, name, value, kind) => h_flex().id(id).h(26).px(9).gap(6).flex_none().items_center().rounded(6)
      .border(1).border_color(t.border).bg(t.chrome).text_size(12).text_color(t.muted)
      .when(Boolean(kind), (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.openMenu(kind)))
      .child(div().text_color(t.dim).child(name))
      .child(div().max_w(220).truncate().text_color(t.foreground).child(value));
    const fallback = this.data && this.requested && !this.data.matched;
    const status = this.loading && !this.data ? "Loading…"
      : this.updated && this.data ? `${count(cols)} of ${this.data.tasks.length} tasks · updated ${this.updated.toLocaleTimeString()}` : "";
    const toolbar = h_flex().id("shepherd-toolbar").flex_none().flex_wrap().min_h(42).px(12).py(8).gap(8).items_center()
      .border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child("Hermes"))
      .when(Boolean(this.data), (el) => el.child(chip("chip-board", "Board", this.data.board_name, null)))
      .when(Boolean(fallback), (el) => el.child(div().flex_none().max_w(260).truncate().text_size(11.5).text_color(t.muted)
        .child(`No board named “${this.requested}”, showing the default`)))
      .child(chip("chip-repo", "Repository", describe(filters.repository), "repository"))
      .child(chip("chip-spec", "Spec", describe(filters.spec), "spec"))
      .child(div().flex_1())
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(status))
      .child(h_flex().id("shepherd-refresh").h(26).px(9).flex_none().items_center().rounded(6).text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx)).child("Refresh"));
    const coordinatorBanner = this.coordinatorBanner(t);
    const banner = this.error && v_flex().flex_none().mx(12).mt(10).p(10).gap(4).rounded(7).border(1).border_color(t.blocked).bg(t.surface)
      .child(div().text_size(12.5).font_semibold().text_color(t.blocked)
        .child(this.data ? "Cannot refresh the Hermes board. Showing the last successful read." : "Cannot read the Hermes board."))
      .child(div().text_size(12).text_color(t.foreground).child(this.error))
      .child(h_flex().id("shepherd-retry").mt(4).h(24).px(9).flex_none().self_start().items_center().rounded(6).bg(t.solid)
        .text_size(12).text_color(t.solid_foreground).hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.refresh(cx)).child("Retry"));
    const card = (task, c, r) => {
      const selected = this.sel?.col === c && this.sel?.row === r;
      return h_flex().id(`card-${task.id}`).w(CARD).flex_none().p(10).gap(9).items_start().rounded(8)
        .border(1).border_color(selected ? t.accent : t.border).bg(t.background)
        .hover((s) => s.bg(t.hover).border_color(selected ? t.accent : t.input))
        .on_click((_e, cx) => { this.sel = { col: c, row: r }; this.handle.focus(); this.openTask(task); cx.notify(); })
        .child(div().mt(4).size(9).flex_none().rounded(5).bg(t[MARKER[task.status]] ?? t.unknown))
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(div().text_size(13).text_color(t.foreground).child(task.title))
          .when(Boolean(task.parked_reason), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(task.parked_reason)))
          .child(h_flex().gap(6).text_size(11.5).min_w(0)
            .child(div().flex_none().text_color(task.assignee ? t.muted : t.dim).child(task.assignee || "Unassigned"))
            .when(Boolean(task.spec), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(`· ${task.spec}`)))));
    };
    const column = (c, i) => v_flex().id(`col-${c.key}`).w(CARD + 16).flex_none().h_full().min_h(0).rounded(9).bg(t.surface)
      .child(h_flex().flex_none().h(34).px(10).gap(7).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(t[MARKER[c.key]] ?? t.unknown))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(label(c)))
        .child(div().text_size(12).text_color(t.dim).child(String(c.tasks.length))))
      .child(v_flex().id(`list-${c.key}`).flex_1().min_h(0).px(8).pb(8).gap(6).overflow_y_scrollbar()
        .children(c.tasks.map((task, r) => card(task, i, r))));
    return v_flex().id("shepherd").size_full().min_w(0).bg(t.canvas).track_focus(this.handle)
      .on_size_change((size, cx) => { if (size.width > 0) this.claim(cx); })
      .on_key_down((e, cx) => {
        if (["left", "right", "up", "down"].includes(e.key)) this.move(e.key, cols);
        else if (e.key === "escape") this.sel = null;
        else if (e.key === "enter" && cols[this.sel?.col]?.tasks[this.sel.row]) this.openTask(cols[this.sel.col].tasks[this.sel.row]);
        else if (e.key === "r") this.openMenu("repository");
        else if (e.key === "s") this.openMenu("spec");
        else if (e.key === "f5") this.refresh(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(toolbar)
      .when(Boolean(banner), (el) => el.child(banner))
      .when(Boolean(coordinatorBanner), (el) => el.child(coordinatorBanner))
      .when(Boolean(this.data), (el) => el.child(h_flex().id("shepherd-board").flex_1().min_h(0).p(12).gap(10).items_start()
        .overflow_x_scrollbar().children(cols.map(column))));
  }

  renderMenu(menu) {
    const t = theme();
    const choose = (option) => {
      setShared(FILTERS, { ...(shared(FILTERS) ?? {}), [menu.kind]: option.value });
      closeOverlay(props().overlay);
    };
    const list = menu.options;
    return v_flex().id("shepherd-menu").track_focus(this.handle).size_full().p(5).bg(t.popover).text_size(12.8).overflow_y_scrollbar()
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") choose(list[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((option, i) => h_flex().id(`opt-${i}`).h(31).px(8).gap(8).flex_none().rounded(7).items_center()
        .text_color(t.foreground).when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(() => choose(option))
        .child(div().w(12).flex_none().text_color(t.accent).child(option.value === menu.current ? "✓" : ""))
        .child(div().flex_1().min_w(0).truncate().child(option.label))));
  }
}

// One task's details: opened by the board as a dialog with props { task: { board, id, db } }.
// Shows the task's native status, assignment and context, its description and its history
// (comments, runs, events) as Markdown, and edits the description while Hermes allows it.
// The helper rechecks eligibility and freshness when saving; a refused save keeps the draft.
// It shares this file with the board because Herdr refuses a relative import that resolves outside the mod folder,
// and Home Manager links main.js on its own so the folder stays writable for the icons.

// Unsaved drafts by board and task, with the version each started from: they outlive the popup.
const DRAFTS = "hermes-shepherd.drafts";

// The popup's tabs; the tab row appears once there is more than one.
const TABS = [{ key: "details", label: "Details" }, { key: "sessions", label: "Sessions" }];

// Session rules, global like the filters: { rules: [{ regex, command, description, tab }] }.
// The helper matches them in a child process it stops after a few seconds, so no regex runs while rendering.
const RULES = "hermes-shepherd.sessions";
const RULE_FIELDS = { regex: "string", command: "string", description: "string", tab: "boolean" };
// The saved rules, or { error, raw } when the saved value is not a rule list. Only Save in Settings replaces it.
const savedRules = () => {
  const saved = shared(RULES);
  if (saved == null) return { rules: [] };
  const rules = saved.rules;
  if (Array.isArray(rules) && rules.every((r) => r && Object.entries(RULE_FIELDS).every(([k, type]) => typeof r[k] === type))) return { rules };
  return { error: "The saved session rules are not a list of { regex, command, description, tab } entries, so none are used.",
    raw: JSON.stringify(saved, null, 2) };
};
const RECORDS_SHOWN = 300; // rows per "Show more": thousands of rows at once make the dialog slow
const shown = (arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);

const when = (at) => at ? new Date(at * 1000).toLocaleString() : "";
const status = (key) => DISPLAY[key] ?? key.replace(/^./, (c) => c.toUpperCase());

// Runs the helper; resolves with its JSON reply and exit code, or rejects with readable text.
async function call(args) {
  let result;
  try { result = await exec(HELPER, args); }
  catch (e) { throw new Error(`Cannot run ${HELPER}: ${e?.message ?? e}. Install it on PATH (see the Hermes Shepherd README).`); }
  let reply = null;
  try { reply = JSON.parse(result.stdout); } catch {}
  if (!reply) throw new Error(result.stderr.trim() || `${HELPER} exited with code ${result.code}`);
  return { code: result.code, reply };
}

class TaskDetails {
  init(cx) {
    this.ref = props().task;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.tab = "details";
    this.task = null; this.error = ""; this.notice = ""; this.saving = false; this.open = true;
    this.loads = 0; this.scan = null; this.launches = {}; this.shown = RECORDS_SHOWN; // Sessions tab: last scan, launch results by record, rows listed
    this.draft = null; this.base = null; // the editor's text state and the version it started from
    this.key = `${this.ref.board}:${this.ref.id}`;
    this.load(cx);
    this.watch(cx);
  }

  close() { this.open = false; this.store(); }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--task", this.ref.board, this.ref.id]);
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.task = reply; this.error = ""; this.loads++;
      } catch (e) { this.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  // Follows the board like the tab does, so a task that starts shows as locked without a reopen.
  watch(cx) {
    const db = this.ref.db;
    if (!db) return;
    cx.spawn(async (cx) => {
      try {
        while (this.open) {
          const changed = await watchFolder(db.slice(0, db.lastIndexOf("/")) || "/");
          if (this.open && changed.includes(db)) this.load(cx);
        }
      } catch {}
    });
  }

  // An unsaved draft outlives the popup (Esc closes it) until it is saved or discarded.
  stored() { return (shared(DRAFTS) ?? {})[this.key] ?? null; }
  store() {
    const { [this.key]: _, ...drafts } = shared(DRAFTS) ?? {};
    if (this.draft) drafts[this.key] = { base: this.base, text: this.draft.value() };
    if (this.draft || _) setShared(DRAFTS, drafts);
  }

  edit(cx) {
    if (!this.draft) {
      const kept = this.stored();
      this.base = kept?.base ?? this.task.version;
      this.draft = TextareaState.new({ value: kept?.text ?? this.task.body, placeholder: "Describe the task in Markdown" });
      // Ctrl+Enter inserts a newline (a change) before it submits; save the text from before that newline.
      this.typed = [this.draft.value(), this.draft.value()];
      this.draft.on("change", () => { this.typed = [this.typed[1], this.draft.value()]; });
      this.draft.on("submit", (e, cx) => {
        if (!e.secondary || !this.task.editable) return;
        const [before, now] = this.typed;
        const at = [...now].findIndex((c, i) => c !== before[i]);
        if (now.length === before.length + 1 && now[at] === "\n" && now.slice(at + 1) === before.slice(at)) this.draft.set_value(before);
        this.save(cx);
      });
    }
    this.editing = true; this.notice = "";
    this.draft.focus();
    cx.notify();
  }

  // Leaves the editor; the draft stays until it is saved or discarded, so Edit brings it back.
  stopEditing(cx) {
    // After a conflict, closing the editor shows the newer description; only then may Save replace it.
    if (this.seen) { this.base = this.seen; this.seen = null; this.store(); }
    this.editing = false; this.handle.focus(); cx.notify();
  }

  discard(cx) { this.draft?.release(); this.draft = null; this.base = null; this.notice = ""; this.store(); this.stopEditing(cx); }

  save(cx) {
    if (this.saving) return;
    this.saving = true; this.notice = "";
    const text = this.draft.value();
    // shortcut: the draft travels as one argument, which Linux caps at 128 KiB; pass a file if descriptions grow that big.
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--edit", this.ref.board, this.ref.id, this.base, text]);
        if (reply.task) this.task = reply.task;
        if (code === 2 && reply.task?.editable) {
          this.seen = reply.task.version;
          throw new Error(`${reply.error} Close the editor to read the current description; after that, Save replaces it with your draft.`);
        }
        if (code !== 0) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.notice = reply.warning ?? "";
        this.draft.release(); this.draft = null; this.base = null; this.editing = false; this.store();
        this.handle.focus();
      } catch (e) { this.notice = e?.message ?? String(e); this.draft.focus(); }
      finally { this.saving = false; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const task = this.task;
    const button = (id, text, primary, action) => h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const section = (title, ...extra) => h_flex().pt(16).pb(6).gap(8).items_center()
      .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.dim).child(title)).children(extra.filter(Boolean));
    const fact = (name, value) => value ? h_flex().gap(6).min_w(0).text_size(12)
      .child(div().flex_none().text_color(t.dim).child(name))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(String(value))) : null;
    const markdown = (id, text) => TextView.markdown(id, text).selectable(true).text_size(13);

    const header = h_flex().flex_none().px(18).pt(16).pb(10).gap(10).items_start()
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(task?.title ?? "Loading…"))
        .when(Boolean(task), (el) => el.child(h_flex().gap(8).items_center().text_size(12)
          .child(div().size(9).flex_none().rounded(5).bg(t[MARKER[task.status]] ?? t.unknown))
          .child(div().text_color(t.foreground).child(status(task.status)))
          .child(div().text_color(task.assignee ? t.muted : t.dim).child(`· ${task.assignee || "Unassigned"}`))
          .child(div().text_color(t.dim).child(`· ${this.ref.id}`)))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc"))
      .child(h_flex().id("details-close").size(24).flex_none().items_center().justify_center().rounded(6)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeOverlay(props().overlay)).child("✕"));

    const tabs = TABS.length > 1 && h_flex().flex_none().px(18).gap(4).border_b(1).border_color(t.border)
      .children(TABS.map((tab) => h_flex().id(`details-tab-${tab.key}`).h(30).px(10).items_center().text_size(12.5)
        .border_b(2).border_color(tab.key === this.tab ? t.accent : t.popover)
        .text_color(tab.key === this.tab ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.tab = tab.key; cx.notify(); }).child(tab.label)));

    const banner = (text, color) => div().mt(10).p(10).rounded(7).border(1).border_color(color).bg(t.surface)
      .text_size(12).text_color(t.foreground).child(text);

    if (task && this.tab === "sessions") this.scanSessions(cx);
    const body = task && this.tab === "sessions" ? this.sessions(t, banner) : task && v_flex().flex_1().min_h(0).px(18).pb(18).overflow_y_scrollbar()
      .child(h_flex().flex_wrap().gap_x(16).gap_y(4).pt(4)
        .children([
          fact("Spec", task.spec), fact("Repository", task.repository), fact("Workspace", task.workspace),
          fact("Priority", task.priority), fact("Created", when(task.created_at)), fact("Started", when(task.started_at)),
          fact("Completed", when(task.completed_at)),
          fact("Parents", task.parents.map((p) => `${p.title} (${status(p.status)})`).join(", ")),
          fact("Children", task.children.map((c) => `${c.title} (${status(c.status)})`).join(", ")),
        ].filter(Boolean)))
      .when(Boolean(this.notice), (el) => el.child(banner(this.notice, t.blocked)))
      .child(section("Description",
        !task.editable && div().text_size(11.5).text_color(t.dim).child(task.edit_blocked),
        // A locked task's leftover draft still opens, so it can be copied or discarded.
        !this.editing && (task.editable || this.draft || this.stored())
          && button("details-edit", this.draft || this.stored() ? task.editable ? "Edit draft" : "View draft" : "Edit", false, (_e, cx) => this.edit(cx))))
      .child(this.editing
        ? v_flex().gap(8)
          .child(Textarea.new(this.draft).w_full().h(320).p(10).rounded(7).border_1().border_color(t.accent)
            .bg(t.background).text_color(t.foreground).text_size(13))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().text_size(11.5).text_color(t.dim).child(task.editable ? "Markdown. Ctrl+Enter saves. The draft is kept until you save or discard it."
              : "This task is locked. Copy what you need from the draft, then discard it."))
            .child(button("details-discard", "Discard", false, (_e, cx) => this.discard(cx)))
            .child(button("details-close-editor", "Close", false, (_e, cx) => this.stopEditing(cx)))
            .when(task.editable, (el) => el.child(button("details-save", this.saving ? "Saving…" : "Save", true, (_e, cx) => this.save(cx)))))
        : task.body ? markdown(`details-body-${task.version}`, task.body)
          : div().text_size(12.5).text_color(t.dim).child("No description."))
      .when(Boolean(task.result), (el) => el.child(section("Result")).child(markdown("details-result", task.result)))
      .child(section("History"))
      .children(this.history(task, t, markdown));

    return v_flex().id("details").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(header)
      .when(Boolean(tabs), (el) => el.child(tabs))
      .when(Boolean(this.error), (el) => el.child(div().px(18).child(banner(
        task ? `Cannot refresh this task. Showing the last successful read. ${this.error}` : this.error, t.blocked))))
      .when(Boolean(body), (el) => el.child(body));
  }

  // Rescans when the rules or the task change; the helper reads the task itself and matches with a time limit.
  scanSessions(cx) {
    const saved = savedRules();
    const key = `${JSON.stringify(saved)}:${this.loads}`;
    if (this.scan?.key === key) return;
    const scan = this.scan = { key, records: null, errors: [], error: saved.error ?? "" };
    if (saved.error || !saved.rules.length) return;
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--sessions", this.ref.board, this.ref.id, JSON.stringify(saved.rules)]);
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        scan.records = reply.records; scan.errors = reply.errors;
      } catch (e) { scan.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  // Every click starts the command again in Core; nothing already running is reused or focused.
  // It runs as `env -- argv`: `hc run` reads a lone argument with spaces or shell signs as a shell line,
  // and a first word that names an hc template as that template. env runs exactly the program it is given.
  launch(record, key, cx) {
    // Takes the cx of the moment: a click handler's cx is no longer valid inside the spawned task.
    const show = (cx, text, failed = false) => { this.launches[key] = { text, failed }; cx.notify(); };
    const space = spaces().find((s) => s.active);
    if (!space) return show(cx, "No space is selected, so there is no folder to start in.", true);
    if (space.machine) return show(cx, `Session commands run on this computer, and the selected space is on ${space.machine}.`, true);
    if (record.argv[0].includes("=")) return show(cx, `Not started: env would read the program name “${record.argv[0]}” as a variable.`, true);
    const cwd = space.folder || home(); // an empty folder is the space's own: its machine's home (SpaceInfo.folder)
    // A tab id the App does not know yet becomes a new tab in that space, showing this terminal.
    const tab = record.tab ? `tb${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}` : null;
    const labels = tab ? ["--label", `herdr.space=${space.id}`, "--label", `herdr.tab=${tab}`] : [];
    show(cx, `Starting in ${cwd}…`);
    cx.spawn(async (cx) => {
      try {
        let result;
        try { result = await hc(["run", "--bg", "--json", "--no-parent", "--cwd", cwd, ...labels, "--", "env", "--", ...record.argv]); }
        catch (e) { throw new Error(`Cannot run hc: ${e?.message ?? e}`); }
        const reply = hcReply(result);
        if (result.code !== 0 || !reply?.address) throw new Error(hcError(result, reply));
        // A missing program shows only as env exiting at once, so look again before calling it running.
        await new Promise((resolve) => cx.timer.after(1000, () => resolve()));
        const got = await hc(["get", reply.address, "--json"]);
        const term = got.code === 0 ? hcReply(got) : null;
        if (!term) throw new Error(`Started ${reply.address}, but Core cannot say whether it is still running: ${hcError(got, null)}`);
        if (term.state !== "live") {
          // Its tab closed with it, so show how it ended here; only a clean exit 0 is not a failure.
          const read = await hc(["read", reply.address, "--lines", "6"]);
          const tail = read.code === 0 ? read.stdout.trim() : "";
          return show(cx, `${reply.address} ${term.reason ?? "ended"}${term.exit_code != null ? ` with code ${term.exit_code}` : ""} within a second.${tail ? `\n${tail}` : ""}`,
            term.exit_code !== 0);
        }
        if (!tab) return show(cx, `Running in the background as ${reply.address} in ${cwd}.`);
        show(cx, `Running as ${reply.address} in a new tab in ${space.name}.`);
        run("tab.select", { id: tab });
        closeOverlay(props().overlay);
      } catch (e) { show(cx, e?.message ?? String(e), true); }
    });
  }

  sessions(t, banner) {
    const scan = this.scan;
    const saved = savedRules();
    const records = scan?.records ?? [];
    const note = (text) => div().pt(10).text_size(12.5).text_color(t.dim).child(text);
    const item = (r) => {
      const key = JSON.stringify([r.description, r.argv]);
      const launch = this.launches[key];
      return v_flex().id(`session-${key}`).flex_none().p(10).gap(4).rounded(7).border(1).border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.launch(r, key, cx))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(r.description || "(empty description)"))
          .child(div().flex_none().px(6).rounded(5).bg(t.surface).text_size(11.5).text_color(t.muted).child(r.tab ? "New tab" : "Background")))
        .child(div().text_size(11.5).text_color(t.dim).child(r.argv.map(shown).join(" ")))
        .when(Boolean(launch), (el) => el.child(div().text_size(12).text_color(launch.failed ? t.blocked : t.muted).child(launch.text)));
    };
    return v_flex().flex_1().min_h(0).px(18).pb(18).pt(10).gap(8).overflow_y_scrollbar()
      .child(div().text_size(11.5).text_color(t.dim).child("Records your session rules find in the description, result, comments and run summaries. "
        + "A click starts the command again, in the selected space's folder. Settings at the top right edits the rules."))
      .when(Boolean(scan?.error), (el) => el.child(banner(scan.error, t.blocked)))
      .children((scan?.errors ?? []).map((e) => banner(e.error, t.blocked)))
      .when(!saved.error && !saved.rules?.length, (el) => el.child(note("No session rules yet. Add them with Settings at the top right.")))
      .when(Boolean(saved.rules?.length && scan && !scan.records && !scan.error), (el) => el.child(note("Reading…")))
      .when(Boolean(scan?.records && !records.length), (el) => el.child(note("The rules find no records in this task.")))
      .children(records.slice(0, this.shown).map(item))
      .when(records.length > this.shown, (el) => el.child(h_flex().pt(6).gap(10).items_center()
        .child(div().text_size(12.5).text_color(t.dim).child(`Showing ${this.shown} of ${records.length} records.`))
        .child(h_flex().id("sessions-more").h(26).px(9).items_center().rounded(6).border_1().border_color(t.input).bg(t.raised)
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => { this.shown += RECORDS_SHOWN; cx.notify(); }).child(`Show ${Math.min(RECORDS_SHOWN, records.length - this.shown)} more`))));
  }

  // Comments, runs and events in time order. Text is rendered as written; nothing is rewritten.
  history(task, t, markdown) {
    const items = [
      ...task.events.filter((e) => e.kind !== "commented").map((e) => ({ at: e.at, el: div().text_size(11.5).text_color(t.dim)
        .child(`${e.kind.replaceAll("_", " ")}${e.payload?.reason ? `: ${e.payload.reason}` : ""} · ${when(e.at)}`) })),
      ...task.comments.map((c, i) => ({ at: c.at, el: v_flex().gap(4).p(10).rounded(7).bg(t.surface)
        .child(div().text_size(11.5).text_color(t.dim).child(`${c.author} · ${when(c.at)}`))
        .child(markdown(`details-comment-${i}`, c.body)) })),
      ...task.runs.map((r, i) => ({ at: r.started_at, el: v_flex().gap(4).p(10).rounded(7).border(1).border_color(t.border)
        .child(div().text_size(11.5).text_color(t.dim)
          .child(`Run · ${r.profile || "Unassigned"} · ${r.outcome || r.status} · ${when(r.started_at)}${r.ended_at ? ` to ${when(r.ended_at)}` : ""}`))
        .when(Boolean(r.summary || r.error), (el) => el.child(markdown(`details-run-${i}`, r.summary || r.error))) })),
    ];
    if (!items.length) return [div().text_size(12.5).text_color(t.dim).child("No history.")];
    return items.sort((a, b) => a.at - b.at).map((item, i) => div().id(`details-history-${i}`).pb(6).child(item.el));
  }
}

// The session rules dialog, opened by the Settings control with props { settings }. It edits a copy of the
// shared rules and saves it only when the helper finds no problem in any rule.
class SessionSettings {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const saved = savedRules();
    this.malformed = saved.error ? saved : null;
    this.rows = (saved.rules ?? []).map((r) => this.row(r));
    this.errors = {}; this.notice = ""; this.saving = false;
  }

  row(rule = { regex: "", command: "", description: "", tab: true }) {
    return {
      regex: InputState.new({ value: rule.regex, placeholder: "e.g. session: (\\S+) harness: claude" }),
      command: InputState.new({ value: rule.command, placeholder: "e.g. claude --resume $1" }),
      description: InputState.new({ value: rule.description, placeholder: "e.g. Claude session $1" }),
      tab: rule.tab,
    };
  }

  release(row) { for (const field of ["regex", "command", "description"]) row[field].release(); }
  close() { this.rows.forEach((row) => this.release(row)); this.rows = []; }

  edit(cx, change) { change(); this.errors = {}; this.notice = ""; cx.notify(); }
  move(i, step, cx) { this.edit(cx, () => { const [row] = this.rows.splice(i, 1); this.rows.splice(i + step, 0, row); }); }
  remove(i, cx) { this.edit(cx, () => this.release(this.rows.splice(i, 1)[0])); }

  save(cx) {
    if (this.saving) return;
    this.saving = true; this.notice = "";
    const current = () => this.rows.map((r) => ({ regex: r.regex.value(), command: r.command.value(), description: r.description.value(), tab: r.tab }));
    const rules = current();
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--check-rules", JSON.stringify(rules)]);
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.errors = {};
        for (const e of reply.errors) (this.errors[e.rule] ??= []).push(e.error);
        if (reply.errors.length) { this.notice = "Not saved: fix the rules marked below."; return; }
        // Typing goes straight into the inputs, so text changed during the check was not checked.
        if (JSON.stringify(current()) !== JSON.stringify(rules)) { this.notice = "Not saved: the rules changed while they were checked. Save again."; return; }
        setShared(RULES, { rules });
        this.malformed = null; this.notice = "Saved.";
      } catch (e) { this.notice = `Not saved: ${e?.message ?? e}`; }
      finally { this.saving = false; cx.notify(); }
    });
  }

  render(_cx) {
    const t = theme();
    const button = (id, text, primary, action) => h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const small = (id, text, enabled, action) => h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).text_size(12)
      .text_color(enabled ? t.muted : t.dim).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(text);
    const field = (name, state) => v_flex().gap(3)
      .child(div().text_size(11.5).text_color(t.dim).child(name))
      .child(Input.new(state).h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground));
    const rule = (row, i) => v_flex().id(`rule-${i}`).flex_none().p(12).gap(8).rounded(8).border(1)
      .border_color(this.errors[i] ? t.blocked : t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child(`Rule ${i + 1}`))
        .child(h_flex().id(`rule-tab-${i}`).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.foreground)
          .on_click((_e, cx) => this.edit(cx, () => { row.tab = !row.tab; }))
          .child(h_flex().size(15).flex_none().items_center().justify_center().rounded(4).border_1()
            .border_color(row.tab ? t.accent : t.input).bg(row.tab ? t.accent : t.background)
            .text_size(11).text_color(t.accent_foreground).child(row.tab ? "✓" : ""))
          .child("Open in new tab"))
        .child(div().w(8))
        .child(small(`rule-up-${i}`, "Up", i > 0, (_e, cx) => this.move(i, -1, cx)))
        .child(small(`rule-down-${i}`, "Down", i < this.rows.length - 1, (_e, cx) => this.move(i, 1, cx)))
        .child(small(`rule-remove-${i}`, "Remove", true, (_e, cx) => this.remove(i, cx))))
      .child(field("Regex", row.regex))
      .child(field("Command", row.command))
      .child(field("Description", row.description))
      .children((this.errors[i] ?? []).map((text) => div().text_size(12).text_color(t.blocked).child(text)));

    return v_flex().id("session-settings").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().px(18).pt(16).pb(10).gap(10).items_start().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(15).font_semibold().child("Session rules"))
          .child(div().text_size(11.5).text_color(t.dim).child("Shared by every Shepherd tab. A task's Sessions tab lists what these rules find in its "
            + "description, result, comments and run summaries. At each place in the text the first rule that matches wins.")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc"))
        .child(h_flex().id("settings-close").size(24).flex_none().items_center().justify_center().rounded(6)
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(props().overlay)).child("✕")))
      .child(v_flex().id("rules").flex_1().min_h(0).px(18).py(12).gap(10).overflow_y_scrollbar()
        .child(div().text_size(12).text_color(t.muted).child("Regex: a Python regular expression. Command and Description: $1, $2 … insert capture groups, "
          + "$0 the whole match, $$ a dollar sign. The command is split into arguments the way a shell would (quotes, backslashes) before "
          + "captures go in, so a capture is always literal text inside one argument. It runs without a shell, through Herdr Core, "
          + "in the selected space's folder: in a new tab, or in the background when Open in new tab is off."))
        .when(Boolean(this.malformed), (el) => el.child(v_flex().p(10).gap(6).rounded(7).border(1).border_color(t.blocked).bg(t.surface)
          .child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(this.malformed.error))
          .child(div().text_size(12).text_color(t.foreground).child("They are kept as they are. Saving here replaces them with the rules below."))
          .child(TextView.markdown("settings-raw", `\`\`\`json\n${this.malformed.raw}\n\`\`\``).selectable(true).text_size(12))))
        .when(!this.rows.length, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("No rules yet.")))
        .children(this.rows.map(rule))
        .child(h_flex().child(button("rule-add", "Add rule", false, (_e, cx) => this.edit(cx, () => this.rows.push(this.row()))))))
      .child(h_flex().flex_none().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(12).text_color(this.notice === "Saved." ? t.muted : t.blocked).child(this.notice))
        .child(button("settings-cancel", "Close", false, () => closeOverlay(props().overlay)))
        .child(button("settings-save", this.saving ? "Checking…" : "Save", true, (_e, cx) => this.save(cx))));
  }
}

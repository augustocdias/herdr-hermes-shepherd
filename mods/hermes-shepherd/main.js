// Hermes Shepherd: a view of a Hermes kanban board, opened as a tab.
// The board is the one named like the tab (slug or display name); otherwise Hermes's
// default board, and the toolbar says so. Repository and spec filters are global.
// In a layout block with props { panel } it is the Shepherd panel's header (ShepherdPanel).
// Opened as a popup with props { menu } it is the board's own filter picker; with props { cron }
// it is the read-only cron jobs dialog; as a dialog with props { task } it is that task's details (TaskDetails);
// with props { settings } it is the Settings dialog for the record rules and the records tab name (SessionSettings).
// With props { actions }, { confirm } or { archived } it is a card's action menu, the confirmation of an archive,
// restore or delete, or the archived-task list (ActionMenu, Confirm, Archived).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, terminals, layout, exec, hc, home, appHome, readTextFile, writeTextFile, run, watchFolder, theme, settings, shared, setShared, props, openOverlay, closeOverlay, nextCommand, notify } from "herdr";

const MOD = "hermes-shepherd";
// Herdr App draws nothing for an SVG that is a symlink (Home Manager installs files as store symlinks),
// so the icons live here and are written as real files on load; unchanged files are left alone.
const SVG = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
const ICONS = {
  icon: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v9"/>'),
  coordinator: SVG('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  cron: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  settings: SVG('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  archive: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
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
const COLUMN = CARD + 16, COLUMN_GAP = 10, BOARD_PAD = 12; // the board's layout, also used to tell when it overflows
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

// The Shepherd panel is a block the person adds to their own layout (README: The Shepherd panel):
// a header (this mod with props { panel }) above a `{ "terminal": PANEL_TERMINAL }` block.
// That one terminal runs the user's own `hermes -p <profile>` through the `hermes` on Core's PATH,
// so their wrapper and jail apply. It serves every space and is restarted only by the person.
// Herdr App deletes a layout's terminal block, and rewrites the layout around it, when the terminal
// ends, so a shell keeps the terminal alive after Hermes exits: it records the exit code as a label
// and starts Hermes again only on Enter or the panel's Restart.
const PANEL = "shepherd"; // layout node ids the README's snippet uses
const PANEL_BLOCK = "shepherd-terminal";
const PANEL_TERMINAL = "hermes-shepherd";
const PROFILE = "coordinator"; // the Hermes profile the Shepherd panel opens until Settings saves another
const EXIT = "hermes-shepherd.exit"; // label: Hermes's last exit code, absent while it runs
const RUNNING_PROFILE = "hermes-shepherd.profile"; // label: the profile the runner last started Hermes with
// The profile Settings saved, as a hidden file the runner reads at every start, so Enter and Restart pick up a change.
// Hidden files in the mod folder do not reload the mod.
const profileFile = () => `${appHome()}/mods/${MOD}/.profile`;
const writeProfile = async (profile) => {
  let current = null;
  try { current = await readTextFile(profileFile()); } catch {}
  if (current !== profile) await writeTextFile(profileFile(), profile, current);
};
// $1 is the profile file; the rest is the hermes command. The profile is one argument after -p; the shell does not parse it.
const RUNNER = `trap : INT QUIT
file=$1; shift
while :; do
  profile=$(cat "$file" 2>/dev/null); [ -n "$profile" ] || profile=${PROFILE}
  hc label "$HC_TERMINAL_ID" ${EXIT}= ${RUNNING_PROFILE}="$profile" >/dev/null 2>&1
  "$@" -p "$profile"; code=$?
  # A crashed TUI can leave raw mode on, where Enter never ends \`read\`.
  stty sane 2>/dev/null
  # Drop keys typed while Hermes ran, so only a new Enter starts it again; the label then offers Restart.
  # dash has no \`read -t\`, so read without blocking through stty.
  old=$(stty -g 2>/dev/null) && { stty -icanon min 0 time 0; cat >/dev/null; stty "$old"; }
  hc label "$HC_TERMINAL_ID" ${EXIT}=$code >/dev/null 2>&1
  printf '\\n[Hermes exited with code %s. Press Enter, or Restart in the Shepherd panel, to start it again.]\\n' "$code"
  until read -r _; do sleep 1; done
done`;
const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? findNode(c, id), null);
// `hc --json` prints its reply on stdout, or `{ error: { message, hint } }` on stderr.
const hcReply = (result) => { for (const text of [result.stdout, result.stderr]) { try { return JSON.parse(text); } catch {} } return null; };
const hcError = (result, reply) => reply?.error?.message ?? (result.stderr.trim() || `hc exited with code ${result.code}`);
const CRON_HELPER = "hermes-shepherd-cron";
const stamp = (iso) => { const d = iso && new Date(iso); return d && !isNaN(d) ? d.toLocaleString() : "—"; };

// Top-right tab-bar controls, published as herdr-navigation's `tab-controls:hermes-shepherd`.
// Add a control with one entry: Smart Tabs runs `hermes-shepherd.<id>`, which reaches `run` in the shown copy.
// Published when a board opens; an unchanged list is not written again.
const CONTROLS = [
  { id: "cron", label: "Cron jobs", icon: `mods/${MOD}/cron.svg`,
    run: () => openOverlay({ mod: MOD, kind: "dialog", width: 640, height: 560, props: { cron: true } }) },
  { id: "settings", label: "Settings", icon: `mods/${MOD}/settings.svg`,
    run: () => openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 860, height: 0.85, props: { settings: true } }) },
  { id: "archived", label: "Show archived", icon: `mods/${MOD}/archive.svg`,
    run: (view) => view.data ? openOverlay({ mod: MOD, kind: "dialog", width: 640, height: 560,
      props: { archived: { board: view.data.board, name: view.data.board_name, db: view.data.db } } })
      // The toast shows one line, so the board's banner carries the error itself.
      : notify({ title: "Cannot show archived tasks", level: "error",
        body: view.error ? "The board did not load; see it, then Retry." : "The board is still loading; try again." }) },
  // Last, so it sits rightmost. Stateless and unchecked: without the panel in the layout, Herdr warns on its own.
  { id: "shepherd", label: "Shepherd", icon: `mods/${MOD}/coordinator.svg`, run: () => run("layout.toggle", { id: PANEL }) },
];
const publishControls = () => {
  const list = CONTROLS.map(({ id, label, icon }) => ({ id, label, icon, command: `${MOD}.${id}` }));
  const key = `tab-controls:${MOD}`;
  if (JSON.stringify(shared(key)) !== JSON.stringify(list)) setShared(key, list);
};

export default class Shepherd extends View {
  init(_props, cx) {
    if (props()?.task) { this.details = new TaskDetails(); this.details.init(cx); return; }
    if (props()?.settings) { this.details = new SessionSettings(); this.details.init(cx); return; }
    if (props()?.panel) { this.details = new ShepherdPanel(); this.details.init(cx); return; }
    const Overlay = props()?.actions ? ActionMenu : props()?.confirm ? Confirm : props()?.archived ? Archived : null;
    if (Overlay) { this.details = new Overlay(); this.details.init(cx); return; }
    this.handle = cx.focus_handle();
    if (props()?.menu) { this.at = 0; this.handle.focus(); return; }
    if (props()?.cron) { this.jobs = null; this.error = ""; this.loadCron(cx); this.handle.focus(); return; }
    this.data = null; this.error = ""; this.loading = false; this.queued = false; this.updated = null;
    this.sel = null; this.tab = null; this.requested = undefined; this.watches = 0;
    cx.timer.every(POLL_MS, (cx) => { if (this.requested !== undefined) this.refresh(cx); });
    publishControls();
    cx.spawn(async (cx) => {
      for (;;) { const id = await nextCommand(); CONTROLS.find((c) => c.id === id)?.run(this, cx); cx.notify(); }
    });
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
        try { result = await exec(HELPER, name ? ["--", name] : []); }
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
  openTask(task) { openDetails({ board: this.data.board, id: task.id, db: this.data.db }); }

  // The card's menu: Send to Todo or Ready for a Triage card, and Archive for any card.
  openActions(task) {
    openOverlay({ mod: MOD, kind: "popup", width: 320, height: task.status === "triage" ? 250 : 132,
      props: { actions: { board: this.data.board, db: this.data.db, id: task.id, title: task.title, status: task.status } } });
  }

  render(cx) {
    if (this.details) return this.details.render(cx);
    if (props()?.menu) return this.renderMenu(props().menu);
    if (props()?.cron) return this.renderCron();
    if (this.requested !== undefined) this.sync(cx);
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
        // A running task pulses natively, so active work stands out without a timer.
        .when(task.status === "running", (el) => el.loop("opacity", { from: 0.6, to: 1, period: 1600 }))
        .on_click((_e, cx) => { this.sel = { col: c, row: r }; this.handle.focus(); this.openTask(task); cx.notify(); })
        .child(div().mt(4).size(9).flex_none().rounded(5).bg(t[MARKER[task.status]] ?? t.unknown))
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(div().text_size(13).text_color(t.foreground).child(task.title))
          .when(Boolean(task.parked_reason), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(task.parked_reason)))
          .child(h_flex().gap(6).text_size(11.5).min_w(0)
            .child(div().flex_none().text_color(task.assignee ? t.muted : t.dim).child(task.assignee || "Unassigned"))
            .when(Boolean(task.spec), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(`· ${task.spec}`)))))
        // Its own click must not also open the card.
        .child(h_flex().id(`card-menu-${task.id}`).size(20).flex_none().items_center().justify_center().rounded(5)
          .text_color(t.dim).hover((s) => s.bg(t.surface).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.sel = { col: c, row: r }; this.openActions(task); cx.notify(); })
          .child("⋯"));
    };
    const column = (c, i) => v_flex().id(`col-${c.key}`).relative().w(COLUMN).flex_none().h_full().min_h(0).rounded(9).bg(t.surface)
      .child(h_flex().flex_none().h(34).px(10).gap(7).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(t[MARKER[c.key]] ?? t.unknown))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(label(c)))
        .child(div().text_size(12).text_color(t.dim).child(String(c.tasks.length))))
      .child(v_flex().id(`list-${c.key}`).min_h(0).px(8).pb(8).gap(6).overflow_y_scroll()
        // A vertical wheel over the cards scrolls this column only, even a short one; elsewhere it scrolls the board sideways.
        .on_scroll_wheel((e, cx) => { if (Math.abs(e.delta.y) > Math.abs(e.delta.x)) cx.stop_propagation(); })
        .children(c.tasks.map((task, r) => card(task, i, r))))
      .child(Scrollbar.vertical(`list-${c.key}`).absolute().top(34).bottom(0).left(0).right(0));
    return v_flex().id("shepherd").size_full().min_w(0).bg(t.canvas).track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (size.width > 0) this.claim(cx);
        const width = size.width / settings().zoom;
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (["left", "right", "up", "down"].includes(e.key)) this.move(e.key, cols);
        else if (e.key === "escape") this.sel = null;
        else if (e.key === "enter" && cols[this.sel?.col]?.tasks[this.sel.row]) this.openTask(cols[this.sel.col].tasks[this.sel.row]);
        else if (e.key === "m" && cols[this.sel?.col]?.tasks[this.sel.row]) this.openActions(cols[this.sel.col].tasks[this.sel.row]);
        else if (e.key === "r") this.openMenu("repository");
        else if (e.key === "s") this.openMenu("spec");
        else if (e.key === "f5") this.refresh(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(toolbar)
      .when(Boolean(banner), (el) => el.child(banner))
      // overflow_x_scroll, unlike overflow_x_scrollbar, also turns a vertical wheel into sideways scrolling.
      // The bar shows only while the columns overflow; it would show a full-width thumb otherwise.
      .when(Boolean(this.data), (el) => el.child(div().flex_1().min_h(0).relative()
        .child(h_flex().id("shepherd-board").size_full().p(BOARD_PAD).gap(COLUMN_GAP).items_start().overflow_x_scroll().children(cols.map(column)))
        .when(cols.length * (COLUMN + COLUMN_GAP) - COLUMN_GAP + 2 * BOARD_PAD > this.width, (el) => el.child(Scrollbar.horizontal("shepherd-board").mode("always").absolute().inset_0()))));
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

// The popup's tabs. A tab without a label shows the records tab name the user set in Settings.
const TABS = [{ key: "details", label: "Details" }, { key: "sessions" }];

// Record rules, the records tab's name and the panel's Hermes profile, global like the filters:
// { name?, profile?, rules: [{ regex, command, description, tab }] }.
// The helper matches the rules in a child process it stops after a few seconds, so no regex runs while rendering.
const RULES = "hermes-shepherd.sessions";
const TAB_NAME = "Links"; // the records tab's name until Settings saves another
const RULE_FIELDS = { regex: "string", command: "string", description: "string", tab: "boolean" };
// { name, profile, rules }, or { name, profile, error, raw } when the saved value is malformed. Only Save in Settings replaces it.
const savedRules = () => {
  const saved = shared(RULES);
  if (saved == null) return { name: TAB_NAME, profile: PROFILE, rules: [] };
  const rules = saved.rules;
  const name = saved.name ?? TAB_NAME; // saved before the name was configurable
  const profile = saved.profile ?? PROFILE; // saved before the profile was configurable
  if (typeof name === "string" && name.trim() && typeof profile === "string" && profile.trim() && Array.isArray(rules)
    && rules.every((r) => r && Object.entries(RULE_FIELDS).every(([k, type]) => typeof r[k] === type))) return { name, profile, rules };
  return { name: TAB_NAME, profile: PROFILE, error: "The saved settings are not a tab name, a profile and a list of { regex, command, description, tab } rules, so no rules are used.",
    raw: JSON.stringify(saved, null, 2) };
};
const RECORDS_SHOWN = 300; // rows per "Show more": thousands of rows at once make the dialog slow
const recordKey = (r) => JSON.stringify([r.description, r.argv]);
const shown = (arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);

// Calls onChange while owner.open whenever a writer changes the board owner.ref.db (see Shepherd.watch).
function follow(owner, cx, onChange) {
  const db = owner.ref.db;
  if (!db) return;
  cx.spawn(async (cx) => {
    try {
      while (owner.open) {
        const changed = await watchFolder(db.slice(0, db.lastIndexOf("/")) || "/");
        if (owner.open && changed.includes(db)) onChange(cx);
      }
    } catch {}
  });
}

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
    this.scan = null; this.launches = {}; this.shown = RECORDS_SHOWN; this.at = 0; // records tab: last scan, launch results by record, rows listed, selected row
    this.draft = null; this.base = null; // the editor's text state and the version it started from
    this.key = `${this.ref.board}:${this.ref.id}`;
    this.loads = 0;
    this.load(cx);
    this.watch(cx);
  }

  // Without an editor open, the stored draft is the latest one; store() would drop it.
  close() { this.open = false; if (this.draft) this.store(); }

  // Replies to overlapping loads can arrive out of order; only the latest one counts.
  load(cx) {
    const seq = ++this.loads;
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--task", this.ref.board, this.ref.id]);
        if (seq !== this.loads) return;
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.task = reply; this.error = "";
      } catch (e) { if (seq === this.loads) this.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  // Follows the board like the tab does, so a task that leaves Triage shows as locked without a reopen.
  watch(cx) { follow(this, cx, (cx) => this.load(cx)); }

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

    const tabs = h_flex().flex_none().px(18).gap(4).items_center().border_b(1).border_color(t.border)
      .children(TABS.map((tab) => h_flex().id(`details-tab-${tab.key}`).h(30).px(10).items_center().text_size(12.5)
        .border_b(2).border_color(tab.key === this.tab ? t.accent : t.popover)
        .text_color(tab.key === this.tab ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.tab = tab.key; this.handle.focus(); cx.notify(); }).child(tab.label ?? savedRules().name)))
      .child(div().flex_1())
      .child(div().flex_none().text_size(11).text_color(t.dim).child("← → switch tabs"));

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

    const records = this.tab === "sessions" ? (this.scan?.records ?? []).slice(0, this.shown) : [];
    if (records.length) this.at = Math.min(this.at, records.length - 1); // a rescan can shorten the list
    return v_flex().id("details").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        // Only while the dialog itself has the keyboard: in the editor these keys edit text.
        else if (!this.handle.is_focused()) return;
        else if (e.key === "left" || e.key === "right") {
          const i = TABS.findIndex((tab) => tab.key === this.tab);
          this.tab = TABS[(i + (e.key === "right" ? 1 : TABS.length - 1)) % TABS.length].key;
        } else if ((e.key === "up" || e.key === "down") && records.length)
          this.at = Math.max(0, Math.min(records.length - 1, this.at + (e.key === "down" ? 1 : -1)));
        else if (e.key === "enter" && records[this.at]) this.launch(records[this.at], recordKey(records[this.at]), cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(header)
      .child(tabs)
      .when(Boolean(this.error), (el) => el.child(div().px(18).child(banner(
        task ? `Cannot refresh this task. Showing the last successful read. ${this.error}` : this.error, t.blocked))))
      .when(Boolean(body), (el) => el.child(body));
  }

  // Rescans when the rules or the task change; the helper reads the task itself and matches with a time limit.
  // Only the child process evaluates regexes; this starts it and returns, and its reply arrives with a later render.
  scanSessions(cx) {
    const saved = savedRules();
    // Only this task's text: a board write elsewhere reloads the task, but must not start another scan.
    const task = this.task;
    const key = JSON.stringify([saved.rules, saved.raw, task.body, task.result, task.comments.map((c) => c.body), task.runs.map((r) => r.summary)]);
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
    if (space.machine) return show(cx, `Record commands run on this computer, and the selected space is on ${space.machine}.`, true);
    if (record.refused) return show(cx, record.refused, true);
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
    const item = (r, i) => {
      const key = recordKey(r);
      const launch = this.launches[key] ?? (r.refused && { text: r.refused, failed: true });
      return v_flex().id(`session-${key}`).flex_none().p(10).gap(4).rounded(7).border(1)
        .border_color(i === this.at ? t.accent : t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.at = i; this.handle.focus(); this.launch(r, key, cx); })
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(r.description || "(empty description)"))
          .child(div().flex_none().px(6).rounded(5).bg(t.surface).text_size(11.5).text_color(t.muted).child(r.tab ? "New tab" : "Background")))
        .child(div().text_size(11.5).text_color(t.dim).child(r.argv.map(shown).join(" ")))
        .when(Boolean(launch), (el) => el.child(div().text_size(12).text_color(launch.failed ? t.blocked : t.muted).child(launch.text)));
    };
    return v_flex().flex_1().min_h(0).px(18).pb(18).pt(10).gap(8).overflow_y_scrollbar()
      .child(div().text_size(11.5).text_color(t.dim).child("Records your rules find in the description, result, comments and run summaries. "
        + "A click, or ↑ ↓ and Enter, starts the command again, in the selected space's folder. Settings at the top right edits the rules."))
      .when(Boolean(scan?.error), (el) => el.child(banner(scan.error, t.blocked)))
      .children((scan?.errors ?? []).map((e) => banner(e.error, t.blocked)))
      .when(!saved.error && !saved.rules?.length, (el) => el.child(note("No rules yet. Add them with Settings at the top right.")))
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

// The Settings dialog, opened by the Settings control with props { settings }. It edits a copy of the
// shared rules and records tab name, saves it only when the helper finds no problem in any rule,
// and asks before Esc or Close throws away unsaved changes.
let escapeBound = false;
const RULE_KEYS = { "alt-shift-up": "shepherd-rule-up", "alt-shift-down": "shepherd-rule-down", "alt-t": "shepherd-rule-tab",
  "alt-shift-backspace": "shepherd-rule-remove" };
class SessionSettings {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const saved = savedRules();
    this.malformed = saved.error ? saved : null;
    this.name = InputState.new({ value: saved.name, placeholder: TAB_NAME });
    this.profile = InputState.new({ value: saved.profile, placeholder: PROFILE });
    this.rows = (saved.rules ?? []).map((r) => this.row(r));
    this.errors = {}; this.notice = ""; this.saving = false; this.confirming = false;
    this.clean = JSON.stringify(this.current());
    // Herdr closes the top dialog on Esc before a key handler sees it; a binding in this dialog's context comes first.
    // The keymap is the App's, so bind it once.
    // The rule keys work from inside the rule's inputs too, so they are bindings that beat the inputs' own.
    if (!escapeBound) escapeBound = cx.bind_keys([{ keystroke: "escape", action: "shepherd-settings-escape", context: "ShepherdSettings" },
      ...Object.entries(RULE_KEYS).map(([keystroke, action]) => ({ keystroke, action, context: "ShepherdSettings" }))]) > 0;
    // The outlined rule, which the rule keys act on: the last one clicked, typed in, added, or picked with ↑ ↓.
    // An input's "focus" event does not reach the mod, so tabbing into a rule does not outline it.
    this.at = 0;
  }

  current() {
    return { name: this.name.value().trim(), profile: this.profile.value().trim(),
      rules: this.rows.map((r) => ({ regex: r.regex.value(), command: r.command.value(), description: r.description.value(), tab: r.tab })) };
  }

  // Esc, Close and ✕: with unsaved changes, ask first. Only Discard then closes; Esc again keeps editing.
  leave(cx) {
    if (JSON.stringify(this.current()) === this.clean) return closeOverlay(props().overlay);
    this.confirming = true; cx.notify();
  }

  row(rule = { regex: "", command: "", description: "", tab: true }) {
    const row = {
      regex: InputState.new({ value: rule.regex, placeholder: "e.g. session: (\\S+) harness: claude" }),
      command: InputState.new({ value: rule.command, placeholder: "e.g. claude --resume $1" }),
      description: InputState.new({ value: rule.description, placeholder: "e.g. Claude session $1" }),
      tab: rule.tab,
    };
    // Typing in a rule outlines it, so the rule keys act on the rule being edited.
    for (const field of ["regex", "command", "description"])
      row[field].on("change", (_e, cx) => { const i = this.rows.indexOf(row); if (i >= 0 && i !== this.at) { this.at = i; cx.notify(); } });
    return row;
  }

  release(row) { for (const field of ["regex", "command", "description"]) row[field].release(); }
  close() { this.closed = true; this.rows.forEach((row) => this.release(row)); this.rows = []; this.name.release(); this.profile.release(); }

  edit(cx, change) { change(); this.errors = {}; this.notice = ""; this.confirming = false; cx.notify(); }
  move(i, step, cx) {
    if (i + step < 0 || i + step >= this.rows.length) return;
    this.edit(cx, () => { const [row] = this.rows.splice(i, 1); this.rows.splice(i + step, 0, row); if (this.at === i) this.at = i + step; else if (this.at === i + step) this.at = i; });
  }
  // The removed rule's input may hold the keyboard; the dialog takes it back so Esc still asks before discarding.
  remove(i, cx) { this.handle.focus(); this.edit(cx, () => { this.release(this.rows.splice(i, 1)[0]); this.at = Math.max(0, Math.min(this.at > i ? this.at - 1 : this.at, this.rows.length - 1)); }); }
  toggle(i, cx) { this.edit(cx, () => { this.rows[i].tab = !this.rows[i].tab; }); }

  save(cx) {
    if (this.saving) return;
    this.notice = ""; this.confirming = false;
    const settings = this.current();
    if (!settings.name) { this.notice = "Not saved: the tab name is empty."; return cx.notify(); }
    if (!settings.profile) { this.notice = "Not saved: the Hermes profile is empty."; return cx.notify(); }
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--check-rules", JSON.stringify(settings.rules)]);
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.errors = {};
        for (const e of reply.errors) (this.errors[e.rule] ??= []).push(e.error);
        if (reply.errors.length) { this.notice = "Not saved: fix the rules marked below."; return; }
        const checked = await call(["--check-profile", settings.profile]);
        if (checked.code !== 0 || checked.reply.error) { this.notice = `Not saved: ${checked.reply.error || `${HELPER} exited with code ${checked.code}`}`; return; }
        // Typing goes straight into the inputs, so text changed during the check was not checked.
        if (this.closed) return; // discarded while the check ran
        if (JSON.stringify(this.current()) !== JSON.stringify(settings)) { this.notice = "Not saved: the settings changed while they were checked. Save again."; return; }
        setShared(RULES, settings);
        this.clean = JSON.stringify(settings);
        // The panel's runner reads the file at its next start; a failed write is reported, the setting is kept.
        try { await writeProfile(settings.profile); } catch (e) { this.notice = `Saved, but the panel cannot read the new profile yet: ${e?.message ?? e}`; return; }
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
      .border_color(this.errors[i] ? t.blocked : i === this.at ? t.accent : t.border).bg(t.surface)
      .on_mouse_down("left", (_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child(`Rule ${i + 1}`))
        .child(h_flex().id(`rule-tab-${i}`).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.foreground)
          .on_click((_e, cx) => this.toggle(i, cx))
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
      .key_context("ShepherdSettings")
      .on_action("shepherd-settings-escape", (_e, cx) => {
        if (this.confirming) { this.confirming = false; cx.notify(); } else this.leave(cx);
      })
      .on_action("shepherd-rule-up", (_e, cx) => this.rows[this.at] && this.move(this.at, -1, cx))
      .on_action("shepherd-rule-down", (_e, cx) => this.rows[this.at] && this.move(this.at, 1, cx))
      .on_action("shepherd-rule-tab", (_e, cx) => this.rows[this.at] && this.toggle(this.at, cx))
      .on_action("shepherd-rule-remove", (_e, cx) => this.rows[this.at] && this.remove(this.at, cx))
      // ↑ ↓ pick a rule and Enter edits it, while no input has the keyboard.
      .on_key_down((e, cx) => {
        if (!this.handle.is_focused() || !this.rows.length) return;
        if (e.key === "up" || e.key === "down") this.at = Math.max(0, Math.min(this.rows.length - 1, this.at + (e.key === "down" ? 1 : -1)));
        else if (e.key === "enter" && this.rows[this.at]) this.rows[this.at].regex.focus();
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().flex_none().px(18).pt(16).pb(10).gap(10).items_start().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(15).font_semibold().child("Settings"))
          .child(div().text_size(11.5).text_color(t.dim).child("Shared by every Shepherd tab. A task's records tab lists what the rules find in its "
            + "description, result, comments and run summaries. At each place in the text the earliest match wins, and the first rule among matches there.")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc"))
        .child(h_flex().id("settings-close").size(24).flex_none().items_center().justify_center().rounded(6)
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.leave(cx)).child("✕")))
      .child(v_flex().id("rules").flex_1().min_h(0).px(18).py(12).gap(10).overflow_y_scrollbar()
        .child(field("Hermes profile: the Shepherd panel runs `hermes -p <profile>`; a change applies at its next start or Restart", this.profile))
        .child(field("Records tab name: the task popup's tab that lists the records", this.name))
        .child(div().pt(6).text_size(12.5).font_semibold().text_color(t.foreground).child("Rules"))
        .child(div().text_size(12).text_color(t.muted).child("Regex: a Python regular expression. Command and Description: $1, $2 … insert capture groups, "
          + "$0 the whole match, $$ a dollar sign. The command is split into arguments the way a shell would (quotes, backslashes) before "
          + "captures go in, so a capture is always literal text inside one argument. It runs without a shell, through Herdr Core, "
          + "in the selected space's folder: in a new tab, or in the background when Open in new tab is off. Matching stops a rule "
          + "that spends more than half of 3 s on a task, and matches the other rules without it. A record whose command would get "
          + "a capture starting with “-” is not started, so task text cannot add options."))
        .child(div().text_size(12).text_color(t.muted).child("Keys act on the outlined rule; a click, typing or ↑ ↓ outlines one, and Enter edits it. "
          + "Alt+Shift+↑ and Alt+Shift+↓ move it, Alt+T toggles Open in new tab, and Alt+Shift+Backspace removes it, also while typing in it."))
        .when(Boolean(this.malformed), (el) => el.child(v_flex().p(10).gap(6).rounded(7).border(1).border_color(t.blocked).bg(t.surface)
          .child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(this.malformed.error))
          .child(div().text_size(12).text_color(t.foreground).child("They are kept as they are. Saving here replaces them with the rules below."))
          .child(TextView.markdown("settings-raw", `\`\`\`json\n${this.malformed.raw}\n\`\`\``).selectable(true).text_size(12))))
        .when(!this.rows.length, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("No rules yet.")))
        .children(this.rows.map(rule))
        .child(h_flex().child(button("rule-add", "Add rule", false, (_e, cx) => this.edit(cx, () => { this.at = this.rows.push(this.row()) - 1; })))))
      .child(h_flex().flex_none().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
        .children(this.confirming ? [
          div().flex_1().text_size(12.5).text_color(t.blocked).child("Discard your unsaved changes?"),
          button("settings-keep", "Keep editing", false, (_e, cx) => { this.confirming = false; cx.notify(); }),
          button("settings-discard", "Discard", true, () => closeOverlay(props().overlay)),
        ] : [
          div().flex_1().min_w(0).text_size(12).text_color(this.notice === "Saved." ? t.muted : t.blocked).child(this.notice),
          button("settings-cancel", "Close", false, (_e, cx) => this.leave(cx)),
          button("settings-save", this.saving ? "Checking…" : "Save", true, (_e, cx) => this.save(cx)),
        ]));
  }
}

// Task actions: a card's menu (ActionMenu), the confirmation of an archive, restore or delete (Confirm),
// and the archived-task list (Archived). Every change runs the helper's --act with the status the person
// saw; the helper rechecks it and refuses a task that changed, so an open menu or confirmation never acts
// on stale state. Hermes's own operations make the change; a refusal shows Hermes's reason.

const openDetails = (ref) => openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 760, height: 0.85, props: { task: ref } });
const openConfirm = (action, ref) => openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 520, height: 340,
  props: { confirm: { action, board: ref.board, db: ref.db, id: ref.id } } });
const VERB = { todo: "Send to Todo", ready: "Send to Ready", archive: "Archive", restore: "Restore to Triage", delete: "Delete permanently" };
// Which status each action needs; archive takes any task that is not archived yet.
const allowed = (action, state) => action === "archive" ? state !== "archived"
  : action === "todo" || action === "ready" ? state === "triage" : state === "archived";

// Resolves with the helper's reply; rejects with Hermes's reason and, when refused, the task as it is now.
async function act(ref, action, expected) {
  const { code, reply } = await call(["--act", ref.board, ref.id, action, expected]);
  if (code !== 0) throw Object.assign(new Error(reply.error || `${HELPER} exited with code ${code}`), { task: reply.task });
  return reply;
}

// Says where Hermes left the task, which can differ from the column asked for.
function announce(action, title, reply) {
  const body = action === "delete" ? "The task and its history are gone."
    : action === "archive" ? "Show archived lists it."
    : action === "restore" ? "Its description can be edited while it stays in Triage."
    : `Hermes shows it in ${status(reply.status)}.${reply.status === "ready" ? " It may start now." : ""}`;
  notify({ title: `${VERB[action]}: ${title}`, body, level: "success" });
}

const actionButton = (t, id, text, kind, onClick) => h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7)
  .border_1().border_color(kind === "primary" ? t.solid : kind === "danger" ? t.blocked : t.input)
  .bg(kind === "primary" ? t.solid : kind === "danger" ? t.blocked : t.raised)
  .text_color(kind ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
  .hover((s) => s.opacity(0.88)).on_click(onClick).child(text);
const errorBox = (t, text) => div().p(8).rounded(7).border(1).border_color(t.blocked).bg(t.surface).text_size(12).text_color(t.foreground).child(text);

class ActionMenu {
  init(cx) {
    this.ref = props().actions;
    this.state = this.ref.status; this.error = ""; this.busy = false; this.at = 0;
    this.handle = cx.focus_handle(); this.handle.focus();
  }

  close() {}

  items() { return ["todo", "ready", "archive"].filter((action) => allowed(action, this.state)); }

  choose(action, cx) {
    if (this.busy) return;
    if (action === "archive") { closeOverlay(props().overlay); openConfirm("archive", this.ref); return; }
    // Leaving Triage needs no confirmation: the menu says Hermes takes over.
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      try {
        const reply = await act(this.ref, action, this.state);
        closeOverlay(props().overlay);
        announce(action, this.ref.title, reply);
      } catch (e) {
        this.error = e?.message ?? String(e);
        if (e?.task) this.state = e.task.status;
      } finally { this.busy = false; this.at = 0; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const items = this.items();
    return v_flex().id("task-actions").track_focus(this.handle).size_full().p(5).gap(2).bg(t.popover).text_size(12.8).overflow_y_scrollbar()
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter" && items[this.at]) this.choose(items[this.at], cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().px(8).pt(4).pb(2).truncate().text_size(11.5).text_color(t.dim).child(this.ref.title))
      // A refusal takes the explanation's place, so it fits the popup.
      .when(Boolean(this.error), (el) => el.child(errorBox(t, this.error)))
      .when(!this.error && this.state === "triage", (el) => el.child(div().px(8).pb(4).text_size(11.5).text_color(t.muted)
        .child("Leaving Triage hands the task to Hermes, which may start it right away. Hermes keeps it out of Ready while a parent task is unfinished.")))
      .children(items.map((action, i) => h_flex().id(`action-${action}`).h(31).px(8).flex_none().rounded(7).items_center()
        .text_color(t.foreground).when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(action, cx))
        .child(this.busy && action !== "archive" ? `${VERB[action]}…` : action === "archive" ? "Archive…" : VERB[action])))
      .when(!items.length, (el) => el.child(div().px(8).text_size(12).text_color(t.muted).child(`The task is ${status(this.state)} now.`)));
  }
}

class Confirm {
  init(cx) {
    this.ref = props().confirm;
    this.task = null; this.error = ""; this.busy = false; this.open = true; this.loads = 0;
    this.handle = cx.focus_handle(); this.handle.focus();
    this.load(cx);
    this.watch(cx);
  }

  close() { this.open = false; }

  // The explanation and the status sent with the change both come from this read.
  load(cx) {
    const seq = ++this.loads;
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--task", this.ref.board, this.ref.id]);
        if (seq !== this.loads) return;
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.task = reply;
      } catch (e) { if (seq === this.loads) this.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  watch(cx) { follow(this, cx, (cx) => { if (!this.busy) this.load(cx); }); }

  confirm(cx) {
    const { action } = this.ref;
    if (this.busy || !this.task || !allowed(action, this.task.status)) return;
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      try {
        const reply = await act(this.ref, action, this.task.status);
        closeOverlay(props().overlay);
        announce(action, this.task.title, reply);
      } catch (e) {
        this.error = e?.message ?? String(e);
        if (e?.task) this.task = e.task;
      } finally { this.busy = false; cx.notify(); }
    });
  }

  // What Hermes does, from the task as it is now.
  effects(task) {
    const { action } = this.ref;
    if (action === "delete") return [`This permanently removes “${task.title}” from Hermes: its description, comments, runs and history, and its links to other tasks. It cannot be undone.`];
    if (action === "restore") return [
      "The task goes back to Triage, not to the column it left, and keeps its history. Hermes does not start it until it is sent to Todo or Ready.",
      "Its description can be edited again while it stays in Triage.",
      task.children.length && "A restored task counts as unfinished again: Hermes moves its child tasks, and theirs, that are Ready, Running, Review or Done back to Todo, and stops the workers of running ones.",
    ];
    const path = task.workspace ? ` ${task.workspace}` : "";
    // Hermes promotes only Todo and Blocked children whose parents are all finished.
    const waiting = task.children.filter((c) => ["todo", "blocked"].includes(c.status));
    return [
      "The task leaves the board. Its description, comments, runs and history are kept, and Show archived can restore or delete it.",
      task.status === "running" && "It is running: Hermes ends the run and stops the worker process it started for this task on this computer. Hermes does not stop agents it did not start, such as ones your own plugins launched.",
      task.workspace && (task.workspace_kind === "scratch" ? `Hermes deletes its scratch workspace${path}, unless a child task still needs it.`
        : task.workspace_kind === "worktree" ? `Hermes removes its git worktree${path} if it has no uncommitted or unpushed work, unless a child task still needs it.`
        : `Its folder${path} is kept.`),
      waiting.length && `Archived tasks count as finished for their children, so ${waiting.map((c) => `“${c.title}”`).join(", ")} may move to Ready and start.`,
    ];
  }

  render(cx) {
    const t = theme();
    const { action } = this.ref;
    const task = this.task;
    const ok = task && allowed(action, task.status);
    return v_flex().id("confirm-action").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        // Enter confirms, except a permanent delete, which takes a click.
        if (e.key === "enter" && action !== "delete") this.confirm(cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground)
          .child(`${action === "archive" ? "Archive" : action === "restore" ? "Restore" : "Delete"} “${task?.title ?? "…"}”?`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().flex_1().min_h(0).gap(8).overflow_y_scrollbar().text_color(t.muted)
        .when(Boolean(task && !ok), (el) => el.child(div().text_color(t.foreground).child(`The task is ${status(task.status)} now, so it cannot be ${action === "archive" ? "archived" : action === "restore" ? "restored" : "deleted"}.`)))
        .when(Boolean(ok), (el) => el.children(this.effects(task).filter(Boolean).map((text) => div().child(text))))
        .when(Boolean(this.error), (el) => el.child(errorBox(t, this.error))))
      .child(h_flex().justify_end().gap(8)
        .child(actionButton(t, "confirm-cancel", "Cancel", null, () => closeOverlay(props().overlay)))
        .when(Boolean(ok), (el) => el.child(actionButton(t, "confirm-yes", this.busy ? "Working…" : VERB[action],
          action === "delete" ? "danger" : "primary", (_e, cx) => this.confirm(cx)))));
  }
}

class Archived {
  init(cx) {
    this.ref = props().archived;
    this.tasks = null; this.error = ""; this.open = true; this.at = 0; this.loads = 0;
    this.handle = cx.focus_handle(); this.handle.focus();
    this.load(cx);
    this.watch(cx);
  }

  close() { this.open = false; }

  load(cx) {
    const seq = ++this.loads;
    cx.spawn(async (cx) => {
      try {
        const { code, reply } = await call(["--archived", this.ref.board]);
        if (seq !== this.loads) return;
        if (code !== 0 || reply.error) throw new Error(reply.error || `${HELPER} exited with code ${code}`);
        this.tasks = reply.tasks; this.error = "";
      } catch (e) { if (seq === this.loads) this.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  watch(cx) { follow(this, cx, (cx) => this.load(cx)); }

  render(cx) {
    const t = theme();
    const ref = (task) => ({ board: this.ref.board, db: this.ref.db, id: task.id });
    const small = (id, text, onClick) => h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).text_size(12)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); }).child(text);
    const tasks = this.tasks ?? [];
    const row = (task, i) => h_flex().id(`archived-${task.id}`).flex_none().p(10).gap(8).items_center().rounded(8)
      .border(1).border_color(i === this.at ? t.accent : t.border).bg(t.background).hover((s) => s.bg(t.hover))
      .on_click(() => openDetails(ref(task)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(13).text_color(t.foreground).child(task.title))
        .child(div().truncate().text_size(11.5).text_color(t.dim)
          .child([task.assignee || "Unassigned", task.spec, task.id].filter(Boolean).join(" · "))))
      .child(small(`restore-${task.id}`, "Restore…", () => openConfirm("restore", ref(task))))
      .child(small(`delete-${task.id}`, "Delete…", () => openConfirm("delete", ref(task))));
    return v_flex().id("shepherd-archived").track_focus(this.handle).size_full().bg(t.popover)
      .on_key_down((e, cx) => {
        const task = tasks[Math.min(this.at, tasks.length - 1)];
        if (e.key === "down" || e.key === "up") this.at = Math.max(0, Math.min(tasks.length - 1, this.at + (e.key === "down" ? 1 : -1)));
        else if (e.key === "enter" && task) openDetails(ref(task));
        else if (e.key === "r" && task) openConfirm("restore", ref(task));
        else if (e.key === "d" && task) openConfirm("delete", ref(task));
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().flex_none().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`Archived tasks · ${this.ref.name}`))
          .child(div().text_size(11.5).text_color(t.dim).child("Click or Enter reads a task. Restore (r) returns it to Triage; Delete (d) removes it for good.")))
        .child(small("archived-close", "Close", () => closeOverlay(props().overlay))))
      .child(v_flex().id("archived-list").flex_1().min_h(0).p(12).gap(8).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(errorBox(t, `Cannot read archived tasks. ${this.error}`)))
        .when(Boolean(this.tasks && !this.tasks.length), (el) => el.child(div().text_size(12.5).text_color(t.muted).child("No archived tasks on this board.")))
        .children(tasks.map(row)));
  }
}

// The Shepherd panel's header (props { panel }): starts the panel terminal when the panel shows and none exists,
// says whether Hermes runs or how it ended, and offers the deliberate restart. Nothing restarts on its own.
// The terminal is found by its name, never by a stored address: Core reuses addresses after a restart.
class ShepherdPanel {
  // phase: null (follow the live terminal), "checking", "launching", "gone" (ended; waits for Start again) or "failed".
  init(_cx) { this.phase = null; this.error = ""; this.why = null; this.reshow = false; }

  // Nothing to release: the hermes-shepherd terminal outlives the header on purpose (--no-parent).
  close() {}

  live() { return terminals().find((t) => t.state === "live" && t.name === PANEL_TERMINAL); }

  status() {
    const term = this.live();
    if (term) {
      const code = term.labels?.[EXIT];
      return code ? { kind: "exited", code, term } : { kind: "running", term };
    }
    return { kind: this.phase ?? "checking" };
  }

  ensure(cx) {
    const status = this.status();
    if (status.term) {
      this.phase = null;
      // The terminal block looks its terminal up by name when it shows, so show it again once Core lists the new one.
      if (this.reshow && findNode(layout(), PANEL_BLOCK)) { run("layout.hide", { id: PANEL_BLOCK }); run("layout.show", { id: PANEL_BLOCK }); }
      this.reshow = false;
      if (status.kind === "exited" && this.why?.key !== `${status.term.address}:${status.code}`) this.readWhy(status.term.address, status.code, cx);
    } else if (this.phase === null) this.check(cx);
  }

  // terminals() lists live terminals only, and a new one shows up a little after `hc run` returns, so Core is asked.
  // No terminal: start one. A finished one is removed at once and waits for Start again: a terminal block finds
  // finished terminals by name too, and Herdr App deletes a block that shows one.
  check(cx) {
    this.phase = "checking";
    cx.spawn(async (cx) => {
      let got = null;
      try { got = await hc(["get", PANEL_TERMINAL, "--json"]); } catch {}
      const term = got?.code === 0 ? hcReply(got) : null;
      if (term?.state === "live") cx.timer.after(1000, (cx) => { if (this.phase === "checking") this.phase = null; cx.notify(); });
      else if (term) { try { await hc(["rm", term.address]); } catch {} this.phase = "gone"; }
      else this.launch(cx);
      cx.notify();
    });
  }

  launch(cx) {
    this.phase = "launching";
    cx.spawn(async (cx) => {
      try {
        // Without the file the runner falls back to the default profile, so start anyway and say so.
        this.profileError = "";
        try { await writeProfile(savedRules().profile); } catch (e) { this.profileError = e?.message ?? String(e); }
        let result;
        try { result = await hc(["run", "--bg", "--json", "--no-parent", "--name", PANEL_TERMINAL, "--cwd", home(),
          "--", "sh", "-c", RUNNER, PANEL_TERMINAL, profileFile(), "hermes"]); }
        catch (e) { throw new Error(`Cannot run hc: ${e?.message ?? e}`); }
        if (result.code !== 0) {
          // Another screen's panel may have started it first: names are unique among live terminals.
          const got = await hc(["get", PANEL_TERMINAL, "--json"]);
          if (!(got.code === 0 && hcReply(got)?.state === "live")) throw new Error(hcError(result, hcReply(result)));
        }
        this.phase = null; this.reshow = true;
      } catch (e) { this.phase = "failed"; this.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  // The last line Hermes printed before it exited usually says why, e.g. a missing profile or `hermes: command not found`.
  readWhy(address, code, cx) {
    const why = this.why = { key: `${address}:${code}`, line: "" };
    cx.spawn(async (cx) => {
      try {
        const read = await hc(["read", address, "--lines", "12"]);
        const lines = read.code === 0 ? read.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[Hermes exited")) : [];
        why.line = lines.pop() ?? "";
      } catch {}
      cx.notify();
    });
  }

  // Exited: the shell starts Hermes again on Enter. Gone or failed: start a new terminal once.
  restart(status, cx) {
    if (status.kind === "exited") cx.spawn(async () => { try { await writeProfile(savedRules().profile); await hc(["keys", status.term.address, "enter"]); } catch {} });
    else { this.phase = null; this.error = ""; }
  }

  render(cx) {
    this.ensure(cx);
    const t = theme();
    const status = this.status();
    const why = this.why?.line ? `: ${this.why.line}` : "";
    const profile = savedRules().profile;
    const using = status.term?.labels?.[RUNNING_PROFILE];
    const later = using && using !== profile ? ` Settings say \`${profile}\`; it applies at the next start or Restart.` : "";
    const [text, action] = {
      checking: [`Starting Hermes (\`${profile}\`)…`], launching: [`Starting Hermes (\`${profile}\`)…`],
      running: [`Running \`hermes -p ${using ?? profile}\`.${later}${this.profileError ? ` Cannot write the profile file: ${this.profileError}` : ""}`],
      exited: [`Hermes (\`${using ?? profile}\`) exited with code ${status.code}${why}.${later}`, "Restart"],
      gone: ["The Shepherd terminal is gone.", "Start again"],
      failed: [`Cannot start Hermes: ${this.error}`, "Start again"],
    }[status.kind];
    const button = (id, label, onClick, solid) => h_flex().id(id).h(24).px(9).flex_none().items_center().rounded(6).text_size(12)
      .bg(solid ? t.solid : t.chrome).text_color(solid ? t.solid_foreground : t.muted)
      .hover((s) => solid ? s.opacity(0.85) : s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
    return h_flex().id("shepherd-panel").size_full().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(svg(`mods/${MOD}/coordinator.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child("Shepherd"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(action ? t.blocked : t.dim)
        .child(findNode(layout(), PANEL_BLOCK) ? text : `${text} Add the "${PANEL_BLOCK}" block back to your layout (see the README).`))
      .when(Boolean(action), (el) => el.child(button("shepherd-restart", action, (cx) => this.restart(status, cx), true)))
      .child(button("shepherd-hide", "Hide", () => run("layout.hide", { id: PANEL }), false));
  }
}

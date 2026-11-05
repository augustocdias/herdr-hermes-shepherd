// Hermes Shepherd: a read-only view of a Hermes kanban board, opened as a tab.
// The board is the one named like the tab (slug or display name); otherwise Hermes's
// default board, and the toolbar says so. Repository and spec filters are global.
// Opened as a popup with props { menu } it is the board's own filter picker.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, exec, watchFolder, theme, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const MOD = "hermes-shepherd";
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

export default class Shepherd extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.menu) { this.at = 0; this.handle.focus(); return; }
    this.data = null; this.error = ""; this.loading = false; this.queued = false; this.updated = null;
    this.sel = null; this.tab = null; this.requested = undefined; this.watches = 0;
    cx.timer.every(POLL_MS, (cx) => { if (this.requested !== undefined) this.refresh(cx); });
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

  render(cx) {
    if (props()?.menu) return this.renderMenu(props().menu);
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
        .on_click((_e, cx) => { this.sel = { col: c, row: r }; this.handle.focus(); cx.notify(); })
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
        else if (e.key === "r") this.openMenu("repository");
        else if (e.key === "s") this.openMenu("spec");
        else if (e.key === "f5") this.refresh(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(toolbar)
      .when(Boolean(banner), (el) => el.child(banner))
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

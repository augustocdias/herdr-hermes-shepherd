# AGENTS.md

Hermes Shepherd is a Herdr App mod that shows and edits a Hermes kanban board. `README.md` is the user-facing contract: every behavior it states is a promise, so change it together with the behavior.

## Map

- `mods/hermes-shepherd/main.js` is the whole UI. One default-exported `View` routes on its props: none for the board tab, `panel` for the Shepherd panel header, and `menu`, `cron`, `task`, `settings`, `actions`, `confirm` or `archived` for the overlays it opens of itself. The header comment lists the routes.
- `board/hermes_shepherd_board.py` is the only code that touches a board. It prints JSON, exits 1 with `{"error"}`, and exits 2 when it refuses a write, returning the task's current details. Its module docstring is the CLI contract.
- `board/hermes_shepherd_cron.py` lists cron jobs of every profile, read-only.
- `home-manager.nix` installs `main.js` and `mod.json` as store symlinks and wraps both helpers with the configured Hermes Python. A new file the mod needs at runtime must be added there too.
- `tests/` runs the helpers as subprocesses against real `hermes_cli` in a temporary `HERMES_HOME`. There is no JS test harness.

## Commands

```sh
"$HERMES_PYTHON" -m unittest discover tests   # about 60 s
```

`$HERMES_PYTHON` is the interpreter that imports `hermes_cli`. It is usually unset in an agent shell. The Hermes Nix package's own `bin/hermes` script sets it in a `HERMES_PYTHON='...'` line; the `hermes` on PATH may be a jail wrapper that `exec`s that script. The `hermes` wrapper refuses to run inside the agent jail; use `"$HERMES_PYTHON" -m hermes_cli.main kanban ...` there instead, always with a temporary `HERMES_HOME`.

UI changes need a private App and Core, as the README's Development section describes. `herdr-app check <mod folder>` needs a Wayland display, so it fails inside the jail. A passing `check` proves only that the mod loads and renders once. Look at a `herdr-app shot` before claiming a visual result.

## Hermes kanban

Read the installed source, not memory: `"$HERMES_PYTHON" -I -c 'import hermes_cli; print(hermes_cli.__path__[0])'`. The package reports version `0.0.0`, so a Nix bump can change any of this without notice. The modules that matter are `kanban_db.py` (tasks, runs, events, state verbs), `kanban_db_connect.py` (connection, migrations, `write_txn`), `kanban_db_boards.py`, `kanban_workflow.py` (columns and manual moves), `kanban_db_dispatch.py`, `kanban_db_workspace.py`, and `plugins/kanban/dashboard/plugin_api.py` (the dashboard's handlers).

### Rules this repo keeps

- Write only through Hermes's own functions: `kb.edit_task`, `kb.archive_task`, `kb.delete_archived_task`, and the dashboard's `plugin_api.update_task` for status moves. `kanban_db` has no public move or restore function, so moves borrow the dashboard handler, which applies the parent gate, the restore cascade and worker kills. Never write SQL or set a status directly.
- Never create a board. `connect` creates `default` on demand, so `open_board` checks that the file exists first.
- Every write is check-then-write. The helper takes the status or description hash the person saw and refuses on a mismatch. Hermes offers no compare-and-set across calls, and `edit_task` raises inside a caller's `write_txn`, so a change landing between the check and the write gets through. Keep the `shortcut:` comments that say so.
- Re-read the task after a write. Moves re-route: Ready can land as Todo or Review, and Review to Todo lands as Ready.
- Show tasks as Hermes stores them. Repository comes only from a native `dir` workspace and spec only from `tenant`; never infer them.
- Strip `HERMES_KANBAN_DB`, `HERMES_KANBAN_BOARD`, `HERMES_KANBAN_HOME` and `HERMES_KANBAN_TASK` in tests. Each one redirects board resolution, and under a worker an explicit `board=` loses.

### Facts that are hard to find

- Kanban lives under one root shared by all profiles (`HERMES_KANBAN_HOME`, else the Hermes root). The `default` board is `<root>/kanban.db`; others are `<root>/kanban/boards/<slug>/kanban.db` beside a `board.json` that holds the display name. A board is a directory; there is no boards table. Cron is per profile, in `<profile home>/cron/jobs.json`, and reading it can create directories and rewrite the file.
- The first connection per process runs schema migrations under `<db>.init.lock`, and the dashboard handler calls `init_db` on every request. Reading a board can change its schema.
- Columns in order are `triage, todo, scheduled, ready, running, blocked, review, done`. `archived` is a filter, not a column. `scheduled` (shown as Parked) has no timer: a worker parks a task with a reason in a `scheduled` event, and only `unblock` or a manual move releases it.
- Parents count as finished when `done` or `archived`. The dispatcher's `recompute_ready` promotes Todo children once all parents are finished, so archiving a parent can start its children. At task creation only `done` counts.
- Moving a task out of `done` or `archived` (including restore) sends every ready, review, running or done descendant back to Todo and kills their running workers.
- Archive ends the active run, stops a host-local worker that Hermes started, deletes a scratch workspace, removes a worktree only when clean and pushed, and keeps a `dir`. Cleanup waits while a child still needs the workspace. `delete_archived_task` leaves `task_attachments` rows and files behind.
- The gateway runs the dispatcher every 60 s and, by default, auto-decomposes up to 3 Triage tasks per tick with an LLM. Decompose can rewrite a Triage task's title and body and move it to Todo, so a Triage description edit can race the gateway.
- Hermes has no change feed. Its dashboard and `hermes kanban watch` poll `task_events`. Some writes add no event, and deletes and `gc` remove events. Shepherd watches the board folder for `kanban.db` changes and polls every 30 s because commits can sit in the WAL until a checkpoint.

## Herdr App

The App writes its own guide on every start: `~/.config/herdr-app/AGENTS.md`, with the API types in `~/.config/herdr-app/herdr.d.ts` and the UI kit types in `mods/hermes-shepherd/gpui-kit.d.ts`. Read the guide's mod and layout sections before changing `main.js` or the README's layout snippet. `herdr-app commands` lists every command with its arguments. The `herdr-app` and `herdr-core` skills cover driving the window and terminals. The App rewrites these generated files, so never edit them.

### Mod facts that bite

- Top-level module code runs once per source version and is shared by every copy (since App 0.1.14). Keep instance state and host calls in the constructor or `init`. The icon writer at module scope is the one deliberate exception.
- Never keep a `cx` across callbacks. There is no `setTimeout`, `setInterval` or top-level `await`; use `cx.spawn`, `cx.sleep` and `cx.timer`. `cx.notify()` redraws the whole window, so animate with the kit's native `.loop`, `.frames` and `.transition`.
- A copy lives while its block is in the layout, including while hidden, and its timers keep running. `close(cx)` gets 250 ms.
- Saving a file in the mod folder reloads every copy. A broken save keeps the old build running and reports the error only in `herdr-app status`, so a working screen does not prove an edit loaded.
- Element colors accept only `#hex`. Take them from `theme()`; layout JSON accepts token names, element styles do not.
- `svg()` and `image()` draw nothing for a symlinked file, and the App remembers a missing image until it restarts. Home Manager installs symlinks, so `main.js` writes its SVGs as real files at load and draws them only after `ASSETS_READY`. New icons go into `ICONS` and `.gitignore`.
- Hidden files in the mod folder do not trigger a reload, which is why the panel's profile lives in `.profile`.
- Mod panes get no pane id. The board claims its tab on the first non-zero size change and follows the tab's name on each render; there is no rename event.
- `shared()`/`setShared()` state is global and persisted, and a set re-renders every mod. Filters, drafts and rules live there. Top-right buttons are herdr-navigation `tab-controls` set through `shared("tab-controls:hermes-shepherd")`; a click arrives as `hermes-shepherd.<id>` through `nextCommand()`.
- Find Core terminals by name, never by a stored address, because Core reuses addresses. Launch record commands as `hc run ... -- env -- <argv>` so `hc` never reads them as a shell line or a template. Refuse captures that start with `-`.

### Layouts and keys

- A layout is a tree of `row`, `column`, `stack` and `block` nodes with `id`, `size` (`{px}` or `{weight}`), `min`, `max` and `hidden`. Block content is `{mod, props}`, `{terminal}` or a tab or agent reference. The guide has the full schema.
- Shipped layouts (`main`, `terminals`, `win98`) are replaced on every start; personal changes go in a `layout.clone`. Clicks such as sizes and shown or hidden state live in `layouts/.state/<name>.json`. Shepherd never edits a layout; the panel exists only if the person's layout has the README's block.
- `keys.json` sections are `global`, `layout:<name>`, `terminal` and `mod:<name>`, and the most specific wins. `<mod>.<command>` reaches the mod's `nextCommand()`.
- The README says the App deletes a terminal block when its terminal ends and rewrote the Files and Changes column on App 0.1.11. The App 0.1.14 changelog says hand-edited layouts now keep their pieces. Re-test on the installed version before changing that behavior or its README text.

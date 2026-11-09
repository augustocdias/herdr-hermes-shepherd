# Hermes Shepherd

A Herdr App tab that shows a live view of a Hermes kanban board. It reads and edits the board only through the installed Hermes package's own task functions. It changes the board only through the description edit, comments, new tasks and the task actions described below. Like any `hermes kanban` command, opening a board may apply Hermes's own schema migrations.

## What the tab shows

- The board's columns in the order Hermes's workflow defines. Hermes's `scheduled` status appears as Parked, with the reason given when the task was parked.
- Every task that is not archived, including all of Done. Each card shows the title, a round status marker, and the assigned profile or Unassigned.
- Repository and Spec filters, which default to All. A task's spec is its Hermes `tenant`. Its repository is the folder of its native Hermes `dir:` workspace. Tasks without that metadata stay visible under All and appear under None.
- The time of the last successful read. If a read fails, a banner shows the error and the last successful read stays on screen.

The tab refreshes when a Hermes process that wrote to the board closes it, and every 30 seconds. Arrow keys move a selection between cards, Enter opens the selected card, `m` opens its menu, `n` opens New task, `r` and `s` open the Repository and Spec filters, and F5 refreshes.

### Task details

Clicking a card, or pressing Enter on it, opens the task in a dialog over the board. A side column shows the task's assigned profile, spec, repository, workspace, priority, dates, and its parent and child tasks as bullet lists. The tabs, which ← and → switch between, are:

- Details: the description, the result and the comments.
- Events: Hermes's log of changes to the task, such as created, claimed, blocked or completed. Hermes logs one for every comment too; those are left out, since the comment shows instead.
- Runs: each attempt a worker made, with its profile, outcome, times and summary or error.
- History: comments, events and runs together, in time order.
- The records tab (see Records and rules).

Descriptions, comments and run summaries are rendered as Markdown exactly as Hermes stores them. A table whose rows start with `|` gets its own box, as wide as its contents need, that scrolls sideways with the scrollbar under it, Shift+wheel or a sideways swipe. A plain wheel scrolls the page. The dialog follows the board, so a task that changes while it is open shows its new state. Esc or the close button dismisses it.

You can edit a task's description only while its Hermes status is Triage. Earlier states and runs do not matter: a task that ran before and was moved back to Triage, or restored from the archive, can be edited. A task in any other column is locked, even if it never ran. Archived tasks are read-only.

Save checks again, right before writing, that the task is still in Triage and that its description is still the one you began editing. If either check fails, nothing is written and your draft stays in the editor. When someone else changed the description, close the editor to read the new text; saving again then replaces it with your draft. A draft survives closing the dialog until you save or discard it. If the task leaves Triage first, the draft opens read-only so you can copy or discard it. Hermes cannot make that check and its write one transaction, so a task that leaves Triage in the instant between them still gets the save through; the dialog then warns that a worker may have the earlier description.

### Comments

Any task that is not Done or archived takes comments, running or not. Write one in the box under the comments and press Comment or Ctrl+Enter. Hermes stores it with the author `user`, as its own CLI does for a person without a profile, and Hermes workers read the comments of their task. Save checks again that the task is not Done or archived; if it is, nothing is added and the text stays in the box. A comment that is not added is lost when the dialog closes.

### Task actions

Every card has a menu (the `⋯` button). A Triage card offers Send to Todo and Send to Ready. Either one runs at once, without a confirmation: leaving Triage hands the task to Hermes, which may start it right away. Shepherd asks Hermes for the move through the handler that Hermes's own dashboard uses, so Hermes's dependency rule applies. Hermes refuses Ready while a parent task is unfinished, and the menu shows its reason. The task then stays in Triage.

A Blocked card has an Unblock button, and its menu offers Unblock too. It runs at once, like Send to Ready, through Hermes's own unblock. Hermes puts the task in Ready, or in Todo while a parent task is unfinished, and may start it right away. A toast says where it went.

Every card's menu also offers Archive, which asks first. The confirmation lists what Hermes will do to this task:

- A running task's run ends, and Hermes stops the worker process it started for the task on this computer. Hermes does not stop agents it did not start, such as ones your own plugins launched.
- Hermes deletes a scratch workspace unless a child task still needs it, removes a git worktree only if it has no uncommitted or unpushed work and no child task still needs it, and keeps a `dir` folder.
- Archived tasks count as finished for their children, so Todo and Blocked children whose other parents are finished may move to Ready and start.

Archiving keeps the description, comments, runs and history. Hermes's own `hermes kanban gc` may later delete old events of archived tasks.

### New tasks

New task, in the board's toolbar, or `n`, asks for a title and an optional Markdown description and adds the task to Triage on the tab's board through Hermes's own create function, with the creator `user`. Hermes picks its workspace as its dashboard does. No worker starts a Triage task, but with Hermes's `kanban.auto_decompose` setting on, its gateway may rewrite the task and send it to Todo within about a minute. Enter in the title, Ctrl+Enter in the description, or Add to Triage adds it, and the description can still be edited while the task is in Triage.

Show archived, at the top right, lists the board's archived tasks. If the board has not loaded, it says why instead. Click one to read its details. Restore moves it back to Triage, never to its old column, after a confirmation, so its description can be edited again. A restored task counts as unfinished again, so Hermes moves its descendants that are Ready, Running, Review or Done back to Todo and stops their running workers. Delete removes an archived task, its comments, runs, history and links for good, through Hermes's archived-only delete. It asks first, and Enter does not confirm it.

Each action sends the status the task had when you chose it. If the task changed since, nothing happens and the menu or confirmation shows the task as it is now. Hermes cannot make that check and the change one transaction, so a change landing in the instant between them is not caught.

### Which board a tab shows

A tab shows the Hermes board whose slug or display name matches the tab's name, ignoring case. An unnamed tab, or a name that matches no board, shows Hermes's `default` board, and the toolbar then says that no board has the tab's name. Renaming the tab switches the board. `hermes kanban boards list` lists the boards.

Filters are global: every Shepherd tab in every space uses the same Repository and Spec filters, and they persist across App restarts.

### The Shepherd panel

The Shepherd panel is a terminal running your existing Hermes coordinator, `hermes -p coordinator` unless Settings names another profile. It is part of your layout, like the Files and Changes panels. Shepherd changes the layout only when you press Restore panel to replace its missing terminal block. To get it, clone the layout you use and add this block next to the Files and Changes `panel` column, usually in the row that holds the tab (`work-body` in Herdr's main layout):

```json
{ "id": "shepherd", "type": "column", "hidden": true, "size": { "px": 460 }, "min": 280, "max": 1100,
  "children": [
    { "id": "shepherd-bar", "type": "block", "size": { "px": 36 },
      "content": { "mod": "hermes-shepherd", "props": { "panel": true } } },
    { "id": "shepherd-terminal", "type": "block", "content": { "terminal": "hermes-shepherd" } } ] }
```

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

Keep the ids `shepherd` and `shepherd-terminal` and the terminal name `hermes-shepherd`; the panel's header finds its terminal and hides the panel by them. Change the width, the limits or the place freely.

Showing and hiding the panel belongs to your layout, as it does for Files and Changes; Shepherd works the same whether or not your layout has the panel. Once shown, the panel stays beside every tab in every space, so you can talk to the coordinator from anywhere. The Shepherd button, rightmost at the top right of a Shepherd tab, shows and hides it, as do `herdr-app do layout.toggle --id shepherd` and the panel's own Hide button. Shepherd does not check whether your layout has the panel; without it, Herdr App reports the missing node itself. To toggle it with a key from any tab, also while a terminal has focus, add a binding to the `global` section of Herdr App's `keys.json`:

```json
"ctrl-shift-y": "layout.toggle:shepherd"
```

Pick any free key; a binding in the `terminal` section would win over it while a terminal has focus. The layout remembers the panel's width when you drag its edge, and whether it is shown, across restarts.

If `herdr-app commands` lists a `focus` argument for `layout.toggle`, use this binding instead:

```json
"ctrl-shift-y": {
  "command": "layout.toggle",
  "args": { "id": "shepherd", "focus": "shepherd-terminal" }
}
```

This opens and focuses a hidden panel. If the panel is visible but focus is elsewhere, it focuses the coordinator without hiding it. Pressing the shortcut while the coordinator has the keyboard hides the panel. Shepherd keeps that focus when its newly started terminal attaches.

When the panel shows and Herdr Core has no terminal named `hermes-shepherd`, Shepherd starts one in your home folder, for example the first time or after a reboot. It runs the `hermes` on Core's PATH inside a small `sh` loop, so your own wrapper, jail and approval settings apply. Shepherd creates no profile and changes no Hermes settings. There is one terminal for every space and tab, and hiding the panel, switching tabs or spaces, and restarting the App leave it running.

When Hermes exits, the terminal stays open: it prints the exit code, and the panel's header shows the code and Hermes's last line with a Restart button. Restart, or Enter in the terminal, starts Hermes again in the same terminal. Shepherd never restarts it on its own. Without the profile, Hermes exits with `Profile 'coordinator' does not exist`.

The Hermes profile field in Settings sets the profile the panel opens; it is `coordinator` until you save another. Save checks it with Hermes's own profile-name rule and creates no profile. Shepherd passes it to `hermes` as one argument after `-p`; the shell does not parse it. A saved change applies the next time Hermes starts, by Restart, Enter in the terminal or a new terminal. A running conversation is never stopped for it: while it runs with the old profile, the header names both.

Herdr App can delete the layout's terminal block when its terminal ends, including after a full Core stop/start. A graceful `hc server restart` keeps the terminal running. If the block disappears, press Restore panel in the header. Shepherd adds `shepherd-terminal` back to the existing `shepherd` column, leaves the rest of the layout intact, and reconnects to a live conversation or starts a new terminal if none exists. Repair requires a personal layout. If Herdr refuses an edit to a shipped layout, clone it with `layout.clone`, then press Restore panel again. If the block is still present but the terminal ended, press Start again.

After upgrading from an earlier Shepherd, end any old `hermes-coordinator` terminals, `hc attach` splits and `hermes-shepherd` terminals once, so the panel starts the current runner.

### Cron jobs

The Cron jobs button at the top right lists the cron jobs of every Hermes profile: name, profile, schedule, state, next run, and the last run with its result or error. The list is read-only. Create, edit, pause or delete jobs with `hermes cron`. Cron jobs are separate from Parked cards, which wait for the workflow, not for a timer.

### Records and rules

The Settings button at the top right edits the panel's Hermes profile, an ordered list of rules and the name of the records tab, all shared by every Shepherd tab in every space. The records tab is called Links until you name it otherwise; the name cannot be empty. Each rule has a regex, a command, a description and an Open in new tab switch, which new rules start with on. Save checks the profile and every rule first and saves nothing while one has a problem. Esc, Close or ✕ with unsaved changes asks before discarding them.

- The regex is a Python regular expression. In the command and the description, `$1`, `$2` and so on insert capture groups, `$0` the whole match, and `$$` a dollar sign.
- The command is split into arguments the way a shell would, with quotes and backslashes, before the captures go in. A capture is always literal text inside one argument, whatever quotes, spaces or `$(…)` it holds.

A task's records tab lists what the rules find in its description, result, comments and run summaries. Each text is read from start to end. Where several rules match, the match that starts first wins, and among matches at the same place the first rule in the list. Reading then goes on after the match. A record with the same command and description as an earlier one is listed once. The Details tab shows the task's text unchanged.

Clicking a record starts its command again every time. Shepherd never reuses or focuses a running one. It runs the command through Herdr Core in the folder of the selected space, as `env -- <command>`, without a shell. Without `env`, `hc run` would treat a single argument with spaces or shell characters as a shell line, and a first word naming an hc template as that template. With Open in new tab checked, the command opens in a new tab of the selected space. Otherwise it runs in the background, where `hc ls` and `hc read` show it. If the program is missing or exits within a second, the record shows its exit code and last lines.

Shepherd refuses to start a record when a capture in its command starts with `-`, and the record says so. Hermes agents write the task text, so a capture such as `--output=/home/you/.bashrc` would otherwise reach the program as an option. A capture is checked wherever the command uses it, also inside a longer argument. Captures that only go into the description are not checked.

In the records tab, ← and → switch between Details and the records, ↑ and ↓ select a record, and Enter starts it. In Settings, the keys act on the outlined rule. Clicking a rule, typing in it, adding one, or ↑ and ↓ outline it, and Enter edits it. Alt+Shift+↑ and Alt+Shift+↓ move it, Alt+T toggles Open in new tab, and Alt+Shift+Backspace removes it; these work while you type in the rule too.

Matching runs in the background, in a separate process, so the dialog stays usable while it runs. Matching a task is stopped after 3 seconds. The rule that spent most of that time is marked as timed out, and the other rules are matched again without it. A timed-out rule therefore finds nothing in that task, and text it might have claimed goes to the rule that wins without it. When no rule spent most of the time, the tab says the task is too large for the rules and names none. Retries stop after 15 seconds in all, and nothing keeps running after matching is stopped. The tab matches again only when the rules or the task's own text change. Saved settings that are not a valid name and rule list are left as they are: the records tab uses no rules, and Settings shows the saved value until Save replaces it.

## Requirements

- Herdr App. Development checks used Herdr App 0.1.11 and Core 0.1.18 on Linux.
- A Hermes installation whose Python can import `hermes_cli`. The tab reads the Hermes home that Herdr App's environment selects (`HERMES_HOME`, else `~/.hermes`). The board and cron list need no Hermes gateway, profile, or plugin.
- For the Shepherd panel: `hermes`, `hc` and `sh` on the PATH Herdr Core runs with, the Hermes profile Settings names (`coordinator` by default), and the panel's block in your layout.
- [herdr-navigation](https://github.com/augustocdias/herdr-navigation) for the Cron jobs, Settings, Show archived and Shepherd buttons. They exist only as its `tab-controls` at the top right of the tab bar, and the board's own toolbar does not repeat them. Without herdr-navigation the board still shows and edits tasks, and the panel works as usual through its Hide button, `layout.toggle` and a key binding, but there is no way to list cron jobs or to list, restore or delete archived tasks. Settings still opens from Edit rules in a task's records tab.

Record commands and the Shepherd terminal run through Herdr Core, like any terminal you open yourself. Shepherd adds no sandbox. Any jail or approval comes from your own wrappers on the PATH Herdr Core runs with, such as a `hermes` wrapper or the programs your rules name.

## Install with Home Manager

Add this repository as a flake input and import its module:

```nix
imports = [inputs.herdr-hermes-shepherd.homeManagerModules.default];

programs.hermes-shepherd = {
  enable = true;
  hermesPython = "${inputs.hermes-agent.packages.${pkgs.system}.default.hermesVenv}/bin/python3";
};
```

The module installs the mod at `~/.config/herdr-app/mods/hermes-shepherd/` and puts `hermes-shepherd-board` and `hermes-shepherd-cron` on your PATH. They run `board/hermes_shepherd_board.py` and `board/hermes_shepherd_cron.py` with `hermesPython`. Point `hermesPython` at the same Hermes package your `hermes` command uses.

## Install by hand

1. Copy the files in `mods/hermes-shepherd/` to `~/.config/herdr-app/mods/hermes-shepherd/`.
2. Create executables `hermes-shepherd-board` and `hermes-shepherd-cron` on the PATH Herdr App runs with:

   ```sh
   #!/bin/sh
   exec /path/to/hermes/python3 /path/to/board/hermes_shepherd_board.py "$@"
   ```

   `hermes-shepherd-cron` is the same with `hermes_shepherd_cron.py`.

   For a pip or uv install, use the interpreter on the first line of the `hermes` script. For the Nix package, use the `HERMES_PYTHON` path that its `hermes` wrapper exports.
3. Run `hermes-shepherd-board` and `hermes-shepherd-cron` once. They print the default board and the cron jobs as JSON, or a JSON `error`.
4. Run `herdr-app check ~/.config/herdr-app/mods/hermes-shepherd`.

## Open the tab

Open it as an ordinary tab, named after the board you want:

```sh
herdr-app do tab.new --mod hermes-shepherd --name "Side work"
```

### Pin it with Smart Tabs

herdr-navigation's Smart Tabs can open a Shepherd tab in every space. Pinning is your configuration, not part of this mod:

```nix
programs.herdr-navigation.pinnedTabs = [
  { label = "Hermes"; mod = "hermes-shepherd"; }
];
```

Without Home Manager, write `[{"label": "Hermes", "mod": "hermes-shepherd"}]` to `~/.config/herdr-app/mods/tabs-enriched/pinned.json`. The label is the tab's name, so it picks the board as described above. Smart Tabs treats a renamed pinned tab as an ordinary tab and opens a new pinned one, so change the label in configuration to show another board.

## Development

Run the helpers' tests with the Hermes Python. They build boards, cron jobs and records in temporary Hermes homes:

```sh
"$HERMES_PYTHON" -m unittest discover tests
```

Run the panel recovery checks with `node --test tests/panel.test.mjs`. They cover restoring the missing block without replacing the rest of the layout or restarting a live conversation, and handling a refused layout edit.

`tests/seed_board.py` fills an empty temporary `HERMES_HOME` with a demo board for checks in a private Herdr App. It refuses a home that already has a board.

Check UI changes in a private App and Core: set `HERDR_APP_HOME`, `XDG_RUNTIME_DIR`, `HC_SOCKET`, and `HERMES_HOME` to temporary folders, keep socket paths under 107 bytes, install the mod there, and inspect `herdr-app shot`. A passing `herdr-app check` does not prove the layout or the live refresh.

# Hermes Shepherd

A Herdr App tab that shows a live view of a Hermes kanban board. It reads and edits the board only through the installed Hermes package's own task functions. It changes the board only through the description edit, comments, new tasks and the task actions described below. Like any `hermes kanban` command, opening a board may apply Hermes's own schema migrations.

## What the tab shows

- The board's columns in the order Hermes's workflow defines. Hermes's `scheduled` status appears as Parked, with the reason given when the task was parked.
- Every task that is not archived, including all of Done. Each card shows the title, a round status marker, and the assigned profile or Unassigned. Spec and repository labels truncate to fit beside the assignee.
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

The copy button beside the ticket ID in the dialog's title bar copies the full ID to the clipboard and shows a confirmation.

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

The Shepherd panel is a native chat with your existing Hermes `coordinator` profile, not a terminal. It shows streaming Markdown, tool calls and results, approval and clarification cards, and a multiline composer. Enter sends; Shift+Enter inserts a newline. Stop interrupts only the selected conversation's current execution.

Tool calls, including skill reads, start as compact rows with their status visible. Click the arrow to expand or collapse their inputs and results. The chat follows new output while you are at the bottom. Scrolling up or expanding a tool pauses following so you can read. Scroll back to the bottom or click Latest to resume.

The panel connects to an already-running Hermes gateway. A gateway running under the default profile can serve `coordinator` when profile multiplexing is enabled (`gateway.multiplex_profiles: true`). Shepherd discovers and authenticates the exact selected profile; it never falls back to the default profile, creates a profile, starts a gateway or changes Hermes configuration.

Choose New or a conversation from History on first use. New creates a conversation in your home directory. History combines active and stored conversations from that profile, showing up to 200 recent choices. Shepherd remembers your selection; it never silently chooses the most recent conversation. If that selection is no longer available, a notice asks you to choose New or History. Each profile has its own selection and draft. Copies of the panel in the same App share them.

An acknowledged send clears its draft. If the connection drops before acknowledgement, the draft and request identity remain. Reconnect and inspect the conversation before choosing Retry same send; Shepherd never resends automatically. Hiding the panel, switching conversations or profiles, and closing the App do not stop gateway work.

The profile button opens Settings. Saving a different profile switches the viewer immediately, without interrupting work in the old profile. Missing profiles, unavailable gateways and identity mismatches appear as errors. Retry reconnects the viewer; it does not start or restart Hermes.

The transcript is a bounded view of Hermes history: at most 400 items, with long entries and oversized histories visibly shortened. Full history remains in Hermes. This is a text chat, not the Hermes terminal UI: it has no terminal slash-command menu, model controls or file uploads. Approval and clarification cards preserve the gateway's offered choices. Other interactive requests, including secret, sudo and vault prompts, receive an explicit unsupported response; Shepherd never grants them silently.

#### Layout and upgrade

Add this single full-height block beside Files and Changes in a personal layout, usually in the row holding the tab:

```json
{ "id": "shepherd", "type": "block", "hidden": true,
  "size": { "px": 460 }, "min": 280, "max": 1100,
  "content": { "mod": "hermes-shepherd", "props": { "panel": true } } }
```

Clone a shipped layout before editing it:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

**Upgrading from the terminal panel:** replace the old `shepherd` column, including `shepherd-bar` and `shepherd-terminal`, with this block. Change any shortcut's focus target from `shepherd-terminal` to `shepherd`. Shepherd does not modify layouts or stop old coordinator terminals. End an old terminal yourself only when its work is finished.

Keep the `shepherd` id; width and placement are yours. The panel stays beside every tab and space. The top-right Shepherd button, the panel's Hide button and `herdr-app do layout.toggle --id shepherd` toggle visibility. Without the block, Herdr App reports the missing node.

For a global shortcut, add this to the `global` section of Herdr App's `keys.json`:

```json
"ctrl-shift-y": {
  "command": "layout.toggle",
  "args": { "id": "shepherd", "focus": "shepherd" }
}
```

On App versions without the `focus` argument, use `"ctrl-shift-y": "layout.toggle:shepherd"` instead. A more specific terminal binding can override a global key. The layout remembers visibility and width across App restarts.

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

- Herdr App. Native chat checks used App 0.1.14 and Core 0.1.19 on Linux.
- A Hermes installation whose Python can import `hermes_cli`. The tab reads the Hermes home that Herdr App's environment selects (`HERMES_HOME`, else `~/.hermes`). The board and cron list need no gateway or coordinator profile.
- For the panel: `hermes-shepherd-chat` on the App's PATH, an existing configured profile and a running canonical Hermes gateway serving it. Integration checks used Hermes commit `a270b24bab474b3a7bdc51c24d918cec086fe9bc`. The standalone TUI gateway is not supported.
- [herdr-navigation](https://github.com/augustocdias/herdr-navigation) for the Cron jobs, Settings, Show archived and Shepherd buttons. They exist only as its `tab-controls` at the top right of the tab bar, and the board's own toolbar does not repeat them. Without herdr-navigation the board still shows and edits tasks, and the panel works as usual through its Hide button, `layout.toggle` and a key binding, but there is no way to list cron jobs or to list, restore or delete archived tasks. Settings still opens from Edit rules in a task's records tab.

Record commands run through Herdr Core and use your configured wrappers. Chat execution happens in the existing Hermes gateway, under that gateway's credentials, sandbox and approval policy. A jailed viewer does not jail the gateway. Shepherd adds no sandbox and does not inherit the old panel's `hermes` CLI wrapper protections.

## Install with Home Manager

Add this repository as a flake input and import its module:

```nix
imports = [inputs.herdr-hermes-shepherd.homeManagerModules.default];

programs.hermes-shepherd = {
  enable = true;
  hermesPython = "${inputs.hermes-agent.packages.${pkgs.system}.default.hermesVenv}/bin/python3";
};
```

The module bundles the JavaScript with esbuild at build time and installs it at `~/.config/herdr-app/mods/hermes-shepherd/`. It adds `hermes-shepherd-board`, `hermes-shepherd-cron` and `hermes-shepherd-chat` to your PATH, using `hermesPython` for all three. Point it at the same Hermes package as your gateway. No Node runtime is required.

The chat helper starts a local viewer process, not a gateway. Its authenticated loopback connection and private registry live under the App's `data/hermes-shepherd-chat/`; the process exits after 60 seconds without viewers. Hermes owns conversations and execution. App shared state stores drafts, so treat the App's files as private conversation data.

## Install by hand

1. Copy the real files in `mods/hermes-shepherd/` to `~/.config/herdr-app/mods/hermes-shepherd/`. Do not symlink `main.js` and `chat.js` separately into another directory: Herdr rejects imports that resolve outside the mod folder. Home Manager avoids this by bundling them.
2. Create executables `hermes-shepherd-board`, `hermes-shepherd-cron` and `hermes-shepherd-chat` on the PATH Herdr App runs with:

   ```sh
   #!/bin/sh
   exec /path/to/hermes/python3 /path/to/board/hermes_shepherd_board.py "$@"
   ```

   Use `board/hermes_shepherd_cron.py` for `hermes-shepherd-cron` and `chat/hermes_shepherd_chat.py` for `hermes-shepherd-chat`.

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

Run the helpers' tests with the Hermes Python. They use temporary Hermes homes and an independent canonical gateway protocol fixture; no live user gateway or model is involved:

```sh
"$HERMES_PYTHON" -m unittest discover tests
```

Run `node --test tests/panel.test.mjs` for native chat state and transport checks, including draft acknowledgement, uncertain sends, profile isolation and prompt lifetimes. These checks do not replace a real App smoke test.

`tests/seed_board.py` fills an empty temporary `HERMES_HOME` with a demo board for checks in a private Herdr App. It refuses a home that already has a board.

Check UI changes in a private App and Core: set `HERDR_APP_HOME`, `XDG_RUNTIME_DIR`, `HC_SOCKET`, and `HERMES_HOME` to temporary folders, keep socket paths under 107 bytes, install the mod there, and inspect `herdr-app shot`. A passing `herdr-app check` does not prove the layout or the live refresh.

For chat integration, run an isolated default-profile gateway with a disposable `coordinator` profile and a local synthetic model endpoint. Exercise New, History, multiline send, streaming, tool results, clarification, Stop and viewer reconnect against that real gateway. Inspect the installed, bundled mod at panel width, not just source files. Never use the user's live coordinator for these checks without separate permission.

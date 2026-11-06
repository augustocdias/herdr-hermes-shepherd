# Hermes Shepherd

A Herdr App tab that shows a live view of a Hermes kanban board. It reads and edits the board only through the installed Hermes package's own task functions. The one change it makes is the description edit described below. Like any `hermes kanban` command, opening a board may apply Hermes's own schema migrations.

## What the tab shows

- The board's columns in the order Hermes's workflow defines. Hermes's `scheduled` status appears as Parked, with the reason given when the task was parked.
- Every task that is not archived, including all of Done. Each card shows the title, a round status marker, and the assigned profile or Unassigned.
- Repository and Spec filters, which default to All. A task's spec is its Hermes `tenant`. Its repository is the folder of its native Hermes `dir:` workspace. Tasks without that metadata stay visible under All and appear under None.
- The time of the last successful read. If a read fails, a banner shows the error and the last successful read stays on screen.

The tab refreshes when a Hermes process that wrote to the board closes it, and every 30 seconds. Arrow keys move a selection between cards, Enter opens the selected card, `r` and `s` open the Repository and Spec filters, and F5 refreshes.

### Task details

Clicking a card, or pressing Enter on it, opens the task in a dialog over the board. It shows the task's Hermes status, assigned profile, spec, repository, workspace, priority, dates, parent and child tasks, and its description, result and history. The history lists comments, runs and events in time order. Descriptions, comments and run summaries are rendered as Markdown exactly as Hermes stores them. The dialog follows the board, so a task that starts while it is open shows as started. Esc or the close button dismisses it.

You can edit the description of a task that has never started. Hermes records a task's first start (`started_at`, and a claimed run), and neither goes away when the task later returns to Ready, Todo or Blocked, so a task that ever ran stays locked. Archived tasks are read-only.

Save checks again, right before writing, that the task has still never started and that its description is still the one you began editing. If either check fails, nothing is written and your draft stays in the editor. When someone else changed the description, close the editor to read the new text; saving again then replaces it with your draft. A draft survives closing the dialog until you save or discard it. If the task starts first, the draft opens read-only so you can copy or discard it. Hermes cannot make that check and its write one transaction, so a worker that claims the task in the instant between them still gets the save through; the dialog then warns that the worker may have the earlier description.

### Which board a tab shows

A tab shows the Hermes board whose slug or display name matches the tab's name, ignoring case. An unnamed tab, or a name that matches no board, shows Hermes's `default` board, and the toolbar then says that no board has the tab's name. Renaming the tab switches the board. `hermes kanban boards list` lists the boards.

Filters are global: every Shepherd tab in every space uses the same Repository and Spec filters, and they persist across App restarts.

### Coordinator

The first time a Shepherd tab is shown, it starts your existing Hermes coordinator: `hermes -p coordinator`, run by Herdr Core in your home folder as the terminal `hermes-coordinator`. It runs the `hermes` on Core's PATH, so your own wrapper, jail and approval settings apply. Shepherd creates no profile and changes no Hermes settings.

There is one coordinator for all tabs and spaces. Each Shepherd tab shows it in a split on the right that runs `hc attach`, so a message typed in one space appears in every other. Drag the divider to resize it; each tab keeps its own width. The Coordinator button at the top right hides the split by zooming the board, and shows it again at the same width. Hiding the split, switching tabs or spaces, and restarting the App leave the coordinator running.

If the coordinator exits, or `hermes` cannot start, the board shows why, with the last lines the coordinator printed, and a button that starts it again. Shepherd never restarts it on its own. Without a `coordinator` profile, Hermes exits with `Profile 'coordinator' does not exist`.

### Cron jobs

The Cron jobs button at the top right lists the cron jobs of every Hermes profile: name, profile, schedule, state, next run, and the last run with its result or error. The list is read-only. Create, edit, pause or delete jobs with `hermes cron`. Cron jobs are separate from Parked cards, which wait for the workflow, not for a timer.

## Requirements

- Herdr App. Development checks used Herdr App 0.1.11 and Core 0.1.18 on Linux.
- A Hermes installation whose Python can import `hermes_cli`. The tab reads the Hermes home that Herdr App's environment selects (`HERMES_HOME`, else `~/.hermes`). The board and cron list need no Hermes gateway, profile, or plugin.
- For the coordinator: `hermes` on the PATH Herdr Core runs with, and a Hermes profile named `coordinator`.

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

[herdr-navigation](https://github.com/augustocdias/herdr-navigation)'s Smart Tabs can open a Shepherd tab in every space. Pinning is your configuration, not part of this mod:

```nix
programs.herdr-navigation.pinnedTabs = [
  { label = "Hermes"; mod = "hermes-shepherd"; }
];
```

Without Home Manager, write `[{"label": "Hermes", "mod": "hermes-shepherd"}]` to `~/.config/herdr-app/mods/tabs-enriched/pinned.json`. The label is the tab's name, so it picks the board as described above. Smart Tabs treats a renamed pinned tab as an ordinary tab and opens a new pinned one, so change the label in configuration to show another board.

## Development

Run the helpers' tests with the Hermes Python. They build boards and cron jobs in temporary Hermes homes:

```sh
"$HERMES_PYTHON" -m unittest discover tests
```

`tests/seed_board.py` fills an empty temporary `HERMES_HOME` with a demo board for checks in a private Herdr App. It refuses a home that already has a board.

Check UI changes in a private App and Core: set `HERDR_APP_HOME`, `XDG_RUNTIME_DIR`, `HC_SOCKET`, and `HERMES_HOME` to temporary folders, keep socket paths under 107 bytes, install the mod there, and inspect `herdr-app shot`. A passing `herdr-app check` does not prove the layout or the live refresh.

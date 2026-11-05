# Hermes Shepherd

A Herdr App tab that shows a live, read-only view of a Hermes kanban board. It reads the board through the installed Hermes package and never changes tasks. Like any `hermes kanban` command, opening a board may apply Hermes's own schema migrations.

## What the tab shows

- The board's columns in the order Hermes's workflow defines. Hermes's `scheduled` status appears as Parked, with the reason given when the task was parked.
- Every task that is not archived, including all of Done. Each card shows the title, a round status marker, and the assigned profile or Unassigned.
- Repository and Spec filters, which default to All. A task's spec is its Hermes `tenant`. Its repository is the path on a `Repo:` line in its body, else the folder of a `dir:` workspace. Tasks without that metadata stay visible under All and appear under None.
- The time of the last successful read. If a read fails, a banner shows the error and the last successful read stays on screen.

The tab refreshes when a Hermes process that wrote to the board closes it, and every 30 seconds. Arrow keys move a selection between cards, `r` and `s` open the Repository and Spec filters, and F5 refreshes.

### Which board a tab shows

A tab shows the Hermes board whose slug or display name matches the tab's name, ignoring case. An unnamed tab, or a name that matches no board, shows Hermes's `default` board, and the toolbar then says that no board has the tab's name. Renaming the tab switches the board. `hermes kanban boards list` lists the boards.

Filters are global: every Shepherd tab in every space uses the same Repository and Spec filters, and they persist across App restarts.

## Requirements

- Herdr App. Development checks used Herdr App 0.1.11 and Core 0.1.18 on Linux.
- A Hermes installation whose Python can import `hermes_cli`. The tab reads the Hermes home that Herdr App's environment selects (`HERMES_HOME`, else `~/.hermes`). It needs no Hermes gateway, profile, or plugin.

## Install with Home Manager

Add this repository as a flake input and import its module:

```nix
imports = [inputs.herdr-hermes-shepherd.homeManagerModules.default];

programs.hermes-shepherd = {
  enable = true;
  hermesPython = "${inputs.hermes-agent.packages.${pkgs.system}.default.hermesVenv}/bin/python3";
};
```

The module installs the mod at `~/.config/herdr-app/mods/hermes-shepherd/` and puts `hermes-shepherd-board` on your PATH. That command runs `board/hermes_shepherd_board.py` with `hermesPython`. Point `hermesPython` at the same Hermes package your `hermes` command uses.

## Install by hand

1. Copy `mods/hermes-shepherd/main.js` and `mod.json` to `~/.config/herdr-app/mods/hermes-shepherd/`.
2. Create an executable `hermes-shepherd-board` on the PATH Herdr App runs with:

   ```sh
   #!/bin/sh
   exec /path/to/hermes/python3 /path/to/board/hermes_shepherd_board.py "$@"
   ```

   For a pip or uv install, use the interpreter on the first line of the `hermes` script. For the Nix package, use the `HERMES_PYTHON` path that its `hermes` wrapper exports.
3. Run `hermes-shepherd-board` once. It prints the default board as JSON, or a JSON `error`.
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

Run the helper's tests with the Hermes Python. They build boards in temporary Hermes homes:

```sh
"$HERMES_PYTHON" -m unittest discover tests
```

`tests/seed_board.py` fills an empty temporary `HERMES_HOME` with a demo board for checks in a private Herdr App. It refuses a home that already has a board.

Check UI changes in a private App and Core: set `HERDR_APP_HOME`, `XDG_RUNTIME_DIR`, `HC_SOCKET`, and `HERMES_HOME` to temporary folders, keep socket paths under 107 bytes, install the mod there, and inspect `herdr-app shot`. A passing `herdr-app check` does not prove the layout or the live refresh.

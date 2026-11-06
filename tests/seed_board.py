"""Seed a throwaway Hermes home with a demo board for private App checks.

Run with the Hermes Python and a temporary HERMES_HOME; it refuses a home that
already has a board, so it cannot touch real work.
"""
import os
import sys
from pathlib import Path

from hermes_cli import kanban_db as kb
from hermes_cli.kanban_db_connect import connect_closing

home = Path(os.environ["HERMES_HOME"])
if (home / "kanban.db").exists():
    sys.exit(f"{home} already has a kanban board; use an empty temporary HERMES_HOME")

with connect_closing() as c:
    kb.create_task(c, title="Triage me", triage=True)
    kb.create_task(c, title="Implement login", assignee="programmer", tenant="auth-spec",
                   workspace_kind="dir", workspace_path="/home/user/dev/webapp")
    kb.create_task(c, title="Review cache layer", assignee="reviewer", tenant="cache-spec",
                   workspace_kind="dir", workspace_path="/home/user/dev/api")
    kb.schedule_task(c, kb.create_task(c, title="Wait for vendor API", assignee="programmer"),
                     reason="Vendor sandbox opens Monday")
    kb.block_task(c, kb.create_task(c, title="Blocked on credentials", assignee="programmer"), reason="needs token")
    kb.create_task(c, title="Waits for login", parents=[kb.list_tasks(c, status="ready")[0].id])
    for n in range(1, 9):
        kb.complete_task(c, kb.create_task(c, title=f"Finished item {n} with a longer title to check wrapping",
                                           tenant="auth-spec"), summary="ok")
    kb.archive_task(c, kb.create_task(c, title="Archived item"))
kb.create_board("side", name="Side work")
with connect_closing(board="side") as c:
    kb.create_task(c, title="Side board task", assignee="research")
print("seeded", home)

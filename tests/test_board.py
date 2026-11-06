"""Run with the Hermes Python: `$HERMES_PYTHON -m unittest discover tests`."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "board" / "hermes_shepherd_board.py"


class BoardSnapshot(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "HERMES_HOME": self.home.name, "HOME": self.home.name}
        for key in ("HERMES_KANBAN_DB", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_HOME"):
            self.env.pop(key, None)

    def tearDown(self):
        self.home.cleanup()

    def helper(self, *args):
        result = subprocess.run([sys.executable, str(HELPER), *args], env=self.env, capture_output=True, text=True, timeout=60)
        return result.returncode, json.loads(result.stdout)

    def native(self, script):
        """Build fixtures through Hermes's own task operations in a child process."""
        code = "from hermes_cli import kanban_db as kb\nfrom hermes_cli.kanban_db_connect import connect_closing\n"
        result = subprocess.run([sys.executable, "-c", code + script], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.split()

    def test_missing_board_is_an_error_and_is_not_created(self):
        code, reply = self.helper()
        self.assertEqual(code, 1)
        self.assertIn("hermes kanban init", reply["error"])
        self.assertFalse((Path(self.home.name) / "kanban.db").exists())

    def test_lists_every_unarchived_task_with_native_columns_and_metadata(self):
        ids = self.native("""
with connect_closing() as c:
    t = kb.create_task(c, title="Triage", triage=True)
    r = kb.create_task(c, title="Ready", assignee="programmer", tenant="spec-a", body="Repo: /src/app\\nTracker: x")
    d = kb.create_task(c, title="Dir", workspace_kind="dir", workspace_path="/src/other")
    s = kb.create_task(c, title="Parked")
    kb.schedule_task(c, s, reason="waiting on vendor")
    a = kb.create_task(c, title="Archived")
    kb.archive_task(c, a)
    done = []
    for n in range(30):
        x = kb.create_task(c, title=f"Done {n}")
        kb.complete_task(c, x, summary="ok")
        done.append(x)
    print(t, r, d, s, a)
""")
        triage, ready, directory, parked, archived = ids
        code, board = self.helper()
        self.assertEqual(code, 0, board)
        self.assertEqual([c["key"] for c in board["columns"]],
                         ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"])
        tasks = {t["id"]: t for t in board["tasks"]}
        self.assertNotIn(archived, tasks)
        self.assertEqual(sum(t["status"] == "done" for t in tasks.values()), 30)
        self.assertEqual(tasks[parked]["status"], "scheduled")
        self.assertEqual(tasks[parked]["parked_reason"], "waiting on vendor")
        self.assertEqual((tasks[ready]["assignee"], tasks[ready]["repository"], tasks[ready]["spec"]),
                         ("programmer", None, "spec-a"))
        self.assertEqual(tasks[directory]["repository"], "/src/other")
        self.assertEqual((tasks[triage]["assignee"], tasks[triage]["repository"], tasks[triage]["spec"]), (None, None, None))

    def test_reassignment_changes_profile_without_changing_status(self):
        (task,) = self.native("""
with connect_closing() as c:
    t = kb.create_task(c, title="Work", assignee="programmer")
    print(t)
""")
        self.native(f"""
with connect_closing() as c:
    kb.assign_task(c, "{task}", "reviewer")
""")
        _, board = self.helper()
        (shown,) = board["tasks"]
        self.assertEqual((shown["assignee"], shown["status"]), ("reviewer", "ready"))

    def test_tab_name_selects_board_by_slug_or_display_name_else_default(self):
        self.native("""
kb.create_board("side", name="Side work")
with connect_closing(board="side") as c:
    kb.create_task(c, title="Side task")
with connect_closing() as c:
    kb.create_task(c, title="Default task")
""")
        for name in ("side", "Side Work", " SIDE "):
            code, side = self.helper(name)
            self.assertEqual(code, 0, side)
            self.assertEqual((side["board"], side["board_name"], side["matched"]), ("side", "Side work", True))
            self.assertEqual([t["title"] for t in side["tasks"]], ["Side task"])
        for args in ((), ("3",), ("Bad Slug!",), ("",)):
            code, shown = self.helper(*args)
            self.assertEqual(code, 0, shown)
            self.assertEqual((shown["board"], shown["matched"]), ("default", False))
            self.assertEqual([t["title"] for t in shown["tasks"]], ["Default task"])
        _, named = self.helper("default")
        self.assertEqual((named["board"], named["matched"]), ("default", True))

if __name__ == "__main__":
    unittest.main()

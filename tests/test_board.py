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


class TaskDetailsAndEditing(unittest.TestCase):
    setUp, tearDown = BoardSnapshot.setUp, BoardSnapshot.tearDown
    helper, native = BoardSnapshot.helper, BoardSnapshot.native

    def create(self, script="t = kb.create_task(c, title='Task', assignee='programmer', body='Old **body**')"):
        (task,) = self.native(f"with connect_closing() as c:\n    {script}\n    print(t)")
        return task

    def run_native(self, task, *calls):
        self.native("with connect_closing() as c:\n" + "".join(f"    {call.format(t=repr(task))}\n" for call in calls))

    def details(self, task):
        code, reply = self.helper("--task", "default", task)
        self.assertEqual(code, 0, reply)
        return reply

    def edit(self, task, version, body):
        return self.helper("--edit", "default", task, version, body)

    def test_details_show_native_task_with_raw_markdown_history(self):
        parent = self.create("t = kb.create_task(c, title='Parent')")
        task = self.create(f"t = kb.create_task(c, title='Child', assignee='qa', tenant='spec-a', priority=3, "
                           f"workspace_kind='dir', workspace_path='/src/app', body='# Plan\\n- one', parents=[{parent!r}])")
        self.run_native(task, "kb.add_comment(c, {t}, 'reviewer', 'See `code` and **this**')")
        shown = self.details(task)
        self.assertEqual((shown["id"], shown["title"], shown["status"], shown["assignee"], shown["spec"], shown["priority"]),
                         (task, "Child", "todo", "qa", "spec-a", 3))
        self.assertEqual(shown["body"], "# Plan\n- one")
        self.assertEqual(shown["repository"], "/src/app")
        self.assertEqual([p["title"] for p in shown["parents"]], ["Parent"])
        self.assertEqual([(c["author"], c["body"]) for c in shown["comments"]], [("reviewer", "See `code` and **this**")])
        self.assertIn("commented", [e["kind"] for e in shown["events"]])
        self.assertTrue(shown["editable"], shown["edit_blocked"])

    def test_unknown_task_and_missing_board_are_errors(self):
        self.create()
        code, reply = self.helper("--task", "default", "t_missing")
        self.assertEqual(code, 1)
        self.assertIn("t_missing", reply["error"])
        code, reply = self.helper("--task", "nope", "t_missing")
        self.assertEqual(code, 1)
        self.assertFalse((Path(self.home.name) / "kanban" / "boards" / "nope").exists())

    def test_eligible_edit_saves_only_the_description(self):
        task = self.create()
        self.run_native(task, "kb.add_comment(c, {t}, 'me', 'keep me')")
        before = self.details(task)
        code, reply = self.edit(task, before["version"], "New *body*")
        self.assertEqual(code, 0, reply)
        after = reply["task"]
        self.assertEqual(after["body"], "New *body*")
        for field in ("title", "status", "assignee", "priority", "spec", "comments", "runs"):
            self.assertEqual(after[field], before[field], field)
        self.assertEqual(after["events"][:len(before["events"])], before["events"])
        self.assertEqual(after["events"][-1]["kind"], "edited")
        self.assertNotEqual(after["version"], before["version"])
        self.assertNotIn("warning", reply)

    def test_executed_task_stays_locked_after_returning_to_waiting(self):
        task = self.create()
        self.run_native(task, "kb.claim_task(c, {t})", "kb.block_task(c, {t}, reason='needs input')",
                        "kb.unblock_task(c, {t})")
        shown = self.details(task)
        self.assertNotEqual(shown["status"], "running")
        self.assertFalse(shown["editable"])
        code, reply = self.edit(task, shown["version"], "Rewritten")
        self.assertEqual(code, 2, reply)
        self.assertEqual(self.details(task)["body"], "Old **body**")

    def test_never_run_blocked_or_parked_tasks_stay_editable(self):
        blocked = self.create()
        self.run_native(blocked, "kb.block_task(c, {t}, reason='waiting on a human')")
        parked = self.create()
        self.run_native(parked, "kb.schedule_task(c, {t}, reason='Monday')")
        for task in (blocked, parked):
            shown = self.details(task)
            self.assertIn(shown["status"], ("blocked", "scheduled"))
            self.assertTrue(shown["editable"], task)

    def test_archived_task_is_read_only(self):
        task = self.create()
        self.run_native(task, "kb.archive_task(c, {t})")
        shown = self.details(task)
        self.assertEqual(shown["status"], "archived")
        self.assertFalse(shown["editable"])
        self.assertEqual(self.edit(task, shown["version"], "x")[0], 2)

    def test_start_while_editor_open_rejects_save_and_keeps_native_data(self):
        task = self.create()
        opened = self.details(task)
        self.run_native(task, "kb.claim_task(c, {t})")
        started = self.details(task)
        code, reply = self.edit(task, opened["version"], "Draft")
        self.assertEqual(code, 2, reply)
        self.assertIn("started", reply["error"])
        self.assertEqual(reply["task"], started)

    def test_description_changed_by_another_writer_rejects_stale_save(self):
        task = self.create()
        opened = self.details(task)
        self.run_native(task, "kb.edit_task(c, {t}, body='Theirs')")
        code, reply = self.edit(task, opened["version"], "Mine")
        self.assertEqual(code, 2, reply)
        self.assertIn("changed", reply["error"])
        self.assertEqual(reply["task"]["body"], "Theirs")
        self.assertEqual(self.details(task)["body"], "Theirs")

    def test_claim_racing_the_write_is_reported_not_hidden(self):
        # The accepted check-then-write window: a claim lands after the recheck, before the write.
        task = self.create()
        opened = self.details(task)
        status, warned = self.native(f"""
import importlib.util
spec = importlib.util.spec_from_file_location("helper", {str(HELPER)!r})
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
write = kb.edit_task
def racing(conn, task_id, **fields):
    kb.claim_task(conn, task_id)
    return write(conn, task_id, **fields)
kb.edit_task = racing
reply = helper.edit_description("default", {task!r}, {opened["version"]!r}, "Mine")
print(reply["task"]["status"], "earlier description" in reply.get("warning", ""))
""")
        self.assertEqual((status, warned), ("running", "True"))


class TriageAndArchive(unittest.TestCase):
    setUp, tearDown = BoardSnapshot.setUp, BoardSnapshot.tearDown
    helper, native = BoardSnapshot.helper, BoardSnapshot.native
    create, run_native, details, edit = (TaskDetailsAndEditing.create, TaskDetailsAndEditing.run_native,
                                         TaskDetailsAndEditing.details, TaskDetailsAndEditing.edit)

    def act(self, task, action, expected):
        return self.helper("--act", "default", task, action, expected)

    def test_triage_cards_move_to_todo_or_ready_through_native_moves(self):
        to_todo = self.create("t = kb.create_task(c, title='A', triage=True)")
        to_ready = self.create("t = kb.create_task(c, title='B', triage=True)")
        code, reply = self.act(to_todo, "todo", "triage")
        self.assertEqual((code, reply["status"]), (0, "todo"), reply)
        code, reply = self.act(to_ready, "ready", "triage")
        self.assertEqual((code, reply["status"]), (0, "ready"), reply)
        self.assertEqual(self.details(to_ready)["events"][-1]["payload"], {"status": "ready", "requested_status": "ready"})

    def test_unfinished_parent_gates_ready_and_leaves_the_task_in_triage(self):
        parent = self.create("t = kb.create_task(c, title='Parent')")
        child = self.create(f"t = kb.create_task(c, title='Child', triage=True, parents=[{parent!r}])")
        before = self.details(child)
        code, reply = self.act(child, "ready", "triage")
        self.assertEqual(code, 2, reply)
        self.assertIn(parent, reply["error"])
        self.assertEqual(reply["task"]["status"], "triage")
        self.assertEqual(self.details(child)["events"], before["events"])
        code, reply = self.act(child, "todo", "triage")
        self.assertEqual((code, reply["status"]), (0, "todo"), reply)

    def test_a_status_changed_since_the_menu_opened_is_refused_without_a_write(self):
        task = self.create("t = kb.create_task(c, title='A', triage=True)")
        self.run_native(task, "kb.specify_triage_task(c, {t})")
        before = self.details(task)
        for action, expected in (("ready", "triage"), ("archive", "triage"), ("restore", "triage")):
            code, reply = self.act(task, action, expected)
            self.assertEqual(code, 2, reply)
            self.assertEqual(self.details(task), before)
        # Only triage cards are sent; the moves are not a general status control.
        code, reply = self.act(task, "todo", before["status"])
        self.assertEqual(code, 2, reply)

    def test_archive_keeps_history_and_releases_children(self):
        parent = self.create("t = kb.create_task(c, title='Parent', assignee='programmer')")
        child = self.create(f"t = kb.create_task(c, title='Child', parents=[{parent!r}])")
        self.run_native(parent, "kb.add_comment(c, {t}, 'me', 'keep me')", "kb.claim_task(c, {t})")
        before = self.details(parent)
        code, reply = self.act(parent, "archive", "running")
        self.assertEqual((code, reply["status"]), (0, "archived"), reply)
        after = self.details(parent)
        self.assertEqual(after["comments"], before["comments"])
        self.assertEqual(after["events"][:len(before["events"])], before["events"])
        self.assertEqual([r["status"] for r in after["runs"]], ["reclaimed"])
        self.assertEqual(self.details(child)["status"], "ready")
        _, board = self.helper()
        self.assertNotIn(parent, [t["id"] for t in board["tasks"]])
        code, archived = self.helper("--archived", "default")
        self.assertEqual(code, 0, archived)
        self.assertEqual([t["id"] for t in archived["tasks"]], [parent])

    def test_archive_stops_a_test_owned_worker_and_cleans_its_scratch_workspace(self):
        worker = subprocess.Popen(["sleep", "300"])
        self.addCleanup(worker.kill)
        (task, workspace) = self.native(f"""
with connect_closing() as c:
    path = kb.workspaces_root() / "ws"
    path.mkdir(parents=True)
    t = kb.create_task(c, title='Worker', workspace_kind='scratch', workspace_path=str(path))
    kb.claim_task(c, t)
    from hermes_cli import kanban_db_dispatch as kbd
    assert kbd.adopt_worker_pid(c, t, kb.get_task(c, t).current_run_id, {worker.pid})
    print(t, path)
""")
        code, reply = self.act(task, "archive", "running")
        self.assertEqual(code, 0, reply)
        self.assertEqual(worker.wait(timeout=30), -15)
        self.assertFalse(Path(workspace).exists())
        (ended,) = [e for e in self.details(task)["events"] if e["kind"] == "archive_worker_termination"]
        self.assertTrue(ended["payload"]["terminated"])

    def test_restore_returns_to_triage_and_reopens_editing_until_the_next_start(self):
        task = self.create()
        self.run_native(task, "kb.claim_task(c, {t})", "kb.complete_task(c, {t}, summary='done once')",
                        "kb.archive_task(c, {t})", "kb.add_comment(c, {t}, 'me', 'comment while archived')")
        self.assertEqual(self.act(task, "restore", "done")[0], 2)
        code, reply = self.act(task, "restore", "archived")
        self.assertEqual((code, reply["status"]), (0, "triage"), reply)
        restored = self.details(task)
        self.assertEqual([r["outcome"] for r in restored["runs"]], ["completed"])
        self.assertTrue(restored["editable"], restored["edit_blocked"])
        code, reply = self.edit(task, restored["version"], "Refined")
        self.assertEqual(code, 0, reply)
        # Leaving Triage keeps the exception; the next start ends it.
        self.assertEqual(self.act(task, "ready", "triage")[0], 0)
        self.assertTrue(self.details(task)["editable"])
        self.run_native(task, "kb.claim_task(c, {t})")
        started = self.details(task)
        self.assertFalse(started["editable"])
        self.assertEqual(self.edit(task, started["version"], "Late")[0], 2)

    def test_a_task_archived_while_running_is_editable_after_restore(self):
        task = self.create()
        self.run_native(task, "kb.claim_task(c, {t})")
        self.assertEqual(self.act(task, "archive", "running")[0], 0)
        self.assertEqual(self.details(task)["events"][-1]["kind"], "archive_worker_termination")
        self.assertEqual(self.act(task, "restore", "archived")[0], 0)
        self.assertTrue(self.details(task)["editable"])

    def test_moving_an_executed_task_back_to_triage_is_not_a_restore(self):
        task = self.create("t = kb.create_task(c, title='A', triage=True)")
        self.act(task, "ready", "triage")
        self.run_native(task, "kb.claim_task(c, {t})", "kb.block_task(c, {t}, reason='x')")
        self.native(f"""
from plugins.kanban.dashboard import plugin_api as api
api.update_task({task!r}, api.UpdateTaskBody(status="triage"), board="default")
""")
        shown = self.details(task)
        self.assertEqual(shown["status"], "triage")
        self.assertFalse(shown["editable"])

    def test_restore_after_event_cleanup_stays_locked(self):
        # gc deleted the archived event, so this restore looks like any move to Triage: fail safe.
        task = self.create()
        self.run_native(task, "kb.claim_task(c, {t})", "kb.archive_task(c, {t})",
                        "__import__('time').sleep(1.1)", "kb.gc_events(c, older_than_seconds=0)")
        self.assertEqual(self.details(task)["events"], [])
        self.assertEqual(self.act(task, "restore", "archived")[0], 0)
        self.assertFalse(self.details(task)["editable"])

    def test_delete_is_refused_until_archived_then_removes_task_and_history(self):
        task = self.create()
        self.run_native(task, "kb.add_comment(c, {t}, 'me', 'note')")
        code, reply = self.act(task, "delete", "ready")
        self.assertEqual(code, 2, reply)
        self.assertEqual(self.details(task)["comments"][0]["body"], "note")
        self.run_native(task, "kb.archive_task(c, {t})")
        code, reply = self.act(task, "delete", "archived")
        self.assertEqual((code, reply["status"]), (0, None), reply)
        self.assertEqual(self.helper("--task", "default", task)[0], 1)
        self.assertEqual(self.native(f"""
with connect_closing() as c:
    print(sum(c.execute(f"SELECT COUNT(*) FROM {{table}} WHERE task_id = ?", ({task!r},)).fetchone()[0]
              for table in ("task_comments", "task_events", "task_runs")))
"""), ["0"])


if __name__ == "__main__":
    unittest.main()

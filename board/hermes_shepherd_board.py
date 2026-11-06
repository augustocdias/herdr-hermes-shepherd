"""Read and edit one Hermes kanban board for the Hermes Shepherd mod. Prints JSON.

Usage:
  hermes-shepherd-board [NAME]                         the board's tasks
  hermes-shepherd-board --task BOARD ID                one task's details and history
  hermes-shepherd-board --edit BOARD ID VERSION BODY   replace the task's description

NAME selects the board whose slug or display name equals it (the Shepherd tab's
name). Without a match, or without NAME, it reads Hermes's `default` board and
reports `matched: false`. BOARD is a board slug. VERSION is the `version` that
`--task` printed when the editor opened; a description changed since then is not
overwritten. `--edit` exits 2 when it refuses the save, with the task's current details.

Run it with the Python interpreter of the Hermes installation, so the native
`hermes_cli` modules resolve the same HERMES_HOME, board and workflow as the
`hermes kanban` CLI. It never creates a missing board. Opening a board goes through
Hermes's own connection code, which may migrate an older schema, as any `hermes kanban`
command does. Every write goes through Hermes's own task functions.
"""
import hashlib
import json
import sys


class Refused(Exception):
    """A save Hermes Shepherd will not make; carries the task's current details."""

    def __init__(self, message, task):
        super().__init__(message)
        self.task = task


def repository(task):
    """The folder of a native `dir` workspace, or None. Never guessed from other metadata."""
    if task.workspace_kind == "dir" and task.workspace_path:
        return task.workspace_path
    return None


def resolve(boards, name):
    """The board whose slug or display name is `name` (any case), else None."""
    wanted = (name or "").strip().lower()
    return next((b for b in boards if wanted and wanted in (b["slug"], b["name"].strip().lower())), None)


def hermes():
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_connect import connect_closing
        from hermes_cli.kanban_workflow import DEFAULT_WORKFLOW
    except ImportError as exc:
        raise RuntimeError(
            f"{sys.executable} cannot import Hermes ({exc}). "
            "Run hermes-shepherd-board with the Python of your Hermes installation."
        ) from exc
    return kb, connect_closing, DEFAULT_WORKFLOW


def open_board(slug):
    """A connection to an existing board; never creates one."""
    kb, connect_closing, _ = hermes()
    path = kb.kanban_db_path(board=slug)
    if not path.exists():
        raise RuntimeError(f"No Hermes kanban board at {path}. Run `hermes kanban init` first.")
    return path, connect_closing(path)


def snapshot(name=None):
    kb, _, workflow = hermes()
    boards = [{"slug": b["slug"], "name": b.get("name") or b["slug"]}
              for b in kb.list_boards(include_archived=False)]
    default = next(b for b in boards if b["slug"] == kb.DEFAULT_BOARD)
    match = resolve(boards, name)
    board = (match or default)["slug"]
    path, connection = open_board(board)
    with connection as conn:
        tasks = []
        for task in kb.list_tasks(conn):
            parked = None
            if task.status == "scheduled":
                events = [e for e in kb.list_events(conn, task.id) if e.kind == "scheduled"]
                parked = ((events[-1].payload or {}).get("reason") or None) if events else None
            tasks.append({
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "assignee": task.assignee,
                "repository": repository(task),
                "spec": task.tenant,
                "parked_reason": parked,
            })
    columns = [{"key": c.key, "label": c.label} for c in workflow.columns]
    return {"board": board, "board_name": (match or default)["name"], "requested": name, "matched": match is not None,
            "db": str(path), "columns": columns, "tasks": tasks}


def version(body):
    """Identifies the description an editor started from."""
    return hashlib.sha256((body or "").encode()).hexdigest()


def edit_blocked(task, runs):
    """Why the description cannot be edited now, or None when it can.

    A task is editable until its first execution. Hermes sets `started_at` when a
    worker first claims the task and never clears it, and every claim opens a run
    that keeps its `claim_lock`. Runs without a lock are bookkeeping that Hermes
    synthesizes when a never-claimed task is blocked or completed, not executions.
    Status alone proves nothing: an executed task returns to ready, todo or blocked.
    """
    if task.status == "archived":
        return "Archived tasks are read-only."
    if task.started_at is not None or any(run.claim_lock for run in runs):
        return "This task has already started, so its description is locked."
    return None


def details(conn, task_id):
    kb, _, _ = hermes()
    task = kb.get_task(conn, task_id)
    if task is None:
        raise RuntimeError(f"No task {task_id} on this board.")
    runs = kb.list_runs(conn, task_id)
    blocked = edit_blocked(task, runs)
    graph = kb.task_graph_context(conn, task_id)
    return {
        "id": task.id, "title": task.title, "body": task.body or "", "version": version(task.body),
        "status": task.status, "assignee": task.assignee, "priority": task.priority, "spec": task.tenant,
        "repository": repository(task), "workspace": task.workspace_path, "result": task.result,
        "created_at": task.created_at, "started_at": task.started_at, "completed_at": task.completed_at,
        "parents": graph["parents"], "children": graph["children"],
        "comments": [{"author": c.author, "body": c.body, "at": c.created_at} for c in kb.list_comments(conn, task_id)],
        "events": [{"kind": e.kind, "payload": e.payload, "at": e.created_at} for e in kb.list_events(conn, task_id)],
        "runs": [{"profile": r.profile, "status": r.status, "outcome": r.outcome, "summary": r.summary, "error": r.error,
                  "started_at": r.started_at, "ended_at": r.ended_at} for r in runs],
        "editable": blocked is None, "edit_blocked": blocked,
    }


def task_details(board, task_id):
    _, connection = open_board(board)
    with connection as conn:
        return details(conn, task_id)


def edit_description(board, task_id, expected, body):
    """Replace the description if the task is still editable and unchanged since `expected`."""
    kb, _, _ = hermes()
    _, connection = open_board(board)
    with connection as conn:
        current = details(conn, task_id)
        if not current["editable"]:
            raise Refused(f"Not saved: {current['edit_blocked']}", current)
        if current["version"] != expected:
            raise Refused("Not saved: the description changed since you opened the editor.", current)
        # shortcut: Hermes's edit_task cannot run inside a caller's write transaction, so this
        # check and the write are separate; a claim landing between them still lets this save
        # through (the post-save check below reports it). Upgrade if Hermes gains a guarded edit.
        if not kb.edit_task(conn, task_id, body=body, board=board):
            raise Refused("Not saved: Hermes refused the edit.", details(conn, task_id))
        saved = details(conn, task_id)
    reply = {"saved": True, "task": saved}
    if not saved["editable"]:
        reply["warning"] = f"Saved, but the task changed at the same moment: {saved['edit_blocked']} Its worker may have the earlier description."
    return reply


def main():
    args = sys.argv[1:]
    try:
        if args[:1] == ["--task"] and len(args) == 3:
            reply = task_details(*args[1:])
        elif args[:1] == ["--edit"] and len(args) == 5:
            reply = edit_description(*args[1:])
        else:
            reply = snapshot(*args[:1])
        print(json.dumps(reply))
    except Refused as exc:
        print(json.dumps({"error": str(exc), "task": exc.task}))
        sys.exit(2)
    except Exception as exc:  # The mod shows this text; a traceback would hide it.
        print(json.dumps({"error": str(exc) or type(exc).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()

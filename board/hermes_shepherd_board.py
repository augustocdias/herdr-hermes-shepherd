"""Print one Hermes kanban board as JSON for the Hermes Shepherd mod.

Usage: hermes-shepherd-board [NAME]

NAME selects the board whose slug or display name equals it (the Shepherd tab's
name). Without a match, or without NAME, it reads Hermes's `default` board and
reports `matched: false`.

Run it with the Python interpreter of the Hermes installation, so the native
`hermes_cli` modules resolve the same HERMES_HOME, board and workflow as the
`hermes kanban` CLI. It never creates a missing board. Opening a board goes through
Hermes's own connection code, which may migrate an older schema, as any `hermes kanban`
command does.
"""
import json
import re
import sys

REPO_LINE = re.compile(r"^Repo:[ \t]*(\S.*?)[ \t\r]*$", re.M)


def repository(task):
    """The repository a task declares, or None. Never guessed from scratch workspaces."""
    match = REPO_LINE.search(task.body or "")
    if match:
        return match.group(1)
    if task.workspace_kind == "dir" and task.workspace_path:
        return task.workspace_path
    return None


def resolve(boards, name):
    """The board whose slug or display name is `name` (any case), else None."""
    wanted = (name or "").strip().lower()
    return next((b for b in boards if wanted and wanted in (b["slug"], b["name"].strip().lower())), None)


def snapshot(name=None):
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli.kanban_db_connect import connect_closing
        from hermes_cli.kanban_workflow import DEFAULT_WORKFLOW
    except ImportError as exc:
        raise RuntimeError(
            f"{sys.executable} cannot import Hermes ({exc}). "
            "Run hermes-shepherd-board with the Python of your Hermes installation."
        ) from exc
    boards = [{"slug": b["slug"], "name": b.get("name") or b["slug"]}
              for b in kb.list_boards(include_archived=False)]
    default = next(b for b in boards if b["slug"] == kb.DEFAULT_BOARD)
    match = resolve(boards, name)
    board = (match or default)["slug"]
    path = kb.kanban_db_path(board=board)
    if not path.exists():
        raise RuntimeError(f"No Hermes kanban board at {path}. Run `hermes kanban init` first.")
    with connect_closing(path) as conn:
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
    columns = [{"key": c.key, "label": c.label} for c in DEFAULT_WORKFLOW.columns]
    return {"board": board, "board_name": (match or default)["name"], "requested": name, "matched": match is not None,
            "db": str(path), "columns": columns, "tasks": tasks}


def main():
    try:
        print(json.dumps(snapshot(*sys.argv[1:2])))
    except Exception as exc:  # The mod shows this text; a traceback would hide it.
        print(json.dumps({"error": str(exc) or type(exc).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()

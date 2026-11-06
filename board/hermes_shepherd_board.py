"""Read and change one Hermes kanban board for the Hermes Shepherd mod. Prints JSON.

Usage:
  hermes-shepherd-board [-- NAME]                      the board's tasks
  hermes-shepherd-board --archived BOARD               the board's archived tasks
  hermes-shepherd-board --task BOARD ID                one task's details and history
  hermes-shepherd-board --edit BOARD ID VERSION BODY   replace the task's description
  hermes-shepherd-board --sessions BOARD ID RULES      records the rules find in the task's text
  hermes-shepherd-board --check-rules RULES            problems in the record rules
  hermes-shepherd-board --act BOARD ID ACTION STATUS   todo, ready, archive, restore or delete

NAME selects the board whose slug or display name equals it (the Shepherd tab's
name). It follows `--`, so a tab named like a flag still names a board; a NAME that does
not start with `-` may also come alone. Without a match, or without NAME, it reads Hermes's
`default` board and reports `matched: false`. An unknown flag, or a flag with the wrong
number of arguments, exits 1 with an `error`. BOARD is a board slug. VERSION is the `version` that
`--task` printed when the editor opened; a description changed since then is not
overwritten. STATUS is the task's status when the person chose ACTION; a task that has
changed since is left alone. `--edit` and `--act` exit 2 when they refuse, with the task's
current details. RULES is the JSON list of record rules (see `extract`); matching runs
in a child process that is stopped after MATCH_SECONDS (see `bounded`), so a pathological regex cannot hang.

Run it with the Python interpreter of the Hermes installation, so the native
`hermes_cli` modules resolve the same HERMES_HOME, board and workflow as the
`hermes kanban` CLI. It never creates a missing board. Opening a board goes through
Hermes's own connection code, which may migrate an older schema, as any `hermes kanban`
command does. Every write goes through Hermes's own task functions.
"""
import hashlib
import json
import re
import resource
import shlex
import subprocess
import sys
import time


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


def edit_blocked(task):
    """Why the description cannot be edited now, or None when it can.

    A description is editable only while the task's native status is triage, whatever
    states and runs it had before. Hermes claims only Ready tasks, so no new run starts
    from a Triage task's description while it is being edited.
    """
    if task.status == "triage":
        return None
    if task.status == "archived":
        return "Archived tasks are read-only."
    return f"Only Triage tasks can be edited, and this task is {task.status.capitalize()}, so its description is locked."


def details(conn, task_id):
    kb, _, _ = hermes()
    task = kb.get_task(conn, task_id)
    if task is None:
        raise RuntimeError(f"No task {task_id} on this board.")
    runs = kb.list_runs(conn, task_id)
    events = kb.list_events(conn, task_id)
    blocked = edit_blocked(task)
    graph = kb.task_graph_context(conn, task_id)
    return {
        "id": task.id, "title": task.title, "body": task.body or "", "version": version(task.body),
        "status": task.status, "assignee": task.assignee, "priority": task.priority, "spec": task.tenant,
        "repository": repository(task), "workspace": task.workspace_path, "workspace_kind": task.workspace_kind,
        "result": task.result,
        "created_at": task.created_at, "started_at": task.started_at, "completed_at": task.completed_at,
        "parents": graph["parents"], "children": graph["children"],
        "comments": [{"author": c.author, "body": c.body, "at": c.created_at} for c in kb.list_comments(conn, task_id)],
        "events": [{"kind": e.kind, "payload": e.payload, "at": e.created_at} for e in events],
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
        # check and the write are separate; a move out of Triage landing between them still lets this save
        # through (the post-save check below reports it). Upgrade if Hermes gains a guarded edit.
        if not kb.edit_task(conn, task_id, body=body, board=board):
            raise Refused("Not saved: Hermes refused the edit.", details(conn, task_id))
        saved = details(conn, task_id)
    reply = {"saved": True, "task": saved}
    if not saved["editable"]:
        reply["warning"] = f"Saved, but the task changed at the same moment: {saved['edit_blocked']} Its worker may have the earlier description."
    return reply


MATCH_SECONDS = 3
MATCH_TOTAL_SECONDS = 15  # retries without timed-out rules stop here, so a scan stays bounded
REFERENCE = re.compile(r"\$(\$|\d+)")  # $N is capture group N ($0: the whole match); $$ is a literal $


class Unresolved(Exception):
    """A template refers to a capture group that has no value in this match."""


def substitute(template, groups):
    def value(ref):
        if ref[1] == "$":
            return "$"
        found = groups[int(ref[1])]
        if found is None:
            raise Unresolved(int(ref[1]))
        return found
    return REFERENCE.sub(value, template)


def compile_rules(rules):
    """[(pattern, argv template, rule) or None per rule], [errors]. Raises ValueError on a malformed list."""
    fields = {"regex": str, "command": str, "description": str, "tab": bool}
    if not isinstance(rules, list) or not all(
            isinstance(r, dict) and all(isinstance(r.get(k), t) for k, t in fields.items()) for r in rules):
        raise ValueError("Rules must be a list of {regex, command, description, tab} entries.")
    compiled, errors = [], []
    for i, r in enumerate(rules):
        try:
            try:
                pattern = re.compile(r["regex"])
            except re.error as exc:
                raise ValueError(f"the regex is invalid: {exc}") from exc
            try:
                # Split before substituting, so captured quotes, spaces and $(...) stay one literal argument each.
                argv = shlex.split(r["command"])
            except ValueError as exc:
                raise ValueError(f"the command cannot be split into arguments: {exc}") from exc
            if not argv:
                raise ValueError("the command is empty.")
            refs = [int(n) for text in [*argv, r["description"]] for n in REFERENCE.findall(text) if n != "$"]
            if refs and max(refs) > pattern.groups:
                raise ValueError(f"${max(refs)} refers to a capture group the regex does not have "
                                 f"(it has {pattern.groups}).")
            compiled.append((pattern, argv, r))
        except ValueError as exc:
            compiled.append(None)
            errors.append({"rule": i, "error": f"Rule {i + 1}: {exc}"})
    return compiled, errors


def extract(rules, texts, progress=lambda i: None, skip=()):
    """Records the rules find in `texts`, in order of appearance, and the rules' errors.

    Each text is scanned left to right. At each occurrence the earliest match wins, and
    among matches starting at the same place the first rule in the list. Scanning goes on
    after the match. A record repeating an earlier command and description is dropped.
    Rules whose index is in `skip` take no part, as if they were not in the list.
    A record whose command takes a capture that starts with `-` carries `refused`: task text,
    which agents write, must not add options to the command, so the mod will not start it.
    """
    compiled, errors = compile_rules(rules)
    usable = [(i, c) for i, c in enumerate(compiled) if c and i not in skip]
    # The capture groups each rule's command takes.
    uses = {i: {int(n) for arg in c[1] for n in REFERENCE.findall(arg) if n != "$"} for i, c in usable}
    records, seen = [], set()
    for text in texts:
        pos, ahead = 0, {}
        while True:
            best = None
            for i, (pattern, _, _) in usable:
                # A rule's next match from an earlier position stays its next match until we pass it.
                if i not in ahead or (ahead[i] is not None and ahead[i].start() < pos):
                    progress(i)
                    ahead[i] = pattern.search(text, pos)
                found = ahead[i]
                if found and (best is None or found.start() < best[1].start()):
                    best = (i, found)
            if not best:
                break
            i, found = best
            pos = found.end() if found.end() > found.start() else found.start() + 1
            _, argv, rule = compiled[i]
            groups = (found[0], *found.groups())
            try:
                record = {"rule": i, "description": substitute(rule["description"], groups),
                          "argv": [substitute(arg, groups) for arg in argv], "tab": rule["tab"]}
            except Unresolved as exc:
                error = {"rule": i, "error": f"Rule {i + 1} matched “{found[0][:80]}”, but capture group "
                                             f"{exc.args[0]} has no value there, so it was not resolved."}
                if error not in errors:
                    errors.append(error)
                continue
            dashed = next((n for n in sorted(uses[i]) if (groups[n] or "").startswith("-")), None)
            if dashed is not None:
                record["refused"] = (f"Not started: capture ${dashed} is “{groups[dashed][:80]}”, which starts with “-”, "
                                     "so the program could read it as an option. Task text never adds options to a command.")
            key = (record["description"], tuple(record["argv"]))
            if key not in seen:
                seen.add(key)
                records.append(record)
    return {"records": records, "errors": errors}


def bounded(rules, texts):
    """`extract` in a child process that is killed after MATCH_SECONDS.

    On a timeout, the rule that spent most of that time searching is marked timed out
    and left out, and the others are matched again without it, so a slow rule never hides
    the other rules' records. Leaving it out entirely keeps precedence exact among the
    rules that finished: text it might have claimed goes to the rule that wins without it.
    When no rule spent most of the time, the scan as a whole is too slow and no rule is
    blamed. Retries stop after MATCH_TOTAL_SECONDS.
    """
    skip, stopped = [], []
    deadline = time.monotonic() + MATCH_TOTAL_SECONDS
    while True:
        try:
            done = subprocess.run([sys.executable, "-I", __file__, "--match"], input=json.dumps([rules, texts, skip]),
                                  capture_output=True, text=True, timeout=MATCH_SECONDS)
        except subprocess.TimeoutExpired as exc:  # subprocess.run kills the child before raising
            spent = time_per_rule((exc.stderr or b"").decode(), time.monotonic())
            i = max(spent, key=spent.get) if spent else None
            if i is None or spent[i] < MATCH_SECONDS / 2:
                raise RuntimeError(f"Matching this task took longer than {MATCH_SECONDS} s with no single rule to blame, "
                                   "so it was stopped. The task is too large for these rules.") from None
            skip.append(i)
            stopped.append({"rule": i, "error": f"Rule {i + 1} timed out: it spent more than {spent[i]:.1f} s on this "
                            "task, so it was stopped and finds nothing here; the other rules were matched without it. "
                            "Its regex probably backtracks catastrophically on this text; rewrite it, for example with "
                            "possessive quantifiers (a++) or atomic groups."})
            if time.monotonic() + MATCH_SECONDS > deadline:
                raise RuntimeError(f"Matching stopped after {MATCH_TOTAL_SECONDS} s: rules "
                                   f"{', '.join(str(r + 1) for r in skip)} timed out on this task.") from None
            continue
        if done.returncode != 0:
            raise RuntimeError(f"Matching failed with exit code {done.returncode}: {done.stderr.strip()[-500:]}")
        reply = json.loads(done.stdout)
        if "error" in reply:
            raise ValueError(reply["error"])
        reply["errors"] += stopped
        reply["timed_out"] = skip
        return reply


def time_per_rule(progress, now):
    """Seconds each rule searched, from a stopped child's progress lines ("rule start")."""
    spent, lines = {}, [line.split() for line in progress.splitlines() if line.strip()]
    for (rule, start), (_, end) in zip(lines, [*lines[1:], (None, now)]):
        spent[int(rule)] = spent.get(int(rule), 0) + float(end) - float(start)
    return spent


def sessions(board, task_id, rules):
    task = task_details(board, task_id)
    texts = [task["body"], task["result"] or "", *(c["body"] for c in task["comments"]),
             *(r["summary"] or "" for r in task["runs"])]
    return bounded(json.loads(rules), texts)


def match():
    """The child side of `bounded`: reports each rule and the time before searching with it, so a timeout names the slowest."""
    # A child whose parent died is not killed by the timeout, so the kernel stops it instead.
    resource.setrlimit(resource.RLIMIT_CPU, (2 * MATCH_SECONDS, 2 * MATCH_SECONDS))

    def progress(i):
        sys.stderr.write(f"{i} {time.monotonic()}\n")
        sys.stderr.flush()
    try:
        rules, texts, skip = json.load(sys.stdin)
        print(json.dumps(extract(rules, texts, progress=progress, skip=set(skip))))
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}))


def archived(board):
    kb, _, _ = hermes()
    path, connection = open_board(board)
    with connection as conn:
        tasks = [{"id": t.id, "title": t.title, "assignee": t.assignee, "spec": t.tenant, "repository": repository(t)}
                 for t in kb.list_tasks(conn, status="archived")]
    return {"board": board, "db": str(path), "tasks": tasks}


# What each action needs the task to be now, and the column it asks Hermes for.
ACTIONS = {"todo": ("triage", "todo"), "ready": ("triage", "ready"), "restore": ("archived", "triage"),
           "archive": (None, "archived"), "delete": ("archived", None)}


def act(board, task_id, action, expected):
    """Make one change through Hermes's own operations, if the task is still as the person saw it.

    Todo, Ready and restore are Hermes's manual moves, made by its dashboard's own handler,
    which applies Hermes's dependency gate and reports what refused the move. Archive and
    delete are Hermes's archive and archived-only delete. Shepherd never writes a status.
    """
    kb, _, workflow = hermes()
    if action not in ACTIONS:
        raise RuntimeError(f"Unknown action {action}.")
    source, target = ACTIONS[action]
    _, connection = open_board(board)
    with connection as conn:
        task = kb.get_task(conn, task_id)
        if task is None:
            raise RuntimeError(f"No task {task_id} on this board.")
        if task.status != expected:
            raise Refused(f"Nothing changed: the task is {task.status} now, not {expected}.", details(conn, task_id))
        if source not in (None, task.status) or (target and not workflow.can_move(task.status, target)):
            raise Refused(f"Nothing changed: Hermes Shepherd does not {action} a task that is {task.status}.",
                          details(conn, task_id))
        # shortcut: Hermes has no compare-and-set for these moves, so a change landing between the check
        # above and the write below is not caught; the reply shows the status Hermes ended with.
        if action == "archive":
            ok, error = kb.archive_task(conn, task_id), "Hermes did not archive it."
        elif action == "delete":
            ok, error = kb.delete_archived_task(conn, task_id), "Hermes deletes only archived tasks."
        else:
            from plugins.kanban.dashboard import plugin_api as api  # Hermes's dashboard; only moves need it
            try:
                api.update_task(task_id, api.UpdateTaskBody(status=target), board=board)
                ok, error = True, None
            except api.HTTPException as exc:
                ok, error = False, str(exc.detail)
        if not ok:
            raise Refused(f"Nothing changed: {error}", details(conn, task_id))
        after = kb.get_task(conn, task_id)
        return {"done": action, "status": after.status if after else None,
                "task": details(conn, task_id) if after else None}


# Each flag and the number of arguments after it.
COMMANDS = {
    "--task": (2, task_details),
    "--edit": (4, edit_description),
    "--sessions": (3, sessions),
    "--check-rules": (1, lambda rules: {"errors": compile_rules(json.loads(rules))[1]}),
    "--archived": (1, archived),
    "--act": (4, act),
}


def main():
    args = sys.argv[1:]
    if args == ["--match"]:
        return match()
    try:
        if args[:1] == ["--"]:
            if len(args) != 2:
                raise ValueError(f"-- takes one board name, not {len(args) - 1} arguments.")
            reply = snapshot(args[1])
        elif args[:1] and args[0] in COMMANDS:
            count, command = COMMANDS[args[0]]
            if len(args) - 1 != count:
                raise ValueError(f"{args[0]} takes {count} argument{'s' * (count != 1)}, not {len(args) - 1}.")
            reply = command(*args[1:])
        elif args[:1] and args[0].startswith("-"):
            raise ValueError(f"Unknown flag {args[0]}. Pass a board name after --.")
        elif len(args) > 1:
            raise ValueError(f"Expected one board name, not {len(args)} arguments.")
        else:
            reply = snapshot(*args)
        print(json.dumps(reply))
    except Refused as exc:
        print(json.dumps({"error": str(exc), "task": exc.task}))
        sys.exit(2)
    except Exception as exc:  # The mod shows this text; a traceback would hide it.
        print(json.dumps({"error": str(exc) or type(exc).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()

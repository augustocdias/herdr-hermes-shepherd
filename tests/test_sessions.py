"""Session rules: run with the Hermes Python, `$HERMES_PYTHON -m unittest discover tests`."""
import json
import time
import unittest

from test_board import BoardSnapshot


def rule(regex, command, description="$0", tab=True):
    return {"regex": regex, "command": command, "description": description, "tab": tab}


class SessionRecords(unittest.TestCase):
    setUp, tearDown = BoardSnapshot.setUp, BoardSnapshot.tearDown
    helper, native = BoardSnapshot.helper, BoardSnapshot.native

    def task(self, body, comments=(), summary=None, expression=None):
        script = f"t = kb.create_task(c, title='Task', body={expression or repr(body)})\n"
        script += "".join(f"    kb.add_comment(c, t, 'worker', {text!r})\n" for text in comments)
        if summary is not None:
            script += f"    kb.complete_task(c, t, summary={summary!r})\n"
        (task,) = self.native(f"with connect_closing() as c:\n    {script}    print(t)")
        return task

    def sessions(self, task, rules):
        code, reply = self.helper("--sessions", "default", task, json.dumps(rules))
        self.assertEqual(code, 0, reply)
        return reply

    def test_first_matching_rule_wins_per_occurrence_across_description_and_history(self):
        task = self.task("Start: session A1 via claude, then session B2.",
                         comments=["Reported again: session A1 via claude", "Later: session C3 via claude"],
                         summary="Finished in session D4")
        reply = self.sessions(task, [
            rule(r"session (\w+) via claude", "claude --resume $1", "Claude $1"),
            rule(r"session (\w+)", "omp --resume $1", "omp $1", tab=False),
        ])
        self.assertEqual(reply["errors"], [])
        self.assertEqual([(r["rule"], r["description"], r["argv"], r["tab"]) for r in reply["records"]], [
            (0, "Claude A1", ["claude", "--resume", "A1"], True),
            (1, "omp B2", ["omp", "--resume", "B2"], False),
            (0, "Claude C3", ["claude", "--resume", "C3"], True),
            (1, "omp D4", ["omp", "--resume", "D4"], False),
        ])

    def test_same_command_with_another_description_is_a_separate_record(self):
        task = self.task("id X9 and ID X9")
        reply = self.sessions(task, [rule(r"(?i)(id) (\w+)", "open $2", "$1 $2")])
        self.assertEqual([(r["description"], r["argv"]) for r in reply["records"]],
                         [("id X9", ["open", "X9"]), ("ID X9", ["open", "X9"])])

    def test_captures_stay_literal_arguments_after_the_template_is_split(self):
        payload = """x'; rm -rf ~ $(id) "q" a\tb`"""
        task = self.task(f"run<<{payload}>>")
        reply = self.sessions(task, [rule(r"run<<(.*?)>>", """printf '%s|' "pre $1 post" $1 '$$1' $$""", "Run $1 for $$5")])
        self.assertEqual(reply["errors"], [])
        (record,) = reply["records"]
        self.assertEqual(record["argv"], ["printf", "%s|", f"pre {payload} post", payload, "$1", "$"])
        self.assertEqual(record["description"], f"Run {payload} for $5")

    def test_invalid_rules_report_errors_and_resolve_nothing(self):
        task = self.task("ticket 7 and other 8")
        rules = [
            rule(r"ticket (\d+", "open $1"),
            rule(r"ticket (\d+)", "open $2"),
            rule(r"ticket (\d+)", "open 'unterminated $1"),
            rule(r"ticket (\d+)", "   "),
            rule(r"ticket (\d+)", "open $1", "Ticket $3"),
            rule(r"other (\d+)|missing (x)", "open $2", "Other"),
        ]
        code, checked = self.helper("--check-rules", json.dumps(rules))
        self.assertEqual(code, 0, checked)
        self.assertEqual([e["rule"] for e in checked["errors"]], [0, 1, 2, 3, 4])
        reply = self.sessions(task, rules)
        self.assertEqual(reply["records"], [])
        self.assertEqual([e["rule"] for e in reply["errors"]], [0, 1, 2, 3, 4, 5])
        self.assertIn("group 2", reply["errors"][-1]["error"])

    def test_malformed_rule_list_is_rejected(self):
        for rules in ({"rules": []}, [{"regex": "x"}], [rule("x", "y") | {"tab": "yes"}]):
            code, reply = self.helper("--check-rules", json.dumps(rules))
            self.assertEqual(code, 1, reply)
            self.assertIn("error", reply)

    def test_pathological_pattern_is_stopped_and_named(self):
        task = self.task("a" * 40 + "!")
        started = time.monotonic()
        code, reply = self.helper("--sessions", "default", task, json.dumps([rule("ok", "true"), rule(r"(a+)+$", "true")]))
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(code, 1, reply)
        self.assertIn("rule 2", reply["error"])

    def test_many_rules_over_large_content(self):
        # Built in the fixture process: a 200 KB body does not fit in one command-line argument.
        task = self.task(None, expression="''.join(f'line {n} session s{n} done\\n' for n in range(8000))")
        rules = [rule(f"nomatch{n} (x)", "true $1") for n in range(60)] + [rule(r"session (s\d+)", "attach $1")]
        reply = self.sessions(task, rules)
        self.assertEqual(reply["errors"], [])
        self.assertEqual(len(reply["records"]), 8000)
        self.assertEqual(reply["records"][-1]["argv"], ["attach", "s7999"])


if __name__ == "__main__":
    unittest.main()

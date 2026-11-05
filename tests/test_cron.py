"""Run with the Hermes Python: `$HERMES_PYTHON -m unittest discover tests`."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "board" / "hermes_shepherd_cron.py"


class CronSnapshot(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "HERMES_HOME": self.home.name, "HOME": self.home.name}

    def tearDown(self):
        self.home.cleanup()

    def helper(self):
        result = subprocess.run([sys.executable, str(HELPER)], env=self.env, capture_output=True, text=True, timeout=60)
        return result.returncode, json.loads(result.stdout)

    def native(self, script, profile=None):
        """Build fixtures through Hermes's own cron and profile operations in a child process."""
        env = {**self.env, "HERMES_HOME": str(Path(self.home.name) / "profiles" / profile)} if profile else self.env
        result = subprocess.run([sys.executable, "-c", "from cron import jobs\n" + script], env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.split()

    def test_no_jobs_lists_nothing_and_creates_no_cron_store(self):
        code, reply = self.helper()
        self.assertEqual((code, reply), (0, {"jobs": [], "errors": []}))
        self.assertFalse((Path(self.home.name) / "cron").exists())

    def test_lists_every_profiles_jobs_with_state_schedule_and_last_result(self):
        ok, failed, paused = self.native("""
ok = jobs.create_job(None, "every 2h", name="Disk", script="disk.sh", no_agent=True)["id"]
failed = jobs.create_job("check", "every 30m", name="Flaky")["id"]
paused = jobs.create_job("digest", "0 9 * * 1-5", name="Digest", repeat=3)["id"]
jobs.mark_job_run(ok, True)
jobs.mark_job_run(failed, False, error="Script exited with code 3")
jobs.pause_job(paused)
print(ok, failed, paused)
""")
        self.native("from hermes_cli.profiles import create_profile\ncreate_profile('ops', no_alias=True)")
        (ops,) = self.native("print(jobs.create_job('report', 'every 1d', name='Ops report')['id'])", profile="ops")
        jobs_before = (Path(self.home.name) / "cron" / "jobs.json").read_text()

        code, reply = self.helper()
        self.assertEqual(code, 0)
        self.assertEqual(reply["errors"], [])
        by_id = {job["id"]: job for job in reply["jobs"]}
        self.assertEqual(set(by_id), {ok, failed, paused, ops})
        self.assertEqual((by_id[ok]["last_status"], by_id[ok]["state"], by_id[ok]["profile"]), ("ok", "scheduled", "default"))
        self.assertEqual(by_id[failed]["last_status"], "error")
        self.assertIn("code 3", by_id[failed]["last_error"])
        self.assertEqual((by_id[paused]["state"], by_id[paused]["enabled"], by_id[paused]["repeat_times"]), ("paused", False, 3))
        self.assertEqual(by_id[paused]["schedule_display"], "0 9 * * 1-5")
        self.assertEqual((by_id[ops]["profile"], by_id[ops]["name"]), ("ops", "Ops report"))
        self.assertEqual((Path(self.home.name) / "cron" / "jobs.json").read_text(), jobs_before)

    def test_an_unreadable_profile_is_reported_without_hiding_the_others(self):
        self.native("jobs.create_job('check', 'every 30m', name='Fine')")
        self.native("from hermes_cli.profiles import create_profile\ncreate_profile('ops', no_alias=True)")
        broken = Path(self.home.name) / "profiles" / "ops" / "cron"
        broken.mkdir(parents=True, exist_ok=True)
        (broken / "jobs.json").write_text('"not a job list"')

        code, reply = self.helper()
        self.assertEqual(code, 0)
        self.assertEqual([job["name"] for job in reply["jobs"]], ["Fine"])
        self.assertEqual([e["profile"] for e in reply["errors"]], ["ops"])


if __name__ == "__main__":
    unittest.main()

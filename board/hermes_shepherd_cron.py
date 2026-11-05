"""Print the native Hermes cron jobs of every profile as JSON for the Hermes Shepherd mod.

Usage: hermes-shepherd-cron

Run it with the Python interpreter of the Hermes installation. It reads each profile's
jobs through `cron.jobs.list_jobs`, as `hermes -p <profile> cron list --all` does, and
never creates, edits, pauses or runs a job. A profile without a jobs file is skipped, so
no cron folder is created for it.
"""
import json
import sys

FIELDS = ("id", "name", "schedule_display", "state", "enabled", "next_run_at", "last_run_at",
          "last_status", "last_error", "last_delivery_error")


def job_summary(profile, job):
    summary = {key: job.get(key) for key in FIELDS}
    repeat = job.get("repeat") or {}
    summary.update(profile=profile, repeat_times=repeat.get("times"), repeat_completed=repeat.get("completed", 0),
                   running=bool(job.get("live_execution")))
    return summary


def snapshot():
    try:
        from cron.jobs import list_jobs
        from hermes_cli.profiles import get_profile_dir, list_profile_names
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    except ImportError as exc:
        raise RuntimeError(
            f"{sys.executable} cannot import Hermes ({exc}). "
            "Run hermes-shepherd-cron with the Python of your Hermes installation."
        ) from exc
    jobs, errors = [], []
    for profile in list_profile_names():
        home = get_profile_dir(profile)
        if not (home / "cron" / "jobs.json").exists():
            continue
        token = set_hermes_home_override(home)
        try:
            jobs += [job_summary(profile, job) for job in list_jobs(include_disabled=True)]
        except Exception as exc:  # One unreadable profile must not hide the others' jobs.
            errors.append({"profile": profile, "error": str(exc) or type(exc).__name__})
        finally:
            reset_hermes_home_override(token)
    return {"jobs": jobs, "errors": errors}


def main():
    try:
        print(json.dumps(snapshot(), default=str))
    except Exception as exc:  # The mod shows this text; a traceback would hide it.
        print(json.dumps({"error": str(exc) or type(exc).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()

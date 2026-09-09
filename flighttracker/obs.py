"""Structured logging, step timing and failure notification.

The fetcher runs unattended once a day inside a container. Nobody watches it.
So every attempt has to leave two traces: a line you can grep in the container
logs, and a row in `fetch_runs` you can query. This module produces both, and
shouts once at the end if anything went wrong.

**Logs are JSON, one object per line.** Not because it looks modern, but
because the interesting fields (provider, route, how many fares, how long) are
values rather than prose, and grepping prose for "how often does Luxair time
out" does not work. `docker logs viajes-fetcher | jq 'select(.status!="ok")'`
does.

**Timing is measured, not estimated.** `step()` wraps an attempt, so the
duration recorded is the wall clock of the call including its retries. A
provider that starts taking eight seconds instead of one is failing slowly,
and that is only visible if the number is written down every day.

**One notification per run, not one per failure.** A provider outage fails
every route it serves; five routes must not become five alerts. The failures
accumulate and `notify_failures` sends one message at the end, or none.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone

# Attempts that did not end in 'ok', collected across the whole run so the
# notification at the end can be a single message.
_failures: list[dict] = []


class _JsonFormatter(logging.Formatter):
    """Renders a record as one JSON object.

    Anything passed through `extra=` lands as a top level field, which is what
    makes the log queryable. `message` stays human readable so that reading
    the raw lines is still possible without a tool.
    """

    RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {
        "message",
        "asctime",
        "taskName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in self.RESERVED:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure(level: str | None = None) -> None:
    """Send JSON logs to stdout.

    stdout rather than stderr: in a container both end up in the same stream,
    and keeping the structured lines on stdout leaves stderr for the crashes
    that escape this module entirely.

    Calling it twice is harmless, which matters because the CLI has several
    entry points and only some of them fetch.
    """
    root = logging.getLogger("flighttracker")
    if root.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level or os.environ.get("LOG_LEVEL", "INFO").upper())
    root.propagate = False


log = logging.getLogger("flighttracker")


class Step:
    """The mutable result of one provider attempt.

    The caller fills in what it learned; `step()` fills in timing and status.
    Kept as a plain object rather than a return value because the interesting
    numbers are only known part way through the block.
    """

    def __init__(self, provider: str, route: str | None):
        self.provider = provider
        self.route = route
        self.found = 0
        self.stored = 0
        self.status = "ok"
        self.error: str | None = None

    def suspect(self, reason: str) -> None:
        """Mark the attempt as answered but not trusted.

        Separate from 'failed' on purpose: a failure means the provider did
        not answer, a suspect run means it did and the answer looked wrong.
        The fix for each is different, so the status has to distinguish them.
        """
        self.status = "suspect"
        self.error = reason


@contextmanager
def step(provider: str, route: str | None = None):
    """Time one provider attempt, log it, and remember it if it went wrong.

    Exceptions are logged and swallowed so that one dead provider does not end
    the run, which is the behaviour the fetcher already had; this just makes
    the swallowing visible instead of a print to stderr.
    """
    s = Step(provider, route)
    started = time.monotonic()
    try:
        yield s
    except Exception as exc:  # noqa: BLE001 - one provider must not end the run
        s.status = "failed"
        s.error = f"{type(exc).__name__}: {exc}"
    duration_ms = int((time.monotonic() - started) * 1000)
    s.duration_ms = duration_ms

    fields = {
        "provider": s.provider,
        "route": s.route,
        "status": s.status,
        "fares_found": s.found,
        "fares_stored": s.stored,
        "duration_ms": duration_ms,
    }
    if s.error:
        fields["error"] = s.error
        _failures.append(dict(fields))
        log.error("provider attempt failed", extra=fields)
    else:
        log.info("provider attempt ok", extra=fields)


def failures() -> list[dict]:
    return list(_failures)


def notify_failures(captured_at: str) -> None:
    """Send one message if anything in this run went wrong.

    Posts to `ALERT_WEBHOOK_URL` when it is set (any endpoint that accepts a
    JSON body: Slack, Discord, an n8n webhook). When it is not, the failures
    still reach stderr, so the alerting is optional and its absence never
    hides a problem -- it only makes it quieter.
    """
    if not _failures:
        log.info("run finished clean", extra={"captured_at": captured_at})
        return

    summary = ", ".join(
        f"{f['provider']}{'/' + f['route'] if f['route'] else ''} {f['status']}"
        for f in _failures
    )
    text = f"viajes fetch {captured_at}: {len(_failures)} problem(s) -- {summary}"
    print(text, file=sys.stderr)

    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not url:
        return
    try:
        import requests

        requests.post(
            url,
            json={"text": text, "captured_at": captured_at, "failures": _failures},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001 - a broken alert channel is not a run failure
        log.error("could not deliver alert", extra={"error": str(exc)})

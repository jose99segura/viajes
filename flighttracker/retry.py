"""Retries with exponential backoff, for transient failures only.

Written by hand rather than pulled from `tenacity`. The policy is twenty
lines, the fetcher image is deliberately thin, and a retry policy you cannot
read is a retry policy you cannot reason about at three in the morning.

**Only transient failures are retried.** A timeout, a dropped connection, a
429 or a 5xx are worth trying again; a 404 is not, and neither is a 400. On
Ryanair a 404 means "this route is not operated", which is a fact, not a
failure -- retrying it three times would turn a correct answer into thirty
seconds of waiting.

**Backoff is exponential with jitter.** Three providers retrying in lockstep
after the same outage is a small thundering herd, and the jitter is what
spreads them out. The waits are roughly 1s, 2s, 4s, so the worst case adds
seven seconds to an attempt rather than minutes.

**Retries are bounded and then it gives up.** The caller is `obs.step`, which
records the failure and moves to the next provider. Retrying forever would
turn a dead provider into a run that never ends, and the run has a daily
schedule to keep.
"""

from __future__ import annotations

import random
import time

import requests

from .obs import log

# 429 is rate limiting, 5xx is the server's problem. Both are worth a retry.
RETRY_STATUS = {429, 500, 502, 503, 504}

ATTEMPTS = 3
BASE_DELAY = 1.0


def _sleep(attempt: int) -> None:
    """Wait before attempt N, exponential with up to 25 percent jitter."""
    delay = BASE_DELAY * (2 ** (attempt - 1))
    time.sleep(delay * (1 + random.random() * 0.25))


def get(session: requests.Session, url: str, **kwargs) -> requests.Response:
    """`session.get`, retried on transient failures.

    Returns the response untouched, including error statuses that are not
    retryable, so the caller keeps deciding what a 404 means for it.
    """
    last_exc: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            resp = session.get(url, **kwargs)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt == ATTEMPTS:
                raise
            log.warning(
                "request failed, retrying",
                extra={"url": url, "attempt": attempt, "error": str(exc)},
            )
            _sleep(attempt)
            continue

        if resp.status_code in RETRY_STATUS and attempt < ATTEMPTS:
            log.warning(
                "transient status, retrying",
                extra={"url": url, "attempt": attempt, "status": resp.status_code},
            )
            _sleep(attempt)
            continue
        return resp

    # Unreachable: the loop either returns or raises on the last attempt.
    raise last_exc if last_exc else RuntimeError("retry loop fell through")


def call(fn, *args, **kwargs):
    """Retry any callable that talks to the network.

    Used for the Google provider, which goes through `fast-flights` rather
    than `requests` and so has no response object to inspect. Every exception
    is treated as transient there because the library does not distinguish
    them, which is acceptable for a call that is idempotent: fetching the same
    day twice reads the same fares.
    """
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - the library raises one type for everything
            if attempt == ATTEMPTS:
                raise
            log.warning(
                "call failed, retrying",
                extra={"fn": getattr(fn, "__name__", str(fn)),
                       "attempt": attempt, "error": str(exc)},
            )
            _sleep(attempt)

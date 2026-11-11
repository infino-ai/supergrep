# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""Indexing the profile's repositories with the client's own `index` command:
a full build where there is no index yet, an incremental sync against the
working tree where there is. `hermes supergrep index` runs it over every
repository; the session-start hook over those that already have an index
(`has_index`), leaving a first build to the server."""
from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Iterator

from . import config

# How long one repository's index or sync may take before it is given up on
# and the session goes on without it; a first build of a large tree can be
# long, and a session should not wait on it forever.
TIMEOUT_S = 600

# Where the client keeps a repository's index, and the manifest it writes
# there once a build completes (src/core/config.ts: INDEX_DIR_NAME,
# MANIFEST_NAME). The child runs with CX_INDEX_DIR removed, so this is where
# its index is.
INDEX_DIR_NAME = ".infino"
MANIFEST_NAME = "codecontext.json"

# Settings that would point the child at another repository or index than
# the one it is run for: the repository is passed as the command's path, and
# its index is the one inside it.
REDIRECTING_VARS = ("CX_ROOT", "CX_INDEX_DIR")

# How an outcome that is not an index or sync starts.
FAILURES = ("failed", "gave up", "the client did not start", "not a directory")
BUSY = "already being indexed here; skipped"

# One index or sync per repository at a time in this process: two sessions
# that start close together find the first one's run and skip it.
_running: dict[Path, threading.Lock] = {}
_running_guard = threading.Lock()


def has_index(repo: Path) -> bool:
    """Whether `repo` has a completed index of its own."""
    return (repo / INDEX_DIR_NAME / MANIFEST_NAME).is_file()


def failed(outcome: str) -> bool:
    return outcome.startswith(FAILURES)


def command(settings: config.Settings, repo: Path) -> list[str]:
    """`cx index <repo>` as the client is run."""
    return [settings.node, str(settings.client_js), "index", str(repo)]


def child_env(settings: config.Settings) -> dict[str, str]:
    """The process environment under the config block, as the server gets
    it, less what would send the run to another root or index."""
    env = {**os.environ, **settings.block}
    for name in REDIRECTING_VARS:
        env.pop(name, None)
    return env


def _lock_for(repo: Path) -> threading.Lock:
    with _running_guard:
        return _running.setdefault(repo, threading.Lock())


def sync_one(settings: config.Settings, repo: Path, timeout_s: int = TIMEOUT_S) -> str:
    """Index or sync `repo`; a one-line outcome for the log."""
    if not repo.is_dir():
        return "not a directory"
    lock = _lock_for(repo)
    if not lock.acquire(blocking=False):
        return BUSY
    try:
        run = subprocess.run(command(settings, repo), cwd=str(repo), env=child_env(settings),
                             capture_output=True, text=True, timeout=timeout_s, check=False)
    except FileNotFoundError as e:
        return f"the client did not start: {e}"
    except subprocess.TimeoutExpired:
        return f"gave up after {timeout_s}s"
    finally:
        lock.release()
    if run.returncode != 0:
        tail = (run.stderr or run.stdout).strip().splitlines()
        return f"failed ({run.returncode}): {tail[-1] if tail else 'no output'}"
    last = (run.stdout.strip().splitlines() or ["indexed"])[-1]
    return last


def sync_all(settings: config.Settings, timeout_s: int = TIMEOUT_S) -> Iterator[tuple[Path, str]]:
    for repo in settings.repos:
        yield repo, sync_one(settings, repo, timeout_s)

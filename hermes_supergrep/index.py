# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""Indexing the profile's repositories with the client's own `index` command:
a full build where there is no index yet, an incremental sync against the
working tree where there is. `hermes supergrep index` runs it over every
repository; the session-start hook over those whose index a sync can
update in place (`sync_skip`), leaving a first build, and an index whose
vectors are still being built, to the server.

The client keeps one writer per index across processes (a lock file in the
index dir): a run that finds the server or another `cx index` writing the
same index exits with EXIT_BUSY and writes nothing, and is reported as
skipped, not failed."""
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Iterator, Optional

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
# The platform table's manifest beside it (PLATFORM_MANIFEST_NAME), present
# when this machine loaded the repository into a platform database.
PLATFORM_MANIFEST_NAME = "platform.json"
# A manifest's `vectors` while a build's vector stage or platform load is
# still running (src/core/manifest.ts: VectorState). A sync refuses such an
# index, and `cx index` then rebuilds it from scratch, dropping the table
# under the server that is still building it.
VECTORS_BUILDING = "building"

# `cx index`'s exit status when another process holds the index's lock
# (src/core/index-lock.ts: EXIT_INDEX_BUSY); nothing was written.
EXIT_BUSY = 75

# Settings that would point the child at another repository or index than
# the one it is run for: the repository is passed as the command's path, and
# its index is the one inside it.
REDIRECTING_VARS = ("CX_ROOT", "CX_INDEX_DIR")

# How an outcome that is not an index or sync starts.
FAILURES = ("failed", "gave up", "the client did not start", "not a directory")
BUSY = "already being indexed here; skipped"
OTHER_PROCESS = "being indexed by another process (the server, or another `cx index`); skipped"
NO_INDEX = "no index yet; the server builds it on the first query"
STILL_BUILDING = ("its vectors are still being built; left to the server (if no server is building them, "
                  "`hermes supergrep index` rebuilds it)")

# One index or sync per repository at a time in this process: two sessions
# that start close together find the first one's run and skip it.
_running: dict[Path, threading.Lock] = {}
_running_guard = threading.Lock()


def _manifest(path: Path) -> Optional[dict]:
    """A manifest's JSON, or None when there is none or it does not parse
    (the client reads such a file as no index)."""
    try:
        parsed = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def has_index(repo: Path) -> bool:
    """Whether `repo` has an index of its own: keyword search is live in it,
    whether or not its vectors are done."""
    return _manifest(repo / INDEX_DIR_NAME / MANIFEST_NAME) is not None


def vectors_building(repo: Path) -> bool:
    """Whether the index's vectors, or its platform table's load, are still
    being built, by its manifest or the platform table's."""
    return any((m or {}).get("vectors") == VECTORS_BUILDING
               for m in (_manifest(repo / INDEX_DIR_NAME / name) for name in (MANIFEST_NAME, PLATFORM_MANIFEST_NAME)))


def sync_skip(repo: Path) -> Optional[str]:
    """Why the session-start hook leaves `repo` alone, or None to sync it:
    no index yet (a first build is the server's), or one whose build has not
    finished (a sync refuses it, and `cx index` would rebuild it under the
    server building it)."""
    if not has_index(repo):
        return NO_INDEX
    if vectors_building(repo):
        return STILL_BUILDING
    return None


def skipped(outcome: str) -> bool:
    return outcome in (BUSY, OTHER_PROCESS)


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
    if run.returncode == EXIT_BUSY:
        return OTHER_PROCESS
    if run.returncode != 0:
        tail = (run.stderr or run.stdout).strip().splitlines()
        return f"failed ({run.returncode}): {tail[-1] if tail else 'no output'}"
    last = (run.stdout.strip().splitlines() or ["indexed"])[-1]
    return last


def sync_all(settings: config.Settings, timeout_s: int = TIMEOUT_S) -> Iterator[tuple[Path, str]]:
    for repo in settings.repos:
        yield repo, sync_one(settings, repo, timeout_s)

# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""Indexing the profile's repositories with the client's own `index` command:
a full build where there is no index yet, an incremental sync against the
working tree where there is. Run when a session starts, and by
`hermes supergrep index`."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterator

from . import config

# How long one repository's index or sync may take before it is given up on
# and the session goes on without it; a first build of a large tree can be
# long, and a session should not wait on it forever.
TIMEOUT_S = 600


def command(settings: config.Settings) -> list[str]:
    """`cx index` as the client is run; the repository is the working
    directory (the client's default root)."""
    return [settings.node, str(settings.client_js), "index"]


def sync_one(settings: config.Settings, repo: Path, timeout_s: int = TIMEOUT_S) -> str:
    """Index or sync `repo`; a one-line outcome for the log."""
    if not repo.is_dir():
        return "not a directory"
    try:
        run = subprocess.run(command(settings), cwd=str(repo), capture_output=True, text=True,
                             timeout=timeout_s, check=False)
    except FileNotFoundError as e:
        return f"the client did not start: {e}"
    except subprocess.TimeoutExpired:
        return f"gave up after {timeout_s}s"
    if run.returncode != 0:
        tail = (run.stderr or run.stdout).strip().splitlines()
        return f"failed ({run.returncode}): {tail[-1] if tail else 'no output'}"
    last = (run.stdout.strip().splitlines() or ["indexed"])[-1]
    return last


def sync_all(settings: config.Settings, timeout_s: int = TIMEOUT_S) -> Iterator[tuple[Path, str]]:
    for repo in settings.repos:
        yield repo, sync_one(settings, repo, timeout_s)

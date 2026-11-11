# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""The client as Hermes's MCP server over the profile's repositories.

Hermes starts one command for `mcp_servers.supergrep`:

    mcp_servers:
      supergrep:
        command: hermes
        args: [supergrep, mcp]
        env:
          SUPERGREP_REPOS: /home/me/src/project-one,/home/me/src/project-two

`hermes supergrep mcp` reads the settings and becomes `node dist/cli.js mcp`
with the first repository as the tools' root (`CX_ROOT`); the client reaches
the other repositories by the `path` its tools take, with their own indexes.
Indexing on a first query and re-syncing against the working tree on later
ones stay on, the client's defaults, so a repository the session-start hook
did not reach is still indexed on first use.
"""
from __future__ import annotations

import os
import sys
from typing import Optional

from . import config

# What the client reads for a root with no index yet, and for syncing one.
AUTO_INDEX_VAR = "CX_AUTO_INDEX"
AUTO_SYNC_VAR = "CX_AUTO_SYNC"
ROOT_VAR = "CX_ROOT"


def command(settings: config.Settings) -> tuple[list[str], dict[str, str]]:
    """The client's command line and the environment it adds."""
    if settings.default_root is None:
        raise ValueError(f"{config.REPOS_ENV} names no repository")
    argv = [settings.node, str(settings.client_js), "mcp"]
    # The client's own defaults, set so a profile's shell cannot turn them
    # off underneath it: SUPERGREP_AUTO_INDEX governs the session-start
    # indexing only, and a root the hook did not index is still indexed on
    # its first query.
    env = {ROOT_VAR: str(settings.default_root), AUTO_INDEX_VAR: "1", AUTO_SYNC_VAR: "1"}
    return argv, env


def launch(settings: Optional[config.Settings] = None) -> None:
    """Become the client. Exits with the reason when it cannot start."""
    settings = settings or config.load()
    problems = config.missing(settings)
    if problems:
        sys.exit("supergrep: " + "; ".join(problems))
    argv, env = command(settings)
    sys.stdout.flush()
    try:
        os.execvpe(argv[0], argv, {**os.environ, **env})
    except OSError as e:
        sys.exit(f"supergrep: the client did not start: {argv[0]}: {e}")

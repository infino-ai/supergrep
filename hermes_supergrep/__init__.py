# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""SuperGrep as a Hermes plugin.

A directory plugin (`$HERMES_HOME/plugins/supergrep/`: what `hermes plugins
install` copies there from this folder, or a symlink to it in a checkout).
It gives a profile the repositories it reads:

- `hermes supergrep mcp` becomes the client's MCP server over those
  repositories, which Hermes starts for `mcp_servers.supergrep`
  (`mcp_launch.py`); the agent then has `find`, `search`, `sql`, `read` and
  the rest of the client's tools, the first repository as their default root
  and the others by their `path`;
- the `code-context` skill, which says how to use them, loads as
  `supergrep:code-context`;
- when a session starts, every repository is indexed or synced in the
  background (`index.py`), so the tools' first call finds the index there
  or nearly so; a call that comes first still indexes on its own, since
  the client does that for any root without an index.

Memory is another plugin's; this one keeps to the code, and
the two load side by side in one profile under different server names.
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

from . import cli, config, index

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Hermes's entry point for the plugin: the CLI command, the skill, and
    the session-start hook. Never raises: a profile with no repositories
    configured still loads the plugin, and says so in its log."""
    cli.register(ctx)
    try:
        skill = config.skill_path(config.load())
        ctx.register_skill("code-context", skill, config.SKILL_DESCRIPTION)
    except (FileNotFoundError, ValueError) as e:
        logger.warning("supergrep: the code-context skill was not registered: %s", e)
    ctx.register_hook("on_session_start", _on_session_start)


def _on_session_start(*args, **kwargs) -> Optional[threading.Thread]:
    """Index or sync every configured repository as a session starts, in a
    thread, since Hermes waits for this hook and a first index of a large
    tree takes minutes. Hermes hands the hook its session (`session_id`,
    `model`); the plugin reads nothing of it, since the repositories are the
    profile's, not the session's. The thread is returned for whoever wants
    to wait on it (the tests); Hermes ignores it."""
    settings = config.load()
    if not settings.repos:
        logger.info("supergrep: %s names no repository; nothing indexed", config.REPOS_ENV)
        return None
    if not settings.auto_index:
        return None

    def run() -> None:
        for repo, outcome in index.sync_all(settings):
            logger.info("supergrep: %s: %s", repo, outcome)

    thread = threading.Thread(target=run, name="supergrep-index", daemon=True)
    thread.start()
    return thread

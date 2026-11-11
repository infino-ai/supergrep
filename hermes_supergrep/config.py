# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""The plugin's settings: which repositories the profile reads, and how the
client is run.

Every setting is an environment variable, so a profile's `.env` or the
`mcp_servers.supergrep.env` block of its config sets it, and `hermes <name>
setup` has nothing to write. The config block wins over the environment:
the block is what Hermes hands the MCP server it starts, so the launcher
and the plugin read the same values.

The client is the checkout this plugin directory sits in when it does
(`$HERMES_HOME/plugins/supergrep` a symlink to `<checkout>/hermes_supergrep`):
`__file__` resolves into the checkout, and `dist/cli.js` and the skill are
found from there. `hermes plugins install` copies the directory out of the
repository instead, with no checkout around it; that install names the
client with SUPERGREP_CLIENT, and the skill is found beside it.
"""
from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

logger = logging.getLogger(__name__)

REPOS_ENV = "SUPERGREP_REPOS"
CLIENT_ENV = "SUPERGREP_CLIENT"
NODE_ENV = "SUPERGREP_NODE"
MCP_SERVER_ENV = "SUPERGREP_MCP_SERVER"
AUTO_INDEX_ENV = "SUPERGREP_AUTO_INDEX"

DEFAULT_MCP_SERVER = "supergrep"
# Spellings that turn a boolean setting off, as the client reads its own.
OFF_VALUES = ("0", "false", "no", "off")
REPOS_SEPARATOR = ","

SKILL_DESCRIPTION = ("How to answer codebase questions with the SuperGrep tools: find and sql over "
                     "the index, search over the platform's copy, read for the lines.")

# The checkout this plugin directory sits in, through the symlink Hermes loads it by.
CHECKOUT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    """The repositories, in the order named (the first is the tools' default
    root), and the client's command."""
    repos: tuple[Path, ...]
    client_js: Path
    node: str
    mcp_server: str = DEFAULT_MCP_SERVER
    auto_index: bool = True

    @property
    def default_root(self) -> Optional[Path]:
        return self.repos[0] if self.repos else None


def skill_path(settings: Optional["Settings"] = None, checkout: Path = CHECKOUT) -> Path:
    """The code-context skill the checkout ships: beside this plugin directory
    when it sits in the checkout, else beside the client it names (a copied
    plugin directory, as `hermes plugins install` makes, with
    SUPERGREP_CLIENT set to the checkout's dist/cli.js)."""
    candidates = [checkout]
    if settings is not None:
        candidates.append(settings.client_js.parent.parent)
    for root in candidates:
        path = root / "skills" / "code-context" / "SKILL.md"
        if path.is_file():
            return path
    raise FileNotFoundError("no code-context skill at " + " or ".join(
        str(root / "skills" / "code-context" / "SKILL.md") for root in candidates))


def default_client(checkout: Path = CHECKOUT) -> Path:
    """The client the checkout builds (`npm run build`)."""
    return checkout / "dist" / "cli.js"


def _block(server: str) -> Mapping[str, str]:
    """The `env` of `mcp_servers.<server>` in the profile's Hermes config,
    when this runs under Hermes; empty elsewhere (the tests, a plain shell)."""
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore
    except Exception:
        return {}
    try:
        cfg = load_config_readonly() or {}
        env = ((cfg.get("mcp_servers") or {}).get(server) or {}).get("env") or {}
        return {str(k): str(v) for k, v in env.items() if v is not None}
    except Exception as e:  # a config that cannot be read is no reason to fail the session
        logger.info("supergrep: the config block was not read: %s", e)
        return {}


def load(env: Optional[Mapping[str, str]] = None, checkout: Path = CHECKOUT) -> Settings:
    """The settings from `env` (the process environment when absent) under
    the config block."""
    env = dict(os.environ if env is None else env)
    server = (env.get(MCP_SERVER_ENV) or DEFAULT_MCP_SERVER).strip() or DEFAULT_MCP_SERVER
    merged = {**env, **_block(server)}

    def value(name: str) -> str:
        return (merged.get(name) or "").strip()

    repos = tuple(
        Path(os.path.expanduser(part.strip())).resolve()
        for part in value(REPOS_ENV).split(REPOS_SEPARATOR)
        if part.strip()
    )
    client = value(CLIENT_ENV)
    client_js = Path(os.path.expanduser(client)).resolve() if client else default_client(checkout)
    node = value(NODE_ENV) or shutil.which("node") or "node"
    auto_index = value(AUTO_INDEX_ENV).lower() not in OFF_VALUES
    return Settings(repos=repos, client_js=client_js, node=node, mcp_server=server, auto_index=auto_index)


def missing(settings: Settings) -> list[str]:
    """What keeps the client from starting: the client not built, a
    repository that is not a directory."""
    out = []
    if not settings.client_js.is_file():
        out.append(f"the client is not built: no {settings.client_js} (run `npm run build` in the checkout, "
                   f"or set {CLIENT_ENV})")
    if not settings.repos:
        out.append(f"{REPOS_ENV} names no repository")
    for repo in settings.repos:
        if not repo.is_dir():
            out.append(f"{repo} is not a directory")
    return out

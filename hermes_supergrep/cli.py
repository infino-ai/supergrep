# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""`hermes supergrep`: status, index, mcp."""
from __future__ import annotations

import argparse
import sys

from . import config, index, mcp_launch

HELP = "SuperGrep: the repositories this profile reads, and the client's MCP server"


def setup(parser: argparse.ArgumentParser) -> None:
    """The subcommands, on the parser Hermes gives `hermes supergrep`."""
    sub = parser.add_subparsers(dest="supergrep_action")
    sub.add_parser("status", help="the repositories, the client, and whether each is in place")
    sub.add_parser("index", help="index or sync every repository now")
    sub.add_parser("mcp", help="the client's MCP server, which Hermes starts (mcp_servers.supergrep)")


def handle(args: argparse.Namespace) -> int:
    action = getattr(args, "supergrep_action", None) or "status"
    return {"status": _status, "index": _index, "mcp": _mcp}[action](args)


def register(ctx) -> None:
    ctx.register_cli_command("supergrep", HELP, setup, handle, description=HELP)


def _status(args) -> int:
    settings = config.load()
    print(f"client: {settings.client_js} ({'built' if settings.client_js.is_file() else 'not built'})")
    print(f"node: {settings.node}")
    print(f"mcp server: {settings.mcp_server}")
    if not settings.repos:
        print(f"repositories: none ({config.REPOS_ENV} is unset)")
    for repo in settings.repos:
        state = "not a directory" if not repo.is_dir() else ("indexed" if (repo / ".infino").is_dir() else "no index yet")
        print(f"repository: {repo} ({state})")
    problems = config.missing(settings)
    for problem in problems:
        print(f"problem: {problem}", file=sys.stderr)
    return 1 if problems else 0


def _index(args) -> int:
    settings = config.load()
    problems = config.missing(settings)
    if problems:
        print("supergrep: " + "; ".join(problems), file=sys.stderr)
        return 1
    failed = 0
    for repo, outcome in index.sync_all(settings):
        print(f"{repo}: {outcome}")
        if outcome.startswith(("failed", "gave up", "the client did not start", "not a directory")):
            failed += 1
    return 1 if failed else 0


def _mcp(args) -> int:
    mcp_launch.launch()
    return 0  # not reached: launch execs the client


def main(argv=None) -> int:
    """Run as `python -m hermes_supergrep ...`, outside Hermes, with the same
    subcommands."""
    parser = argparse.ArgumentParser(prog="hermes supergrep", description=HELP)
    setup(parser)
    return handle(parser.parse_args(argv))

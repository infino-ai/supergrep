# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""The client's MCP server instructions, in every Hermes session's system
prompt.

An MCP server says how to use its tools in its answer to `initialize`: look
with `find`, `search` and `sql` before opening files, read every path in one
call, and so on. Claude Code puts those instructions in front of the model,
which is what makes it reach for the tools. Hermes hands on a server's tools
but not its instructions, so an agent in Hermes had `find`, `search`, `sql`
and `read` and still read files one at a time with Hermes's own file tools:
none of 147 tool calls of one review went to the server.

So the plugin starts the server as Hermes does (`mcp_launch.command`, with the
profile's `mcp_servers.supergrep.env`), takes the instructions from its answer
to `initialize`, and gives them to Hermes as system prompt sections: a Hermes
session starts with what a Claude Code one does. Hermes caps a section at
4,000 characters and all plugins' sections in a session at 8,000 together,
skipping whole any section that would pass either, so the text goes in as two
sections cut at line ends, and what runs past them is left out. A server that
does not answer leaves the sections empty, and the session starts as it did
before.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
from typing import Callable, Optional

from . import config, mcp_launch

logger = logging.getLogger(__name__)

# The sections' ids, `supergrep.instructions.1` and on, and how many there are.
# Hermes renders at most 8,000 characters of plugin sections a session, headings
# and markers included, and skips a section whole that would pass that; two
# full parts with their headings come to about 7,850, so a third would never
# be shown.
SECTION_ID = "supergrep.instructions.{}"
PARTS = 2
# The most characters a part holds, under Hermes's 4,000 for the section's
# heading and markers.
PART_CHARS = 3_800
# How long the server has to answer `initialize`.
ANSWER_TIMEOUT_S = 30.0
# How long one answer serves the sessions that start after it, and how long an
# empty one (a server that did not start or answer) does: long enough that the
# second section does not wait again, short enough that a slow start does not
# leave the next minutes' sessions without instructions.
CACHE_S = 300.0
EMPTY_CACHE_S = 30.0
# The MCP revision the request names; the server answers in the one it speaks.
PROTOCOL_VERSION = "2025-06-18"

_cache: dict[tuple, tuple[float, str]] = {}
_cache_lock = threading.Lock()


def fetch(settings: config.Settings, timeout: float = ANSWER_TIMEOUT_S) -> str:
    """The instructions the server gives in its answer to `initialize`, or ""
    when it cannot start or does not answer in `timeout`."""
    if config.missing(settings):
        return ""
    argv, env = mcp_launch.command(settings)
    try:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            env={**os.environ, **settings.block, **env}, cwd=str(settings.default_root))
    except OSError as e:
        logger.info("supergrep: the server did not start for its instructions: %s", e)
        return ""
    lines: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in proc.stdout], daemon=True).start()
    request = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                          "clientInfo": {"name": "hermes-supergrep", "version": "0.1.0"}}}
    try:
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                logger.info("supergrep: the server gave no instructions within %.0f s", timeout)
                return ""
            try:
                line = lines.get(timeout=left)
            except queue.Empty:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("id") == 1:
                result = message.get("result") or {}
                text = result.get("instructions") if isinstance(result, dict) else None
                return text if isinstance(text, str) else ""
    except (OSError, ValueError) as e:
        logger.info("supergrep: the server's instructions were not read: %s", e)
        return ""
    finally:
        proc.kill()
        proc.wait()


def parts(text: str, size: int = PART_CHARS, count: int = PARTS) -> list[str]:
    """`text` in at most `count` parts of at most `size` characters, cut at
    line ends; a line longer than `size` is cut where it reaches it. What does
    not fit in `count` parts is left out, and logged."""
    out: list[str] = []
    part = ""
    for line in text.splitlines(keepends=True):
        while len(line) > size:
            if part:
                out.append(part)
                part = ""
            out.append(line[:size])
            line = line[size:]
        if len(part) + len(line) > size:
            out.append(part)
            part = ""
        part += line
    if part:
        out.append(part)
    out = [p.strip("\n") for p in out if p.strip()]
    if len(out) > count:
        kept = sum(len(p) for p in out[:count])
        logger.warning("supergrep: the server's instructions are %d characters; %d fit in %d sections "
                       "and the rest is left out", len(text), kept, count)
    return out[:count]


def current(load: Callable[[], config.Settings] = config.load,
            fetch_fn: Callable[[config.Settings], str] = fetch) -> list[str]:
    """The instructions' parts for a session starting now: fetched from the
    server, or the answer of the last `CACHE_S` seconds for the same settings
    (`EMPTY_CACHE_S` when that answer was empty)."""
    settings = load()
    key = (settings.repos, str(settings.client_js), settings.node, tuple(sorted(settings.block.items())))
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < (CACHE_S if hit[1] else EMPTY_CACHE_S):
            return parts(hit[1])
        text = fetch_fn(settings)
        _cache[key] = (now, text)
    return parts(text)


def section(n: int, current_fn: Callable[[], list[str]] = current) -> Callable[[object], str]:
    """The content of section `n` (from 0): Hermes calls it with the session's
    info as a session starts."""
    def render(_session_info: object) -> str:
        try:
            got = current_fn()
        except Exception as e:  # a session never fails over this
            logger.info("supergrep: no server instructions for this session: %s", e)
            return ""
        return got[n] if n < len(got) else ""
    return render


def register(ctx, current_fn: Optional[Callable[[], list[str]]] = None) -> bool:
    """Register the sections, when this Hermes has system prompt sections;
    whether it did."""
    add = getattr(ctx, "register_system_prompt_section", None)
    if add is None:
        logger.info("supergrep: this Hermes has no system prompt sections; the server's instructions "
                    "stay with the server")
        return False
    for n in range(PARTS):
        add(SECTION_ID.format(n + 1), section(n, current_fn or current))
    return True

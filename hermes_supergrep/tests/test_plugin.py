# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""The plugin against a stand-in for Hermes's plugin context: what it
registers, how it reads its settings, and the commands it runs. Hermes
itself is not needed; its context's methods are the ones this plugin calls
(`register_cli_command`, `register_skill`, `register_hook`)."""
from __future__ import annotations

import argparse
import os
import stat
from pathlib import Path

import pytest

import hermes_supergrep
from hermes_supergrep import cli, config, index, mcp_launch

CHECKOUT = Path(__file__).resolve().parent.parent.parent


class FakeCtx:
    def __init__(self):
        self.cli_commands = {}
        self.skills = {}
        self.hooks = {}

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli_commands[name] = (help, setup_fn, handler_fn)

    def register_skill(self, name, path, description=""):
        if not Path(path).exists():
            raise FileNotFoundError(path)
        self.skills[name] = (Path(path), description)

    def register_hook(self, hook_name, callback, *, hold_stream=False):
        self.hooks.setdefault(hook_name, []).append(callback)


@pytest.fixture
def fake_node(tmp_path):
    """A `node` that records what it was asked and where, and answers as the
    client's `index` does."""
    log = tmp_path / "node.log"
    script = tmp_path / "node"
    script.write_text(
        "#!/bin/sh\n"
        f"echo \"$PWD $*\" >> {log}\n"
        "if [ \"$2\" = index ]; then echo 'indexed 3 files'; fi\n"
        "case \"$1\" in */fail.js) echo boom >&2; exit 3;; esac\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script, log


def test_register_gives_hermes_the_command_the_skill_and_the_hook():
    ctx = FakeCtx()
    hermes_supergrep.register(ctx)
    assert "supergrep" in ctx.cli_commands
    skill_path, description = ctx.skills["code-context"]
    assert skill_path == CHECKOUT / "skills" / "code-context" / "SKILL.md"
    assert description
    assert ctx.hooks["on_session_start"] == [hermes_supergrep._on_session_start]
    # The command's parser takes the three actions.
    parser = argparse.ArgumentParser()
    ctx.cli_commands["supergrep"][1](parser)
    assert parser.parse_args(["mcp"]).supergrep_action == "mcp"
    assert parser.parse_args(["index"]).supergrep_action == "index"
    assert parser.parse_args([]).supergrep_action is None


def test_settings_name_the_repositories_in_order_and_the_checkout_s_client(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    settings = config.load({config.REPOS_ENV: f"{a}, {b} ,", config.NODE_ENV: "/usr/bin/node22"})
    assert settings.repos == (a.resolve(), b.resolve())
    assert settings.default_root == a.resolve()
    assert settings.client_js == CHECKOUT / "dist" / "cli.js"
    assert settings.node == "/usr/bin/node22"
    assert settings.mcp_server == "supergrep"
    assert settings.auto_index
    # A named client and server, and auto-index off, as a copied plugin dir sets them.
    other = config.load({config.REPOS_ENV: str(a), config.CLIENT_ENV: str(tmp_path / "cli.js"),
                         config.MCP_SERVER_ENV: "code", config.AUTO_INDEX_ENV: "off"})
    assert other.client_js == (tmp_path / "cli.js").resolve()
    assert other.mcp_server == "code"
    assert not other.auto_index
    # Nothing named: no repositories, and `missing` says so.
    empty = config.load({})
    assert empty.repos == ()
    assert any(config.REPOS_ENV in m for m in config.missing(empty))


def test_the_mcp_command_runs_the_client_over_the_first_repository(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    settings = config.load({config.REPOS_ENV: f"{a},{b}", config.CLIENT_ENV: str(client),
                            config.NODE_ENV: "node"})
    argv, env = mcp_launch.command(settings)
    assert argv == ["node", str(client), "mcp"]
    assert env == {"CX_ROOT": str(a.resolve()), "CX_AUTO_INDEX": "1", "CX_AUTO_SYNC": "1"}
    assert config.missing(settings) == []
    with pytest.raises(ValueError):
        mcp_launch.command(config.load({config.CLIENT_ENV: str(client)}))


def test_indexing_runs_the_client_s_index_in_each_repository(tmp_path, fake_node):
    node, log = fake_node
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    settings = config.load({config.REPOS_ENV: f"{a},{b},{tmp_path / 'gone'}", config.CLIENT_ENV: str(client),
                            config.NODE_ENV: str(node)})
    outcomes = list(index.sync_all(settings))
    assert outcomes == [(a.resolve(), "indexed 3 files"), (b.resolve(), "indexed 3 files"),
                        ((tmp_path / "gone").resolve(), "not a directory")]
    runs = log.read_text().strip().splitlines()
    assert runs == [f"{a.resolve()} {client} index", f"{b.resolve()} {client} index"]
    # A client that fails says so with its last line, and the index command reports it.
    failing = config.load({config.REPOS_ENV: str(a), config.CLIENT_ENV: str(tmp_path / "fail.js"),
                           config.NODE_ENV: str(node)})
    assert index.sync_one(failing, a.resolve()) == "failed (3): boom"


def test_the_session_start_hook_indexes_unless_told_not_to(tmp_path, fake_node, monkeypatch):
    node, log = fake_node
    a = tmp_path / "a"
    a.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    env = {config.REPOS_ENV: str(a), config.CLIENT_ENV: str(client), config.NODE_ENV: str(node)}
    monkeypatch.setattr(os, "environ", env)
    thread = hermes_supergrep._on_session_start(session_id="s1", model="m")
    assert thread is not None, "the indexing runs in a thread, so the session does not wait on it"
    thread.join(timeout=30)
    assert not thread.is_alive()
    assert log.read_text().strip() == f"{a.resolve()} {client} index"
    env[config.AUTO_INDEX_ENV] = "0"
    assert hermes_supergrep._on_session_start(session_id="s2", model="m") is None, "off: nothing started"
    assert len(log.read_text().strip().splitlines()) == 1, "off: nothing more indexed"
    del env[config.REPOS_ENV]
    assert hermes_supergrep._on_session_start(session_id="s3", model="m") is None, "no repositories: nothing started"


def test_the_skill_is_found_beside_a_copied_plugin_s_client(tmp_path):
    """`hermes plugins install` copies the plugin directory out of the
    repository; the skill is then found from the client it names."""
    copy = tmp_path / "plugins" / "supergrep"
    copy.mkdir(parents=True)
    checkout = tmp_path / "checkout"
    (checkout / "skills" / "code-context").mkdir(parents=True)
    (checkout / "skills" / "code-context" / "SKILL.md").write_text("---\nname: code-context\n---\n")
    (checkout / "dist").mkdir()
    (checkout / "dist" / "cli.js").write_text("")
    settings = config.load({config.CLIENT_ENV: str(checkout / "dist" / "cli.js")}, checkout=copy.parent)
    assert config.skill_path(settings, checkout=copy.parent) == checkout / "skills" / "code-context" / "SKILL.md"
    with pytest.raises(FileNotFoundError):
        config.skill_path(config.load({}, checkout=copy.parent), checkout=copy.parent)


def test_the_command_line_status_and_index(tmp_path, fake_node, monkeypatch, capsys):
    node, log = fake_node
    a = tmp_path / "a"
    a.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    monkeypatch.setattr(os, "environ", {config.REPOS_ENV: str(a), config.CLIENT_ENV: str(client),
                                        config.NODE_ENV: str(node)})
    assert cli.main(["status"]) == 0
    out = capsys.readouterr().out
    assert f"repository: {a.resolve()} (no index yet)" in out
    assert cli.main(["index"]) == 0
    assert "indexed 3 files" in capsys.readouterr().out
    monkeypatch.setattr(os, "environ", {config.CLIENT_ENV: str(client), config.NODE_ENV: str(node)})
    assert cli.main(["status"]) == 1
    assert config.REPOS_ENV in capsys.readouterr().err

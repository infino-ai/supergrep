# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright The Infino Authors
"""The plugin against a stand-in for Hermes's plugin context: what it
registers, how it reads its settings, and the commands it runs. Hermes
itself is not needed; its context's methods are the ones this plugin calls
(`register_cli_command`, `register_skill`, `register_hook`)."""
from __future__ import annotations

import argparse
import logging
import os
import threading
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
        f"echo \"env CX_ROOT=$CX_ROOT CX_INDEX_DIR=$CX_INDEX_DIR CX_INCLUDE=$CX_INCLUDE\" >> {log}.env\n"
        "if [ \"$2\" = index ]; then echo 'indexed 3 files'; fi\n"
        "case \"$1\" in */fail.js) echo boom >&2; exit 3;; */busy.js) echo 'error: another process' >&2; exit 75;; esac\n"
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
    assert runs == [f"{a.resolve()} {client} index {a.resolve()}", f"{b.resolve()} {client} index {b.resolve()}"]
    # A client that fails says so with its last line, and the index command reports it.
    failing = config.load({config.REPOS_ENV: str(a), config.CLIENT_ENV: str(tmp_path / "fail.js"),
                           config.NODE_ENV: str(node)})
    assert index.sync_one(failing, a.resolve()) == "failed (3): boom"


def _indexed(repo: Path, vectors: str = "ready", platform: str = "") -> Path:
    (repo / index.INDEX_DIR_NAME).mkdir(parents=True)
    (repo / index.INDEX_DIR_NAME / index.MANIFEST_NAME).write_text(f'{{"vectors": "{vectors}"}}')
    if platform:
        (repo / index.INDEX_DIR_NAME / index.PLATFORM_MANIFEST_NAME).write_text(
            f'{{"origin": "hosted", "vectors": "{platform}"}}')
    return repo


def test_the_session_start_hook_syncs_indexed_repositories_unless_told_not_to(tmp_path, fake_node, monkeypatch):
    node, log = fake_node
    a = _indexed(tmp_path / "a")
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    env = {config.REPOS_ENV: f"{fresh},{a}", config.CLIENT_ENV: str(client), config.NODE_ENV: str(node)}
    monkeypatch.setattr(os, "environ", env)
    thread = hermes_supergrep._on_session_start(session_id="s1", model="m")
    assert thread is not None, "the indexing runs in a thread, so the session does not wait on it"
    thread.join(timeout=30)
    assert not thread.is_alive()
    # The repository with no index is left to the server's first query.
    assert log.read_text().strip() == f"{a.resolve()} {client} index {a.resolve()}"
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


def test_the_index_run_gets_the_config_block_and_not_another_root(tmp_path, fake_node, monkeypatch):
    """The child runs with the server's `env` block and without CX_ROOT or
    CX_INDEX_DIR, so it indexes the repository it is run for, into its own
    index, with the server's file settings."""
    node, log = fake_node
    a = tmp_path / "a"
    a.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    monkeypatch.setattr(config, "_block", lambda server: {"CX_INCLUDE": "vendor/**", "CX_ROOT": "/elsewhere"})
    monkeypatch.setattr(os, "environ", {"PATH": os.environ.get("PATH", ""), "CX_ROOT": "/elsewhere",
                                        "CX_INDEX_DIR": "/shared-index"})
    settings = config.load({config.REPOS_ENV: str(a), config.CLIENT_ENV: str(client), config.NODE_ENV: str(node)})
    assert settings.block == {"CX_INCLUDE": "vendor/**", "CX_ROOT": "/elsewhere"}
    assert index.sync_one(settings, a.resolve()) == "indexed 3 files"
    assert (tmp_path / "node.log.env").read_text().strip() == "env CX_ROOT= CX_INDEX_DIR= CX_INCLUDE=vendor/**"


def test_one_run_per_repository_at_a_time(tmp_path, fake_node):
    node, log = fake_node
    a = tmp_path / "a"
    a.mkdir()
    client = tmp_path / "cli.js"
    client.write_text("")
    settings = config.load({config.REPOS_ENV: str(a), config.CLIENT_ENV: str(client), config.NODE_ENV: str(node)})
    held = index._lock_for(a.resolve())
    held.acquire()
    try:
        assert index.sync_one(settings, a.resolve()) == index.BUSY
    finally:
        held.release()
    assert not log.exists(), "a busy repository is not run a second time"
    assert index.sync_one(settings, a.resolve()) == "indexed 3 files"


def test_a_failed_sync_logs_a_warning(tmp_path, fake_node, monkeypatch, caplog):
    node, log = fake_node
    a = _indexed(tmp_path / "a")
    env = {config.REPOS_ENV: str(a), config.CLIENT_ENV: str(tmp_path / "fail.js"), config.NODE_ENV: str(node)}
    monkeypatch.setattr(os, "environ", env)
    with caplog.at_level(logging.INFO, logger="hermes_supergrep"):
        hermes_supergrep._on_session_start(session_id="s", model="m").join(timeout=30)
    failures = [r for r in caplog.records if "failed (3): boom" in r.getMessage()]
    assert [r.levelno for r in failures] == [logging.WARNING]


def test_node_falls_back_to_hermes_s_own_and_a_missing_one_is_a_problem(tmp_path, monkeypatch):
    client = tmp_path / "cli.js"
    client.write_text("")
    a = tmp_path / "a"
    a.mkdir()
    # Newest by version, not by name: 22.19.0 after 22.9.0, which sorts after it as text.
    for folder in ("node-v22.9.0-linux-x64", "node-v22.19.0-linux-x64", "node-v8.0.0-linux-x64"):
        bin_dir = tmp_path / "hermes" / "tools" / folder / "bin"
        bin_dir.mkdir(parents=True)
        hermes = bin_dir / "node"
        hermes.write_text("#!/bin/sh\n")
        hermes.chmod(hermes.stat().st_mode | stat.S_IEXEC)
    hermes = tmp_path / "hermes" / "tools" / "node-v22.19.0-linux-x64" / "bin" / "node"
    empty_path = tmp_path / "empty"
    empty_path.mkdir()
    monkeypatch.setenv("PATH", str(empty_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    env = {config.REPOS_ENV: str(a), config.CLIENT_ENV: str(client), "PATH": str(empty_path),
           "HERMES_HOME": str(tmp_path / "hermes")}
    assert config.load(env).node == str(hermes)
    assert config.missing(config.load(env)) == []
    del env["HERMES_HOME"]
    settings = config.load(env)
    assert settings.node == "node"
    assert any("no Node" in m for m in config.missing(settings))
    with pytest.raises(SystemExit) as exited:
        mcp_launch.launch(settings)
    assert "no Node" in str(exited.value)


def test_the_hook_leaves_an_index_whose_vectors_are_still_building(tmp_path, fake_node, monkeypatch, caplog, capsys):
    """A sync refuses an index whose vectors (or platform load) are still
    being built, and `cx index` then rebuilds it under the server building
    it; the hook leaves it alone, and syncs it once the build is done."""
    node, log = fake_node
    local = _indexed(tmp_path / "local", vectors="building")
    platform = _indexed(tmp_path / "platform", platform="building")
    done = _indexed(tmp_path / "done")
    client = tmp_path / "cli.js"
    client.write_text("")
    env = {config.REPOS_ENV: f"{local},{platform},{done}", config.CLIENT_ENV: str(client), config.NODE_ENV: str(node)}
    monkeypatch.setattr(os, "environ", env)
    with caplog.at_level(logging.INFO, logger="hermes_supergrep"):
        hermes_supergrep._on_session_start(session_id="s", model="m").join(timeout=30)
    assert log.read_text().strip() == f"{done.resolve()} {client} index {done.resolve()}"
    left = [r for r in caplog.records if index.STILL_BUILDING in r.getMessage()]
    assert len(left) == 2 and all(r.levelno == logging.INFO for r in left)
    assert cli.main(["status"]) == 0
    assert f"repository: {local.resolve()} (indexed, vectors still building)" in capsys.readouterr().out
    # Once the build finishes, the next session syncs it.
    (local / index.INDEX_DIR_NAME / index.MANIFEST_NAME).write_text('{"vectors": "ready"}')
    assert index.sync_skip(local.resolve()) is None
    # A manifest that does not parse reads as no index, as the client reads it.
    (local / index.INDEX_DIR_NAME / index.MANIFEST_NAME).write_text("{")
    assert index.sync_skip(local.resolve()) == index.NO_INDEX


def test_a_repository_another_process_is_indexing_is_skipped_not_failed(tmp_path, fake_node, monkeypatch, caplog):
    """`cx index` exits EXIT_BUSY when the server or another run holds the
    index's lock; the hook logs that at info and the index command does not
    count it as a failure."""
    node, log = fake_node
    a = _indexed(tmp_path / "a")
    (tmp_path / "busy.js").write_text("")
    env = {config.REPOS_ENV: str(a), config.CLIENT_ENV: str(tmp_path / "busy.js"), config.NODE_ENV: str(node)}
    monkeypatch.setattr(os, "environ", env)
    settings = config.load()
    assert index.sync_one(settings, a.resolve()) == index.OTHER_PROCESS
    assert index.skipped(index.OTHER_PROCESS) and not index.failed(index.OTHER_PROCESS)
    with caplog.at_level(logging.INFO, logger="hermes_supergrep"):
        hermes_supergrep._on_session_start(session_id="s", model="m").join(timeout=30)
    busy = [r for r in caplog.records if index.OTHER_PROCESS in r.getMessage()]
    assert [r.levelno for r in busy] == [logging.INFO]
    assert cli.main(["index"]) == 0

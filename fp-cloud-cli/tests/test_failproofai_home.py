"""The CLI's config lives inside a home another product owns.

`~/.failproofai/` belongs to the Enforcement CLI. Its layout is declared in
`src/hooks/fp-home.ts`, mirrored for the daemon in
`crates/failproofaid/src/paths.rs`, and a reset walks it with
`rmSync(recursive)`. So the two things that matter here are not "can we write a
file" — they are:

  * we CREATE and never destroy. Anything already in that home survives every
    path this module can take, including the failure paths.
  * we are visible to the layout register, so a future migration knows a
    credential lives under `fpcli/`. That half is asserted on the TS side
    (`HOME_CLASSES`); what is asserted here is the Python half agreeing about
    where the file goes.

The legacy `~/.fp/cli.json` is read once and never deleted: `load_config`
adopts a pre-move session and copies it to the new path, leaving the original
so a downgrade still finds it. Both halves are tested below.

This paragraph claimed the file was "neither read nor deleted" and that the
move forced a re-login. Adoption landed after the move, the tests 200 lines
down were updated for it, and this header was not — which is how a docstring
ends up contradicting the assertions in its own file.
"""
from __future__ import annotations

import errno
import json
import os
import stat
from pathlib import Path

import pytest

from fp_cli import config as cfg


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    """No inherited home vars, and `Path.home()` pinned inside the tmp dir."""
    for var in ("FP_HOME", "FAILPROOFAI_HOME"):
        monkeypatch.delenv(var, raising=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", staticmethod(lambda: fake_home))
    return fake_home


def _child_writer(n: int, home: str) -> None:  # pragma: no cover - child process
    """Runs in a spawned interpreter, so it must be importable by name."""
    os.environ["FP_HOME"] = home
    os.environ.pop("FAILPROOFAI_HOME", None)
    from fp_cli import config as c

    for _ in range(15):
        c.save_config(c.CliConfig(session_token=f"proc-{n}"))


# ── Where the file resolves ──────────────────────────────────────────────────


def test_default_is_under_the_failproofai_home(clean_env):
    assert cfg.config_path() == clean_env / ".failproofai" / "fpcli" / "cli-auth.json"


def test_failproofai_home_env_appends_the_subdir(clean_env, monkeypatch, tmp_path):
    """`FAILPROOFAI_HOME` names the HOME ROOT, so `fpcli/` is appended to it."""
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "elsewhere"))
    assert cfg.config_path() == tmp_path / "elsewhere" / "fpcli" / "cli-auth.json"


def test_fp_home_is_used_as_is(clean_env, monkeypatch, tmp_path):
    """`FP_HOME` names the CLI's OWN directory — no subdir appended.

    That is what it meant before the move, so an existing export keeps
    addressing the same directory it always did.
    """
    monkeypatch.setenv("FP_HOME", str(tmp_path / "mine"))
    assert cfg.config_path() == tmp_path / "mine" / "cli-auth.json"


def test_fp_home_wins_over_failproofai_home(clean_env, monkeypatch, tmp_path):
    monkeypatch.setenv("FP_HOME", str(tmp_path / "mine"))
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "theirs"))
    assert cfg.config_path() == tmp_path / "mine" / "cli-auth.json"


@pytest.mark.parametrize("var", ["FP_HOME", "FAILPROOFAI_HOME"])
def test_an_empty_env_var_is_not_a_path(clean_env, monkeypatch, var):
    """`FP_HOME=` must fall through, not resolve the config to `/cli-auth.json`."""
    monkeypatch.setenv(var, "")
    assert cfg.config_path() == clean_env / ".failproofai" / "fpcli" / "cli-auth.json"


# ── Create, never destroy ────────────────────────────────────────────────────


def test_creates_the_whole_chain_when_nothing_exists(clean_env):
    assert not (clean_env / ".failproofai").exists()
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert cfg.config_path().is_file()


def test_a_populated_failproofai_home_is_left_intact(clean_env):
    """The case this whole design is about: never wipe somebody else's home."""
    home = clean_env / ".failproofai"
    (home / "policies").mkdir(parents=True)
    (home / "policies" / "mine.mjs").write_text("// hand-written")
    (home / "credentials.json").write_text('{"token": "enforcement-cli"}')
    (home / "VERSION").write_text('{"layout": 4}')
    (home / "state").mkdir()
    (home / "state" / "spool").mkdir()

    cfg.save_config(cfg.CliConfig(session_token="t"))

    assert (home / "policies" / "mine.mjs").read_text() == "// hand-written"
    assert json.loads((home / "credentials.json").read_text())["token"] == "enforcement-cli"
    assert json.loads((home / "VERSION").read_text())["layout"] == 4
    assert (home / "state" / "spool").is_dir()
    assert cfg.config_path().is_file()


def test_other_files_in_fpcli_survive_a_save(clean_env):
    """We own `cli-auth.json`, not the directory it sits in."""
    fpcli = clean_env / ".failproofai" / "fpcli"
    fpcli.mkdir(parents=True)
    (fpcli / "unrelated.json").write_text("{}")
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert (fpcli / "unrelated.json").is_file()


def test_an_existing_auth_file_is_replaced_not_merged(clean_env):
    """A stale session must not leak fields into the new one."""
    cfg.save_config(cfg.CliConfig(session_token="old", email="old@x", org="old-org"))
    cfg.save_config(cfg.CliConfig(session_token="new"))
    loaded = cfg.load_config()
    assert loaded.session_token == "new"
    assert loaded.email is None
    assert loaded.org is None


def test_save_is_idempotent(clean_env):
    for _ in range(3):
        cfg.save_config(cfg.CliConfig(session_token="t"))
    assert cfg.load_config().session_token == "t"


# ── Hostile filesystem ───────────────────────────────────────────────────────


def test_home_occupied_by_a_regular_file_raises_not_corrupts(clean_env):
    """`~/.failproofai` as a FILE must fail loudly and leave it byte-identical."""
    home = clean_env / ".failproofai"
    home.write_text("not a directory")
    with pytest.raises(OSError):
        cfg.save_config(cfg.CliConfig(session_token="t"))
    assert home.read_text() == "not a directory"


def test_fpcli_occupied_by_a_regular_file_raises(clean_env):
    fpcli = clean_env / ".failproofai" / "fpcli"
    fpcli.parent.mkdir(parents=True)
    fpcli.write_text("not a directory")
    with pytest.raises(OSError):
        cfg.save_config(cfg.CliConfig(session_token="t"))
    assert fpcli.read_text() == "not a directory"


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_a_read_only_home_raises_and_changes_nothing(clean_env):
    home = clean_env / ".failproofai"
    home.mkdir()
    (home / "credentials.json").write_text("keep me")
    home.chmod(0o500)
    try:
        with pytest.raises(OSError):
            cfg.save_config(cfg.CliConfig(session_token="t"))
        assert (home / "credentials.json").read_text() == "keep me"
    finally:
        home.chmod(0o700)  # so tmp_path cleanup can run


def test_a_symlinked_home_is_followed(clean_env, tmp_path):
    """Some setups symlink the home onto another volume."""
    real = tmp_path / "real-home"
    real.mkdir()
    (clean_env / ".failproofai").symlink_to(real, target_is_directory=True)
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert (real / "fpcli" / "cli-auth.json").is_file()


def test_unreadable_config_reads_as_absent_rather_than_raising(clean_env):
    """A corrupt file must not crash every command — it means "logged out"."""
    cfg.save_config(cfg.CliConfig(session_token="t"))
    cfg.config_path().write_text("{ not json")
    assert cfg.load_config().session_token is None


# ── Permissions ──────────────────────────────────────────────────────────────


def test_auth_file_is_owner_only(clean_env):
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert stat.S_IMODE(os.stat(cfg.config_path()).st_mode) == 0o600


def test_rewriting_a_loosened_file_restores_0600(clean_env):
    cfg.save_config(cfg.CliConfig(session_token="t"))
    cfg.config_path().chmod(0o644)
    cfg.save_config(cfg.CliConfig(session_token="t2"))
    assert stat.S_IMODE(os.stat(cfg.config_path()).st_mode) == 0o600


# ── The legacy ~/.fp/cli.json ────────────────────────────────────────────────


def _plant_legacy(home: Path) -> Path:
    old = home / ".fp"
    old.mkdir()
    path = old / "cli.json"
    path.write_text(json.dumps({"session_token": "legacy", "email": "old@x"}))
    return path


def test_a_legacy_session_is_adopted(clean_env):
    """Nobody is signed out by the move. The old session is picked up as-is."""
    _plant_legacy(clean_env)
    loaded = cfg.load_config()
    assert loaded.session_token == "legacy"
    assert loaded.email == "old@x"


def test_adoption_writes_the_session_to_the_new_location(clean_env):
    _plant_legacy(clean_env)
    assert not cfg.config_path().exists()
    cfg.load_config()
    assert json.loads(cfg.config_path().read_text())["session_token"] == "legacy"


def test_adoption_is_a_copy_so_a_downgrade_still_works(clean_env):
    """The old `fp` must still find its session if someone rolls back."""
    legacy = _plant_legacy(clean_env)
    cfg.load_config()
    assert json.loads(legacy.read_text())["session_token"] == "legacy"


def test_adoption_does_not_happen_when_a_current_session_exists(clean_env):
    _plant_legacy(clean_env)
    cfg.save_config(cfg.CliConfig(session_token="current"))
    assert cfg.load_config().session_token == "current"


def test_a_corrupt_legacy_file_is_skipped_not_adopted(clean_env):
    old = clean_env / ".fp"
    old.mkdir()
    (old / "cli.json").write_text("{ not json")
    assert cfg.load_config().session_token is None


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_an_unwritable_target_still_hands_back_the_session(clean_env):
    """Our housekeeping must never be the reason someone is logged out."""
    _plant_legacy(clean_env)
    home = clean_env / ".failproofai"
    home.mkdir()
    home.chmod(0o500)
    try:
        assert cfg.load_config().session_token == "legacy"
    finally:
        home.chmod(0o700)


def test_a_relocated_legacy_session_is_adopted(clean_env, monkeypatch, tmp_path):
    """`FP_HOME` users are carried across too — their old file is beside the new."""
    relocated = tmp_path / "custom"
    relocated.mkdir()
    (relocated / "cli.json").write_text(json.dumps({"session_token": "relocated"}))
    monkeypatch.setenv("FP_HOME", str(relocated))
    assert cfg.load_config().session_token == "relocated"


def test_fp_home_does_not_reach_into_the_home_directory(clean_env, monkeypatch, tmp_path):
    """Someone who redirected the config said where it lives. Respect that.

    Reaching past `FP_HOME` into `~/.fp` would adopt a session from a different
    context — another tenant, or another user's leftovers on a shared box.
    """
    _plant_legacy(clean_env)  # a session at ~/.fp/cli.json
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("FP_HOME", str(empty))
    assert cfg.load_config().session_token is None


def test_a_legacy_session_is_never_deleted(clean_env):
    """Deleting a file the user did not ask us to touch is not ours to do."""
    legacy = _plant_legacy(clean_env)
    cfg.save_config(cfg.CliConfig(session_token="new"))
    assert legacy.is_file()
    assert json.loads(legacy.read_text())["session_token"] == "legacy"


def test_a_relocated_legacy_session_is_detected_too(clean_env, monkeypatch, tmp_path):
    """The group most likely to be broken silently: `FP_HOME` users.

    The move changed the FILENAME as well as the directory, so somebody who
    exported `FP_HOME` has their old session at `$FP_HOME/cli.json` and may own
    no `~/.fp` at all. Checking only the default hands exactly those users an
    unexplained logout.
    """
    relocated = tmp_path / "custom"
    relocated.mkdir()
    (relocated / "cli.json").write_text('{"session_token": "old"}')
    monkeypatch.setenv("FP_HOME", str(relocated))

    assert cfg.legacy_install_detected() is True
    assert cfg.legacy_config_path() == relocated / "cli.json"


def test_the_relocated_path_is_named_before_the_default(clean_env, monkeypatch, tmp_path):
    """When both exist, name the one THIS invocation would have read.

    Naming the default instead tells an `FP_HOME` user to delete an unrelated
    file — on a machine they may share.
    """
    _plant_legacy(clean_env)  # the default, ~/.fp/cli.json
    relocated = tmp_path / "custom"
    relocated.mkdir()
    (relocated / "cli.json").write_text('{"session_token": "old"}')
    monkeypatch.setenv("FP_HOME", str(relocated))

    assert cfg.legacy_config_path() == relocated / "cli.json"


def test_no_legacy_anywhere_reports_none(clean_env):
    assert cfg.legacy_config_path() is None
    assert cfg.legacy_install_detected() is False


def test_legacy_install_detected_only_before_the_first_login(clean_env):
    _plant_legacy(clean_env)
    assert cfg.legacy_install_detected() is True
    cfg.save_config(cfg.CliConfig(session_token="new"))
    assert cfg.legacy_install_detected() is False


def test_no_legacy_file_means_no_notice(clean_env):
    assert cfg.legacy_install_detected() is False


# ── The neighbouring roots stay separate ─────────────────────────────────────


def test_the_sdk_spool_root_is_untouched(clean_env, monkeypatch):
    """`~/.agenteye` is a wire contract with the collector, not a preference.

    A save must not create, move or read it — renaming it from this side would
    write events into a directory nothing watches.
    """
    monkeypatch.setenv("AGENTEYE_HOME", str(clean_env / ".agenteye"))
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert not (clean_env / ".agenteye").exists()


# ── Symlinks: we write into a directory full of another product's secrets ────


def test_a_symlinked_config_never_writes_through_to_a_neighbour(clean_env):
    """The bug the move created.

    `O_TRUNC` follows symlinks. A link at `cli-auth.json` pointing at
    `../credentials.json` therefore made `fp login` truncate the Enforcement
    CLI's token and write ours over it — no error, no trace. Harmless while the
    CLI owned `~/.fp` outright; not harmless in a shared home.
    """
    home = clean_env / ".failproofai"
    (home / "fpcli").mkdir(parents=True)
    victim = home / "credentials.json"
    victim.write_text('{"token": "enforcement-cli"}')
    cfg.config_path().symlink_to(victim)

    with pytest.raises(OSError, match="symbolic link"):
        cfg.save_config(cfg.CliConfig(session_token="ours"))

    assert json.loads(victim.read_text())["token"] == "enforcement-cli"


def test_a_dangling_symlinked_config_is_refused_too(clean_env):
    """Not just "does the target matter" — following at all is the bug."""
    (clean_env / ".failproofai" / "fpcli").mkdir(parents=True)
    cfg.config_path().symlink_to(clean_env / "nowhere.json")
    with pytest.raises(OSError, match="symbolic link"):
        cfg.save_config(cfg.CliConfig(session_token="t"))
    assert not (clean_env / "nowhere.json").exists()


def test_the_refusal_does_not_delete_the_link(clean_env):
    """A symlink is something a person put there. Refuse; never clean up."""
    (clean_env / ".failproofai" / "fpcli").mkdir(parents=True)
    target = clean_env / "target.json"
    target.write_text("{}")
    cfg.config_path().symlink_to(target)
    with pytest.raises(OSError):
        cfg.save_config(cfg.CliConfig(session_token="t"))
    assert cfg.config_path().is_symlink()


def test_a_symlinked_fpcli_directory_is_followed(clean_env, tmp_path):
    """Only the FINAL component is guarded. A relocated directory is fine."""
    real = tmp_path / "real-fpcli"
    real.mkdir()
    (clean_env / ".failproofai").mkdir()
    (clean_env / ".failproofai" / "fpcli").symlink_to(real, target_is_directory=True)
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert (real / "cli-auth.json").is_file()


def test_a_config_path_occupied_by_a_directory_raises(clean_env):
    (clean_env / ".failproofai" / "fpcli").mkdir(parents=True)
    cfg.config_path().mkdir()
    with pytest.raises(OSError):
        cfg.save_config(cfg.CliConfig(session_token="t"))
    assert cfg.config_path().is_dir()


def test_a_broken_symlinked_home_raises_rather_than_writing_elsewhere(clean_env, tmp_path):
    (clean_env / ".failproofai").symlink_to(tmp_path / "does-not-exist", target_is_directory=True)
    with pytest.raises(OSError):
        cfg.save_config(cfg.CliConfig(session_token="t"))


# ── Permissions of what we create ────────────────────────────────────────────


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_created_directories_are_not_group_or_world_writable(clean_env):
    """`fpcli/` holds a credential, so it is created `0700` regardless of umask.

    A group-writable directory does not expose the `0600` file inside it, but it
    does let anyone in the group replace that file — which is a session swap.

    The shared parent is deliberately NOT asserted on: when we are the first to
    create `~/.failproofai` we leave it to the umask, exactly as the Enforcement
    CLI would, and when it already exists we must not re-permission a home we do
    not own.
    """
    cfg.save_config(cfg.CliConfig(session_token="t"))
    mode = stat.S_IMODE(os.stat(clean_env / ".failproofai" / "fpcli").st_mode)
    assert not mode & stat.S_IWGRP, f"fpcli/ is group-writable ({oct(mode)})"
    assert not mode & stat.S_IWOTH, f"fpcli/ is world-writable ({oct(mode)})"
    assert not mode & stat.S_IRGRP and not mode & stat.S_IROTH, oct(mode)


def test_an_existing_shared_home_is_never_re_permissioned(clean_env):
    """We hardened `fpcli/`; doing the same to a home we do not own is not ours."""
    home = clean_env / ".failproofai"
    home.mkdir(mode=0o755)
    before = stat.S_IMODE(os.stat(home).st_mode)
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert stat.S_IMODE(os.stat(home).st_mode) == before


def test_an_existing_fpcli_dir_keeps_its_mode(clean_env):
    """`exist_ok=True` must not chmod — a user who widened it chose that."""
    fpcli = clean_env / ".failproofai" / "fpcli"
    fpcli.mkdir(parents=True, mode=0o755)
    before = stat.S_IMODE(os.stat(fpcli).st_mode)
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert stat.S_IMODE(os.stat(fpcli).st_mode) == before


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_an_untraversable_home_raises_and_keeps_its_contents(clean_env):
    home = clean_env / ".failproofai"
    (home / "fpcli").mkdir(parents=True)
    (home / "credentials.json").write_text("keep me")
    home.chmod(0o000)
    try:
        with pytest.raises(OSError):
            cfg.save_config(cfg.CliConfig(session_token="t"))
    finally:
        home.chmod(0o700)
    assert (home / "credentials.json").read_text() == "keep me"


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read any file")
def test_an_unreadable_config_reads_as_logged_out(clean_env):
    """EACCES on read must not crash every command."""
    cfg.save_config(cfg.CliConfig(session_token="t"))
    cfg.config_path().chmod(0o000)
    try:
        assert cfg.load_config().session_token is None
    finally:
        cfg.config_path().chmod(0o600)


# ── Env var shapes ───────────────────────────────────────────────────────────


def test_a_trailing_slash_resolves_to_the_same_file(clean_env, monkeypatch, tmp_path):
    monkeypatch.setenv("FAILPROOFAI_HOME", f"{tmp_path / 'h'}/")
    assert cfg.config_path() == tmp_path / "h" / "fpcli" / "cli-auth.json"


def test_a_relative_env_path_is_taken_relative_to_cwd(clean_env, monkeypatch, tmp_path):
    """Documented behaviour rather than an accident: `Path` does not absolutise."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("FP_HOME", "rel-home")
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert (tmp_path / "rel-home" / "cli-auth.json").is_file()


def test_a_deeply_nested_home_creates_every_parent(clean_env, monkeypatch, tmp_path):
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "a" / "b" / "c" / "d"))
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert cfg.config_path().is_file()


# ── Logout, and concurrency ──────────────────────────────────────────────────


def test_logout_clears_the_session_without_touching_the_shared_home(clean_env):
    home = clean_env / ".failproofai"
    home.mkdir()
    (home / "credentials.json").write_text('{"token": "enforcement-cli"}')
    cfg.save_config(cfg.CliConfig(session_token="t", email="a@b", org="acme",
                                  base_url="https://x", anonymous_id="anon"))
    out = cfg.clear_token(cfg.load_config())

    assert out.session_token is None and out.email is None and out.org is None
    # kept on purpose, so the next login needs no re-configuring
    assert out.base_url == "https://x" and out.anonymous_id == "anon"
    assert json.loads((home / "credentials.json").read_text())["token"] == "enforcement-cli"
    assert cfg.config_path().is_file()


def test_concurrent_saves_leave_valid_json(clean_env):
    """Two `fp` processes can race. Last write wins; a torn file does not."""
    import threading

    errors: list = []

    def writer(n: int) -> None:
        try:
            for _ in range(20):
                cfg.save_config(cfg.CliConfig(session_token=f"tok-{n}"))
        except Exception as exc:  # pragma: no cover - surfaced via `errors`
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert cfg.load_config().session_token.startswith("tok-")


# ── Hard links, atomicity, and the temp file ─────────────────────────────────


def test_a_hard_linked_config_does_not_clobber_its_twin(clean_env):
    """`O_NOFOLLOW` says nothing about hard links — they are not links.

    A hard link is a second NAME for one inode, so an in-place write went
    straight through it into the neighbour's file. `os.replace` swaps the
    directory entry instead, leaving the other name on the old inode.
    """
    home = clean_env / ".failproofai"
    (home / "fpcli").mkdir(parents=True)
    victim = home / "credentials.json"
    victim.write_text('{"token": "enforcement-cli"}')
    os.link(victim, cfg.config_path())

    cfg.save_config(cfg.CliConfig(session_token="ours"))

    assert json.loads(victim.read_text())["token"] == "enforcement-cli"
    assert cfg.load_config().session_token == "ours"


def test_no_temp_file_survives_a_successful_save(clean_env):
    cfg.save_config(cfg.CliConfig(session_token="t"))
    leftovers = [p.name for p in cfg.config_path().parent.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_no_temp_file_survives_a_failed_save(clean_env, monkeypatch):
    """A disk-full or killed write must not strand a credential beside the real one."""
    cfg.save_config(cfg.CliConfig(session_token="original"))
    real_replace = os.replace

    def boom(src, dst):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        cfg.save_config(cfg.CliConfig(session_token="doomed"))
    monkeypatch.setattr(os, "replace", real_replace)

    leftovers = [p.name for p in cfg.config_path().parent.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []
    # and the previous session is still readable — the write never landed
    assert cfg.load_config().session_token == "original"


def test_a_reader_never_sees_a_half_written_file(clean_env):
    """Atomicity, asserted through the only observable that matters.

    The rename is the whole point: a reader either gets the old session or the
    new one, never a splice. Simulated by failing between write and rename,
    which is exactly the window an in-place write left open.
    """
    cfg.save_config(cfg.CliConfig(session_token="v1", email="a@b"))
    before = cfg.config_path().read_text()

    import unittest.mock as mock

    with mock.patch.object(os, "replace", side_effect=OSError(errno.EIO, "io")):
        with pytest.raises(OSError):
            cfg.save_config(cfg.CliConfig(session_token="v2"))

    assert cfg.config_path().read_text() == before
    assert cfg.load_config().session_token == "v1"


def test_concurrent_processes_leave_one_whole_session(clean_env):
    """Threads share a pid; processes do not. Both must land on a valid file."""
    import multiprocessing as mp

    target = str(cfg.config_path().parent)
    ctx = mp.get_context("spawn")
    procs = [ctx.Process(target=_child_writer, args=(i, target)) for i in range(4)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(timeout=60)

    assert all(p.exitcode == 0 for p in procs), [p.exitcode for p in procs]
    assert cfg.load_config().session_token.startswith("proc-")
    leftovers = [p.name for p in cfg.config_path().parent.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


# ── Exotic paths ─────────────────────────────────────────────────────────────


def test_a_path_with_spaces_and_unicode(clean_env, monkeypatch, tmp_path):
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "my home ünïcode 目录"))
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert cfg.load_config().session_token == "t"


def test_a_fifo_in_the_config_position_is_refused(clean_env):
    """A FIFO in the config position must not hang the CLI.

    Measured, not theorised: with the previous in-place `os.open(..., O_TRUNC)`
    this test does not fail, it HANGS — opening a FIFO for writing blocks until
    a reader appears, so `fp login` waits forever with no output. A mutation run
    that removed the temp-and-rename sat here for ten minutes before being
    killed. Writing to a fresh temp file and renaming over the FIFO cannot
    block, because the open never touches the FIFO at all.
    """
    (clean_env / ".failproofai" / "fpcli").mkdir(parents=True)
    try:
        os.mkfifo(cfg.config_path())
    except (AttributeError, OSError):  # pragma: no cover - platform without FIFOs
        pytest.skip("mkfifo unavailable")
    # The rename replaces the directory entry; the FIFO must not be written into.
    cfg.save_config(cfg.CliConfig(session_token="t"))
    assert not stat.S_ISFIFO(os.lstat(cfg.config_path()).st_mode)
    assert cfg.load_config().session_token == "t"


# ── The shipped text must not name the old location ──────────────────────────


def test_no_shipped_module_names_the_pre_move_path():
    """Help text is a docstring, so a stale path compiles, ships and passes.

    This is the same failure the `fp.events` example was: prose that describes
    the product, wrong, with nothing to catch it. Four modules named
    `~/.fp/cli.json` after the move — `login`, `logout` and `orgs switch` all
    print theirs to the user.

    `config.py` is exempt: it is where the legacy path is deliberately named, to
    recognise a pre-move install and say so.
    """
    import fp_cli

    pkg = Path(fp_cli.__file__).parent
    offenders = []
    for path in sorted(pkg.rglob("*.py")):
        if path.name == "config.py":
            continue
        if "~/.fp/cli.json" in path.read_text(encoding="utf-8"):
            offenders.append(str(path.relative_to(pkg)))
    assert offenders == [], f"these still name the pre-move config path: {offenders}"


def test_logout_is_not_undone_by_adoption(clean_env):
    """The sharp edge of adopting: it must not resurrect a session on purpose.

    `logout` writes a config with no token rather than deleting the file, so
    adoption has to key off the file being ABSENT or unreadable — not off "there
    is no token here". Keying off the token would make every command after a
    logout re-adopt `~/.fp/cli.json` and sign the user back in, which is worse
    than the problem adoption solves.
    """
    _plant_legacy(clean_env)
    assert cfg.load_config().session_token == "legacy"  # adopted
    cfg.clear_token(cfg.load_config())                  # `fp logout`
    assert cfg.load_config().session_token is None      # and it stays out


def test_a_current_config_without_a_token_blocks_adoption(clean_env):
    """The same invariant stated directly, without going through logout."""
    _plant_legacy(clean_env)
    cfg.save_config(cfg.CliConfig(base_url="https://x"))  # no token
    loaded = cfg.load_config()
    assert loaded.session_token is None
    assert loaded.base_url == "https://x"

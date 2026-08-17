"""The spool root selects the failproofai umbrella only on an explicit opt-in.

The rule these tests exist to hold: a spool is worthless unless a daemon reads
it, and the presence of the umbrella DIRECTORY does not imply the presence of a
daemon that watches it.

Two daemons read this spool and they do not read the same roots. ``failproofaid``
— shipped from this repository, ``crates/fpai-collect/src/config.rs`` — watches
both. The older ``agenteye-collector``, in the private AgentEye repository, reads
``$AGENTEYE_HOME`` or ``~/.agenteye`` and nothing else. So selecting the umbrella
on a host running that one is silent data loss, which is why it stays opt-in even
though the path itself is now verifiable against the daemon next door
(``test_spool_contract.py``).
"""
import os
from pathlib import Path
import pytest
from failproofai_sdk import _resolver

OPT_IN = _resolver.SPOOL_OPT_IN_ENV


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    _resolver.set_base_dir(None)
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
    monkeypatch.delenv("FAILPROOFAI_HOME", raising=False)
    monkeypatch.delenv(OPT_IN, raising=False)
    yield
    _resolver.set_base_dir(None)


def test_falls_back_to_agenteye_when_no_failproofai(tmp_path, monkeypatch):
    # The critical default. Writing to the failproofai home on a machine with
    # no failproofai would drop events where nothing watches — silent loss,
    # invisible because an empty spool looks exactly like an idle one.
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


def test_umbrella_alone_is_not_enough(tmp_path, monkeypatch):
    """THE REGRESSION TEST. The directory existing must change nothing.

    This is the case that shipped: installing failproofai beside a normal
    agenteye-collector creates this directory, and the SDK used to follow it —
    moving every batch somewhere the running collector never looks, with no
    error on either side.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".failproofai" / "custom-agents").mkdir(parents=True)
    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


@pytest.mark.parametrize("truthy", ["1", "true", "TRUE", "yes", "on"])
def test_opt_in_selects_the_umbrella(tmp_path, monkeypatch, truthy):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".failproofai" / "custom-agents").mkdir(parents=True)
    monkeypatch.setenv(OPT_IN, truthy)
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


@pytest.mark.parametrize("falsy", ["", "0", "false", "no", "off", "maybe"])
def test_non_truthy_opt_in_keeps_the_default(tmp_path, monkeypatch, falsy):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".failproofai" / "custom-agents").mkdir(parents=True)
    monkeypatch.setenv(OPT_IN, falsy)
    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


def test_opt_in_without_the_directory_keeps_the_default(tmp_path, monkeypatch):
    # Opting in on a host where failproofai is not actually installed must not
    # invent the directory — that would be the original bug with extra steps.
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv(OPT_IN, "1")
    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


def test_env_override_beats_the_umbrella(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".failproofai" / "custom-agents").mkdir(parents=True)
    monkeypatch.setenv(OPT_IN, "1")
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "explicit"))
    assert _resolver.get_base_dir() == tmp_path / "explicit"


def test_set_base_dir_beats_everything(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".failproofai" / "custom-agents").mkdir(parents=True)
    monkeypatch.setenv(OPT_IN, "1")
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "env"))
    _resolver.set_base_dir(tmp_path / "explicit")
    assert _resolver.get_base_dir() == tmp_path / "explicit"


def test_failproofai_home_env_is_honoured(tmp_path, monkeypatch):
    # Must match fp-home.ts and fpai-collect, or the SDK writes where the
    # daemon never reads.
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv(OPT_IN, "1")
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "custom-fp"))
    (tmp_path / "custom-fp" / "custom-agents").mkdir(parents=True)
    assert _resolver.get_base_dir() == tmp_path / "custom-fp" / "custom-agents"

"""The spool root IS the failproofai umbrella, and no environment can move it out.

This file used to assert the opposite, and the reason it flipped is worth
keeping: the umbrella was previously behind an ``AGENTEYE_SPOOL_TO_FAILPROOFAI``
opt-in that ALSO required ``~/.failproofai/custom-agents`` to already exist.
Nothing ever created that directory — not this SDK, not ``failproofaid``, not
either installer — so the second condition was never satisfied and the opt-in
never fired once. It was documented, tested, and dead.

The rule now: the SDK ships beside ``failproofaid``, which watches BOTH roots,
so on any host running it the default is a no-op that only changes which
directory the files appear in. The old root keeps being watched indefinitely, so
an unupgraded SDK keeps working and batches already spooled there still drain.

The case that genuinely breaks is a host running the OLDER
``agenteye-collector``, which resolves ``$AGENTEYE_HOME`` or ``~/.agenteye`` and
nothing else.

``AGENTEYE_HOME`` USED TO BE THAT HOST'S ESCAPE HATCH, AND NO LONGER IS. It sat
above the default in resolution, so it could aim this SDK anywhere from the
environment — including as a side effect of an operator exporting it for the
collector, which is the component that actually reads it. A redirect that
silent is not a good property for the one variable named after a product this
package no longer belongs to. Resolution is now exactly `set_base_dir()` then
the umbrella, and the bridges for that host are listed in
``_resolver.get_base_dir``: run ``failproofaid`` (it watches both roots), point
the COLLECTOR at the umbrella, or call ``set_base_dir()`` explicitly.
"""
from pathlib import Path

import pytest

from failproofai_sdk import _resolver


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    _resolver.set_base_dir(None)
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
    monkeypatch.delenv("FAILPROOFAI_HOME", raising=False)
    yield
    _resolver.set_base_dir(None)


# ─────────────────────────────────────────────────────────────────────────────
# The default
# ─────────────────────────────────────────────────────────────────────────────


def test_the_default_is_the_failproofai_umbrella(tmp_path, monkeypatch):
    """THE CHANGE. A clean machine writes to the umbrella, with nothing set."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


def test_the_umbrella_does_not_have_to_exist_first(tmp_path, monkeypatch):
    """The regression that made the old opt-in dead.

    Requiring the directory to pre-exist means it can never be the place a first
    batch is written — nothing creates it, so the branch is unreachable. The
    writer mkdirs what it is about to write into, so resolution must not care.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    assert not (tmp_path / ".failproofai").exists()
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


def test_an_existing_legacy_root_does_not_drag_the_default_back(tmp_path, monkeypatch):
    """Presence of ``~/.agenteye`` is not a vote.

    It exists on any machine that merely ran the old CLI once — it holds that
    CLI's `cli.json` — so treating it as a signal would pin those machines to
    the old path forever despite no collector ever having watched it.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".agenteye" / "events").mkdir(parents=True)
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


# ─────────────────────────────────────────────────────────────────────────────
# The retired escape hatch — these assert that it is inert, not that it works
# ─────────────────────────────────────────────────────────────────────────────


def test_agenteye_home_cannot_drag_the_spool_back_to_the_legacy_root(tmp_path, monkeypatch):
    """THE CHANGE. Exporting it does nothing to this SDK any more.

    This is the assertion that makes the guarantee testable: whatever is in the
    environment, this package writes inside the umbrella. An operator exporting
    ``AGENTEYE_HOME`` for ``agenteye-collector`` — the component that still
    reads it — no longer moves this SDK's spool as a side effect.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / ".agenteye"))
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


def test_agenteye_home_cannot_point_the_spool_anywhere_else_either(tmp_path, monkeypatch):
    """Not just the legacy root — the variable has no effect at all."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "somewhere" / "else"))
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


def test_an_empty_agenteye_home_is_ignored_rather_than_resolving_to_cwd(tmp_path, monkeypatch):
    """``AGENTEYE_HOME=`` in a CI env file must not spool into the repo.

    Kept although the variable is no longer read: an empty value was the shape
    most likely to resolve to a relative path, and the test costs nothing.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("AGENTEYE_HOME", "")
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


def test_no_environment_variable_can_take_the_spool_outside_the_umbrella(tmp_path, monkeypatch):
    """The guarantee in one line: FAILPROOFAI_HOME MOVES the umbrella, and the
    ``custom-agents`` segment is appended unconditionally, so there is no
    environment in which this SDK writes somewhere that is not inside it."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "relocated"))
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "hijack"))
    resolved = _resolver.get_base_dir()
    assert resolved == tmp_path / "relocated" / "custom-agents"
    assert resolved.name == "custom-agents"


# ─────────────────────────────────────────────────────────────────────────────
# Precedence and the umbrella path itself
# ─────────────────────────────────────────────────────────────────────────────


def test_set_base_dir_beats_every_environment_variable(tmp_path, monkeypatch):
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "env"))
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "legacy"))
    _resolver.set_base_dir(tmp_path / "explicit")
    assert _resolver.get_base_dir() == tmp_path / "explicit"


def test_set_base_dir_is_the_only_way_to_choose_the_legacy_root(tmp_path, monkeypatch):
    """Still possible, but only as an explicit, visible call.

    That is the whole trade: the destination stays reachable for anyone who
    genuinely wants it, and reaching it now requires saying so at the call site
    rather than inheriting somebody else's environment.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    _resolver.set_base_dir(tmp_path / ".agenteye")
    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


def test_failproofai_home_moves_the_umbrella(tmp_path, monkeypatch):
    """Mirrors ``FAILPROOFAI_HOME`` in fp-home.ts; containers rely on it."""
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "elsewhere"))
    assert _resolver.get_base_dir() == tmp_path / "elsewhere" / "custom-agents"


def test_the_retired_opt_in_variable_no_longer_exists():
    """It was the entry point to the dead branch; leaving it would mislead.

    Anyone who exported it wanted the umbrella and now gets it by default, so
    removing it changes no behaviour for them — only the docs they read.
    """
    assert not hasattr(_resolver, "SPOOL_OPT_IN_ENV")


def test_the_retired_opt_in_variable_has_no_effect_if_someone_still_exports_it(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("AGENTEYE_SPOOL_TO_FAILPROOFAI", "0")
    assert _resolver.get_base_dir() == tmp_path / ".failproofai" / "custom-agents"


def test_the_legacy_root_is_still_spelled_somewhere_findable(tmp_path, monkeypatch):
    """The migration notes and the escape hatch both name it; one definition."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    assert _resolver.legacy_agenteye_dir() == tmp_path / ".agenteye"

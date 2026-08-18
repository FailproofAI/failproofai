"""Persistent CLI configuration at ``~/.failproofai/fpcli/cli-auth.json`` (mode 0600).

This used to be ``~/.fp/cli.json`` — a third top-level dotfile beside
``~/.failproofai`` (the Enforcement CLI) and ``~/.agenteye`` (the SDK and
collector's event spool). One product owning three home directories is one more
than anybody can keep track of, so the CLI moved under the failproofai home.
``~/.agenteye`` stays where it is: it is a wire contract with the collector, not
a preference (see the SDK's ``test_server_contract.py``).

The failproofai home is a governed layout, NOT a free directory. Its shape is
declared in one place — ``src/hooks/fp-home.ts`` in this repo, mirrored for the
daemon in ``crates/failproofaid/src/paths.rs`` — and that file's rule is that
nothing outside it may join a path onto the home. So ``fpcli/cli-auth.json`` is
registered there too, classified ``user-typed`` in ``HOME_CLASSES``. That
classification is what keeps it: a layout migration deletes only ``derived`` and
``refetchable`` paths, and ``resettablePaths()`` is a filter over that table
rather than a hand-written list. It follows ``audit/session.json``, which is the
same thing for the audit tool and is likewise TS-side only — the daemon never
opens a human credential.

We only ever create. ``mkdir(parents=True, exist_ok=True)`` will bring
``~/.failproofai`` into existence on a machine that has never run the
Enforcement CLI, and leaves a populated one exactly as it found it. Nothing here
removes or rewrites a path it does not own.

The move is invisible to the user: a session at the old path is adopted on the
next command, so nobody is signed out by an upgrade. The old file is copied, not
moved, which keeps a downgrade working — an older `fp` still finds its session
where it left it.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# The dashboard the CLI talks to when nothing else says otherwise. Resolution is
# always explicit flag/env (`--base-url` / `FP_DASHBOARD_URL`) > saved config
# (`~/.failproofai/fpcli/cli-auth.json`) > this default, so a fresh install points at the hosted
# product with zero configuration, while a self-hosted or dev user overrides it
# once (at login, or per command) and never thinks about it again.
# NOT stored in `CliConfig` — a saved config with no `base_url` still reads back
# as `None`; the default is applied only when resolving the effective URL.
DEFAULT_BASE_URL = "https://app.befailproof.ai"


#: The CLI's own directory inside the failproofai home. Mirrors ``fpcliDir`` in
#: ``src/hooks/fp-home.ts`` — change one, change the other; nothing checks.
FPCLI_SUBDIR = "fpcli"

#: Kept only to recognise a pre-move install. Never read, never written, never
#: deleted: see :func:`legacy_config_path`.
LEGACY_DIR_NAME = ".fp"
LEGACY_FILE_NAME = "cli.json"


def base_dir() -> Path:
    """Where ``cli-auth.json`` lives.

    ``$FP_HOME`` (the CLI's own variable, and the one the docs have always
    named) wins, so an existing override keeps working untouched. Otherwise
    ``$FAILPROOFAI_HOME`` — the variable the rest of the failproofai home
    already honours, which containers and tests routinely set — and finally
    ``~/.failproofai/fpcli``.

    Both env vars name a DIRECTORY that the config file sits directly in.
    ``FAILPROOFAI_HOME`` points at the home root, so the subdirectory is
    appended; ``FP_HOME`` points at the CLI's own directory and is used as-is,
    which is what it meant before the move.
    """
    override = os.environ.get("FP_HOME")
    if override:
        return Path(override)
    fp_home = os.environ.get("FAILPROOFAI_HOME")
    if fp_home:
        return Path(fp_home) / FPCLI_SUBDIR
    return Path.home() / ".failproofai" / FPCLI_SUBDIR


def config_path() -> Path:
    return base_dir() / "cli-auth.json"


def legacy_config_paths() -> list[Path]:
    """Every place a pre-move session could still be sitting.

    Two, not one, and the second is the one that is easy to miss. The move
    changed the FILENAME as well as the directory, so somebody who exported
    ``FP_HOME`` — the documented way to relocate this config, and the shape CI
    images use — has their old session at ``$FP_HOME/cli.json`` and will never
    own a ``~/.fp`` at all. Checking only the default would hand exactly those
    users an unexplained logout, which is the group least able to shrug at one.

    A session found here is COPIED to the new location on the next command and
    the original is left alone — see :func:`load_config`. Copying rather than
    moving keeps a downgrade working: an older `fp` still finds its session.

    The relocated path is checked FIRST. When both exist, the one in the
    directory this invocation actually resolved is the one that explains this
    user's logout; naming the default instead sends somebody with ``FP_HOME``
    set to delete an unrelated file on a machine they may share.
    """
    candidates = [base_dir() / LEGACY_FILE_NAME]
    # `~/.fp` is only a candidate when the user has NOT redirected the config.
    # Someone who exported `FP_HOME` said where their config lives; reaching past
    # that into the home directory would adopt a session from a different context
    # — a different tenant, or another user's leftovers on a shared box — and is
    # also how this fallback quietly picked up the developer's own login when the
    # suite ran.
    if not os.environ.get("FP_HOME"):
        default = Path.home() / LEGACY_DIR_NAME / LEGACY_FILE_NAME
        if default not in candidates:
            candidates.append(default)
    return candidates


def legacy_config_path() -> Optional[Path]:
    """The first pre-move session file that actually exists, if any."""
    for path in legacy_config_paths():
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def legacy_install_detected() -> bool:
    """True when a pre-move session is on disk and the new one is not.

    False once the new config exists, so the notice stops after the first
    successful `fp login` rather than nagging forever.
    """
    try:
        if config_path().is_file():
            return False
    except OSError:
        return False
    return legacy_config_path() is not None


@dataclass
class CliConfig:
    base_url: Optional[str] = None
    session_token: Optional[str] = None
    expires_at: Optional[str] = None  # ISO 8601, e.g. 2026-05-26T12:00:00Z
    email: Optional[str] = None
    user_id: Optional[str] = None
    insecure: bool = False
    org: Optional[str] = None  # active tenant slug, chosen at login (multi-tenant)
    anonymous_id: Optional[str] = None  # stable per-machine id for anonymous telemetry


def _parse(path: Path) -> Optional[CliConfig]:
    """Read one config file, or ``None`` if it is missing/unreadable/not ours."""
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return _from_dict(data)


def load_config() -> CliConfig:
    """Load the session, adopting a pre-move one the first time we see it.

    The move is silent for the user: nobody is signed out, no command changes
    behaviour, and CI that authenticates by env var never enters this path at
    all. The adoption is a copy — the old file is left exactly where it is, so
    downgrading to a previous `fp` finds its session intact and this is
    reversible on the machine as well as in the release.

    Adoption is best-effort by design. If the new location cannot be written
    (read-only home, a symlink we refuse, a full disk) the caller still gets the
    session that was found, so a machine that cannot be migrated keeps working
    rather than being logged out by our own housekeeping.
    """
    current = _parse(config_path())
    if current is not None:
        return current

    for legacy in legacy_config_paths():
        adopted = _parse(legacy)
        if adopted is None:
            continue
        try:
            save_config(adopted)
        except OSError:
            pass  # unwritable target: still hand back the session we found
        return adopted

    return CliConfig()


def _from_dict(data: dict) -> CliConfig:
    return CliConfig(
        base_url=data.get("base_url"),
        session_token=data.get("session_token"),
        expires_at=data.get("expires_at"),
        email=data.get("email"),
        user_id=data.get("user_id"),
        insecure=bool(data.get("insecure", False)),
        org=data.get("org"),
        anonymous_id=data.get("anonymous_id"),
    )


def save_config(cfg: CliConfig) -> None:
    """Write the session atomically, owner-only, without following any link.

    Both halves of this matter only because the file now sits in a directory
    another product's secrets live in. Writing in place was fine when the CLI
    owned ``~/.fp`` outright; beside ``credentials.json`` it is a way to destroy
    someone else's token.

    * A **symlink** at ``cli-auth.json`` is refused outright. It is not removed:
      a link is something a person put there, and replacing it silently is the
      behaviour this function exists to avoid.
    * A **hard link** cannot be detected the same way — it is not a link, it is a
      second name for one inode, so ``O_NOFOLLOW`` says nothing about it. Writing
      to a temporary file and ``os.replace``-ing it into position is what
      actually answers this: rename swaps the DIRECTORY ENTRY, so the other name
      keeps the old inode and the neighbour's file is untouched.

    The same rename gives two things worth having on their own: a reader never
    observes a half-written credential, and two ``fp`` processes racing end with
    one of the two sessions rather than a splice of both.
    """
    path = config_path()
    # `mode` applies to the LEAF only, which is exactly the split we want: our
    # own directory is created `0700` because it holds a credential, while a
    # `~/.failproofai` we happen to be the first to create is left to the user's
    # umask — the same shape the Enforcement CLI would have made it. An existing
    # directory keeps its mode either way: `exist_ok=True` does not chmod, and
    # re-permissioning a home another product owns is not ours to do.
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    # `lstat`, not `exists`: the question is what the NAME is, not what it leads
    # to. A dangling link must be refused too, or the refusal depends on whether
    # the attacker's target happens to exist yet.
    try:
        if stat.S_ISLNK(os.lstat(path).st_mode):
            raise OSError(
                errno.ELOOP,
                f"{path} is a symbolic link. Refusing to write the session "
                "through it — that would overwrite whatever it points at, and "
                "this directory is shared with the Enforcement CLI. Remove the "
                "link and run the command again.",
            )
    except FileNotFoundError:
        pass  # the ordinary first-login case

    payload = json.dumps(asdict(cfg), indent=2) + "\n"
    # Same directory, so the rename is on one filesystem and therefore atomic.
    #
    # `mkstemp` rather than a name built from the pid: two THREADS share a pid,
    # so a pid-derived name collided under `O_EXCL` and turned a concurrent
    # `save_config` into a crash. It also creates `0600` and `O_EXCL` itself,
    # which is the same guarantee hand-rolled with fewer ways to get it wrong.
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())  # survive a crash between write and rename
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        # Never leave a stray credential behind on the failure paths.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def clear_token(cfg: CliConfig) -> CliConfig:
    """Clear the whole logged-in session and persist.

    Drops everything tied to *who* was signed in — token, expiry, email, user id,
    and the active org/tenant — so a logout leaves no stale identity (and the next
    `login` starts the org picker fresh, with no remembered tenant). Kept on
    purpose: `base_url` and the `insecure` TLS preference (so the next login
    doesn't need them re-specified) and the machine-stable `anonymous_id`.
    """
    cfg.session_token = None
    cfg.expires_at = None
    cfg.email = None
    cfg.user_id = None
    cfg.org = None
    save_config(cfg)
    return cfg


def _parse_iso(value: str) -> datetime:
    # Python 3.10's fromisoformat does not accept a trailing 'Z'.
    normalized = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def is_expired(cfg: CliConfig, *, skew_secs: int = 60, now: Optional[datetime] = None) -> bool:
    """True if there is no usable, unexpired token (with a safety skew)."""
    if not cfg.session_token or not cfg.expires_at:
        return True
    try:
        expires = _parse_iso(cfg.expires_at)
    except ValueError:
        return True
    now = now or datetime.now(timezone.utc)
    return now >= expires - timedelta(seconds=skew_secs)

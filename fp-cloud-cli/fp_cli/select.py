"""Interactive selection helpers (TTY pickers), shared across commands.

Kept in one place so the org picker used at ``login`` and at ``orgs switch`` reads
and behaves identically. Pure presentation + input; no network, no persistence.
"""

from __future__ import annotations

import os
import sys
from typing import List, Optional, Sequence

from . import output


def stdin_is_tty() -> bool:  # noqa: D401
    """True iff stdin is an interactive terminal (so we may prompt for a choice).

    Factored out so it can be stubbed in tests — the CliRunner's stdin is not a
    TTY, so the interactive pickers are otherwise unreachable under test.
    """
    try:
        return sys.stdin.isatty()
    except Exception:
        return False


def choose_org(slugs: Sequence[str], default: Optional[str] = None) -> str:
    """Render ``slugs`` and prompt until the user picks one (by slug or number).

    ``default`` (only if it is one of ``slugs``) is the Enter-to-keep choice and is
    marked ``· current`` in the list. Re-prompts on any out-of-range / unknown input,
    so the return value is always one of ``slugs`` — a non-member slug can never be
    selected through the picker.
    """
    slugs = list(slugs)
    output.org_picker(slugs, current=default)
    prompt_default = default if (default in slugs) else None
    while True:
        choice = str(output.prompt("org", default=prompt_default)).strip()
        if choice in slugs:
            return choice
        if choice.isdigit() and 1 <= int(choice) <= len(slugs):
            return slugs[int(choice) - 1]
        output.warn(f"  '{choice}' is not one of your orgs — try again.")


# ── orgs switch — arrow-key picker (raw mode) + numbered fallback ─────────────


def _supports_raw_picker() -> bool:
    """True iff we can run the raw-mode arrow picker: a real interactive TTY on both stdin
    (we read keys) and stderr (we draw the menu), and POSIX ``termios`` is importable.
    Anything else — pipes, CI, the test runner, Windows — falls back to the numbered prompt
    (so the picker never hangs or crashes off a TTY, per the handoff spec §3/§7)."""
    try:
        import termios  # noqa: F401
    except Exception:
        return False
    try:
        return bool(sys.stdin.isatty() and sys.stderr.isatty())
    except Exception:
        return False


def _read_key(fd: int) -> str:
    """Read one logical keypress from a raw-mode ``fd`` → a token: ``UP``/``DOWN``/``ENTER``/
    ``ESC``/``EOF`` or the raw character. Distinguishes a lone Esc from an arrow escape
    sequence (``\\x1b[A``) with a tiny ``select`` timeout so Esc never blocks."""
    import select as _sel

    ch = os.read(fd, 1)
    if not ch:
        return "EOF"
    if ch == b"\x1b":  # Esc, or the start of an arrow escape sequence
        r, _, _ = _sel.select([fd], [], [], 0.0008)
        if not r:
            return "ESC"
        seq = os.read(fd, 2)
        return {b"[A": "UP", b"[B": "DOWN", b"[C": "RIGHT", b"[D": "LEFT"}.get(seq, "ESC")
    if ch in (b"\r", b"\n"):
        return "ENTER"
    if ch == b"\x03":  # Ctrl-C (also raised as KeyboardInterrupt under cbreak)
        return "CTRL_C"
    return ch.decode("utf-8", "ignore")


def _numbered_pick(orgs: Sequence[dict], *, current: Optional[str]) -> str:
    """Non-TTY fallback: a boxed numbered list + a typed choice (slug or number). Re-prompts on
    bad input, so the return is always one of the orgs' slugs. Default is the current org. With
    no input at all (closed/empty stdin, e.g. CI) the prompt aborts → a clean usage error so the
    run never hangs."""
    import typer

    from . import _click_compat as click  # the Click Typer is running

    slugs: List[str] = [o["slug"] for o in orgs]
    output.render_org_picker_numbered(orgs, current=current)
    default = current if current in slugs else None
    while True:
        try:
            choice = str(output.prompt("org", default=default)).strip()
        except (click.Abort, EOFError):
            raise typer.BadParameter(
                "No org selected and no interactive terminal. "
                "Pass a slug, e.g. `fp orgs switch <slug>`."
            )
        if choice in slugs:
            return choice
        if choice.isdigit() and 1 <= int(choice) <= len(slugs):
            return slugs[int(choice) - 1]
        output.warn(f"  '{choice}' is not one of your orgs — try again.")


def choose_org_interactive(orgs: Sequence[dict], *, current_slug: Optional[str] = None) -> Optional[str]:
    """Pick an org to switch to. ``orgs`` is a list of ``{"slug", "is_current"}`` dicts. Returns
    the chosen slug, or ``None`` if the user cancelled (Esc / Ctrl-C). On a real TTY this is an
    in-place arrow-key menu (cursor starts on the current org); otherwise it falls back to a
    numbered prompt (which can't cancel — it always returns a slug)."""
    orgs = list(orgs)
    if not _supports_raw_picker():
        return _numbered_pick(orgs, current=current_slug)

    import termios
    import tty

    from rich.live import Live

    idx = next((i for i, o in enumerate(orgs) if o.get("is_current")), 0)
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        with Live(output.org_picker_frame(orgs, idx), console=output._stderr,
                  auto_refresh=False, transient=True) as live:
            while True:
                key = _read_key(fd)
                if key in ("UP", "k"):
                    idx = (idx - 1) % len(orgs)
                elif key in ("DOWN", "j"):
                    idx = (idx + 1) % len(orgs)
                elif key == "ENTER":
                    return orgs[idx]["slug"]
                elif key in ("ESC", "CTRL_C", "q", "EOF"):
                    return None
                else:
                    continue
                live.update(output.org_picker_frame(orgs, idx))
                live.refresh()
    except KeyboardInterrupt:
        return None
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


# ── login — the single-box interactive flow (one Live panel, raw-mode in-box input) ──


class LoginCancelled(Exception):
    """The user pressed Esc / Ctrl-C during the login flow (calm cancel, not an error)."""


def login_box_supported() -> bool:
    """True iff the single-box interactive login can run (real TTY on stdin+stderr + termios) —
    otherwise ``login`` uses the plain prompt flow (tests, pipes, CI, ``--json``)."""
    return _supports_raw_picker()


class LoginBox:
    """Drives the single-box ``login``: ONE Rich ``Live`` panel redrawn in place as steps advance.
    email/code are read in **raw mode** (echo off) and rendered INSIDE the frame; the org step is the
    shared arrow picker as a nested inset. Restores the terminal on exit. Used only on a real TTY —
    the non-interactive path keeps the plain prompts."""

    def __init__(self) -> None:
        self.done: List = []      # collapsed ✓ steps: (label, value)
        self.active: Optional[str] = None
        self._fd = sys.stdin.fileno()
        self._old = None
        self._live = None

    def __enter__(self) -> "LoginBox":
        import termios
        import tty

        from rich.live import Live

        self._old = termios.tcgetattr(self._fd)
        tty.setcbreak(self._fd)  # canonical + echo off, signals on (Ctrl-C → KeyboardInterrupt)
        self._live = Live(output.render_login_frame(self.done, None), console=output._stderr,
                          auto_refresh=False, transient=False)
        self._live.__enter__()
        return self

    def __exit__(self, *exc) -> None:
        import termios

        try:
            if self._live is not None:
                self._live.__exit__(*exc)
        finally:
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old)

    def _draw(self, **kw) -> None:
        self._live.update(output.render_login_frame(self.done, self.active, **kw))
        self._live.refresh()

    def _read_line(self, *, helper, slots, error) -> str:
        """Read one line in raw mode, redrawing the frame on every keystroke so the typed text
        appears INSIDE the box (echo is off). Backspace edits; Enter accepts; Esc / Ctrl-C / EOF
        cancel (an arrow escape-sequence mid-type is swallowed, not a cancel). A ``slots`` field
        accepts digits only, capped at ``slots``."""
        import select as _sel

        buf = ""
        self._draw(active_value=buf, active_slots=slots, helper=helper, error=error)
        while True:
            try:
                ch = os.read(self._fd, 1)
            except KeyboardInterrupt:
                raise LoginCancelled()
            if not ch:
                raise LoginCancelled()
            if ch in (b"\r", b"\n"):
                return buf
            if ch == b"\x03":  # Ctrl-C as a byte (if signals were off)
                raise LoginCancelled()
            if ch == b"\x1b":  # Esc, or the start of an arrow escape sequence
                r, _, _ = _sel.select([self._fd], [], [], 0.0008)
                if r:
                    os.read(self._fd, 2)  # swallow the arrow/sequence — don't cancel mid-type
                    continue
                raise LoginCancelled()
            if ch in (b"\x7f", b"\x08"):  # backspace / delete
                buf = buf[:-1]
                self._draw(active_value=buf, active_slots=slots, helper=helper, error=None)
                continue
            try:
                c = ch.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if not c.isprintable():
                continue
            if slots and (not c.isdigit() or len(buf) >= slots):
                continue  # the code field is digits-only, capped
            buf += c
            self._draw(active_value=buf, active_slots=slots, helper=helper, error=None)

    def text_step(self, label: str, *, helper=None, slots=None, validate=None,
                  error_msg=None, hidden_value: bool = False, collapse: bool = True,
                  initial_error=None) -> str:
        """Run one bright ``❯ {label}`` input step; on a failed ``validate`` show the error sub-line
        and re-prompt. On accept it collapses to a dim ``✓ {label} {value}`` line (the value is
        omitted when ``hidden_value``). With ``collapse=False`` it returns the value WITHOUT adding
        the ✓ line (the caller verifies it over the network first, then calls ``note``); ``initial_error``
        seeds the error sub-line on the first draw (a re-prompt after a wrong code)."""
        self.active = label
        error = initial_error
        while True:
            buf = self._read_line(helper=helper, slots=slots, error=error).strip()
            if validate is None or validate(buf):
                self.active = None
                if collapse:
                    self.done.append((label, "" if hidden_value else buf))
                self._draw()
                return buf
            error = error_msg or "that doesn't look right"

    def note(self, label: str, value=None) -> None:
        """Add a completed ✓ line that wasn't an input step (e.g. ``✓ code sent``)."""
        self.done.append((label, value))
        self._draw()

    def working(self, text: str) -> None:
        """Show a transient dim ``· {text}`` line (e.g. while a network call runs)."""
        self._draw(note=text)

    def retry_text(self, message: str) -> None:
        """Re-arm the code step with an error sub-line (used after a wrong code)."""
        # text_step's own loop shows the error; this is for the verify-fail re-prompt path.
        self._draw(error=message)

    def pick(self, slugs: Sequence[str], *, default: Optional[str] = None) -> str:
        """The nested org-picker inset: arrow keys move the cursor, Enter selects (collapses to
        ``✓ org {slug}``), Esc / Ctrl-C raise ``LoginCancelled``."""
        slugs = list(slugs)
        idx = slugs.index(default) if default in slugs else 0
        self.active = None
        self._draw(inset=output.login_inset(slugs, idx))
        while True:
            try:
                key = _read_key(self._fd)
            except KeyboardInterrupt:
                raise LoginCancelled()
            if key in ("UP", "k"):
                idx = (idx - 1) % len(slugs)
            elif key in ("DOWN", "j"):
                idx = (idx + 1) % len(slugs)
            elif key == "ENTER":
                chosen = slugs[idx]
                self.done.append(("org", chosen))
                self._draw()
                return chosen
            elif key in ("ESC", "CTRL_C", "q", "EOF"):
                raise LoginCancelled()
            else:
                continue
            self._draw(inset=output.login_inset(slugs, idx))

    def finish(self, email: str, org: Optional[str]) -> None:
        """Final state: the outer border + legend flip SUCCESS green; ``● signed in`` + email + org."""
        self._draw(signed_in=(email, org))

    def cancel(self, persisted: bool) -> None:
        """Render the calm close — ``○ cancelled — not signed in`` (or ``○ signed in · pick an org …``
        when the session was already persisted)."""
        self._draw(cancelled=bool(persisted))

    def fail(self, message: str, hint: Optional[str] = None) -> None:
        """Render a failure INSIDE the box (red border + ``✗ {message}`` + an optional hint) — e.g.
        a wrong/expired code — instead of a separate error box below the frame."""
        self._draw(failed=(message, hint))

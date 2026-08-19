"""Rendering helpers.

Data goes to **stdout** (a JSON document with ``--json``, or a Rich table for
humans). Human chatter — status lines, hints, errors — goes to **stderr**, so
``--json`` stdout is always clean and machine-parseable.
"""

from __future__ import annotations

import contextlib
import dataclasses
import json as _json
import math
import re
from datetime import datetime, timezone
from typing import Any, List, Optional, Sequence

import typer
from rich.box import ROUNDED, SIMPLE_HEAD
from rich.console import Console, Group
from rich.padding import Padding
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

from . import theme

_stdout = Console()
_stderr = Console(stderr=True)
_quiet = False
_no_color = False
_json_out = False


def configure(*, no_color: bool = False, quiet: bool = False, json: bool = False) -> None:
    """Reconfigure the consoles from the resolved global flags."""
    global _stdout, _stderr, _quiet, _no_color, _json_out
    _stdout = Console(no_color=no_color)
    _stderr = Console(stderr=True, no_color=no_color)
    _quiet = quiet
    _no_color = no_color
    _json_out = json


def is_json() -> bool:
    """Whether the active invocation requested ``--json`` (set by :func:`configure`).

    Lets the single error chokepoint in ``app.py`` decide between a JSON error envelope
    (stdout) and the human red box (stderr) without threading ``AppState`` into Click's
    exception renderer.
    """
    return _json_out


@contextlib.contextmanager
def thinking(label: str = "thinking…", *, enabled: bool = True):
    """A themed braille spinner on **stderr** while a slow call runs (e.g. the assistant
    streaming its reply, which otherwise looks hung). A no-op when ``enabled`` is False,
    ``--quiet`` is set, or stderr isn't a TTY — so piped / scripted / ``--json`` output stays
    clean (data on stdout is never touched)."""
    if not enabled or _quiet or not _stderr.is_terminal:
        yield
        return
    with _stderr.status(Text(label, style=theme.ACCENT), spinner="dots", spinner_style=theme.ACCENT):
        yield


def _ansi(text: str, **style: Any) -> str:
    """A click-styled string for use in input prompts, or plain when colour is off."""
    if _no_color:
        return text
    return typer.style(text, **style)


def prompt(label: str, *, default: Optional[str] = None, hide_input: bool = False) -> str:
    """A styled, indented input prompt on stderr — `❯ label  <input>` — so prompts share
    the indentation/accent of the status lines. Wraps ``typer.prompt`` unchanged, so the
    input mechanism (and the CliRunner test input) behaves exactly as before."""
    # Pad the label so the typed values line up across email / code / org.
    text = _ansi("  ❯ ", fg=_ACCENT, bold=True) + _ansi(label.ljust(5), bold=True)
    kwargs: dict = {"err": True, "prompt_suffix": " ", "hide_input": hide_input}
    if default is not None:
        kwargs["default"] = default
    return typer.prompt(text, **kwargs)


def _json_default(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return str(obj)


def _json_safe(obj: Any) -> Any:
    """Map non-finite floats (NaN/Infinity) to ``null`` so the output is always valid JSON.

    A single ``NaN`` from a server aggregate would otherwise make ``emit_json`` print a
    bare ``NaN`` token that breaks ``jq`` / ``JSON.parse`` for any consumer. Walks dicts,
    lists and dataclasses (flattening the latter the same way ``_json_default`` would).
    """
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return _json_safe(dataclasses.asdict(obj))
    return obj


def emit_json(obj: Any) -> None:
    """Write a JSON document to stdout (no Rich markup interpretation).

    Non-finite floats are coerced to ``null`` and ``allow_nan=False`` is a backstop, so the
    document is always parseable by standard JSON consumers.
    """
    print(_json.dumps(_json_safe(obj), indent=2, ensure_ascii=False,
                      default=_json_default, allow_nan=False))


def print_table(
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    *,
    title: Optional[str] = None,
    show_header: bool = True,
) -> None:
    table = Table(
        title=title, title_justify="left", header_style="bold", show_header=show_header
    )
    for column in columns:
        table.add_column(str(column), overflow="fold")
    for row in rows:
        # Wrap each cell in Text so a value containing Rich markup (e.g. "[/]" or
        # "[red]" in a server-provided field) renders literally instead of raising
        # MarkupError mid-render (which would abort with a raw traceback).
        table.add_row(*[Text(_cell(value)) for value in row])
    _stdout.print(table)


def _cell(value: Any) -> str:
    if value is None:
        return "-"
    return str(value)


def info(message: str) -> None:
    if not _quiet:
        _stderr.print(message)


def success(message: str) -> None:
    if not _quiet:
        _stderr.print(message, style="green")


def hint(message: str) -> None:
    if not _quiet:
        _stderr.print(message, style="dim")


def error(message: str) -> None:
    _stderr.print(message, style="bold red")


def warn(message: str) -> None:
    if not _quiet:
        _stderr.print(message, style="yellow")


# ── Auth experience (login / logout) — presentation only ────────────────────
# A light, cohesive treatment for the first commands a user runs. Everything
# here is stderr status chrome (never the --json data on stdout); the accent is
# the project's pink/magenta. All gated on `_quiet`.

_ACCENT = "magenta"
_NEUTRAL = "grey62"  # gray for 'already in that state' no-op boxes (neutral, not red/green)


def auth_header() -> None:
    """The sign-in header: a branded wordmark + a warm, one-line welcome."""
    if _quiet:
        return
    _stderr.print()
    _stderr.print(f"  [bold {_ACCENT}]◆ fp[/]")
    _stderr.print("  [dim]welcome — let's get you signed in with a one-time code[/]")
    _stderr.print()


def step(message: str) -> None:
    """A single styled step line in a flow (e.g. 'sending a code …')."""
    if _quiet:
        return
    _stderr.print(f"  [{_ACCENT}]›[/] {message}")


def code_sent(email: str) -> None:
    """Confirm the one-time code was emailed (the completed `request_otp` step)."""
    if _quiet:
        return
    _stderr.print(f"  [green]✓[/] code sent to [bold {_ACCENT}]{email}[/]")


def org_picker(slugs: Sequence[str], current: Optional[str] = None) -> None:
    """Render the multi-tenant org list above the selection prompt."""
    if _quiet:
        return
    _stderr.print()
    _stderr.print(f"  [bold]choose your org[/]  [dim]· {len(slugs)} available[/]")
    _stderr.print()
    for i, slug in enumerate(slugs, 1):
        mark = "  [dim]· current[/]" if slug == current else ""
        _stderr.print(f"    [bold {_ACCENT}]{i}[/]  [{_ACCENT}]›[/] [bold]{slug}[/]{mark}")
    _stderr.print()


def signed_in(email: str, org: Optional[str]) -> None:
    """Success box for `login` (green `✓`) — the warm landing of the first flow."""
    if _quiet:
        return
    body = Text()
    body.append(email, style="bold")
    if org:
        body.append("  ·  ", style="dim")
        body.append(org, style=_ACCENT)
    _panel("✓", "green", "signed in", body)


def already_signed_in(email: Optional[str], org: Optional[str]) -> None:
    """`login` when a valid session already exists — a neutral, boxed status (NOT the red
    error box; nothing failed, the command exits 0). Says who you are + how to switch."""
    if _quiet:
        return
    who = email or "your account"
    body = Text()
    body.append(who, style="bold")
    if org:
        body.append("  ·  ", style="dim")
        body.append(org, style=_ACCENT)
    _status_box(
        "already signed in",
        body,
        hint="run fp logout to switch accounts, or login --force to re-authenticate",
    )


def signed_out() -> None:
    """Success box for `logout` (green `✓`) — parallels `already signed out`."""
    if _quiet:
        return
    _panel("✓", "green", "signed out", Text("session ended"),
           hint="run fp login to sign back in")


# ── interactive login — the single-box flow (one Live panel, redrawn in place) ──
# The whole `fp login` renders inside ONE outer Panel with `◆ fp` on the top
# border as a legend. Steps progress in place: each completed step collapses to a dim `✓`
# line; the active step is the bright `❯` line (or the nested org-picker inset). The border
# flips ACCENT → SUCCESS once signed in. Chrome → stderr; only `--json` writes stdout.

def _login_slots(buf: str, slots: int) -> Text:
    """Render the typed code as fixed slots — ``9 6 7 _ _ _`` (typed digits, ``_`` for the rest)."""
    chars = list(buf)[:slots]
    out = Text()
    for i in range(slots):
        if i:
            out.append(" ", style=theme.FAINT)
        if i < len(chars):
            out.append(chars[i], style=f"bold {theme.TEXT}")
        else:
            out.append("_", style=theme.FAINT)
    return out


def login_inset(slugs: Sequence[str], idx: int):
    """The nested org-picker inset (a renderable inside the login frame): a ``choose your org · N``
    title, then a FAINT-bordered inset box (a hair-lighter fill) with one row per org — ``❯`` cursor
    (ACCENT) on row ``idx``, selected slug bright, others dim — then a FAINT key-hint line."""
    title = Text()
    title.append("choose your org", style=f"bold {theme.TEXT}")
    title.append(f"  ·  {len(slugs)}", style=theme.FAINT)
    table = Table(box=None, show_header=False, pad_edge=False, padding=(0, 2, 0, 0))
    table.add_column(no_wrap=True)
    table.add_column(no_wrap=True)
    for i, slug in enumerate(slugs):
        selected = i == idx
        ptr = Text("❯", style=f"bold {theme.ACCENT}") if selected else Text(" ")
        name = Text(str(slug), style=theme.TEXT if selected else theme.TEXT_DIM)
        table.add_row(ptr, name)
    inset = Panel(table, box=ROUNDED, border_style=theme.FAINT, style=f"on {theme.INSET_BG}",
                  padding=(0, 1), expand=False)
    hint = Text("↑↓ move · ⏎ select · esc cancel", style=theme.FAINT)
    return Group(title, inset, hint)


def render_login_frame(done, active, *, active_value: str = "", active_slots: Optional[int] = None,
                       helper=None, error=None, inset=None, note=None, signed_in=None,
                       cancelled=None, failed=None):
    """Build the one login Panel (a renderable the caller redraws via ``Live``). ``done`` is a list
    of ``(label, value)`` collapsed ✓ steps; ``active`` is the current step label (bright ``❯``
    line) with ``active_value`` the in-progress typed text (rendered as fixed slots when
    ``active_slots`` is set, e.g. the 6-digit code). ``inset`` is the org-picker block; ``signed_in``
    = ``(email, org)`` flips the border green; ``cancelled`` (bool: was the session persisted?)
    renders the calm close; ``failed`` = ``(message, hint)`` flips the border red and shows the
    failure INSIDE the same box (e.g. a wrong code). Legend ``◆ fp`` rides the top border."""
    if signed_in is not None:
        border = theme.SUCCESS
    elif failed is not None:
        border = theme.ERROR
    elif cancelled is not None:
        border = theme.FAINT
    else:
        border = theme.ACCENT
    lines: List[Any] = []
    if signed_in is None and cancelled is None:
        intro = Text()
        intro.append("welcome ", style=theme.TEXT_DIM)
        intro.append("— ", style=theme.FAINT)
        intro.append("sign in with a one-time code", style=theme.TEXT_DIM)
        lines.append(intro)
    for label, value in done:
        ln = Text()
        ln.append("✓ ", style=theme.SUCCESS)
        ln.append(str(label), style=theme.TEXT_DIM)
        if value:
            ln.append(" ")
            ln.append(str(value), style=theme.TEXT_DIM)
        lines.append(ln)
    if active is not None:
        ln = Text()
        ln.append("❯ ", style=f"bold {theme.ACCENT}")
        ln.append(str(active), style=theme.TEXT)
        ln.append(" ")
        if active_slots:
            ln.append_text(_login_slots(active_value, active_slots))
        else:
            ln.append(active_value, style=f"bold {theme.TEXT}")
            ln.append("▌", style=theme.ACCENT)  # a static block cursor
        lines.append(ln)
        if error:
            lines.append(Text("  " + str(error), style=theme.ERROR))
        elif helper:
            lines.append(Text("  " + str(helper), style=theme.TEXT_DIM))
    if note:
        lines.append(Text("· " + str(note), style=theme.FAINT))
    if inset is not None:
        lines.append(inset)
    if signed_in is not None:
        email, org = signed_in
        lines.append(Rule(style=theme.THIN_RULE))
        head = Text()
        head.append("● ", style=theme.SUCCESS)
        head.append("signed in", style=theme.TEXT)
        lines.append(head)
        lines.append(Text(str(email), style=theme.ACCENT))
        if org:
            lines.append(Text(str(org), style=theme.TEXT_DIM))
    if cancelled is not None:
        ln = Text()
        ln.append("○ ", style=theme.FAINT)
        if cancelled:  # the session WAS saved — you're in, just no org yet
            ln.append("signed in", style=theme.TEXT_DIM)
            ln.append(" · pick an org with ", style=theme.FAINT)
            ln.append("fp orgs switch", style=theme.TEXT_DIM)
        else:
            ln.append("cancelled — not signed in", style=theme.FAINT)
        lines.append(ln)
    if failed is not None:
        msg, hint = failed
        fl = Text()
        fl.append("✗ ", style=f"bold {theme.ERROR}")
        fl.append(str(msg), style=theme.TEXT)
        lines.append(fl)
        if hint:
            h = Text(str(hint), style=theme.TEXT_DIM)
            h.highlight_words(["fp login"], style=theme.ACCENT)  # glow the command to run
            lines.append(h)
    legend = Text()
    legend.append("◆ ", style=f"bold {border}")
    legend.append("fp", style="bold white")
    panel = Panel(Group(*lines), box=ROUNDED, border_style=border, title=legend,
                  title_align="left", padding=(0, 1), expand=False)
    return Padding(panel, (0, 0, 0, 2))


def _panel(mark: str, color: str, title: str, body: Text, hint: Optional[str] = None) -> None:
    """The one boxed-notice renderer for the whole auth/outcome family — `mark` + `body`
    in a `color`-bordered titled box, with an optional dim hint and any command refs
    highlighted. Built from a `rich.Text` (literal body — no markup injection). The colour
    carries the meaning: **green** = success, **brand-accent** = neutral 'already-in-state'
    no-op, **red** = failure. One shape so they all read as one family."""
    text = Text()
    indent = ""
    # A box may be mark-less (the colour/title carry the meaning, e.g. the red
    # `not signed in` box); then the body sits flush and the hint lines up under it.
    if mark:
        text.append(f"{mark}  ", style=f"bold {color}")
        indent = "   "
    text.append_text(body)
    if hint:
        text.append(f"\n{indent}")
        text.append(hint, style="dim")
    text.highlight_words(
        ["fp login", "fp logout", "login --force"], style="bold cyan"
    )
    panel = Panel(
        text,
        border_style=color,
        title=f"[bold {color}]{title}[/]",
        title_align="left",
        expand=False,
        padding=(0, 1),
    )
    # A blank line above for breathing room, and a 2-space left indent so the box
    # lines up with the rest of the indented chrome (`◆`/`❯`/`✓` are all at col 2)
    # instead of sitting flush-left against it.
    _stderr.print()
    _stderr.print(Padding(panel, (0, 0, 0, 2)))


def _error_box(message: str, hint: Optional[str] = None) -> None:
    """A red `✗` failure box — the chokepoint for every CLI error."""
    _panel("✗", "red", "error", Text(message), hint)


def _status_box(title: str, body: Text, hint: Optional[str] = None) -> None:
    """A neutral **gray** `○` box for 'already in that state' auth no-ops (login when already
    signed in, logout when already signed out) — gray, deliberately NOT the red error box."""
    _panel("○", _NEUTRAL, title, body, hint)


def version_banner(version: str) -> None:
    """A small branded box for `fp version` — `◆  fp vX.Y.Z` in a brand-accent
    box, on **stdout** (the version is the command's output). `--quiet` prints the bare
    version so scripts still get a clean value; use `--json` for a machine-readable shape."""
    if _quiet:
        _stdout.print(version)
        return
    body = Text()
    body.append("◆  ", style=f"bold {_ACCENT}")
    body.append("fp", style="bold")
    body.append("  ")
    body.append(f"v{version}", style=f"bold {_ACCENT}")
    panel = Panel(
        body,
        border_style=_ACCENT,
        title=f"[bold {_ACCENT}]version[/]",
        title_align="left",
        expand=False,
        padding=(0, 1),
    )
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


# ── top-level help (the grouped `fp` / `fp help` / `fp --help` screen) ──
# Commands grouped by PURPOSE (auth/identity → read-only telemetry → mutating resources →
# utilities), each row a one-line "what it does" + a dim trailing subcommand/flag hint. One
# rounded ACCENT panel, the same shell as every other boxed view.

# (group heading, [(command, one-line description, subcommand/flag hint)]) — fixed order.
_TOP_LEVEL_GROUPS = [
    ("ESSENTIALS", [
        ("version", "Show the CLI version.", ""),
        ("help", "Show this help and the available commands.", ""),
        ("login", "Sign in with an emailed one-time code.", ""),
        ("logout", "Clear the saved session on this machine.", ""),
        ("whoami", "Show the current user, active org, and perms.", ""),
    ]),
    ("OBSERVE", [
        ("events", "List the raw per-step agent event trail.", ""),
        ("sessions", "List agent runs — one row per run.", ""),
        ("evals", "List scored agent evaluations.", "--aggregate"),
        ("errors", "List errored events.", "--aggregate"),
        ("usage", "Show current org usage for the metering window.", ""),
        ("guardrails", "What enforcement actually blocked.", "summary timeline policies"),
    ]),
    ("MANAGE", [
        ("orgs", "Switch and inspect the active org.", "list switch current perms"),
        ("keys", "Provision and manage API keys.", "list show create update disable regenerate"),
        ("users", "Manage org members and their permissions.", "list show create update disable enable"),
        ("query", "Run and manage saved SQL queries.", "list show create update delete run schema"),
        ("alerts", "Define, edit, and test alerts.", "list show create update delete test"),
        # `context-*` rather than the three names spelled out: this hint column
        # ellipsis-truncates at ~110 cols (see `desc_max` below) and this row was
        # already overflowing, so the long form would never render. The full list
        # is one level down, in `fp audits --help`, which walks the real
        # Click tree.
        ("audits", "Schedule audits and triage their findings.", "list show create edit delete run runs findings context-*"),
        ("issues", "Triage and resolve issues.", "list count show ack assign resolve comment subscribe open"),
        ("settings", "View and change org settings.", "list schema set"),
        ("policies", "Write cloud-managed policies.", "list show publish enable disable delete"),
        ("fleet", "Deploy policies to machines.", "list show deploy diff history rollback rename"),
    ]),
    ("TOOLS", [
        ("list", "List distinct values behind the filter dropdowns.", ""),
        ("agent", "Chat with the FailproofAI Cloud assistant.", "health models chats ask show rename delete"),
    ]),
]

# (example command, one-line purpose) — chosen to cover globals, commands, subcommands, flags, pipes.
_TOP_LEVEL_EXAMPLES = [
    ("fp --base-url https://dash.example.com login", "first run — set the dashboard URL, then sign in"),
    ("fp --json sessions --since 24h", "a command + the global --json + an option"),
    ("fp keys create ci-bot --permission-set read-only", "command → subcommand → options"),
    ("fp evals --aggregate --since 7d --env prod", "a command flag (--aggregate) + filters"),
    ("fp --json errors --since 24h | jq '.total'", "pipe JSON output into a script"),
]


def render_top_level_help() -> None:
    """The grouped top-level help (stdout) for ``fp`` / ``fp help`` / ``fp
    --help``: a short intro + globals line, the ``Commands · {n}`` panel (four purpose groups —
    bold-white headings, BLUE command names, white one-line descriptions, FAINT subcommand hints,
    a FAINT footer), then aligned EXAMPLES. Presentation only — same routing, same commands.
    NO_COLOR keeps the box + bold headings + alignment, drops colour."""
    total = sum(len(cmds) for _, cmds in _TOP_LEVEL_GROUPS)

    def _bullet(*parts) -> Text:
        line = Text("  · ", style=theme.FAINT)
        for text, style in parts:
            line.append(text, style=style)
        return line

    # ── brand mark ──
    _stdout.print()
    _stdout.print(Text("  ◆ fp", style=f"bold {theme.ACCENT}"))

    # ── getting started ──
    _stdout.print()
    _stdout.print(Text("  GETTING STARTED", style="bold white"))
    _stdout.print(_bullet(("sign in — the CLI points at ", theme.TEXT),
                          ("https://app.befailproof.ai", theme.TEXT_DIM),
                          (" by default:  ", theme.TEXT),
                          ("fp login", theme.ACCENT)))
    _stdout.print(Text("    (self-hosted or dev? add ", style=theme.FAINT) +
                  Text("--base-url https://your-dashboard", style=theme.TEXT_DIM) +
                  Text(" or set ", style=theme.FAINT) +
                  Text("FP_DASHBOARD_URL", style=theme.TEXT_DIM) +
                  Text("; saved after login.)", style=theme.FAINT))
    _stdout.print(_bullet(("sign in with the 6-digit code emailed to you.  self-signed dashboard? add ", theme.TEXT),
                          ("--insecure", theme.ACCENT), (".", theme.TEXT)))
    _stdout.print(_bullet(("then: ", theme.TEXT), ("fp whoami", theme.ACCENT),
                          ("   ", theme.FAINT), ("fp --json sessions --since 24h", theme.ACCENT)))

    # ── global options (placement + the list + multi-tenant) ──
    _stdout.print()
    head = Text("  GLOBAL OPTIONS", style="bold white")
    head.append("  — pass them BEFORE the command", style=theme.FAINT)
    _stdout.print(head)
    glob = Text("    ")
    for i, g in enumerate(("--json", "--base-url", "--org", "--token", "--api-key",
                           "--insecure/--secure", "--timeout", "--quiet", "--no-color")):
        if i:
            glob.append(" · ", style=theme.FAINT)
        glob.append(g, style=theme.TEXT_DIM)
    _stdout.print(glob)
    eg = Text("    e.g.  ")
    eg.append("fp --json events ", style=theme.TEXT_DIM)
    eg.append("✓", style=theme.SUCCESS)
    eg.append("     fp events --json ", style=theme.TEXT_DIM)
    eg.append("✗", style=theme.ERROR)
    _stdout.print(eg)
    mt = Text("    multi-tenant: set the org at login (", style=theme.FAINT)
    mt.append("login --org <slug>", style=theme.ACCENT)
    mt.append(") or per command (", style=theme.FAINT)
    mt.append("--org", style=theme.TEXT_DIM)
    mt.append(" / ", style=theme.FAINT)
    mt.append("FP_ORG", style=theme.TEXT_DIM)
    mt.append(").", style=theme.FAINT)
    _stdout.print(mt)
    ci = Text("    in CI: authenticate with ", style=theme.FAINT)
    ci.append("--api-key", style=theme.TEXT_DIM)
    ci.append(" / ", style=theme.FAINT)
    ci.append("FP_API_KEY", style=theme.TEXT_DIM)
    ci.append(" instead of a session (", style=theme.FAINT)
    ci.append("login", style=theme.TEXT_DIM)
    ci.append(", ", style=theme.FAINT)
    ci.append("orgs", style=theme.TEXT_DIM)
    ci.append(" and ", style=theme.FAINT)
    ci.append("agent", style=theme.TEXT_DIM)
    ci.append(" then exit 2).", style=theme.FAINT)
    _stdout.print(ci)

    # ── the Commands panel (one table; group headings are full-width rows in col 0) ──
    name_w = max(max(len(c) for c, _, _ in cmds) for _, cmds in _TOP_LEVEL_GROUPS)
    name_w = max(name_w, max(len(h) for h, _ in _TOP_LEVEL_GROUPS))  # headings sit in the same column
    desc_max = max(SCORES_MIN_WIDTH, min(_stdout.width, 110) - name_w - 8)  # cap so the panel fits; hints ellipsis-truncate
    table = Table(box=None, show_header=False, pad_edge=False, padding=(0, 2, 0, 0))
    table.add_column(no_wrap=True, width=name_w)
    table.add_column(no_wrap=True, overflow="ellipsis", max_width=desc_max)
    for gi, (heading, cmds) in enumerate(_TOP_LEVEL_GROUPS):
        if gi:
            table.add_row("", "")  # blank line between groups
        table.add_row(Text(heading, style="bold white"), Text(""))
        for name, desc, hint in cmds:
            cell = Text(desc, style=theme.TEXT)
            if hint:
                cell.append("  ·  ", style=theme.FAINT)
                cell.append(hint, style=theme.FAINT)
            table.add_row(Text(name, style=theme.BLUE), cell)
    footer = Text()
    footer.append("run ", style=theme.FAINT)
    footer.append("fp <command> --help", style=theme.TEXT_DIM)
    footer.append(" for a command's subcommands and flags", style=theme.FAINT)
    title = Text()
    title.append("Commands", style="bold white")
    title.append(" · ", style=theme.FAINT)
    title.append(str(total), style=theme.TEXT_DIM)
    panel = Panel(Group(table, Text(""), footer), box=ROUNDED, border_style=theme.ACCENT,
                  title=title, title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))

    # ── examples (aligned, below the panel) ──
    _stdout.print()
    _stdout.print(Text("  EXAMPLES", style="bold white"))
    ex = Table(box=None, show_header=False, pad_edge=False, padding=(0, 3, 0, 0))
    ex.add_column(no_wrap=True)
    ex.add_column(no_wrap=True, overflow="ellipsis", max_width=max(SCORES_MIN_WIDTH, min(_stdout.width, 110) - 56))
    for cmd, why in _TOP_LEVEL_EXAMPLES:
        ex.add_row(Text(cmd, style=theme.ACCENT), Text(why, style=theme.TEXT_DIM))
    _stdout.print(Padding(ex, (0, 0, 0, 2)))

    _stdout.print()


def already_signed_out() -> None:
    """`logout` with no active session — a calm, neutral **gray** box (NOT an error; you
    wanted out, you're out). The command still exits 0."""
    if _quiet:
        return
    _status_box(
        "already signed out",
        Text("no active session"),
        hint="run fp login to sign in",
    )


def not_signed_in() -> None:
    """`whoami` with no session — a **red** 'not signed in' box (this IS an error: you asked
    who you are, and the answer is nobody). whoami still exits 0; presentation only. The red
    title carries the meaning, so the body is mark-less."""
    if _quiet:
        return
    _panel(
        "",
        "red",
        "not signed in",
        Text("you're not logged in right now"),
        hint="run fp login to sign in",
    )


def render_key_mode_whoami(active_org: Optional[str]) -> None:
    """`whoami` under an API key — the neutral gray box, NOT the red "not signed in" one.

    You are authenticated; you are simply not a *user*, so there is no identity, no
    membership list and no permission panel to show. The org line is the part worth
    reading: blank means no `--org` was given, and an instance-scoped key with no org
    silently resolves to the deployment's default one.
    """
    if _quiet:
        return
    body = Text("authenticated with an API key — no user session")
    # 3 spaces: `_status_box`'s mark is `○` + 2 spaces, so continuation lines and the
    # hint line up under the first character of the body, like every other box here.
    body.append("\n   ")
    body.append(f"org: {active_org}" if active_org else "org: not specified")
    _status_box(
        "api-key mode",
        body,
        hint=None if active_org else "pass --org <slug> if the key serves more than one org",
    )


def cli_error(message: str, hint: Optional[str] = None) -> None:
    """The single chokepoint for every CLI failure (auth/forbidden/not-found/usage/api),
    so they all share one prominent red box. Always shown (errors ignore --quiet)."""
    _error_box(message, hint)


def user_banner(email: str, is_instance_admin: bool = False) -> None:
    """A one-line 'who you are' header above the org list."""
    if _quiet:
        return
    tag = "  [dim]· instance admin[/]" if is_instance_admin else ""
    _stderr.print()
    _stderr.print(f"  [bold {_ACCENT}]◆[/] [bold]{email}[/]{tag}")


# ── whoami (logged-in view) — presentation only ─────────────────────────────


# Resource display order for the grouped permissions panel (then alphabetical for the rest).
_PERM_RESOURCE_PRIORITY = ["dashboards", "keys", "queries", "users", "issues", "alerts",
                           "settings", "evaluations", "events", "agent"]


def _perm_res_key(r: str):
    return (_PERM_RESOURCE_PRIORITY.index(r) if r in _PERM_RESOURCE_PRIORITY
            else len(_PERM_RESOURCE_PRIORITY), r)


def _perm_act_key(a: str):
    """Action sort key: risk order (read → modify → invoke → destroy), then alphabetical."""
    return (theme.PERM_RANK.get(theme.perm_color(a), 99), a)


def _group_permissions(perms: Sequence[str]):
    """Group a flat permission list (``dashboards:read`` …) by resource → a list of
    ``(resource, [(action, color), …])``. Resources follow a fixed priority order (then
    alphabetical); actions within a row follow risk order (read → modify → invoke → destroy),
    then alphabetical. Unknown actions get the neutral default color (never crash)."""
    by_resource: dict = {}
    for p in perms:
        resource, _, action = str(p).partition(":")
        by_resource.setdefault(resource, []).append(action)
    grouped = []
    for resource in sorted(by_resource, key=_perm_res_key):
        actions = sorted(set(by_resource[resource]), key=_perm_act_key)
        grouped.append((resource, [(a, theme.perm_color(a)) for a in actions]))
    return grouped


# Diff highlight backgrounds (subtle, match the keys secret-box green chip): added grants get
# a green chip, removed grants a red chip + strikethrough. Mirror the dashboard's git-style diff.
_DIFF_ADDED_STYLE = f"{theme.SUCCESS} on #13211c"
_DIFF_REMOVED_STYLE = f"{theme.ERROR} on #241516 strike"


def _group_permissions_diff(union: Sequence[str], added: set, removed: set):
    """Group the UNION of before+after grants by resource → ``(resource, [(action, state), …])``
    where ``state`` ∈ {``added``, ``removed``, ``unchanged``}. Kept actions (added/unchanged)
    are risk-ordered first; removed actions (ghosts) sort to the end of their row."""
    by_resource: dict = {}
    for p in union:
        resource, _, action = str(p).partition(":")
        by_resource.setdefault(resource, []).append(action)
    grouped = []
    for resource in sorted(by_resource, key=_perm_res_key):
        actions = sorted(set(by_resource[resource]), key=_perm_act_key)
        kept = [a for a in actions if f"{resource}:{a}" not in removed]
        gone = [a for a in actions if f"{resource}:{a}" in removed]
        states = []
        for a in kept + gone:  # removed (struck ghosts) at the end of the row
            perm = f"{resource}:{a}"
            st = "added" if perm in added else ("removed" if perm in removed else "unchanged")
            states.append((a, st))
        grouped.append((resource, states))
    return grouped


def render_permissions_panel(
    permissions: Sequence[str],
    *,
    active_org: Optional[str] = None,
    suffix: Optional[str] = None,
    diff: Optional[dict] = None,
):
    """The grouped, risk-coloured permissions panel — the ONE renderer shared by ``whoami``,
    ``orgs perms``, ``users show``/``create``/``update``, and ``keys create``/``update``. Rounded
    ACCENT panel titled ``permissions · {n}`` (+ ``· {active_org}`` / ``· {suffix}`` when given);
    one row per resource (`_group_permissions` ordering), each action coloured by the action→risk
    map; under NO_COLOR destructive actions get a ``*``. Returns the padded renderable so the
    caller prints it (so every call site can never drift).

    With ``diff={"added": [...], "removed": [...]}`` the ``permissions`` arg is the UNION of the
    before+after grants and each action renders by its diff state: added = green chip, removed =
    red chip + strikethrough (a ghost), unchanged = dim. The title count is the NEW set size
    (added + unchanged; the struck removals are not counted). NO_COLOR falls back to ``+``/``-``
    prefixes since the chip colours/strikethrough don't render."""
    perm_table = Table(box=None, pad_edge=False, show_header=False)
    perm_table.add_column(style=theme.TEXT_DIM, no_wrap=True)  # resource
    perm_table.add_column()  # actions

    if diff is not None:
        added, removed = set(diff.get("added") or []), set(diff.get("removed") or [])
        for resource, states in _group_permissions_diff(permissions, added, removed):
            acts = Text()
            for i, (action, st) in enumerate(states):
                if i:
                    acts.append(" ")
                if st == "added":
                    acts.append(f"+{action}" if _no_color else f" {action} ", style=_DIFF_ADDED_STYLE)
                elif st == "removed":
                    acts.append(f"-{action}" if _no_color else f" {action} ", style=_DIFF_REMOVED_STYLE)
                else:
                    acts.append(action, style=theme.TEXT_DIM)
            perm_table.add_row(resource, acts)
        title_count = len([p for p in permissions if p not in removed])
    else:
        for resource, actions in _group_permissions(permissions):
            acts = Text()
            for i, (action, color) in enumerate(actions):
                if i:
                    acts.append(" ")
                label = action + ("*" if (_no_color and color == theme.PERM_DANGER) else "")
                acts.append(label, style=color)
            perm_table.add_row(resource, acts)
        title_count = len(permissions)

    if perm_table.row_count == 0:  # 0-perm user / non-member org → a calm row, not an empty box
        perm_table.add_row("", Text("(no permissions)", style=theme.FAINT))

    title = Text()
    title.append("permissions", style=f"bold {theme.ACCENT}")
    title.append(f" · {title_count}", style=theme.LABEL)
    if active_org:
        # whoami passes the active org's NAME here; render it in glowing white so the
        # "whose permissions" context stands out.
        title.append(" · ", style=theme.LABEL)
        title.append(active_org, style="bold white")
    if suffix:
        title.append(f" · {suffix}", style=theme.LABEL)
    return Padding(Panel(perm_table, box=ROUNDED, border_style=theme.ACCENT, title=title,
                         title_align="left", padding=(0, 1), expand=False), (0, 0, 0, 2))


def perm_diff_legend() -> Text:
    """A dim legend under the update diff panel: ``added  removed(struck)  unchanged`` in their
    own diff styles (NO_COLOR keeps the words readable)."""
    t = Text("  ")
    if _no_color:
        t.append("+added", style=theme.SUCCESS)
        t.append("   ")
        t.append("-removed", style=theme.ERROR)
        t.append("   ")
        t.append("unchanged", style=theme.TEXT_DIM)
        return t
    t.append(" added ", style=_DIFF_ADDED_STYLE)
    t.append("   ")
    t.append(" removed ", style=_DIFF_REMOVED_STYLE)
    t.append("   ")
    t.append("unchanged", style=theme.TEXT_DIM)
    return t


def render_orgs_panel(orgs: Sequence[dict]):
    """The ``your orgs · {n}`` panel — the ONE renderer shared by ``whoami`` and ``orgs list``.
    Marker ``●`` (active) / ``○`` (other), columns org/name/role/perms, and a ``switch with …``
    line when there are other orgs. Returns the padded renderable so the caller prints it."""
    # Column headers in white (brighter than the dim data) so they read as labels.
    org_table = Table(box=None, pad_edge=False, show_header=True, header_style=theme.TEXT)
    org_table.add_column(" ")  # marker
    for col in ("org", "name", "role", "perms"):
        org_table.add_column(col)
    for o in orgs:
        is_active = o["is_active"]
        marker = Text("●", style=theme.ACCENT) if is_active else Text("○", style=theme.FAINT)
        org_table.add_row(
            marker,
            # the ACTIVE org's slug glows white (the org column); others stay dim.
            Text(o["slug"], style="bold white" if is_active else theme.TEXT_DIM),
            Text(o["name"], style=theme.TEXT_DIM),
            Text(o["role"], style=theme.LABEL),
            Text(str(o["perms"]), style=theme.LABEL),
        )
    others = [o["slug"] for o in orgs if not o["is_active"]]
    if others:
        switch = Text()
        switch.append("switch with ", style=theme.FAINT)
        switch.append("fp orgs switch <slug>", style=theme.ACCENT)
        body: Any = Group(org_table, Text(), switch)
    else:
        body = org_table
    title = Text()
    title.append("your orgs", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(orgs)}", style=theme.LABEL)
    return Padding(Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=title,
                         title_align="left", padding=(0, 1), expand=False), (0, 0, 0, 2))


def render_whoami(
    *,
    email: str,
    is_instance_admin: bool,
    user_id: str,
    active_org: Optional[str],
    active_role: Optional[str],
    permissions: Sequence[str],
    orgs: Sequence[dict],
) -> None:
    """The logged-in ``whoami`` view (stdout): an identity header, then the shared
    permissions + orgs panels. Presentation only; no legend."""
    c = _stdout

    # ── identity header (no box) ──
    c.print()
    head = Text("  ")
    head.append("◆ ", style=theme.ACCENT)
    head.append(email, style=f"bold {theme.TEXT}")
    if is_instance_admin:
        head.append(" · ", style=theme.FAINT)
        head.append("instance admin", style=theme.LABEL)
    c.print(head)

    lw = len("active")  # align the id / active labels in one fixed column
    id_line = Text("  ")
    id_line.append("id".ljust(lw), style=theme.LABEL)
    id_line.append("  ")
    id_line.append(user_id, style=theme.TEXT_DIM)
    c.print(id_line)

    active_line = Text("  ")
    active_line.append("active".ljust(lw), style=theme.LABEL)
    active_line.append("  ")
    if active_org:
        active_line.append(active_org, style=f"bold {theme.ACCENT}")
        if active_role:
            active_line.append(" · ", style=theme.FAINT)
            active_line.append(active_role, style=theme.TEXT)
    else:
        active_line.append("(none)", style=theme.TEXT_DIM)
    c.print(active_line)

    # The permissions panel is titled with the active org's NAME (e.g. "Globex Corp"),
    # falling back to the slug if the membership has no name.
    active_org_name = next((o["name"] for o in orgs if o.get("is_active") and o.get("name")), active_org)
    c.print()
    c.print(render_permissions_panel(permissions, active_org=active_org_name))
    c.print()
    c.print(render_orgs_panel(orgs))
    c.print()


def render_orgs_list(orgs: Sequence[dict]) -> None:
    """``orgs list`` (stdout): just the shared ``your orgs`` panel."""
    _stdout.print()
    _stdout.print(render_orgs_panel(orgs))
    _stdout.print()


def render_current_org(*, slug: str, name: Optional[str], role: str,
                       permission_count: int, email: str) -> None:
    """``orgs current`` (stdout): a compact ``current org`` identity card — slug (ACCENT) +
    name on line 1, role + permission count on line 2, signed-in email on line 3 — with a
    dim footer (stderr) cross-linking ``orgs perms`` and ``orgs switch``."""
    line1 = Text()
    line1.append(slug, style=f"bold {theme.ACCENT}")
    if name:
        line1.append("  ")
        line1.append(name, style=theme.TEXT_DIM)
    line2 = Text()
    line2.append("role ", style=theme.LABEL)
    line2.append(role, style=theme.TEXT)
    line2.append(" · ", style=theme.FAINT)
    line2.append(f"{permission_count} permissions", style=theme.LABEL)
    line3 = Text()
    line3.append("signed in as ", style=theme.LABEL)
    line3.append(email, style=theme.TEXT_DIM)

    panel = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.ACCENT,
                  title=Text("current org", style=f"bold {theme.ACCENT}"),
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))
    if not _quiet:
        foot = Text("  ")
        foot.append("see permissions with ", style=theme.FAINT)
        foot.append("fp orgs perms", style=theme.ACCENT)
        foot.append(" · ", style=theme.FAINT)
        foot.append("switch with ", style=theme.FAINT)
        foot.append("fp orgs switch <slug>", style=theme.ACCENT)
        _stderr.print(foot)
        _stderr.print()


def render_org_perms(*, slug: str, role: str, permissions: Sequence[str],
                     name: Optional[str] = None) -> None:
    """``orgs perms`` (stdout): an identity header line + the shared permissions panel.

    The header leads with the org **name** (glowing accent) then the slug handle and your role;
    the permission count moves into the panel's border title (``permissions · {n} · {name}``),
    so the header reads as a clean identity line instead of repeating the count."""
    head = Text("  ")
    head.append("◆ ", style=theme.ACCENT)
    head.append(name or slug, style=f"bold {theme.ACCENT}")  # org name — the identity, glowing
    if name and name != slug:
        head.append("  ·  ", style=theme.FAINT)
        head.append(slug, style=theme.TEXT_DIM)             # the slug handle, dim
    head.append("  ·  ", style=theme.FAINT)
    head.append("role ", style=theme.LABEL)
    head.append(role, style=theme.TEXT)
    _stdout.print()
    _stdout.print(head)
    _stdout.print()
    # The org NAME rides in the panel's border title (permissions · {n} · {name}), glowing white.
    _stdout.print(render_permissions_panel(permissions, active_org=name or slug))
    _stdout.print()


# ── orgs switch — interactive picker + switched card (presentation only) ─────
# The picker frame and the switched card share the same rounded Panel shell as every other
# boxed view (only the border colour + contents differ), so they read as one system.

_PICKER_FOOTER = "↑↓ move · ⏎ select · esc cancel"


def org_picker_frame(orgs: Sequence[dict], idx: int):
    """One frame of the interactive ``orgs switch`` picker (a renderable, redrawn in place by the
    caller's ``Live``): a rounded ACCENT panel ``switch org · {n} available``; one row per org with
    a ``❯`` pointer (ACCENT) on row ``idx`` — the selected slug bright (TEXT), others dim — and a
    ``● current`` (SUCCESS) / ``○`` (FAINT) status. Footer ``↑↓ move · ⏎ select · esc cancel`` in
    the bottom border. NO_COLOR keeps the box, pointer, and ●/○ shapes (colour drops out)."""
    table = Table(box=None, pad_edge=False, show_header=False, padding=(0, 2, 0, 0))
    table.add_column(no_wrap=True)  # pointer
    table.add_column(no_wrap=True)  # slug
    table.add_column(no_wrap=True)  # status
    for i, o in enumerate(orgs):
        selected = i == idx
        ptr = Text("❯", style=f"bold {theme.ACCENT}") if selected else Text(" ")
        slug = Text(o["slug"], style=theme.TEXT if selected else theme.TEXT_DIM)
        status = (Text("● current", style=theme.SUCCESS) if o.get("is_current")
                  else Text("○", style=theme.FAINT))
        table.add_row(ptr, slug, status)
    title = Text()
    title.append("switch org", style=f"bold {theme.TEXT}")
    title.append(" · ", style=theme.FAINT)
    title.append(f"{len(orgs)} available", style=theme.TEXT_DIM)
    panel = Panel(table, box=ROUNDED, border_style=theme.ACCENT, title=title, title_align="left",
                  padding=(0, 1), expand=False)
    # The key hint rides as a FAINT line just beneath the panel (always fits — no border
    # truncation of the wide ⏎/arrow glyphs), aligned under the box.
    footer = Text("  " + _PICKER_FOOTER, style=theme.FAINT)
    return Group(Padding(panel, (0, 0, 0, 2)), footer)


def render_org_picker_numbered(orgs: Sequence[dict], *, current: Optional[str] = None) -> None:
    """Non-TTY fallback for ``orgs switch`` (stderr): the same boxed panel as the live picker, but
    numbered (``# · slug · status``) for a typed choice. Printed once above the prompt."""
    if _quiet:
        return
    table = Table(box=SIMPLE_HEAD, border_style=theme.THIN_RULE, pad_edge=False, show_edge=False,
                  show_header=True, header_style="bold white", padding=(0, 2, 0, 0))
    for col in ("#", "org", "status"):
        table.add_column(col, no_wrap=True)
    table.add_row("", "", "")
    for i, o in enumerate(orgs, 1):
        status = (Text("● current", style=theme.SUCCESS) if o.get("slug") == current
                  else Text("○", style=theme.FAINT))
        table.add_row(Text(str(i), style=theme.ACCENT), Text(o["slug"], style=theme.TEXT), status)
    title = Text()
    title.append("switch org", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(orgs)} available", style=theme.LABEL)
    _stderr.print()
    _stderr.print(Padding(Panel(table, box=ROUNDED, border_style=theme.ACCENT, title=title,
                                title_align="left", padding=(0, 1), expand=False), (0, 0, 0, 2)))


def render_switched_org(*, slug: str, prev_slug: Optional[str] = None,
                        perm_count: Optional[int] = None) -> None:
    """The ``orgs switch`` success card (stderr): a GREEN-bordered ``switched org`` card — a
    hairline under the title, a hero ``● {slug}`` (SUCCESS dot + ACCENT slug), and a meta line
    ``was {prev} · {n} permissions``. The green border IS the success signal (no tick, no
    'successfully'). The same box shell as the picker — only the border colour + contents differ."""
    if _quiet:
        return
    hero = Text()
    hero.append("● ", style=theme.SUCCESS)
    hero.append(slug, style=f"bold {theme.ACCENT}")
    meta = Text()
    if prev_slug:
        meta.append("was ", style=theme.TEXT_DIM)
        meta.append(prev_slug, style=theme.TEXT_DIM)
    if perm_count is not None:
        if prev_slug:
            meta.append("  ·  ", style=theme.FAINT)
        meta.append(f"{perm_count} permissions", style=theme.TEXT_DIM)
    parts = [Rule(style=theme.THIN_RULE), hero]
    if meta.plain:
        parts.append(meta)
    card = Panel(Group(*parts), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("switched org", style=f"bold {theme.TEXT}"), title_align="left",
                 padding=(0, 1), expand=False, width=min(max(_stderr.width - 4, 36), 60))
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def org_already_on(slug: str) -> None:
    """Calm no-op for selecting the org you're already on (stderr): ``○ already on {slug} —
    nothing changed`` (calm ``○``, dim body — not a ``✓``, which would read as an action). A
    single line, not the card."""
    if _quiet:
        return
    _stderr.print()
    _plain(("○ ", theme.TEXT_DIM), ("already on ", theme.TEXT_DIM),
           (slug, f"bold {theme.ACCENT}"), (" — nothing changed", theme.TEXT_DIM))


def org_only_one(slug: str) -> None:
    """Calm line when the account has a single org (stderr): ``only org · {slug}. nothing to
    switch to.``"""
    if _quiet:
        return
    _stderr.print()
    _plain(("only org · ", theme.TEXT_DIM), (slug, f"bold {theme.ACCENT}"),
           (". nothing to switch to.", theme.TEXT_DIM))


def org_switch_cancelled(current: Optional[str]) -> None:
    """Calm cancel line for an Esc/Ctrl-C mid-pick (stderr): ``○ cancelled — still on {current}``
    (FAINT). Declining is a good outcome, not an error."""
    if _quiet:
        return
    _stderr.print()
    if current:
        _plain(("○ ", theme.FAINT), ("cancelled — still on ", theme.LABEL), (current, theme.LABEL))
    else:
        _plain(("○ ", theme.FAINT), ("cancelled — nothing changed", theme.LABEL))


def org_none_available(*, instance_admin: bool) -> None:
    """Calm empty-state when you belong to no org (stderr): ``no orgs available`` + an admin hint."""
    if _quiet:
        return
    _stderr.print()
    _plain(("no orgs available", theme.TEXT_DIM))
    if instance_admin:
        _plain(("instance admin — pass a slug: ", theme.FAINT), ("fp orgs switch <slug>", theme.ACCENT))


def org_not_found(slug: str, *, suggestion: Optional[str] = None) -> None:
    """Not-found error for ``orgs switch <slug>`` (stderr, always shown): ``✗ no org named {slug}``
    + an optional ``did you mean {match}?`` + a ``run fp orgs switch to pick`` hint."""
    _stderr.print()
    _plain(("✗ ", f"bold {theme.ERROR}"), ("no org named ", theme.TEXT), (slug, f"bold {theme.ACCENT}"))
    hint = Text("  ")
    if suggestion:
        hint.append("did you mean ", theme.FAINT)
        hint.append(suggestion, style=theme.ACCENT)
        hint.append("? · ", style=theme.FAINT)
    else:
        hint.append("", style=theme.FAINT)
    hint.append("run ", style=theme.FAINT)
    hint.append("fp orgs switch", style=theme.ACCENT)
    hint.append(" to pick", style=theme.FAINT)
    _stderr.print(hint)


# ── list panels (events / sessions) — presentation only ─────────────────────

# Score colour bands (named so they're easy to tune) — ONE scale used everywhere a score
# is coloured (evals score cells, the aggregate avg + bar): ≥ GOOD cyan-green, ≥ OK amber,
# below OK red. Unified on .80/.50 (was .85/.70) so a score reads the same colour CLI-wide.
SCORE_GOOD = 0.80
SCORE_OK = 0.50
# The scores column is width-aware: pairs are fitted into a per-render budget (and capped
# there via the column max_width) so the fixed columns keep their natural width and the rest
# of the pairs collapse to `+N`. SCORES_MIN_WIDTH floors the budget on a narrow terminal.
SCORES_MIN_WIDTH = 8
# Chrome reserved when sizing the scores budget (deliberately generous): the panel
# border/padding + left indent + the inter-column padding, plus headroom for Rich's own
# layout rounding. Over-reserving costs a few scores chars but keeps time/status intact.
_LIST_CHROME = 2 * 6 + 12

# Run/job states → colour. A small, stable enum, so a value→colour map is safe;
# anything unknown falls back to neutral dim (never crash on a new state).
_STATUS_COLORS = {
    "done": theme.SUCCESS, "completed": theme.SUCCESS, "passed": theme.SUCCESS,
    "running": theme.AMBER, "queued": theme.AMBER, "pending": theme.AMBER,
    "failed": theme.ERROR, "error": theme.ERROR, "cancelled": theme.ERROR, "timeout": theme.ERROR,
}


def _parse_iso(ts: str) -> Optional[datetime]:
    """Tolerant ISO-8601 parse → datetime, or None if it doesn't parse (e.g. an
    opaque/empty ts). Never raises — the caller falls back to the raw string."""
    s = (ts or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _row_times(timestamps: Sequence[Optional[datetime]]):
    """Format a column of parsed timestamps for a list panel → ``(cells, days)``.

    Rows show clock time (`HH:MM:SS`) with the shared date carried in the panel title;
    if the rows span more than one UTC day the date is folded back into each cell
    (`MM-DD HH:MM:SS`). An unparsed slot yields ``None`` (the caller substitutes raw)."""
    days = {dt.date() for dt in timestamps if dt is not None}
    fmt = "%m-%d %H:%M:%S" if len(days) > 1 else "%H:%M:%S"
    cells = [dt.strftime(fmt) if dt is not None else None for dt in timestamps]
    return cells, days


def _panel_title(name: str, count: int, order: Optional[str], days) -> Text:
    title = Text()
    title.append(name, style=f"bold {theme.ACCENT}")
    title.append(f" · {count}", style=theme.LABEL)
    title.append(f" · {'oldest first' if order == 'asc' else 'newest first'}", style=theme.LABEL)
    if days:
        span = f"{min(days)} → {max(days)}" if len(days) > 1 else str(next(iter(days)))
        title.append(f" · {span}", style=theme.LABEL)
    return title


def render_list_panel(
    name: str,
    *,
    header: Sequence[str],
    rows: Sequence[Sequence[Text]],
    days,
    order: Optional[str],
    empty_message: str,
    last_col: Optional[str] = None,
    last_col_max: Optional[int] = None,
    title: Optional[Text] = None,
    border: str = theme.ACCENT,
    rule: str = theme.THIN_RULE,
) -> None:
    """Shared boxed-list renderer for `events`/`sessions`/`evals`/`errors` (stdout). A rounded
    panel (``border``, default ACCENT) titled ``{name} · {n} · {dir} · {date}`` (or an explicit
    ``title`` override, e.g. the aggregate score-stats / error panels) wrapping a borderless
    table with a bold-white header and a thin ``rule`` beneath it. ``rows`` are pre-styled cells
    (per-column colour is the caller's job); ``days`` drives the title date/span. ``last_col``
    controls the final column's overflow: ``"ellipsis"`` truncates with `…` (capped to
    ``last_col_max`` so it can't squeeze the fixed columns), ``"wrap"`` folds, ``None`` plain."""
    if not rows:
        body: Any = Text(empty_message, style=theme.TEXT_DIM)
    else:
        # Bold bright-white headers so the column labels glow against the dim rows (the
        # border tint lives in the panel; the thin rule separates header from data).
        table = Table(box=SIMPLE_HEAD, border_style=rule, pad_edge=False,
                      show_edge=False, show_header=True, header_style="bold white",
                      expand=False, padding=(0, 2, 0, 0))
        last = len(header) - 1
        for i, col in enumerate(header):
            if last_col and i == last:
                if last_col == "wrap":
                    table.add_column(col, no_wrap=False, overflow="fold")
                else:
                    table.add_column(col, no_wrap=True, overflow="ellipsis", max_width=last_col_max)
            else:
                table.add_column(col, no_wrap=True)
        table.add_row(*([""] * len(header)))  # a blank line between the header rule and the rows
        for row in rows:
            table.add_row(*row)
        body = table

    panel = Panel(body, box=ROUNDED, border_style=border,
                  title=title if title is not None else _panel_title(name, len(rows), order, days),
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


def render_events(items: Sequence[Any], *, order: Optional[str] = None,
                  empty_message: str = "no events in this window") -> None:
    """The default ``events`` view: columns ``time · type · env · agent · session`` in the
    shared list panel. Presentation only — ``--json``/``--fields`` never reach here. When the
    set is empty the caller passes a filter-aware ``empty_message`` (e.g. ``no events match
    these filters`` when filters are active vs the default ``no events in this window``)."""
    tcells, days = _row_times([_parse_iso(getattr(e, "ts", "")) for e in items])
    rows = []
    for e, t in zip(items, tcells):
        rows.append([
            Text(t if t is not None else (getattr(e, "ts", "") or "-"), style=theme.TEXT),
            Text(getattr(e, "event_type", "") or "-", style=theme.TEXT),
            Text(getattr(e, "environment", "") or "-", style=theme.TEXT_DIM),
            Text(getattr(e, "agent_id", "") or "-", style=theme.TEXT_DIM),
            Text(getattr(e, "session_id", "") or "-", style=theme.TEXT_DIM),
        ])
    render_list_panel("events", header=["time", "type", "env", "agent", "session"],
                      rows=rows, days=days, order=order, empty_message=empty_message)


def _short_session(sid: str, *, full: bool = False) -> str:
    """Truncate a long session id for the table (full id always kept in ``--json``):
    ``sess-20260615-fcf97e01`` → ``sess-…fcf97e01`` (prefix + last 8); other long ids →
    first 6 + ``…`` + last 6; short ids are left intact."""
    if full or not sid or sid == "-":
        return sid
    if sid.startswith("sess-") and len(sid) > 14:
        return "sess-…" + sid[-8:]
    if len(sid) > 18:
        return sid[:6] + "…" + sid[-6:]
    return sid


def _fmt_score_num(f: float) -> str:
    """Compact score number: ``0.94`` → ``.94``, ``0.00`` → ``.00``, ``1.00`` → ``1.0``."""
    s = f"{f:.2f}"
    if s == "1.00":
        return "1.0"
    if s.startswith("0."):
        return s[1:]
    if s.startswith("-0."):
        return "-" + s[2:]
    return s


def _score_color(f: float) -> str:
    """A numeric score → its band colour: ≥.80 cyan-green, .50–.80 amber, <.50 red.
    Higher == better for every metric (the CLI has no per-metric direction flag), so an
    inverted metric like a raw `toxicity` would read 'backwards' — documented, not special-cased."""
    return theme.SCORE_HIGH if f >= SCORE_GOOD else (theme.AMBER if f >= SCORE_OK else theme.ERROR)


def _fmt_avg(v: float) -> str:
    """Aggregate avg format: 2 decimals, leading zero KEPT (`0.71`), `1.00` → `1.0`."""
    s = f"{v:.2f}"
    return "1.0" if s == "1.00" else s


def _score_value(value: Any):
    """A score value → ``(display, colour)``. Numeric values colour by the GOOD/OK
    thresholds; non-numeric values use a pass/fail substring rule. Under NO_COLOR a
    failing numeric value (< OK) gets a trailing ``!`` so it stays visible without colour."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        low = str(value).lower()
        if "fail" in low or "error" in low:
            return str(value), theme.ERROR
        if "pass" in low or "ok" in low or "true" in low:
            return str(value), theme.SUCCESS
        return str(value), theme.TEXT_DIM
    color = _score_color(f)
    label = _fmt_score_num(f)
    if _no_color and f < SCORE_OK:
        label += "!"
    return label, color


def _scores_cell(scores: Optional[dict], *, budget: Optional[int] = None, full: bool = False) -> Text:
    """Render a score map as ``metric value`` pairs (metric dim, value colour-coded). With a
    width ``budget`` the cell greedily fits as many pairs as the budget allows (always at
    least one) then appends ``+N`` for the rest — so an eval stays exactly one row and the
    fixed columns never get squeezed. ``full`` (or no budget) shows every pair (and may wrap).
    No ``=`` — pairs sit two spaces apart."""
    if not scores:
        return Text("-", style=theme.TEXT_DIM)
    rendered = [(str(k), *_score_value(v)) for k, v in scores.items()]  # (metric, label, colour)

    if full or budget is None:
        shown, extra = rendered, 0
    else:
        shown, used = [], 0
        for i, (metric, label, _c) in enumerate(rendered):
            w = (2 if shown else 0) + len(metric) + 1 + len(label)
            leftover = len(rendered) - (len(shown) + 1)
            suffix = (2 + 1 + len(str(leftover))) if leftover > 0 else 0  # room for "  +N"
            if shown and used + w + suffix > budget:
                break
            shown.append(rendered[i])
            used += w
        extra = len(rendered) - len(shown)

    txt = Text()
    for i, (metric, label, color) in enumerate(shown):
        if i:
            txt.append("  ")
        txt.append(metric, style=theme.TEXT_DIM)
        txt.append(" ")
        txt.append(label, style=color)
    if extra > 0:
        txt.append("  ")
        txt.append(f"+{extra}", style=theme.LABEL)
    return txt


def _status_cell(status: str) -> Text:
    return Text(status or "-", style=_STATUS_COLORS.get(str(status).lower(), theme.TEXT_DIM))


def _eval_row_columns(items, *, full_ids):
    """The five fixed columns (time/env/agent/session/status) shared by the sessions and
    evals list views, as plain strings + the parsed ``days`` for the panel title."""
    tcells, days = _row_times(
        [_parse_iso(getattr(e, "completed_at", "") or getattr(e, "created_at", "")) for e in items]
    )
    times = [t if t is not None else (getattr(e, "completed_at", "") or "-") for e, t in zip(items, tcells)]
    envs = [getattr(e, "environment", "") or "-" for e in items]
    agents = [getattr(e, "agent_id", "") or "-" for e in items]
    sessions = [_short_session(getattr(e, "session_id", "") or "-", full=full_ids) for e in items]
    statuses = [getattr(e, "status", "") or "-" for e in items]
    return times, envs, agents, sessions, statuses, days


def _session_agents(e: Any) -> list:
    """The session's agent roster: a list of ``{"agent_id", "event_count"}`` dicts, server-sorted
    by event count desc. Empty when the field is absent (older server) — so single-agent sessions
    and legacy responses both fall through to the plain one-name rendering."""
    raw = getattr(e, "agents", None) or []
    return [a for a in raw if isinstance(a, dict)]


def is_multi_agent(e: Any) -> bool:
    """True when more than one agent ran in the session — drives the ``+N`` badge and the
    sessions footer's ``multi-agent`` count."""
    return len(_session_agents(e)) > 1


def _agent_cell(e: Any) -> Text:
    """The ``agent`` column for a session row: the root agent name, plus ``+N`` (N = the number of
    OTHER agents that ran) in the accent colour when the session is multi-agent. The extra agents'
    names are never listed inline — the badge keeps the roster one row wide (use ``--agents`` to
    expand into the full list)."""
    txt = Text(getattr(e, "agent_id", "") or "-", style=theme.TEXT)
    extra = len(_session_agents(e)) - 1
    if extra > 0:
        txt.append(" ")
        txt.append(f"+{extra}", style=theme.ACCENT)
    return txt


def _session_row_time(e: Any) -> str:
    """The session's last-activity timestamp for the time column, with fallbacks (started_at, then
    an eval-shaped completed_at/created_at) so a stray Evaluation-shaped row still renders."""
    return (getattr(e, "last_event_at", "") or getattr(e, "started_at", "")
            or getattr(e, "completed_at", "") or getattr(e, "created_at", ""))


def render_sessions(items: Sequence[Any], *, order: Optional[str] = None,
                    full_ids: bool = False, empty_message: str = "no sessions") -> None:
    """The default ``sessions`` view: columns ``time · env · agent · session · status`` in the
    shared list panel — agent bright (plus ``+N`` in accent when multi-agent), the rest
    contextual-dim; status coloured by state. ``time`` is the session's last activity
    (``last_event_at``), ``status`` its latest evaluation outcome (blank if never evaluated).
    Scores live on ``evals``, not here. Session ids truncate unless ``full_ids``. The ``--json`` /
    ``--fields`` paths never reach here. When empty the caller passes a filter-aware
    ``empty_message``."""
    tcells, days = _row_times([_parse_iso(_session_row_time(e)) for e in items])
    rows = []
    for e, t in zip(items, tcells):
        rows.append([
            Text(t if t is not None else (_session_row_time(e) or "-"), style=theme.TEXT_DIM),
            Text(getattr(e, "environment", "") or "-", style=theme.LABEL),
            _agent_cell(e),
            Text(_short_session(getattr(e, "session_id", "") or "-", full=full_ids), style=theme.TEXT_DIM),
            _status_cell(getattr(e, "status", "") or "-"),
        ])
    render_list_panel("sessions", header=["time", "env", "agent", "session", "status"],
                      rows=rows, days=days, order=order, empty_message=empty_message)


def render_sessions_expanded(items: Sequence[Any], *, order: Optional[str] = None,
                             full_ids: bool = False, empty_message: str = "no sessions") -> None:
    """``sessions --agents``: the same list, but every multi-agent session is expanded into an
    indented roster beneath its row — ``├ name   N ev`` for every agent (uniform, ordered by event
    count desc; ``└`` closes the list, no special "root" marker). Single-agent sessions render as a
    normal row. The panel's count stays the number of sessions — the roster sub-rows aren't counted."""
    tcells, days = _row_times([_parse_iso(_session_row_time(e)) for e in items])
    rows = []
    for e, t in zip(items, tcells):
        rows.append([
            Text(t if t is not None else (_session_row_time(e) or "-"), style=theme.TEXT_DIM),
            Text(getattr(e, "environment", "") or "-", style=theme.LABEL),
            _agent_cell(e),
            Text(_short_session(getattr(e, "session_id", "") or "-", full=full_ids), style=theme.TEXT_DIM),
            _status_cell(getattr(e, "status", "") or "-"),
        ])
        agents = _session_agents(e)
        if len(agents) > 1:
            width = max(len(str(a.get("agent_id", ""))) for a in agents)
            n = len(agents)
            for i, a in enumerate(agents):
                # Uniform glyph — no special "root" marker; `└` just closes the list.
                glyph = "└" if i == n - 1 else "├"
                cell = Text("  ")
                cell.append(f"{glyph} ", style=theme.FAINT)
                cell.append(str(a.get("agent_id", "")).ljust(width), style=theme.TEXT)
                cell.append("   ")
                cell.append(f"{a.get('event_count', 0)} ev", style=theme.LABEL)
                rows.append([Text(""), Text(""), cell, Text(""), Text("")])
    render_list_panel("sessions", header=["time", "env", "agent", "session", "status"],
                      rows=rows, days=days, order=order, empty_message=empty_message,
                      title=_panel_title("sessions", len(items), order, days))


def render_evals(items: Sequence[Any], *, order: Optional[str] = None,
                 full_ids: bool = False, scores_full: bool = False,
                 empty_message: str = "no evals") -> None:
    """The default ``evals`` list view: same columns as ``sessions`` plus a final ``scores``
    column — agent bright, the rest contextual-dim; status coloured by state; scores coloured
    by value (≥.85 green / .70–.85 amber / <.70 red). Session ids truncate unless ``full_ids``;
    scores are width-fitted (then ``+N``) so an eval stays one row and the fixed columns never
    squeeze, unless ``scores_full``. The ``--json`` / ``--fields`` paths never reach here."""
    times, envs, agents, sessions, statuses, days = _eval_row_columns(items, full_ids=full_ids)

    budget: Optional[int] = None
    if items and not scores_full:
        fixed = sum(max((len(x) for x in col), default=0) for col in (times, envs, agents, sessions, statuses))
        budget = max(SCORES_MIN_WIDTH, _stdout.width - fixed - _LIST_CHROME)

    rows = []
    for i, e in enumerate(items):
        rows.append([
            Text(times[i], style=theme.TEXT_DIM),
            Text(envs[i], style=theme.LABEL),
            Text(agents[i], style=theme.TEXT),
            Text(sessions[i], style=theme.TEXT_DIM),
            _status_cell(statuses[i]),
            _scores_cell(getattr(e, "scores", None), budget=budget, full=scores_full),
        ])
    render_list_panel("evals", header=["time", "env", "agent", "session", "status", "scores"],
                      rows=rows, days=days, order=order, empty_message=empty_message,
                      last_col=("wrap" if scores_full else "ellipsis"), last_col_max=budget)


def _footer_line(command: str, shown: int, more: bool) -> Text:
    line = Text("  ")
    line.append(f"{shown} shown", style=theme.LABEL)
    if more:
        line.append("  ·  ", style=theme.FAINT)
        line.append("more available", style=theme.LABEL)
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"fp {command} --all", style=theme.ACCENT)
    return line


def events_footer(shown: int, *, more: bool, command: str = "events") -> None:
    """The dim summary line under the events box (stderr): ``<n> shown`` and, when the server
    has more rows, ``· more available · fp <command> --all`` with the command glowed."""
    if _quiet:
        return
    _stderr.print(_footer_line(command, shown, more))
    _stderr.print()


# Filters that narrow a list (events/sessions), mapped to the `fp list <facet>` that
# enumerates their valid values (so a 0-result run with a typo'd value points the user at the
# right answer). Shared across commands: a filter with no enumerable facet (e.g. --session-id,
# --status, --since) simply gets named without a "see valid values" line.
_FILTER_FACETS = {
    "--env": "envs",
    "--agent-id": "agents",
    "--event-type": "event_types",
    "--error-type": "error_types",
}


def recheck_filters_hint(active_filters: Sequence[str]) -> None:
    """Dim stderr nudge shown when a *filtered* list returns 0 rows: name the filters the user
    set and, for those with a discoverable value set, point at ``fp list <facet>``. This
    makes a typo'd value (the ``--env xyz`` case) read as "check your filters" rather than the
    misleading "no data exists" — the server silently returns 0 for any value that matches
    nothing, so the CLI can't tell a bad value from a genuinely empty slice. No-op when no
    filters were active (a bare run with 0 rows is a real empty window, not a typo)."""
    if _quiet or not active_filters:
        return
    line = Text("  ")
    line.append("↳ ", style=theme.FAINT)
    line.append("no matches — double-check the value", style=theme.LABEL)
    line.append("s" if len(active_filters) > 1 else "", style=theme.LABEL)
    line.append(" you passed for ", style=theme.LABEL)
    for i, flag in enumerate(active_filters):
        if i:
            line.append(", ", style=theme.FAINT)
        line.append(flag, style=theme.ACCENT)
    _stderr.print(line)
    facets = [_FILTER_FACETS[f] for f in active_filters if f in _FILTER_FACETS]
    if facets:
        l2 = Text("    ")
        l2.append("see valid values: ", style=theme.FAINT)
        for i, fa in enumerate(facets):
            if i:
                l2.append(" · ", style=theme.FAINT)
            l2.append(f"fp list {fa}", style=theme.ACCENT)
        _stderr.print(l2)
    _stderr.print()


def sessions_footer(shown: int, *, more: bool, multi_agent: int = 0) -> None:
    """The sessions summary line (stderr): ``<n> shown``; then ``· <m> multi-agent · fp
    sessions --agents`` when any shown session ran more than one agent (nudging the roster
    expand); then ``· more available · fp sessions --all`` when the server has more rows.
    No score legend (sessions has no scores)."""
    if _quiet:
        return
    line = Text("  ")
    line.append(f"{shown} shown", style=theme.LABEL)
    if multi_agent > 0:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{multi_agent} multi-agent", style=theme.LABEL)
        line.append("  ·  ", style=theme.FAINT)
        line.append("fp sessions --agents", style=theme.ACCENT)
    if more:
        line.append("  ·  ", style=theme.FAINT)
        line.append("more available", style=theme.LABEL)
        line.append("  ·  ", style=theme.FAINT)
        line.append("fp sessions --all", style=theme.ACCENT)
    _stderr.print(line)
    _stderr.print()


def _score_legend() -> Text:
    """Compact score-band legend for the evals footer (the cut points aren't obvious)."""
    t = Text()
    t.append("score: ", style=theme.LABEL)
    t.append("≥.80", style=theme.SCORE_HIGH)
    t.append(" ")
    t.append(".50–.80", style=theme.AMBER)
    t.append(" ")
    t.append("<.50", style=theme.ERROR)
    return t


def evals_footer(shown: int, *, more: bool) -> None:
    """The evals list summary line (stderr): the shared pagination line plus a compact
    score-colour legend on the same line. The legend is dropped (not wrapped) if the terminal
    is too narrow."""
    if _quiet:
        return
    line = _footer_line("evals", shown, more)
    legend = _score_legend()
    if line.cell_len + 4 + legend.cell_len <= _stderr.width:
        line.append("    ")
        line.append_text(legend)
    _stderr.print(line)
    _stderr.print()


# ── eval aggregate (evals --aggregate) — presentation only ───────────────────

# Stable display order for the status dots; any bucket not listed sorts after these
# (built dynamically so a new backend status never crashes the card).
_AGG_STATUS_ORDER = ["done", "passed", "error", "failed", "timeout", "cancelled"]


def _success_rate_color(pct: float) -> str:
    """Success-rate colour: ≥95% green, 85–95% amber, <85% red."""
    return theme.SUCCESS if pct >= 95 else (theme.AMBER if pct >= 85 else theme.ERROR)


# ── score bar config ──
BAR_CELLS = 10
BAR_LO, BAR_HI = 0.40, 1.00  # zoomed scale: the typical .7–.9 range shows visible variation
# Empty-track tint, nudged toward each band so the track reads as "the rest of this bar".
_BAR_TRACK_TINT = {theme.SCORE_HIGH: "#1d3833", theme.AMBER: "#3a352d", theme.ERROR: "#3a2d2d"}


def _bar_glyphs() -> tuple:
    """(fill, track) glyphs. Braille (`⣿`/`⣀`) when colour is on — prettier, with built-in
    inter-cell spacing; solid blocks (`█`/`░`) otherwise (mono-safe, clearer fill contrast and
    a universally-rendered fallback for fonts that mis-advance wide unicode)."""
    enc = str(getattr(_stdout, "encoding", "utf-8") or "utf-8").lower()
    return ("⣿", "⣀") if (not _no_color and "utf" in enc) else ("█", "░")


def _avg_bar(avg: Optional[float]) -> Text:
    """A 10-cell mini-bar for an average on the zoomed `.40–1.0` scale: filled cells in the
    score's band colour, the rest a band-tinted track. Conveys the value by fill level alone,
    so it still works under NO_COLOR. Lives in its own table column, so even if a font advances
    braille differently the later columns stay aligned (Rich pads to the cell width)."""
    fill_g, track_g = _bar_glyphs()
    if avg is None:
        return Text(track_g * BAR_CELLS, style=theme.BAR_EMPTY)
    color = _score_color(avg)
    frac = max(0.0, min(1.0, (avg - BAR_LO) / (BAR_HI - BAR_LO)))
    filled = round(frac * BAR_CELLS)
    bar = Text()
    bar.append(fill_g * filled, style=color)
    bar.append(track_g * (BAR_CELLS - filled), style=_BAR_TRACK_TINT.get(color, theme.BAR_EMPTY))
    return bar


def _score_bar_legend() -> Text:
    """One dim line explaining the bar's zoomed scale + colour bands."""
    fill_g, _ = _bar_glyphs()
    t = Text("  ")
    t.append("scale .40–1.0 · ", style=theme.LABEL)
    t.append(fill_g, style=theme.SCORE_HIGH); t.append(" ≥.80   ", style=theme.LABEL)
    t.append(fill_g, style=theme.AMBER); t.append(" .50–.80   ", style=theme.LABEL)
    t.append(fill_g, style=theme.ERROR); t.append(" <.50", style=theme.LABEL)
    return t


def render_eval_aggregate(data: dict, *, show_bar: Optional[bool] = None) -> None:
    """The ``evals --aggregate`` view (stdout): a totals card (hero count + colour-coded status
    dots + a derived success-rate line) then a score-stats table — one row per metric with its
    sample count, threshold-coloured avg + a mini-bar, and min/max/p50 — sorted worst-avg first,
    every metric shown. Presentation only (``--json`` emits the raw payload). Higher == better is
    assumed for every metric (the CLI has no per-metric direction flag), so an inverted metric
    such as a raw `toxicity` would read 'backwards' — uniform rule, not special-cased."""
    total = int(data.get("total", 0) or 0)
    counts = {k: int(v or 0) for k, v in (data.get("status_counts", {}) or {}).items()}

    # ── panel 1: totals card ──
    line1 = Text()
    line1.append(str(total), style=f"bold {theme.TEXT}")
    line1.append(" evals", style=theme.LABEL)
    for b in sorted(counts, key=lambda x: (_AGG_STATUS_ORDER.index(x) if x in _AGG_STATUS_ORDER else len(_AGG_STATUS_ORDER), x)):
        n = counts[b]
        zero = n == 0
        line1.append("   ")
        line1.append("○" if zero else "●", style=theme.FAINT if zero else _STATUS_COLORS.get(b, theme.TEXT_DIM))
        line1.append(f" {n} {b}", style=theme.LABEL if zero else theme.TEXT)

    done = counts.get("done", 0) + counts.get("passed", 0)
    line2 = Text()
    if total > 0:
        pct = done / total * 100
        line2.append(f"{pct:.1f}%", style=_success_rate_color(pct))
        line2.append(" success rate", style=theme.LABEL)
    else:
        line2.append("no evals in this window", style=theme.TEXT_DIM)

    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.ACCENT,
                 title=Text("eval-aggregate", style=f"bold {theme.ACCENT}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))

    # ── panel 2: score stats table ──
    stats = list(data.get("score_stats", []) or [])
    if not stats:
        # No metrics (e.g. an empty/0-total slice). Match the non-empty path, which ends
        # with a trailing blank under its legend, so a following recheck-hint has separation.
        if not _quiet:
            _stderr.print()
        return
    # Worst average first (problem metrics surface at the top); no-avg metrics sort last.
    stats.sort(key=lambda s: (s.get("avg") is None, s.get("avg") if s.get("avg") is not None else 0.0))

    if show_bar is None:
        show_bar = _stdout.width >= 80  # the bar is the most expendable column on a narrow terminal

    header = ["metric", "n", "avg"] + ([""] if show_bar else []) + ["min", "max", "p50"]
    rows = []
    for s in stats:
        avg = s.get("avg")
        numeric = isinstance(avg, (int, float))
        color = _score_color(float(avg)) if numeric else theme.TEXT_DIM
        avg_label = _fmt_avg(float(avg)) if numeric else "-"
        if _no_color and numeric and float(avg) < SCORE_OK:
            avg_label += "!"
        row = [
            Text(str(s.get("key", "")), style=theme.TEXT),
            Text(str(s.get("count", 0)), style=theme.TEXT_DIM),
            Text(avg_label, style=color),
        ]
        if show_bar:
            row.append(_avg_bar(float(avg) if numeric else None))
        for k in ("min", "max", "p50"):
            v = s.get(k)
            row.append(Text(_fmt_score_num(float(v)) if isinstance(v, (int, float)) else "-", style=theme.TEXT_DIM))
        rows.append(row)

    title = Text()
    title.append("score stats", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(stats)} metrics · sorted by avg", style=theme.LABEL)
    render_list_panel("score stats", header=header, rows=rows, days=set(), order=None,
                      empty_message="no scores", title=title)
    # one dim legend line under the panel (stderr chrome) — explains the scale + bands
    if not _quiet:
        _stderr.print(_score_bar_legend())
        _stderr.print()


# ── errors (errors list + errors-aggregate card) — presentation only ─────────


def _truncate(s: str, n: int = 80) -> str:
    return s[: n - 1] + "…" if len(s) > n else s


def _event_cell(event_type: str) -> Text:
    """The errors ``event`` cell: ``● {event_type}``. Red when the type itself names an error
    (`error`/`fail` substring) — the only coloured marker; everything else is neutral dim. No
    per-event-type colour map (the CLI has no fixed enum). NO_COLOR: ``! {type}`` marks errors."""
    et = event_type or "-"
    is_err = "error" in et.lower() or "fail" in et.lower()
    t = Text()
    if _no_color:
        t.append("! " if is_err else "  ")  # '!' marks error rows; pad others to align
        t.append(et)
    else:
        t.append("● ", style=theme.ERROR if is_err else theme.FAINT)
        t.append(et, style=theme.ERROR if is_err else theme.TEXT_DIM)
    return t


def _errors_title(count: int, order: Optional[str], days) -> Text:
    """The errors-list title — red ``errors`` word + dim-red metadata."""
    t = Text()
    t.append("errors", style=f"bold {theme.ERROR}")
    t.append(f" · {count}", style=theme.TITLE_ERROR_DIM)
    t.append(f" · {'oldest first' if order == 'asc' else 'newest first'}", style=theme.TITLE_ERROR_DIM)
    if days:
        span = f"{min(days)} → {max(days)}" if len(days) > 1 else str(next(iter(days)))
        t.append(f" · {span}", style=theme.TITLE_ERROR_DIM)
    return t


def render_errors(items: Sequence[Any], *, order: Optional[str] = None, full_ids: bool = False,
                  empty_message: str = "no errors") -> None:
    """The ``errors`` list view (stdout): an error-themed (muted red-purple border) boxed table —
    columns ``time · event · env · agent · session · summary``. agent/summary bright, the rest
    contextual-dim; the event marker is red only when the type names an error. The ``summary``
    is the server-computed ``summary`` field from the light ``/events/summary`` feed (the CLI
    never parses the raw payload) and truncates with `…` (never wraps). When empty the caller
    passes a filter-aware ``empty_message``. ``--json``/``--fields`` skip this."""
    tcells, days = _row_times([_parse_iso(getattr(e, "ts", "")) for e in items])
    times = [t if t is not None else (getattr(e, "ts", "") or "-") for e, t in zip(items, tcells)]
    etypes = [getattr(e, "event_type", "") or "-" for e in items]
    envs = [getattr(e, "environment", "") or "-" for e in items]
    agents = [getattr(e, "agent_id", "") or "-" for e in items]
    sessions = [_short_session(getattr(e, "session_id", "") or "-", full=full_ids) for e in items]

    # Cap the summary column to the leftover width so it can run to the edge + truncate, but
    # never squeezes the fixed columns before it (same approach as the evals scores column).
    budget: Optional[int] = None
    if items:
        fixed = sum((
            max((len(x) for x in times), default=0),
            max((len(et) + 2 for et in etypes), default=0),  # "● " marker + type
            max((len(x) for x in envs), default=0),
            max((len(x) for x in agents), default=0),
            max((len(x) for x in sessions), default=0),
        ))
        budget = max(SCORES_MIN_WIDTH, _stdout.width - fixed - _LIST_CHROME)

    rows = []
    for i, e in enumerate(items):
        rows.append([
            Text(times[i], style=theme.TEXT_DIM),
            _event_cell(etypes[i]),
            Text(envs[i], style=theme.LABEL),
            Text(agents[i], style=theme.TEXT),
            Text(sessions[i], style=theme.TEXT_DIM),
            Text((getattr(e, "summary", "") or "-"), style=theme.TEXT),
        ])
    render_list_panel("errors", header=["time", "event", "env", "agent", "session", "summary"],
                      rows=rows, days=days, order=order, empty_message=empty_message,
                      last_col="ellipsis", last_col_max=budget,
                      title=_errors_title(len(items), order, days),
                      border=theme.BORDER_ERROR, rule=theme.RULE_ERROR)


def errors_footer(shown: int, *, more: bool) -> None:
    """The errors-list summary line (stderr): ``<n> shown`` + ``· more available · fp
    errors --all``. No legend (errors are the only coloured marker)."""
    if _quiet:
        return
    _stderr.print(_footer_line("errors", shown, more))
    _stderr.print()


def _relative_age(ts_iso: Optional[str]) -> str:
    """Humanize an ISO timestamp as ``8 min ago`` / ``2 hr ago`` / ``3 days ago`` (``""`` if
    unparseable). The recency is the actionable bit on the errors card."""
    dt = _parse_iso(ts_iso or "")
    if dt is None:
        return ""
    secs = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())
    if secs < 90:
        return f"{int(secs)} sec ago"
    if secs < 90 * 60:
        return f"{int(round(secs / 60))} min ago"
    if secs < 36 * 3600:
        return f"{int(round(secs / 3600))} hr ago"
    return f"{int(round(secs / 86400))} days ago"


def render_error_aggregate(data: dict) -> None:
    """The ``errors --aggregate`` card (stdout): a large red hero count + an ``across N sessions
    · N agents · last <relative>`` line, in the errors-themed red-purple panel. Zero errors →
    a calm green ``✓ no errors found`` in a neutral ACCENT panel. Presentation only."""
    total = int(data.get("total", 0) or 0)

    if total == 0:
        # Consistent red errors border regardless of count (the green ✓ carries the good news).
        panel = Panel(Text("✓ no errors found", style=theme.SUCCESS), box=ROUNDED,
                      border_style=theme.BORDER_ERROR,
                      title=Text("errors-aggregate", style=f"bold {theme.ERROR}"),
                      title_align="left", padding=(0, 1), expand=False)
        _stdout.print()
        _stdout.print(Padding(panel, (0, 0, 0, 2)))
        # Trailing blank so a following recheck-hint (when filters are active) is separated.
        if not _quiet:
            _stderr.print()
        return

    sep = theme.TITLE_ERROR_DIM
    line1 = Text()
    line1.append(str(total), style=f"bold {theme.ERROR}")  # the hero count
    line1.append("  errored events", style=theme.LABEL)

    line2 = Text()
    line2.append("across ", style=theme.FAINT)
    line2.append(str(int(data.get("sessions", 0) or 0)), style=f"bold {theme.TEXT}")
    line2.append(" sessions", style=theme.LABEL)
    line2.append("  ·  ", style=sep)
    line2.append(str(int(data.get("agents", 0) or 0)), style=f"bold {theme.TEXT}")
    line2.append(" agents", style=theme.LABEL)
    age = _relative_age(data.get("last_ts"))
    if age:
        line2.append("  ·  ", style=sep)
        line2.append("last ", style=theme.LABEL)
        line2.append(age, style=theme.ERROR)

    panel = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.BORDER_ERROR,
                  title=Text("errors-aggregate", style=f"bold {theme.ERROR}"),
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


# ── list <kind> (value discovery) — presentation only ───────────────────────

LIST_COL_HEIGHT = 8     # a column fills to this many rows, then overflows to the next
_LIST_GUTTER = 3        # spaces between columns
_LIST_CHROME = 8        # panel border + padding + left indent, reserved when capping columns


def render_value_list(kind: str, values: Sequence[str], *, description: str = "") -> None:
    """The shared ``list <kind>`` view (stdout): an ACCENT panel titled ``{kind} · {n} {desc}``
    (the count ``{n}`` glows bold-white) with the (sorted) values in **column-major flow** — fill
    a column of ``LIST_COL_HEIGHT``, then overflow to the next; the column count is capped to the
    terminal width (preferring taller over wider-than-screen, min one column). Empty → ``none
    found``."""
    vals = sorted(values)
    n = len(vals)

    if n == 0:
        body: Any = Text("none found", style=theme.TEXT_DIM)
    else:
        col_w = max(len(v) for v in vals) + _LIST_GUTTER
        max_cols = max(1, (_stdout.width - _LIST_CHROME) // col_w)
        height = LIST_COL_HEIGHT
        ncols = -(-n // height)               # ceil(n / height)
        if ncols > max_cols:                  # too wide → fewer columns, taller
            ncols = max_cols
            height = -(-n // ncols)
        columns = [vals[i * height:(i + 1) * height] for i in range(ncols)]
        nrows = len(columns[0])
        table = Table(box=None, pad_edge=False, show_header=False, padding=(0, _LIST_GUTTER, 0, 0))
        for _ in range(ncols):
            table.add_column(no_wrap=True, style=theme.TEXT)
        for r in range(nrows):
            table.add_row(*[(columns[c][r] if r < len(columns[c]) else "") for c in range(ncols)])
        body = table

    title = Text()
    title.append(kind, style=f"bold {theme.ACCENT}")
    title.append(" · ", style=theme.FAINT)
    title.append(str(n), style="bold white")  # the count glows white — the headline of the list
    if description:
        title.append(f" {description}", style=theme.LABEL)
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=title,
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


# ── keys (list box + destructive confirm/cancel + secret reveal) ─────────────

# Key status → (marker, colour). A small fixed enum; filled ● = live/usable,
# hollow ○ = dead/unusable. Unknown statuses fall back to a neutral dim dot.
_KEY_STATUS = {
    "active": ("●", theme.SUCCESS),
    "pending": ("●", theme.AMBER),
    "revoked": ("○", theme.ERROR),
    "expired": ("○", theme.ERROR),
    "disabled": ("○", theme.ERROR),
}


def _short_id(value: str) -> str:
    """A long id → ``1f58…9826`` (first 4 + ``…`` + last 4); short ids unchanged."""
    return value[:4] + "…" + value[-4:] if len(value) > 9 else value


def _short_chat_id(value: str) -> str:
    """A chat id → its short, copy-friendly handle: the segment before the first ``-`` (the first
    8 hex of a UUID, e.g. ``07854990-dade-…`` → ``07854990``), or the first 8 chars when there's no
    ``-``. The CLI resolves this prefix back to the full id against the chat list, while the server
    keeps the full id intact."""
    s = str(value or "")
    if "-" in s:
        return s.split("-", 1)[0]
    return s[:8] if len(s) > 8 else s


def _fmt_key_created(iso: str) -> str:
    """Compact key-created stamp: ``MM-DD HH:MM`` (year/seconds dropped); raw if unparsable."""
    dt = _parse_iso(iso)
    return dt.strftime("%m-%d %H:%M") if dt is not None else (iso or "-")


def _key_status_cell(status: str) -> Text:
    marker, color = _KEY_STATUS.get(status.lower(), ("●", theme.FAINT))
    label_style = color if status.lower() in _KEY_STATUS else theme.TEXT_DIM
    t = Text()
    t.append(marker + " ", style=color if status.lower() in _KEY_STATUS else theme.FAINT)
    t.append(status, style=label_style)
    return t


def render_keys(keys: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``keys list`` view (stdout): an ACCENT panel titled ``api keys · {n} · active first``
    with columns ``created · name · permissions · status`` (status colour-coded by the key-status
    enum). **Active keys sort to the top** (then revoked), each group newest-first. ``show_id``
    prepends a short id column. The raw id / full ISO live only in ``--json``."""
    items = sorted(keys, key=lambda k: getattr(k, "created_at", "") or "", reverse=True)  # newest first
    items.sort(key=lambda k: 1 if getattr(k, "revoked_at", None) else 0)  # then active(0) before revoked(1)

    header = (["id"] if show_id else []) + ["created", "name", "permissions", "status"]
    rows = []
    for k in items:
        status = "revoked" if getattr(k, "revoked_at", None) else "active"
        row = [Text(_short_id(getattr(k, "id", "") or "-"), style=theme.TEXT_DIM)] if show_id else []
        row += [
            Text(_fmt_key_created(getattr(k, "created_at", "")), style=theme.TEXT_DIM),
            Text(getattr(k, "name", "") or "-", style=theme.TEXT),
            Text(str(len(getattr(k, "permissions", []) or [])), style=theme.TEXT_DIM),
            _key_status_cell(status),
        ]
        rows.append(row)

    title = Text()
    title.append("api keys", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)} · active first", style=theme.LABEL)
    render_list_panel("api keys", header=header, rows=rows, days=set(), order=None,
                      empty_message="no keys", title=title)


def keys_footer(keys: Sequence[Any]) -> None:
    """Status summary under the keys box (stderr): ``{total} keys · {n} active · {m} revoked``,
    each count in its status colour. Built from the actual statuses present."""
    if _quiet:
        return
    total = len(keys)
    active = sum(1 for k in keys if not getattr(k, "revoked_at", None))
    revoked = total - active
    line = Text("  ")
    line.append(f"{total} keys", style=theme.LABEL)
    if active:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{active} active", style=theme.SUCCESS)
    if revoked:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{revoked} revoked", style=theme.ERROR)
    _stderr.print(line)
    _stderr.print()


def _notice_box(body: Any, *, color: str, title: str) -> None:
    """A small rounded notice box (stderr): ``color``-bordered, ``title`` in the border, ``body``
    a pre-styled Text/Group. The colour carries the meaning (amber confirm / red error / green
    success / faint neutral). The shared shape for the key-action flow states, so the whole
    `keys` surface reads as one boxed family."""
    panel = Panel(body, box=ROUNDED, border_style=color,
                  title=Text(title, style=f"bold {color}"), title_align="left",
                  padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(panel, (0, 0, 0, 2)))


def confirm_prompt(action: str, target: str, consequence: str, *,
                   glyph: str = "⚠", color: Optional[str] = None, title: str = "confirm") -> bool:
    """Render a boxed confirm prompt (stderr) and ask ``[y/N]`` (default NO): a ``color``-bordered
    ``title`` box holding ``{glyph} {action} {target}?`` + the dim consequence, then a
    ``confirm? [y/N]`` line below it. Returns the answer. Defaults to the amber ⚠ destructive
    shape (shared by the key actions + ``users disable``); ``users enable`` passes the calm ACCENT
    ``↑`` re-activation glyph instead (enabling restores access — not a warning)."""
    color = color or theme.AMBER
    line1 = Text()
    line1.append(f"{glyph}  ", style=f"bold {color}")
    line1.append(action, style=theme.TEXT)
    line1.append(" ")
    line1.append(target, style=f"bold {theme.ACCENT}")
    line1.append("?", style=theme.TEXT)
    _notice_box(Group(line1, Text(consequence, style=theme.LABEL)), color=color, title=title)
    return typer.confirm(_ansi("  confirm?", dim=True), default=False, err=True, prompt_suffix=" ")


def print_cancelled(message: str = "nothing changed") -> None:
    """The calm cancel box (stderr): a faint ``cancelled`` box (``○ {message}``). NOT an error —
    declining a destructive action is a good outcome. Shared by the destructive key actions
    (``message`` lets update say ``permissions unchanged``)."""
    body = Text()
    body.append("○ ", style=theme.FAINT)
    body.append(message, style=theme.LABEL)
    _notice_box(body, color=theme.FAINT, title="cancelled")


def key_error(message: str) -> None:
    """A red error box (stderr) for a plain key-action error message (bad permission token, …)."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append(message, style=theme.TEXT)
    _notice_box(body, color=theme.ERROR, title="error")


def key_exists(name: str) -> None:
    """A red error box (stderr): ``✗ a key named <name> already exists``."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append("a key named ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append(" already exists", style=theme.TEXT)
    _notice_box(body, color=theme.ERROR, title="error")


def key_action_line(action: str, name: str, count: int) -> None:
    """The shared create/update success line (stderr): ``✓ created key <name> · N permissions``
    or ``✓ updated key <name> · now N permissions``."""
    line = Text("  ")
    line.append("✓ ", style=theme.SUCCESS)
    if action == "created":
        line.append("created key ", style=theme.TEXT)
        line.append(name, style=theme.ACCENT)
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{count} permissions", style=theme.LABEL)
    else:  # updated
        line.append("updated key ", style=theme.TEXT)
        line.append(name, style=theme.ACCENT)
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"now {count} permissions", style=theme.LABEL)
    _stderr.print()
    _stderr.print(line)


def permissions_box(permissions: Sequence[str]) -> None:
    """Print the shared grouped permissions panel to stderr — the create/update ending (same
    component as ``whoami`` / ``orgs perms``, so a granted set reads identically CLI-wide)."""
    _stderr.print(render_permissions_panel(permissions))
    _stderr.print()


# ── keys: show / created / updated cards (mirror the users cards) ────────────


def _key_card_lines(key: Any) -> tuple:
    """The two identity-card lines shared by ``keys show`` (ACCENT) and ``keys created`` (green):
    line 1 the key name (bold); line 2 ``created {date} · {n} permissions · {status}`` (status
    ● active / ○ revoked from ``revoked_at``). Mirrors ``_user_card_lines``."""
    revoked = bool(getattr(key, "revoked_at", None))
    line1 = Text(key.name or "-", style=f"bold {theme.TEXT}")
    line2 = Text()
    line2.append("created ", style=theme.LABEL)
    line2.append(_fmt_key_created(getattr(key, "created_at", "")), style=theme.TEXT)
    line2.append(" · ", style=theme.FAINT)
    line2.append(f"{len(key.permissions)} permissions", style=theme.LABEL)
    line2.append(" · ", style=theme.FAINT)
    line2.append_text(_key_status_cell("revoked" if revoked else "active"))
    return line1, line2


def render_key_show(key: Any) -> None:
    """The ``keys show <name>`` view (stdout): an identity card (``key``) then the shared grouped
    permissions panel with ALL the key's grants — the key analogue of ``users show``."""
    line1, line2 = _key_card_lines(key)
    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.ACCENT,
                 title=Text("key", style=f"bold {theme.ACCENT}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))
    _stdout.print(render_permissions_panel(key.permissions))
    _stdout.print()


def render_key_created(key: Any) -> None:
    """The ``keys create`` identity card (stderr chrome): a GREEN-bordered ``key created`` card —
    the green border is the success signal. The caller prints the secret box + permissions panel
    after it (so the secret stays prominent). Mirrors ``render_user_created``."""
    line1, line2 = _key_card_lines(key)
    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("key created", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def render_key_updated(key: Any, *, added: Sequence[str], removed: Sequence[str],
                       union: Sequence[str]) -> None:
    """The ``keys update`` result (stderr chrome): a GREEN summary card (``permissions updated ·
    {name}`` / ``now {n} · +{a} added · −{r} removed``) then the shared permissions panel in DIFF
    mode + a dim legend. The key analogue of ``render_user_updated`` (keys have no role/set)."""
    a, r = len(added), len(removed)
    summary = Text()
    summary.append(f"now {len(key.permissions)}", style=theme.LABEL)
    summary.append(" · ", style=theme.FAINT)
    summary.append(f"+{a} added", style=theme.SUCCESS)
    summary.append(" · ", style=theme.FAINT)
    summary.append(f"−{r} removed", style=theme.ERROR)
    title = Text()
    title.append("permissions updated", style=f"bold {theme.SUCCESS}")
    title.append(" · ", style=theme.FAINT)
    title.append(key.name or "-", style=f"bold {theme.SUCCESS}")
    card = Panel(summary, box=ROUNDED, border_style=theme.SUCCESS, title=title,
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))
    _stderr.print(render_permissions_panel(union, diff={"added": list(added), "removed": list(removed)}))
    _stderr.print(perm_diff_legend())
    _stderr.print()


def key_no_change() -> None:
    """Calm no-op box (stderr) for ``keys update``: ``○ no change — permissions already match``."""
    body = Text()
    body.append("○ ", style=theme.FAINT)
    body.append("no change — permissions already match", style=theme.LABEL)
    _notice_box(body, color=theme.FAINT, title="no change")


def confirm_key_update(name: str, added: int, removed: int) -> bool:
    """The amber ``keys update`` confirm (stderr) showing the diff SCALE: ``⚠ change permissions on
    key {name}?`` + ``+{a} / −{r} — the key keeps working, only its permissions change`` + ``confirm?
    [y/N]`` (default NO). Mirrors ``confirm_user_update``."""
    line1 = Text()
    line1.append("⚠  ", style=f"bold {theme.AMBER}")
    line1.append("change permissions on key ", style=theme.TEXT)
    line1.append(name, style=f"bold {theme.ACCENT}")
    line2 = Text("   ")
    line2.append(f"+{added}", style=theme.SUCCESS)
    line2.append(" / ", style=theme.FAINT)
    line2.append(f"−{removed}", style=theme.ERROR)
    line2.append(" — the key keeps working, only its permissions change", style=theme.LABEL)
    return confirm_line(line1, line2)


def render_created_secret_box(secret: str) -> None:
    """The ``secret · shown once`` reveal box (stderr) for ``keys create``: green panel with the
    secret on its own highlighted line + a ⚠ copy-it-now warning. The raw secret is printed to
    stdout SEPARATELY by the caller (so a pipe captures just the secret)."""
    sec = Text("  ")
    sec.append(f" {secret} ", style=f"bold {theme.SUCCESS} on #13211c")
    warn = Text()
    warn.append("⚠ ", style=theme.AMBER)
    warn.append("copy it now — it can't be retrieved again", style=theme.LABEL)
    _notice_box(Group(sec, warn), color=theme.SUCCESS, title="secret · shown once")


def key_not_found(name: str) -> None:
    """A red error box (stderr): ``✗ no key named <name>`` + a dim hint."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append("no key named ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    hint = Text()
    hint.append("run ", style=theme.FAINT)
    hint.append("fp keys list", style=theme.ACCENT)
    hint.append(" to see your keys", style=theme.FAINT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def key_already_disabled(name: str) -> None:
    """A calm no-op box (stderr): ``○ key <name> is already disabled``."""
    body = Text()
    body.append("○ ", style=theme.FAINT)
    body.append("key ", style=theme.LABEL)
    body.append(name, style=theme.ACCENT)
    body.append(" is already disabled", style=theme.LABEL)
    _notice_box(body, color=theme.FAINT, title="no change")


def key_disabled(name: str) -> None:
    """A green success box (stderr): ``✓ disabled key <name> · it can no longer be used``."""
    body = Text()
    body.append("✓ ", style=theme.SUCCESS)
    body.append("disabled key ", style=theme.TEXT)
    body.append(name, style=theme.ACCENT)
    body.append("  ·  ", style=theme.FAINT)
    body.append("it can no longer be used", style=theme.LABEL)
    _notice_box(body, color=theme.SUCCESS, title="disabled")


def render_secret_box(name: str, secret: str) -> None:
    """The ``secret rotated`` reveal box (stderr) for an interactive regenerate: green panel,
    the secret on its own highlighted line, a ⚠ shown-once warning. The raw secret is printed
    to stdout SEPARATELY by the caller (so a pipe captures just the secret)."""
    head = Text()
    head.append("✓ ", style=theme.SUCCESS)
    head.append("new secret for key ", style=theme.TEXT)
    head.append(name, style=theme.ACCENT)
    secret_line = Text("  ")
    secret_line.append(f" {secret} ", style=f"bold {theme.SUCCESS} on #13211c")  # stands out, easy to select
    warn = Text()
    warn.append("⚠ shown once", style=theme.AMBER)
    warn.append(" — copy it now, it can't be retrieved again", style=theme.LABEL)
    _notice_box(Group(head, Text(), secret_line, Text(), warn), color=theme.SUCCESS, title="secret rotated")


# ── users (member list + identity cards + create/update/disable/enable flows) ─

# The protected-member marker. 🔒 renders inconsistently across fonts/terminals, so it lives
# in its own fixed-width column (Rich pads it → a misrender can't shift later columns) and
# falls back to a text ``P`` under NO_COLOR / a non-unicode terminal. One swappable constant.
LOCK_GLYPH = "🔒"


def _unicode_ok() -> bool:
    enc = str(getattr(_stdout, "encoding", "utf-8") or "utf-8").lower()
    return not _no_color and "utf" in enc


def _lock_text(*, inline: bool = False) -> Text:
    """The protected marker as a Text — 🔒 (amber) or the ``P`` fallback. ``inline`` adds the
    trailing `` protected`` word (the identity-card / footer form)."""
    glyph = LOCK_GLYPH if _unicode_ok() else "P"
    t = Text()
    t.append(glyph, style=theme.AMBER)
    if inline:
        t.append(" protected", style=theme.AMBER)
    return t


def _lock_cell(protected: bool) -> Text:
    """The leading list-column marker: 🔒/``P`` (amber) for a protected member, else blank."""
    return _lock_text() if protected else Text("")


def _user_status_cell(disabled: bool, *, muted: bool = False) -> Text:
    """Member status derived from ``disabled_at``: ``● active`` (green) / ``○ disabled``. In a
    dimmed list row the disabled status is muted (``muted``); on the identity card it's red."""
    t = Text()
    if disabled:
        c = theme.TEXT_DIM if muted else theme.ERROR
        t.append("○ ", style=c)
        t.append("disabled", style=c)
    else:
        t.append("● ", style=theme.SUCCESS)
        t.append("active", style=theme.SUCCESS)
    return t


def _fmt_user_joined(iso: str, multi_year: bool) -> str:
    """Compact join date from ``created_at``: ``MM-DD`` (``YYYY-MM-DD`` when the list spans
    more than one year); ``-`` if unparsable."""
    dt = _parse_iso(iso)
    if dt is None:
        return "-"
    return dt.strftime("%Y-%m-%d" if multi_year else "%m-%d")


def render_users(users: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``users list`` view (stdout): an ACCENT panel titled ``users · {n}`` with columns
    ``[lock] email · access · permissions · joined · status``. A leading narrow column carries the
    protected 🔒 (amber, blank otherwise). Active members sort to the top (then disabled, which are
    fully dimmed so active members dominate); status is derived from ``disabled_at``. ``joined``
    (from ``created_at``) only appears if at least one member has it. ``show_id`` adds a short id
    column. The raw id / full timestamps live only in ``--json``."""
    items = sorted(users, key=lambda u: 1 if u.disabled_at else 0)  # stable: active first
    parsed = [_parse_iso(u.created_at) for u in items]
    has_joined = any(p is not None for p in parsed)
    multi_year = len({p.year for p in parsed if p is not None}) > 1

    header = ([""] + (["id"] if show_id else []) + ["email", "access", "perms"]
              + (["joined"] if has_joined else []) + ["status"])
    rows = []
    for u in items:
        disabled = bool(u.disabled_at)
        email_style = theme.TEXT_DIM if disabled else theme.TEXT
        dim = theme.FAINT if disabled else theme.TEXT_DIM
        row: List[Text] = [_lock_cell(u.is_protected)]
        if show_id:
            row.append(Text(_short_id(u.id or "-"), style=dim))
        row.append(Text(u.email or "-", style=email_style))
        row.append(Text(u.permission_set or "—", style=dim))
        row.append(Text(str(len(u.permissions)), style=dim))
        if has_joined:
            row.append(Text(_fmt_user_joined(u.created_at, multi_year), style=dim))
        row.append(_user_status_cell(disabled, muted=disabled))
        rows.append(row)

    title = Text()
    title.append("users", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)}", style=theme.LABEL)
    render_list_panel("users", header=header, rows=rows, days=set(), order=None,
                      empty_message="no users", title=title)


def users_footer(users: Sequence[Any]) -> None:
    """Membership-health summary under the users box (stderr): ``{total} users · {n} active ·
    {m} disabled · 🔒 {p} protected``, each count in its colour. The protected segment is omitted
    when zero; ``P`` replaces 🔒 under NO_COLOR / non-unicode."""
    if _quiet:
        return
    total = len(users)
    active = sum(1 for u in users if not u.disabled_at)
    disabled = total - active
    protected = sum(1 for u in users if u.is_protected)
    line = Text("  ")
    line.append(f"{total} users", style=theme.LABEL)
    if active:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{active} active", style=theme.SUCCESS)
    if disabled:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{disabled} disabled", style=theme.ERROR)
    if protected:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{LOCK_GLYPH if _unicode_ok() else 'P'} {protected} protected", style=theme.AMBER)
    _stderr.print(line)
    _stderr.print()


def _user_card_lines(user: Any) -> tuple:
    """The two identity-card lines shared by ``users show`` (ACCENT) and ``users created``
    (green): line 1 the email (bold) + ``🔒 protected`` when protected; line 2
    ``access {set} · {n} permissions · {status}``."""
    line1 = Text()
    line1.append(user.email or "-", style=f"bold {theme.TEXT}")
    if user.is_protected:
        line1.append("  ")
        line1.append_text(_lock_text(inline=True))
    line2 = Text()
    line2.append("access ", style=theme.LABEL)
    line2.append(user.permission_set or "—", style=theme.TEXT)
    line2.append(" · ", style=theme.FAINT)
    line2.append(f"{len(user.permissions)} permissions", style=theme.LABEL)
    line2.append(" · ", style=theme.FAINT)
    line2.append_text(_user_status_cell(bool(user.disabled_at)))
    return line1, line2


def render_user_show(user: Any) -> None:
    """The ``users show <email>`` view (stdout): an identity card (``user``) then the shared
    grouped permissions panel with ALL the member's effective grants (no truncation — this is a
    single-member detail view)."""
    line1, line2 = _user_card_lines(user)
    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.ACCENT,
                 title=Text("user", style=f"bold {theme.ACCENT}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))
    _stdout.print(render_permissions_panel(user.permissions))
    _stdout.print()


def render_user_created(user: Any) -> None:
    """The ``users create`` success view (stderr chrome): a GREEN-bordered ``user created``
    identity card (the green border is the success signal — no tick) then the shared permissions
    panel titled ``permissions · {n} · {set}``, showing all the new member's grants."""
    line1 = Text()
    line1.append(user.email or "-", style=f"bold {theme.TEXT}")
    line2 = Text()
    line2.append("access ", style=theme.LABEL)
    line2.append(user.permission_set or "—", style=theme.TEXT)
    line2.append(" · ", style=theme.FAINT)
    line2.append(f"{len(user.permissions)} permissions", style=theme.LABEL)
    line2.append(" · ", style=theme.FAINT)
    line2.append("● active", style=theme.SUCCESS)
    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("user created", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))
    _stderr.print(render_permissions_panel(user.permissions, suffix=user.permission_set or None))
    _stderr.print()


def confirm_user_update(email: str, added: int, removed: int) -> bool:
    """The amber update confirm (stderr) showing the diff SCALE before committing: ``⚠ change
    permissions for {email}?`` + ``this replaces their current grants +{a} / −{r} (the user keeps
    access)`` with the counts coloured, then ``confirm? [y/N]`` (default NO). Calm framing — a
    permission change is reversible and doesn't lock the user out."""
    line1 = Text()
    line1.append("⚠  ", style=f"bold {theme.AMBER}")
    line1.append("change permissions for ", style=theme.TEXT)
    line1.append(email, style=f"bold {theme.ACCENT}")
    line1.append("?", style=theme.TEXT)
    line2 = Text()
    line2.append("this replaces their current grants ", style=theme.LABEL)
    line2.append(f"+{added}", style=theme.SUCCESS)
    line2.append(" / ", style=theme.FAINT)
    line2.append(f"−{removed}", style=theme.ERROR)
    line2.append(" (the user keeps access)", style=theme.LABEL)
    _notice_box(Group(line1, line2), color=theme.AMBER, title="confirm")
    return typer.confirm(_ansi("  confirm?", dim=True), default=False, err=True, prompt_suffix=" ")


def render_user_updated(user: Any, *, added: Sequence[str], removed: Sequence[str],
                        union: Sequence[str]) -> None:
    """The ``users update`` result (stderr chrome): a GREEN summary card (``permissions updated ·
    {email}`` / ``{role} · now {n} · +{a} added · −{r} removed``) then the shared permissions panel
    in DIFF mode — added grants as green chips, removed as red struck ghosts, unchanged dim — plus
    a dim legend line."""
    a, r = len(added), len(removed)
    summary = Text()
    summary.append(user.permission_set or "—", style=theme.LABEL)
    summary.append(" · ", style=theme.FAINT)
    summary.append(f"now {len(user.permissions)}", style=theme.LABEL)
    summary.append(" · ", style=theme.FAINT)
    summary.append(f"+{a} added", style=theme.SUCCESS)
    summary.append(" · ", style=theme.FAINT)
    summary.append(f"−{r} removed", style=theme.ERROR)
    title = Text()
    title.append("permissions updated", style=f"bold {theme.SUCCESS}")
    title.append(" · ", style=theme.FAINT)
    title.append(user.email or "-", style=f"bold {theme.SUCCESS}")
    card = Panel(summary, box=ROUNDED, border_style=theme.SUCCESS, title=title,
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))
    _stderr.print(render_permissions_panel(union, diff={"added": list(added), "removed": list(removed)}))
    _stderr.print(perm_diff_legend())
    _stderr.print()


def _user_notice(mark: str, color: str, title: str, body_parts: Sequence[tuple],
                 *, hint: Optional[tuple] = None) -> None:
    """Build + print a small user-flow notice box (stderr). ``body_parts`` is a list of
    ``(text, style)`` segments after the ``mark``; ``hint`` an optional second dim line built
    the same way (with command refs in ACCENT)."""
    body = Text()
    if mark:
        body.append(f"{mark} ", style=f"bold {color}" if color != theme.FAINT else theme.FAINT)
    for text, style in body_parts:
        body.append(text, style=style)
    group: Any = body
    if hint is not None:
        hint_line = Text()
        for text, style in hint:
            hint_line.append(text, style=style)
        group = Group(body, hint_line)
    _notice_box(group, color=color, title=title)


def user_not_found(email: str) -> None:
    """Red error box (stderr): ``✗ no user with email "<email>"`` + a dim hint."""
    _user_notice("✗", theme.ERROR, "error",
                 [('no user with email "', theme.TEXT), (email, f"bold {theme.ACCENT}"), ('"', theme.TEXT)],
                 hint=[("run ", theme.FAINT), ("fp users list", theme.ACCENT),
                       (" to see members", theme.FAINT)])


def user_exists(email: str) -> None:
    """Red error box (stderr): ``✗ a user with email "<email>" already exists``."""
    _user_notice("✗", theme.ERROR, "error",
                 [('a user with email "', theme.TEXT), (email, f"bold {theme.ACCENT}"),
                  ('" already exists', theme.TEXT)])


def user_error(message: str) -> None:
    """Red error box (stderr) for a plain user-action error message (bad permission token, …)."""
    _user_notice("✗", theme.ERROR, "error", [(message, theme.TEXT)])


def user_no_change() -> None:
    """Calm no-op box (stderr): ``○ no change — permissions already match`` (exit 0, no change)."""
    _user_notice("○", theme.FAINT, "no change",
                 [("no change — permissions already match", theme.LABEL)])


def user_disabled(email: str) -> None:
    """Green success box (stderr): ``✓ disabled <email> · they can no longer sign in`` + a dim
    ``re-enable with fp users enable <email>`` pointer (disabling is reversible)."""
    _user_notice("✓", theme.SUCCESS, "disabled",
                 [("disabled ", theme.TEXT), (email, theme.ACCENT),
                  ("  ·  ", theme.FAINT), ("they can no longer sign in", theme.LABEL)],
                 hint=[("re-enable with ", theme.FAINT),
                       (f"fp users enable {email}", theme.ACCENT)])


def user_already_disabled(email: str) -> None:
    """Calm no-op box (stderr): ``○ user "<email>" is already disabled``."""
    _user_notice("○", theme.FAINT, "no change",
                 [('user "', theme.LABEL), (email, theme.ACCENT), ('" is already disabled', theme.LABEL)])


def user_protected_disable(email: str) -> None:
    """Red error box (stderr): ``✗ "<email>" is protected and can't be disabled``."""
    _user_notice("✗", theme.ERROR, "error",
                 [('"', theme.TEXT), (email, f"bold {theme.ACCENT}"),
                  ('" is protected and can\'t be disabled', theme.TEXT)])


def user_self_disable() -> None:
    """Red error box (stderr): ``✗ you can't disable your own account``."""
    _user_notice("✗", theme.ERROR, "error", [("you can't disable your own account", theme.TEXT)])


def user_enabled(email: str) -> None:
    """Green success box (stderr): ``✓ enabled <email> · they can sign in again``."""
    _user_notice("✓", theme.SUCCESS, "enabled",
                 [("enabled ", theme.TEXT), (email, theme.ACCENT),
                  ("  ·  ", theme.FAINT), ("they can sign in again", theme.LABEL)])


def user_already_active(email: str) -> None:
    """Calm no-op box (stderr): ``○ user "<email>" is already active``."""
    _user_notice("○", theme.FAINT, "no change",
                 [('user "', theme.LABEL), (email, theme.ACCENT), ('" is already active', theme.LABEL)])


# ── saved queries (list box + show: metadata card + highlighted SQL) ─────────

# The saved-query SQL runs against the read-only analytics pool (ClickHouse). The lexer is
# generic `sql` (Pygments handles ClickHouse funcs fine); the label is shown in the sql box title.
QUERY_SQL_DIALECT = "clickhouse"

_sql_theme_cache: Any = None


def _sql_syntax_theme():
    """A custom Pygments syntax theme mapping SQL tokens to the brand palette (keywords ACCENT,
    functions/builtins green, strings amber, numbers/params pink, identifiers TEXT, comments
    faint). Built + cached lazily so the (heavyish) pygments import only happens on ``query show``,
    not on every CLI invocation."""
    global _sql_theme_cache
    if _sql_theme_cache is None:
        from pygments.style import Style
        from pygments.token import (Comment, Keyword, Name, Number, Operator,
                                     Punctuation, String, Token)
        from rich.syntax import PygmentsSyntaxTheme

        class _FpSqlStyle(Style):
            background_color = "#0e0c12"  # overridden by Syntax(background_color="default")
            styles = {
                Token: theme.TEXT,
                Comment: f"italic {theme.FAINT}",
                Keyword: f"bold {theme.ACCENT}",
                Keyword.Type: theme.SCORE_HIGH,
                Operator: theme.TEXT_DIM,
                Operator.Word: f"bold {theme.ACCENT}",  # AND / OR / NOT
                Name: theme.TEXT,
                Name.Builtin: theme.SUCCESS,
                Name.Function: theme.SUCCESS,
                Name.Variable: theme.PERM_WRITE,  # :name / @var params
                String: theme.AMBER,
                String.Symbol: theme.AMBER,
                Number: theme.PERM_WRITE,
                Punctuation: theme.TEXT_DIM,
            }

        _sql_theme_cache = PygmentsSyntaxTheme(_FpSqlStyle)
    return _sql_theme_cache


def _fmt_query_date_full(iso: str) -> str:
    """The query detail-card date: full ``YYYY-MM-DD`` (``-`` if unparsable)."""
    dt = _parse_iso(iso)
    return dt.strftime("%Y-%m-%d") if dt is not None else "-"


def _created_by_cell(created_by: Optional[str]) -> Text:
    """``created_by`` cell: built-in ``system`` queries dim, a real username brighter (TEXT) so
    team-made vs built-in is distinguishable at a glance."""
    cb = created_by or "system"
    return Text(cb, style=theme.TEXT_DIM if cb == "system" else theme.TEXT)


def render_queries(queries: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``query list`` view (stdout): an ACCENT panel titled ``saved queries · {n}`` with columns
    ``name · description · created by · created``. The long ``description`` is truncated to ONE line
    (`…`) on a width budget so rows never grow; ``created`` is the compact ``created_at`` (`MM-DD`,
    `YYYY-MM-DD` if the list spans years) — ``updated_at`` is not shown. ``name`` is the handle
    (`query run`/`query show`); the raw id is hidden unless ``show_id``. Full description + ISO live
    only in ``--json``. Newest-created first, then by name."""
    items = sorted(queries, key=lambda q: q.name or "")
    items.sort(key=lambda q: q.created_at or "", reverse=True)  # newest first, name tiebreak
    parsed = [_parse_iso(q.created_at) for q in items]
    multi_year = len({p.year for p in parsed if p is not None}) > 1

    names = [q.name or "-" for q in items]
    ids = [_short_id(q.id or "-") for q in items] if show_id else []
    created_by = [(q.created_by or "system") for q in items]
    created = [_fmt_user_joined(q.created_at, multi_year) for q in items]

    header = (["id"] if show_id else []) + ["name", "description", "created by", "created"]
    # Budget the description to the leftover width so every row stays one line. The other
    # columns size to max(header, value) — so the wider HEADER ("created by") is counted, else
    # the description over-runs and squeezes `name`. Reserve per-column padding + panel chrome.
    budget: Optional[int] = None
    if items:
        def _col_w(label: str, vals) -> int:
            return max(len(label), max((len(x) for x in vals), default=0))
        fixed = (_col_w("name", names) + _col_w("created by", created_by) + _col_w("created", created)
                 + (_col_w("id", ids) if show_id else 0))
        budget = max(SCORES_MIN_WIDTH, _stdout.width - fixed - (2 * len(header) + 8))

    rows = []
    for i, q in enumerate(items):
        desc = " ".join((q.description or "").split())  # collapse newlines/runs → one line
        if budget is not None:
            desc = _truncate(desc, budget)
        row = ([Text(ids[i], style=theme.TEXT_DIM)] if show_id else []) + [
            Text(names[i], style=theme.TEXT),
            Text(desc or "—", style=theme.TEXT_DIM),
            _created_by_cell(created_by[i]),
            Text(created[i], style=theme.TEXT_DIM),
        ]
        rows.append(row)

    title = Text()
    title.append("saved queries", style=f"bold {theme.ACCENT}")
    title.append(" · ", style=theme.FAINT)
    title.append(str(len(items)), style="bold white")  # the count glows — the headline of the list
    render_list_panel("saved queries", header=header, rows=rows, days=set(), order=None,
                      empty_message="no saved queries", title=title)


def _query_sql_panel(sql_text: str, *, line_numbers: bool = True):
    """The shared SQL box: a Rich ``Syntax`` (line-numbered, no reflow, brand palette) inside an
    ACCENT ``sql · {dialect}`` panel. Returns the padded renderable so show/create/update share it."""
    from rich.syntax import Syntax

    sql = Syntax(sql_text or "", "sql", theme=_sql_syntax_theme(), line_numbers=line_numbers,
                 word_wrap=False, background_color="default", padding=(0, 1))
    sql_title = Text()
    sql_title.append("sql", style=f"bold {theme.ACCENT}")
    sql_title.append(f" · {QUERY_SQL_DIALECT}", style=theme.LABEL)
    panel = Panel(sql, box=ROUNDED, border_style=theme.ACCENT, title=sql_title,
                  title_align="left", padding=(0, 1), expand=False)
    return Padding(panel, (0, 0, 0, 2))


def render_query_show(query: Any) -> None:
    """The ``query show <name>`` view (stdout): a metadata card (``{name} · saved query`` + the FULL
    wrapped description + ``created by {who} · created {date}``) then a line-numbered,
    syntax-highlighted SQL box (``sql · {dialect}``, Rich ``Syntax`` on the brand palette, never
    truncated/reflowed). No run footer."""
    desc = (query.description or "").strip() or "—"
    meta = Text()
    meta.append("created by ", style=theme.LABEL)
    cb = query.created_by or "system"
    meta.append(cb, style=theme.TEXT_DIM if cb == "system" else theme.TEXT)
    meta.append(" · ", style=theme.FAINT)
    meta.append("created ", style=theme.LABEL)
    meta.append(_fmt_query_date_full(query.created_at), style=theme.TEXT_DIM)

    title = Text()
    title.append(query.name or "-", style=f"bold {theme.ACCENT}")
    title.append(" · saved query", style=theme.LABEL)
    # Bound the card width so a long single-line description wraps (the SQL box below is
    # content-width so its lines never reflow).
    card_width = min(max(_stdout.width - 4, 40), 80)
    card = Panel(Group(Text(desc, style=theme.TEXT_DIM), Text(), meta), box=ROUNDED,
                 border_style=theme.ACCENT, title=title, title_align="left",
                 padding=(0, 1), expand=False, width=card_width)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))
    _stdout.print(_query_sql_panel(query.sql_text or ""))
    _stdout.print()


# ── query write flows (create / update / delete) — plain feedback + data cards ─
# Design principle for the query family: BOXES carry data (the created/updated/preview cards +
# the sql box + list/show/run/schema panels); action FEEDBACK (confirm / warning / ✓ / ○ / ✗)
# is plain indented lines on stderr. (keys/users box their feedback — a deliberate query split.)


def _plain(*parts, console=None) -> None:
    """Print one plain indented stderr line built from ``(text, style)`` segments (skips under
    ``--quiet`` for non-error chrome; callers that must always show pass ``console``)."""
    line = Text("  ")
    for text, style in parts:
        line.append(text, style=style)
    (console or _stderr).print(line)


def query_not_found(name: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ no query named "<name>"`` + a dim hint to
    ``fp query list``. The boxed query-feedback family — consistent with keys/users."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append('no query named "', style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append('"', style=theme.TEXT)
    hint = Text()
    hint.append("run ", style=theme.FAINT)
    hint.append("fp query list", style=theme.ACCENT)
    hint.append(" to see saved queries", style=theme.FAINT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def query_exists(name: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ a query named <name> already exists`` + a dim hint."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append("a query named ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append(" already exists", style=theme.TEXT)
    hint = Text()
    hint.append("pick a different name, or update it with ", style=theme.FAINT)
    hint.append(f"fp query update {name}", style=theme.ACCENT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def query_failed(message: str, *, permission: bool = False) -> None:
    """Red ``error`` notice box (stderr) for a failed ``query run``. A SQL/exec failure reads
    ``✗ query failed — <server message>`` + a dim ``check your query and rerun it`` hint; a
    permission error (``permission=True``) shows just the server message (no query hint)."""
    msg = (message or "").strip()
    if permission:
        body = Text()
        body.append("✗  ", style=f"bold {theme.ERROR}")
        body.append(msg or "you don't have permission to run queries", style=theme.TEXT)
        _notice_box(body, color=theme.ERROR, title="error")
        return
    head = Text()
    head.append("✗  ", style=f"bold {theme.ERROR}")
    if not msg or msg.lower() == "query failed":
        head.append("query failed", style=theme.TEXT)
    else:
        head.append("query failed — ", style=theme.TEXT)
        head.append(msg, style=theme.TEXT)
    hint = Text("check your query and rerun it", style=theme.LABEL)
    _notice_box(Group(head, hint), color=theme.ERROR, title="error")


def query_cancelled(tail: str) -> None:
    """Faint ``cancelled`` notice box (stderr): ``○ <tail>`` (e.g. ``nothing deleted`` /
    ``nothing changed``). Declining is a good outcome, not an error."""
    if _quiet:
        return
    body = Text()
    body.append("○ ", style=theme.FAINT)
    body.append(tail, style=theme.LABEL)
    _notice_box(body, color=theme.FAINT, title="cancelled")


def confirm_line(headline: Text, consequence: Optional[Text] = None) -> bool:
    """A plain (unboxed) confirm on stderr: the pre-built ``headline`` line, an optional dim
    ``consequence`` line, then ``confirm? [y/N]`` (default NO). Returns the answer. Used by the
    query delete/update flows (the query family keeps action prompts plain, not boxed)."""
    _stderr.print()
    _stderr.print(Text("  ") + headline)
    if consequence is not None:
        _stderr.print(Text("   ") + consequence)
    return typer.confirm(_ansi("  confirm?", dim=True), default=False, err=True, prompt_suffix=" ")


def _query_card(query: Any, *, title_word: str, verb: str, old_name: Optional[str] = None) -> None:
    """The shared green created/updated card (stderr) + SQL box + run-hint. Line 1 = the (new)
    name (bold hero) + dim `` was {old}`` when renamed; line 2 = description (omitted if none);
    line 3 = ``{verb} by you · just now``. ``title_word`` is ``query created`` / ``query updated``."""
    line1 = Text()
    line1.append(query.name or "-", style=f"bold {theme.TEXT}")
    if old_name and old_name != query.name:
        line1.append("   was ", style=theme.FAINT)
        line1.append(old_name, style=theme.FAINT)
    rows = [line1]
    desc = (query.description or "").strip()
    if desc:
        rows.append(Text(desc, style=theme.TEXT_DIM))
    line3 = Text()
    line3.append(f"{verb} by ", style=theme.LABEL)
    line3.append("you", style=theme.TEXT)
    line3.append(" · ", style=theme.FAINT)
    line3.append("just now", style=theme.LABEL)
    rows.append(line3)

    card = Panel(Group(*rows), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text(title_word, style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))
    # Numbered SQL box — identical to `query show`, so create/update/show read the same. No run
    # footer, and no trailing blank (the SQL panel already carries its own left/below padding).
    _stderr.print(_query_sql_panel(query.sql_text or "", line_numbers=True))


def render_query_created(query: Any) -> None:
    """The ``query create`` success view (stderr): GREEN ``query created`` card + SQL box + run-hint."""
    _query_card(query, title_word="query created", verb="created")


def render_query_updated(query: Any, *, old_name: Optional[str] = None) -> None:
    """The ``query update`` success view (stderr): GREEN ``query updated`` card (` was {old}` when
    renamed) + SQL box + run-hint (new name)."""
    _query_card(query, title_word="query updated", verb="updated", old_name=old_name)


def render_query_delete_preview(query: Any) -> None:
    """The ``query delete`` preview (stderr): an AMBER ``delete saved query`` box showing what's
    about to be removed — name (ACCENT), one-line description, ``created by {who} · {date}`` — so
    the operator can confirm it's the right query before the prompt."""
    line1 = Text(query.name or "-", style=f"bold {theme.ACCENT}")
    desc = " ".join((query.description or "").split())
    width = min(max(_stdout.width - 4, 40), 80)
    line2 = Text(_truncate(desc, width - 4) if desc else "—", style=theme.TEXT_DIM)
    line3 = Text()
    line3.append("created by ", style=theme.LABEL)
    cb = query.created_by or "system"
    line3.append(cb, style=theme.TEXT_DIM if cb == "system" else theme.TEXT)
    line3.append(" · ", style=theme.FAINT)
    line3.append(_fmt_query_date_full(query.created_at), style=theme.TEXT_DIM)
    card = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.AMBER,
                 title=Text("delete saved query", style=f"bold {theme.AMBER}"),
                 title_align="left", padding=(0, 1), expand=False, width=width)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def query_deleted(name: str) -> None:
    """Green ``deleted`` notice box (stderr): ``✓ deleted saved query <name>``."""
    if _quiet:
        return
    body = Text()
    body.append("✓ ", style=theme.SUCCESS)
    body.append("deleted saved query ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    _notice_box(body, color=theme.SUCCESS, title="deleted")


def query_no_change() -> None:
    """Faint ``no change`` notice box (stderr): ``○ query already matches``."""
    if _quiet:
        return
    body = Text()
    body.append("○ ", style=theme.FAINT)
    body.append("query already matches", style=theme.LABEL)
    _notice_box(body, color=theme.FAINT, title="no change")


def confirm_query_delete() -> bool:
    """Plain delete confirm (stderr): ``⚠ this permanently removes the query — it can't be
    undone`` + ``confirm? [y/N]`` (the amber preview box was printed just above). Returns y/N."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("this permanently removes the query — it can't be undone", style=theme.LABEL)
    return confirm_line(h)


def confirm_query_update(name: str, fields: str) -> bool:
    """Plain update confirm (stderr): ``⚠ update saved query {name}?`` + ``this replaces its
    {fields}`` + ``confirm? [y/N]`` (calm — update is reversible). Returns y/N."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("update saved query ", style=theme.TEXT)
    h.append(name, style=f"bold {theme.ACCENT}")
    h.append("?", style=theme.TEXT)
    c = Text(f"this replaces its {fields}", style=theme.LABEL)
    return confirm_line(h, c)


# ── query run (adaptive result renderer) ─────────────────────────────────────
# The result shape is unknown (any columns/types/row counts), so ONE renderer dispatches on
# shape: 0 rows → empty; 1×1 → scalar card; 1×N → vertical record; N rows → table. Values arrive
# as strings; the column `type` (ClickHouse type name) drives numeric alignment/colour, with a
# value heuristic fallback. NEVER keyed on column NAME (the schema can't be enumerated).
QUERY_RUN_ROW_CAP = 50
_RUN_CELL_MAX = 48  # truncate a wide table cell to this many chars (keeps rows one line)
_NUMERIC_TYPE_RE = re.compile(r"int|float|decimal|numeric|double|real|^u?int", re.IGNORECASE)


def _is_numeric_type(type_str: Optional[str]) -> bool:
    return bool(type_str) and bool(_NUMERIC_TYPE_RE.search(str(type_str)))


def _looks_numeric(value: Any) -> bool:
    try:
        float(str(value).replace(",", ""))
        return True
    except (TypeError, ValueError):
        return False


def _col_is_numeric(col: dict, rows: Sequence[Sequence[Any]], i: int) -> bool:
    """Whether column ``i`` is numeric — by its declared ``type`` if present, else a value
    heuristic on the first non-null cell."""
    t = col.get("type")
    if t:
        return _is_numeric_type(t)
    for r in rows:
        v = r[i] if i < len(r) else None
        if v is not None:
            return _looks_numeric(v)
    return False


def _run_value(value: Any, numeric: bool) -> Text:
    """One result cell → styled Text: null = dim italic ``null``; numeric = pink (integers get
    thousands separators, floats keep their string precision); else TEXT."""
    if value is None:
        return Text("null", style=f"italic {theme.FAINT}")
    s = str(value)
    if numeric:
        try:
            s = f"{int(s):,}"  # thousands separators for integers
        except ValueError:
            pass               # float/decimal → keep the original precision
        return Text(s, style=theme.PINK)
    return Text(s, style=theme.TEXT)


def _run_title(name: str, n: int, ms: Optional[int]) -> Text:
    t = Text()
    t.append(name, style=f"bold {theme.ACCENT}")
    t.append(f" · {n} {'row' if n == 1 else 'rows'}", style=theme.LABEL)
    if ms is not None:
        t.append(f" · {ms}ms", style=theme.LABEL)
    return t


def _run_panel(body: Any, title: Text) -> None:
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=title,
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


def render_query_result(name: str, result: Any, *, row_cap: int = QUERY_RUN_ROW_CAP,
                        show_all: bool = False) -> None:
    """Adaptive ``query run`` result renderer (stdout): dispatches on result shape — 0 rows →
    empty card, 1×1 → scalar stat card, 1×N → vertical key/value record, N rows → boxed table
    (numeric cols right-aligned + pink, others left + TEXT, null dim italic, rows capped to
    ``row_cap`` unless ``show_all``, wide cells truncated, overflow columns dropped). Title
    ``{name} · {n} rows · {ms}ms``."""
    cols = list(result.columns or [])
    rows = list(result.rows or [])
    n, ncols = len(rows), len(cols)
    ms = getattr(result, "elapsed_ms", None)
    title = _run_title(name, n, ms)

    if n == 0:
        _run_panel(Text("no rows returned", style=theme.TEXT_DIM), title)
        return

    if n == 1 and ncols == 1:  # scalar stat card
        numeric = _col_is_numeric(cols[0], rows, 0)
        val = _run_value(rows[0][0], numeric)
        body = Text()
        body.append(val.plain, style=f"bold {theme.PINK if numeric else theme.TEXT}")
        body.append("  ")
        body.append(str(cols[0].get("name", "")), style=theme.LABEL)
        _run_panel(body, title)
        return

    if n == 1:  # single record → vertical key/value card
        kv = Table(box=None, pad_edge=False, show_header=False)
        kv.add_column(style=theme.LABEL, no_wrap=True)
        kv.add_column()
        for i, c in enumerate(cols):
            v = rows[0][i] if i < len(rows[0]) else None
            kv.add_row(str(c.get("name", "")), _run_value(v, _col_is_numeric(c, rows, i)))
        _run_panel(kv, title)
        return

    _run_table(title, cols, rows, row_cap=row_cap, show_all=show_all, total=n, ms=ms)


def _run_table(title: Text, cols: list, rows: list, *, row_cap: int, show_all: bool,
               total: int, ms: Optional[int]) -> None:
    numeric = [_col_is_numeric(cols[i], rows, i) for i in range(len(cols))]
    shown = rows if show_all else rows[:row_cap]

    # Column display widths (header vs capped cell content), then drop overflow columns from the
    # right until the table fits the terminal — keep the leftmost (most identifying) columns.
    def _cellw(i: int) -> int:
        w = len(str(cols[i].get("name", "")))
        for r in shown:
            v = r[i] if i < len(r) else None
            w = max(w, min(len(_run_value(v, numeric[i]).plain), _RUN_CELL_MAX))
        return w
    widths = [_cellw(i) for i in range(len(cols))]
    avail = max(20, _stdout.width - 6)
    keep = len(cols)
    while keep > 1 and sum(widths[:keep]) + 2 * keep > avail:
        keep -= 1
    hidden = len(cols) - keep

    table = Table(box=SIMPLE_HEAD, border_style=theme.THIN_RULE, pad_edge=False, show_edge=False,
                  show_header=True, header_style=theme.LABEL, expand=False, padding=(0, 2, 0, 0))
    for i in range(keep):
        table.add_column(str(cols[i].get("name", "")), justify="right" if numeric[i] else "left",
                         no_wrap=True, overflow="ellipsis", max_width=_RUN_CELL_MAX)
    table.add_row(*([""] * keep))  # spacer under the header rule
    for r in shown:
        table.add_row(*[_run_value(r[i] if i < len(r) else None, numeric[i]) for i in range(keep)])
    _run_panel(table, title)

    if not _quiet:
        foot = Text("  ")
        if not show_all and total > len(shown):
            foot.append(f"showing {len(shown):,} of {total:,} rows", style=theme.LABEL)
        else:
            foot.append(f"{total:,} {'row' if total == 1 else 'rows'}", style=theme.LABEL)
        foot.append("  ·  ", style=theme.FAINT)
        foot.append(f"{len(cols)} columns", style=theme.LABEL)
        if ms is not None:
            foot.append("  ·  ", style=theme.FAINT)
            foot.append(f"{ms}ms", style=theme.LABEL)
        if hidden:
            foot.append("  ·  ", style=theme.FAINT)
            foot.append(f"{hidden} columns hidden", style=theme.AMBER)
        if (not show_all and total > len(shown)) or hidden:
            foot.append("  ·  ", style=theme.FAINT)
            foot.append("fp --json query run …", style=theme.ACCENT)
            foot.append(" for all", style=theme.FAINT)
        _stderr.print(foot)
        _stderr.print()


# ── query schema (boxed, table-grouped, typed colours) ───────────────────────


def _schema_type_color(base: str) -> str:
    """Colour a base type by category (family, never by column name): numeric pink, string green,
    uuid/timestamp blue, bool amber, else neutral TEXT."""
    b = base.lower()
    if re.search(r"int|float|decimal|numeric|double|real", b):
        return theme.PINK
    if "uuid" in b:
        return theme.BLUE
    if re.search(r"time|date", b):
        return theme.BLUE
    if "bool" in b:
        return theme.AMBER
    if re.search(r"str|text|char", b):
        return theme.SUCCESS
    return theme.TEXT


def _schema_type_cell(type_str: str) -> Text:
    """``string?`` → green ``string`` + dim italic `` ?`` (the ``?`` = nullable, split from the
    base so 'what type' and 'can be null' read separately)."""
    nullable = type_str.endswith("?")
    base = type_str[:-1] if nullable else type_str
    t = Text(base, style=_schema_type_color(base))
    if nullable:
        t.append(" ?", style=f"italic {theme.TEXT_DIM}")
    return t


def render_query_schema(data: dict) -> None:
    """The ``query schema`` view (stdout): a boxed ``schema · {db} · {t} tables · {c} columns``
    panel with columns ``table · column · type``. The table name prints ONCE per group (ACCENT
    bold on the first row, blank on repeat) with a spacer row between groups; the type is coloured
    by category + a dim ``?`` for nullable. All tables/columns shown (a schema is a reference)."""
    db = data.get("schema", "")
    tables = list(data.get("tables", []) or [])
    total_cols = sum(len(t.get("columns", []) or []) for t in tables)

    rows = []
    for ti, tbl in enumerate(tables):
        tname = str(tbl.get("name", ""))
        columns = tbl.get("columns", []) or []
        for ci, col in enumerate(columns):
            if ci == 0 and ti > 0:
                rows.append([Text(""), Text(""), Text("")])  # blank spacer between table groups
            table_cell = Text(tname, style=f"bold {theme.ACCENT}") if ci == 0 else Text("")
            rows.append([table_cell, Text(str(col.get("name", "")), style=theme.TEXT),
                         _schema_type_cell(str(col.get("type", "")))])

    t_word = "table" if len(tables) == 1 else "tables"
    c_word = "column" if total_cols == 1 else "columns"
    title = Text()
    title.append("schema", style=f"bold {theme.ACCENT}")
    for part in ([db] if db else []) + [f"{len(tables)} {t_word}", f"{total_cols} {c_word}"]:
        title.append(f" · {part}", style=theme.LABEL)
    render_list_panel("schema", header=["table", "column", "type"], rows=rows, days=set(),
                      order=None, empty_message="no schema available", title=title)


def schema_footer(ntables: int, ncols: int) -> None:
    """Dim legend under the schema box (stderr): counts + a colour key (``int string
    uuid/timestamp``) + ``? nullable``, so the type colours are self-explaining."""
    if _quiet:
        return
    line = Text("  ")
    line.append(f"{ntables} {'table' if ntables == 1 else 'tables'}", style=theme.LABEL)
    line.append("  ·  ", style=theme.FAINT)
    line.append(f"{ncols} {'column' if ncols == 1 else 'columns'}", style=theme.LABEL)
    line.append("  ·  ", style=theme.FAINT)
    line.append("int", style=theme.PINK)
    line.append(" ")
    line.append("string", style=theme.SUCCESS)
    line.append(" ")
    line.append("uuid/timestamp", style=theme.BLUE)
    line.append("  ·  ", style=theme.FAINT)
    line.append("?", style=f"italic {theme.TEXT_DIM}")
    line.append(" nullable", style=theme.LABEL)
    _stderr.print(line)
    _stderr.print()


def schema_table_not_found(name: str, available: Sequence[str]) -> None:
    """Red ``error`` notice box (stderr): ``✗ no table named "<name>"`` + a dim list of the
    available tables."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append('no table named "', style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append('"', style=theme.TEXT)
    parts = [body]
    if available:
        avail = Text()
        avail.append("available: ", style=theme.FAINT)
        avail.append(", ".join(available), style=theme.TEXT_DIM)
        parts.append(avail)
    _notice_box(Group(*parts), color=theme.ERROR, title="error")


# ── alerts (list box + show cards) ───────────────────────────────────────────

# Severity → colour. A small fixed enum with real urgency meaning, so a value→colour map is
# safe; unknown severities fall back to neutral dim (never crash / guess a colour).
_SEVERITY_COLORS = {"critical": theme.ERROR, "warning": theme.AMBER, "info": theme.TEXT_DIM}


def humanize_secs(n: Optional[int]) -> str:
    """A ``*_secs`` value → a compact human duration: whole units when divisible (300→``5m``,
    900→``15m``, 3600→``1h``, 86400→``1d``), else seconds (``45s``). ``-`` if missing."""
    if n is None:
        return "-"
    n = int(n)
    if n and n % 86400 == 0:
        return f"{n // 86400}d"
    if n and n % 3600 == 0:
        return f"{n // 3600}h"
    if n and n % 60 == 0:
        return f"{n // 60}m"
    return f"{n}s"


def _age_compact(ts: Optional[str]) -> Optional[str]:
    """Compact relative age for the alerts ``last alert`` column: ``45s ago`` / ``2m ago`` /
    ``1h ago`` / ``3d ago``; ``None`` if the timestamp is missing/unparsable (caller → ``never``)."""
    dt = _parse_iso(ts or "")
    if dt is None:
        return None
    secs = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())
    if secs < 60:
        return f"{int(secs)}s ago"
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if secs < 86400:
        return f"{int(secs // 3600)}h ago"
    return f"{int(secs // 86400)}d ago"


def _anchor_compact(ts: Optional[str]) -> str:
    """A schedule anchor as ``2026-07-22 09:00 UTC``. The anchor is a PHASE, not a
    deadline — what an operator needs to read off it is the time of day runs land
    on — so it renders absolute and in UTC (audits are UTC end to end), never as a
    relative age. Falls back to the raw string if it doesn't parse, so a value the
    server accepted is never hidden."""
    dt = _parse_iso(ts or "")
    if dt is None:
        return str(ts or "-")
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _severity_cell(severity: str, *, muted: bool = False) -> Text:
    """The severity as a colour-coded word (critical red / warning amber / info+unknown neutral).
    ``muted`` dims it (disabled rows). Under NO_COLOR a ``!`` marks critical so it stays visible."""
    sev = severity or "-"
    if _no_color and sev == "critical":
        sev += "!"  # keep the critical marker even on a muted (disabled) row — colour is gone
    if muted:
        return Text(sev, style=theme.FAINT)
    color = _SEVERITY_COLORS.get(severity or "-", theme.TEXT_DIM)
    return Text(sev, style=color)


def _alert_status_cell(enabled: bool, *, muted: bool = False) -> Text:
    """Alert status from ``enabled``: ``● on`` (green) / ``○ off`` (dim) — same dot vocabulary as
    keys/users. In a dimmed (disabled) row the whole cell is muted."""
    t = Text()
    if enabled:
        c = theme.FAINT if muted else theme.SUCCESS
        t.append("● ", style=c)
        t.append("on", style=c)
    else:
        c = theme.FAINT if muted else theme.TEXT_DIM
        t.append("○ ", style=c)
        t.append("off", style=c)
    return t


def render_alerts(alerts: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``alerts list`` view (stdout): an ACCENT panel titled ``alerts · {n} · newest first`` with
    columns ``created · name · by · trigger · severity · last alert``. ``by`` is the actual creator
    (email); severity is a colour-coded word; ``last alert`` is the humanized age of
    ``last_attempted_at`` (``never`` if it has never been evaluated — e.g. a disabled alert).
    Disabled alerts dim entirely so live ones dominate (the on/off split lives in the footer).
    ``name`` is the handle; raw id hidden unless ``show_id``. The ``id``/``open_incidents``/raw ISO
    live only in ``--json``."""
    items = sorted(alerts, key=lambda a: a.created_at or "", reverse=True)  # newest first
    parsed = [_parse_iso(a.created_at) for a in items]
    multi_year = len({p.year for p in parsed if p is not None}) > 1

    header = (["id"] if show_id else []) + ["created", "name", "by", "trigger", "severity", "last alert"]
    rows = []
    for a in items:
        disabled = not a.enabled
        name_style = theme.TEXT_DIM if disabled else theme.TEXT
        dim = theme.FAINT if disabled else theme.TEXT_DIM
        by = a.created_by or "-"  # the actual creator (email), not "you"
        age = _age_compact(a.last_attempted_at)
        last = Text(age, style=dim) if age else Text("never", style=theme.FAINT)
        row = [Text(_short_id(a.id or "-"), style=dim)] if show_id else []
        row += [
            Text(_fmt_user_joined(a.created_at, multi_year), style=dim),
            Text(a.name or "-", style=name_style),
            Text(by, style=dim),
            Text(a.trigger_kind or "-", style=dim),
            _severity_cell(a.severity, muted=disabled),
            last,
        ]
        rows.append(row)

    title = Text()
    title.append("alerts", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)} · newest first", style=theme.LABEL)
    render_list_panel("alerts", header=header, rows=rows, days=set(), order=None,
                      empty_message="no alerts", title=title)


def alerts_footer(alerts: Sequence[Any]) -> None:
    """Distribution summary under the alerts box (stderr): ``{total} alerts · {n} on · {m} off ·
    {c} critical {w} warning`` — counts in their colours, each severity segment present only when
    that severity actually appears."""
    if _quiet:
        return
    total = len(alerts)
    on = sum(1 for a in alerts if a.enabled)
    off = total - on
    line = Text("  ")
    line.append(f"{total} alerts", style=theme.LABEL)
    if on:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{on} on", style=theme.SUCCESS)
    if off:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{off} off", style=theme.FAINT)
    sev_counts = {}
    for a in alerts:
        sev_counts[a.severity] = sev_counts.get(a.severity, 0) + 1
    sev_segs = [s for s in ("critical", "warning", "info") if sev_counts.get(s)]
    if sev_segs:
        line.append("  ·  ", style=theme.FAINT)
        for i, s in enumerate(sev_segs):
            if i:
                line.append(" ")
            line.append(f"{sev_counts[s]} {s}", style=_SEVERITY_COLORS.get(s, theme.TEXT_DIM))
    _stderr.print(line)
    _stderr.print()


# ── alerts show (stacked cards: identity · trigger(per-kind) · evaluation · channels) ──


def _fmt_alert_num(v: Any) -> str:
    """A trigger-spec number → display string (``0.8``, ``50``); ``50.0`` → ``50``."""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _alert_card(title: Text, body: Any) -> None:
    """Print one ACCENT card (stdout) in the alerts-show stack, with a blank line above it."""
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=title, title_align="left",
                  padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


def _trig_metric_threshold(spec: dict):
    s = Text()
    s.append("fire when ", style=theme.TEXT)
    s.append(str(spec.get("metric", "?")), style=theme.ACCENT)
    s.append(" ")
    s.append(str(spec.get("op", "?")), style=theme.ERROR)
    s.append(" ")
    s.append(_fmt_alert_num(spec.get("value")), style=theme.PINK)
    s.append(" over ", style=theme.TEXT)
    s.append(humanize_secs(spec.get("window_secs")), style=theme.BLUE)
    lines = [s]
    filt = spec.get("filter") or {}
    present = [(k, v) for k, v in filt.items() if v not in (None, "")]
    if present:
        f = Text()
        f.append("filter".ljust(10), style=theme.LABEL)
        for i, (k, v) in enumerate(present):
            if i:
                f.append(" · ", style=theme.FAINT)
            f.append(f"{k} = ", style=theme.LABEL)
            f.append(str(v), style=theme.TEXT)
        lines.append(f)
    return lines, None


def _trig_custom_sql(spec: dict):
    s = Text()
    s.append("fire when query ", style=theme.TEXT)
    s.append(str(spec.get("query_name") or spec.get("query_id") or "?"), style=theme.ACCENT)
    s.append(" ")
    s.append(str(spec.get("op", "?")), style=theme.ERROR)
    s.append(" ")
    s.append(_fmt_alert_num(spec.get("value")), style=theme.PINK)
    s.append(" rows", style=theme.TEXT)
    return [s], spec.get("sql")


def _trig_evaluation_score(spec: dict):
    s = Text()
    s.append("fire when ", style=theme.TEXT)
    s.append(str(spec.get("score_key", "?")), style=theme.ACCENT)
    s.append(" ")
    s.append(str(spec.get("op", "?")), style=theme.ERROR)
    s.append(" ")
    s.append(_fmt_alert_num(spec.get("value")), style=theme.PINK)
    if spec.get("min_count") is not None:
        s.append(f" (min {spec['min_count']})", style=theme.LABEL)
    s.append(" over ", style=theme.TEXT)
    s.append(humanize_secs(spec.get("window_secs")), style=theme.BLUE)
    lines = [s]
    if spec.get("environment"):
        e = Text()
        e.append("environment".ljust(13), style=theme.LABEL)
        e.append(str(spec["environment"]), style=theme.TEXT)
        lines.append(e)
    return lines, None


def _trig_per_event(spec: dict):
    s = Text()
    s.append("fire on ", style=theme.TEXT)
    s.append(str(spec.get("event_type", "?")), style=theme.ACCENT)
    s.append(" events within ", style=theme.TEXT)
    s.append(humanize_secs(spec.get("lookback_secs")), style=theme.BLUE)
    lines = [s]
    for label, key in (("environment", "environment"), ("tool_name", "tool_name"),
                       ("error_type", "error_type"), ("agent_id", "agent_id")):
        v = spec.get(key)
        if v not in (None, ""):
            ln = Text()
            ln.append(label.ljust(13), style=theme.LABEL)
            ln.append(str(v), style=theme.TEXT)
            lines.append(ln)
    if spec.get("message_contains"):
        ln = Text()
        ln.append("message ~".ljust(13), style=theme.LABEL)
        ln.append(f'"{spec["message_contains"]}"', style=theme.TEXT)
        lines.append(ln)
    return lines, None


def _trig_eval_compound(spec: dict):
    comb = spec.get("combinator")
    if isinstance(comb, dict) and "at_least" in comb:
        phrase = f"at least {comb['at_least']}"
    elif comb in ("any", "all"):
        phrase = comb
    else:
        phrase = str(comb)
    s = Text()
    s.append("fire when ", style=theme.TEXT)
    s.append(phrase, style=f"bold {theme.TEXT}")
    s.append(" of these over ", style=theme.TEXT)
    s.append(humanize_secs(spec.get("window_secs")), style=theme.BLUE)
    s.append(":", style=theme.TEXT)
    lines = [s]
    for cond in spec.get("conditions") or []:
        ln = Text("  ")
        ln.append(str(cond.get("score_key", "?")), style=theme.ACCENT)
        ln.append(" ")
        ln.append(str(cond.get("op", "?")), style=theme.ERROR)
        ln.append(" ")
        ln.append(_fmt_alert_num(cond.get("value")), style=theme.PINK)
        lines.append(ln)
    trailing = Text()
    if spec.get("min_count") is not None:
        trailing.append("min count ", style=theme.LABEL)
        trailing.append(str(spec["min_count"]), style=theme.TEXT)
    if spec.get("environment"):
        if trailing.plain:
            trailing.append("  ·  ", style=theme.FAINT)
        trailing.append("environment ", style=theme.LABEL)
        trailing.append(str(spec["environment"]), style=theme.TEXT)
    if trailing.plain:
        lines.append(trailing)
    return lines, None


def _trig_unknown(spec: dict):
    """Graceful fallback for a future/unknown trigger kind: a key/value dump (numbers coloured,
    nested objects shown compact) — never crash, never dump raw JSON wholesale."""
    lines = []
    for k, v in (spec or {}).items():
        ln = Text()
        ln.append(str(k).ljust(16), style=theme.LABEL)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            ln.append(_fmt_alert_num(v), style=theme.PINK)
        elif isinstance(v, (dict, list)):
            ln.append(_json.dumps(v, ensure_ascii=False), style=theme.TEXT_DIM)
        else:
            ln.append(str(v), style=theme.TEXT)
        lines.append(ln)
    return lines or [Text("(no spec)", style=theme.TEXT_DIM)], None


_TRIGGER_PARSERS = {
    "metric_threshold": _trig_metric_threshold,
    "custom_sql": _trig_custom_sql,
    "evaluation_score": _trig_evaluation_score,
    "per_event": _trig_per_event,
    "eval_compound": _trig_eval_compound,
}


def _alert_trigger_body(kind: str, spec: Optional[dict]):
    """Parse ``trigger_spec`` into a card body, dispatched on ``trigger_kind`` (with a graceful
    key/value fallback for unknown kinds). ``custom_sql``'s SQL is rendered via the shared
    ``Syntax`` box inside the card."""
    lines, sql = _TRIGGER_PARSERS.get(kind, _trig_unknown)(spec or {})
    if sql:
        from rich.syntax import Syntax
        syn = Syntax(sql, "sql", theme=_sql_syntax_theme(), line_numbers=False,
                     word_wrap=False, background_color="default")
        return Group(*lines, Text(), syn)
    return Group(*lines)


def _is_default_key(key: Optional[str]) -> bool:
    """A channel setting-key is on the org DEFAULT when it's absent or ``alerts.``-prefixed
    (e.g. ``alerts.slack_default_webhook``); a bare entered key/url is CUSTOM."""
    return key is None or str(key).startswith("alerts.")


def _alert_channels_body(channels: Optional[list]):
    """Parse ``channels`` into ``(all_default, table)``: one row per channel with a DIM ITALIC
    ``default …`` descriptor where it inherits org settings, or the entered value in GREEN where
    overridden (mixed supported). Empty ``[]`` → the full default set (slack/webhook/email)."""
    dim_it = lambda s: Text(s, style=f"italic {theme.TEXT_DIM}")  # noqa: E731
    rows = []
    all_default = True
    if not channels:
        rows = [("slack", dim_it("default webhook")),
                ("webhook", dim_it("default url + signing secret")),
                ("email", dim_it("default recipients"))]
    else:
        for ch in channels:
            kind = str(ch.get("kind", "?"))
            if kind == "slack":
                key = ch.get("webhook_setting_key")
                if _is_default_key(key):
                    desc = dim_it("default webhook")
                else:
                    desc = Text(str(key), style=theme.SUCCESS)
                    all_default = False
            elif kind == "webhook":
                desc = Text()
                url, sec = ch.get("url_setting_key"), ch.get("secret_setting_key")
                if _is_default_key(url):
                    desc.append("default url", style=f"italic {theme.TEXT_DIM}")
                else:
                    desc.append(str(url), style=theme.SUCCESS)
                    all_default = False
                desc.append(" + ", style=theme.FAINT)
                if _is_default_key(sec):
                    desc.append("signing secret", style=f"italic {theme.TEXT_DIM}")
                else:
                    desc.append(str(sec), style=theme.SUCCESS)
                    all_default = False
            elif kind == "email":
                rec = ch.get("recipients")
                if not rec:
                    desc = dim_it("default recipients")
                else:
                    desc = Text(", ".join(rec), style=theme.SUCCESS)
                    all_default = False
            elif kind == "dashboard":
                desc = dim_it("in-app")
            else:
                desc = dim_it(_json.dumps(ch, ensure_ascii=False))
            rows.append((kind, desc))

    table = Table(box=None, pad_edge=False, show_header=False)
    table.add_column(style=theme.TEXT, no_wrap=True)
    table.add_column()
    for kind, desc in rows:
        table.add_row(kind, desc)
    return all_default, table


def _alert_status_inline(enabled: bool) -> Text:
    """The ``● enabled``/``○ disabled`` fragment used in the alert identity/card lines."""
    t = Text()
    if enabled:
        t.append("● ", style=theme.SUCCESS)
        t.append("enabled", style=theme.SUCCESS)
    else:
        t.append("○ ", style=theme.TEXT_DIM)
        t.append("disabled", style=theme.TEXT_DIM)
    return t


def _alert_identity_line(alert: Any, *, with_open: bool = True) -> Text:
    """``{severity} · {● enabled/○ disabled} · {trigger_kind}`` (+ ``· {N} open incidents`` when
    ``with_open``, the count red if > 0). Shared by show + created/updated cards."""
    line = Text()
    line.append_text(_severity_cell(alert.severity))
    line.append("  ·  ", style=theme.FAINT)
    line.append_text(_alert_status_inline(alert.enabled))
    line.append("  ·  ", style=theme.FAINT)
    line.append(alert.trigger_kind or "-", style=theme.TEXT_DIM)
    if with_open:
        oi = alert.open_incidents
        line.append("  ·  ", style=theme.FAINT)
        line.append(str(oi), style=f"bold {theme.ERROR}" if oi > 0 else theme.LABEL)
        line.append(f" open incident{'' if oi == 1 else 's'}", style=theme.LABEL)
    return line


def _alert_config_cards(alert: Any) -> None:
    """Print the trigger / evaluation / channels cards (ACCENT) — shared by show + created/updated.
    Returns nothing; the identity card + footer are the caller's (they differ per flow)."""
    # trigger (parsed per kind)
    t2 = Text()
    t2.append("trigger", style=f"bold {theme.ACCENT}")
    t2.append(f" · {(alert.trigger_kind or '').replace('_', ' ')}", style=theme.LABEL)
    _alert_card(t2, _alert_trigger_body(alert.trigger_kind, alert.trigger_spec))

    # evaluation
    ev = Text()
    ev.append("window ", style=theme.LABEL)
    ev.append(str(alert.eval_window), style=theme.TEXT)
    ev.append("  ·  ", style=theme.FAINT)
    ev.append("min breaches ", style=theme.LABEL)
    ev.append(str(alert.min_breaches), style=theme.TEXT)
    ev.append("  ·  ", style=theme.FAINT)
    ev.append("checks every ", style=theme.LABEL)
    ev.append(humanize_secs(alert.eval_interval_secs), style=theme.TEXT)
    _alert_card(Text("evaluation", style=f"bold {theme.ACCENT}"), ev)

    # channels (default vs custom)
    all_default, ch_body = _alert_channels_body(alert.channels)
    t4 = Text()
    t4.append("channels", style=f"bold {theme.ACCENT}")
    t4.append(" · ", style=theme.FAINT)
    t4.append("default" if all_default else "custom", style=theme.LABEL)
    _alert_card(t4, ch_body)


def render_alert_show(alert: Any) -> None:
    """The ``alerts show <name>`` view (stdout): a stack of cards — identity (severity · status ·
    kind · open incidents), ``trigger`` (parsed per ``trigger_kind``), ``evaluation`` (window /
    min breaches / interval), and ``channels`` (default vs custom) — then a ``--json`` footer."""
    _alert_card(Text(alert.name or "-", style=f"bold {theme.ACCENT}"), _alert_identity_line(alert))
    _alert_config_cards(alert)
    if not _quiet:
        _stderr.print()


def _render_alert_write_result(alert: Any, *, verb: str, old_name: Optional[str] = None) -> None:
    """Shared ``alerts create``/``update`` success view (stdout): a GREEN ``alert {verb}`` card
    (name hero + ` was {old}` on rename + identity line + ``{verb} by you · just now``) then the
    same trigger/evaluation/channels config cards as ``show``, and a dim ``alerts show`` pointer."""
    line1 = Text()
    line1.append(alert.name or "-", style=f"bold {theme.TEXT}")
    if old_name and old_name != alert.name:
        line1.append("   was ", style=theme.FAINT)
        line1.append(old_name, style=theme.FAINT)
    line2 = _alert_identity_line(alert, with_open=False)
    line3 = Text()
    line3.append(f"{verb} by ", style=theme.LABEL)
    line3.append("you", style=theme.TEXT)
    line3.append(" · ", style=theme.FAINT)
    line3.append("just now", style=theme.LABEL)
    card = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text(f"alert {verb}", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))
    _alert_config_cards(alert)
    if not _quiet:
        _stderr.print()


def render_alert_created(alert: Any) -> None:
    """The ``alerts create`` success view (stdout): GREEN ``alert created`` card + config cards."""
    _render_alert_write_result(alert, verb="created")


def render_alert_updated(alert: Any, *, old_name: Optional[str] = None) -> None:
    """The ``alerts update`` success view (stdout): GREEN ``alert updated`` card (` was {old}` on
    rename) + config cards showing the new state."""
    _render_alert_write_result(alert, verb="updated", old_name=old_name)


def confirm_alert_update(name: str) -> bool:
    """Plain update confirm (stderr): ``⚠ update alert {name}?`` + ``this replaces its definition``
    + ``confirm? [y/N]`` (calm — update is reversible). Returns the answer."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("update alert ", style=theme.TEXT)
    h.append(name, style=f"bold {theme.ACCENT}")
    h.append("?", style=theme.TEXT)
    c = Text("this replaces the alert's definition", style=theme.LABEL)
    return confirm_line(h, c)


def alert_exists(name: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ an alert named <name> already exists`` + a dim hint."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append('an alert named "', style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append('" already exists', style=theme.TEXT)
    hint = Text()
    hint.append("pick a different name, or update it with ", style=theme.FAINT)
    hint.append(f"fp alerts update {name}", style=theme.ACCENT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def confirm_alert_test(name: str) -> bool:
    """Plain test confirm (stderr): ``⚠ send a test notification for {name}?`` + ``it delivers a
    sample alert to the configured channels`` + ``confirm? [y/N]``. Returns the answer."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("send a test notification for ", style=theme.TEXT)
    h.append(name, style=f"bold {theme.ACCENT}")
    h.append("?", style=theme.TEXT)
    c = Text("it delivers a sample alert to the configured channels", style=theme.LABEL)
    return confirm_line(h, c)


def alert_test_sent(name: str, channel_kinds: Sequence[str]) -> None:
    """Green ``test sent`` notice box (stderr): ``✓ test notification sent for {name}`` + a dim
    ``dispatched to {kinds}`` line + an honest note that delivery isn't confirmed (the server's
    test always returns ok regardless of actual delivery — see issue #183)."""
    if _quiet:
        return
    head = Text()
    head.append("✓ ", style=theme.SUCCESS)
    head.append("test notification sent for ", style=theme.TEXT)
    head.append(name, style=f"bold {theme.ACCENT}")
    rows = [head]
    if channel_kinds:
        line = Text()
        line.append("dispatched to ", style=theme.FAINT)
        for i, k in enumerate(channel_kinds):
            if i:
                line.append("  ·  ", style=theme.FAINT)
            line.append(k, style=theme.TEXT_DIM)
        rows.append(line)
    rows.append(Text("delivery isn't confirmed — verify it arrived in each channel", style=theme.FAINT))
    _notice_box(Group(*rows), color=theme.SUCCESS, title="test sent")


def alert_not_found(name: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ no alert named "<name>"`` + a dim ``alerts list`` hint."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append('no alert named "', style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append('"', style=theme.TEXT)
    hint = Text()
    hint.append("run ", style=theme.FAINT)
    hint.append("fp alerts list", style=theme.ACCENT)
    hint.append(" to see alerts", style=theme.FAINT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def cancelled_plain(tail: str) -> None:
    """Plain calm cancel line (stderr): ``○ cancelled — <tail>`` (shared by query/alerts deletes)."""
    if _quiet:
        return
    _stderr.print()
    _plain(("○ ", theme.FAINT), ("cancelled — ", theme.LABEL), (tail, theme.LABEL))


def render_alert_delete_preview(alert: Any) -> None:
    """The ``alerts delete`` preview (stderr): an AMBER ``delete alert`` box — name + severity ·
    trigger · status + ``{n} open incidents`` (red if > 0, since deleting orphans them)."""
    line1 = Text(alert.name or "-", style=f"bold {theme.ACCENT}")
    line2 = Text()
    line2.append_text(_severity_cell(alert.severity))
    line2.append("  ·  ", style=theme.FAINT)
    line2.append(alert.trigger_kind or "-", style=theme.TEXT_DIM)
    line2.append("  ·  ", style=theme.FAINT)
    line2.append_text(_alert_status_cell(alert.enabled))
    line3 = Text()
    oi = alert.open_incidents
    line3.append(str(oi), style=f"bold {theme.ERROR}" if oi > 0 else theme.TEXT_DIM)
    line3.append(f" open incident{'' if oi == 1 else 's'}", style=theme.LABEL)
    card = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.AMBER,
                 title=Text("delete alert", style=f"bold {theme.AMBER}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def confirm_alert_delete(open_incidents: int) -> bool:
    """Plain delete confirm (stderr): ``⚠ this permanently removes the alert …`` (notes orphaned
    open incidents when any) + ``confirm? [y/N]`` (the amber preview box was printed just above)."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    if open_incidents > 0:
        h.append(f"this permanently removes the alert — its {open_incidents} open "
                 f"incident{'' if open_incidents == 1 else 's'} will be orphaned", style=theme.LABEL)
    else:
        h.append("this permanently removes the alert — it can't be undone", style=theme.LABEL)
    return confirm_line(h)


def alert_deleted(name: str) -> None:
    """Green ``deleted`` notice box (stderr): ``✓ deleted alert <name>``."""
    if _quiet:
        return
    body = Text()
    body.append("✓ ", style=theme.SUCCESS)
    body.append("deleted alert ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    _notice_box(body, color=theme.SUCCESS, title="deleted")


# ── usage (current billing-window summary) ──────────────────────────────────

def render_usage(data: dict) -> None:
    """Render current-window usage as a hierarchy, not an undifferentiated metric list."""
    window = data.get("window") if isinstance(data.get("window"), dict) else {}
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}

    def parsed(raw: Any) -> Optional[datetime]:
        dt = _parse_iso(str(raw or ""))
        return dt.astimezone(timezone.utc) if dt else None

    def day(raw: Any) -> str:
        dt = _parse_iso(str(raw or ""))
        return dt.astimezone(timezone.utc).strftime("%b %d, %Y") if dt else str(raw or "-")

    def n(key: str) -> int:
        raw = usage.get(key, 0)
        return raw if isinstance(raw, int) and not isinstance(raw, bool) else 0

    def stat(value: int, label: str, color: str = theme.TEXT) -> Text:
        out = Text(f"{value:,}", style=f"bold {color}")
        out.append(f"\n{label}", style=theme.LABEL)
        return out

    start, end = parsed(window.get("start")), parsed(window.get("end"))
    now = datetime.now(timezone.utc)
    if start and end and end > start:
        elapsed = max(0.0, min(1.0, (now - start).total_seconds() / (end - start).total_seconds()))
    else:
        elapsed = 0.0
    track_cells = 12
    filled = round(elapsed * track_cells)

    window_line = Text()
    window_line.append("CURRENT WINDOW  ", style=f"bold {theme.TEXT_DIM}")
    window_line.append(day(window.get("start")), style=theme.TEXT)
    window_line.append("  →  ", style=theme.FAINT)
    window_line.append(day(window.get("end")), style=theme.TEXT)
    window_line.append("    ")
    window_line.append("━" * filled, style=theme.ACCENT)
    window_line.append("━" * (track_cells - filled), style=theme.BAR_EMPTY)
    window_line.append(f"  {round(elapsed * 100)}%", style=theme.TEXT_DIM)

    hero = Table(box=None, show_header=False, pad_edge=False, expand=False, padding=(0, 5, 0, 0))
    hero.add_column(min_width=17)
    hero.add_column(min_width=11)
    hero.add_column(min_width=10)
    hero.add_column(min_width=12)
    hero.add_row(
        stat(n("events_ingested"), "events ingested", theme.ACCENT),
        stat(n("sessions"), "sessions"),
        stat(n("agents"), "agents"),
        stat(n("environments"), "environments"),
    )

    def completion(name: str, finished: int, total: int, detail: str, color: str) -> tuple:
        rate = min(100, round((finished / total) * 100)) if total else 0
        cells = 12
        done = round(rate / 100 * cells)
        bar = Text("●" * done, style=color)
        bar.append("○" * (cells - done), style=theme.BAR_EMPTY)
        pct = Text(f"{rate}%", style=f"bold {color}")
        counts = Text(f"{finished:,} / {total:,} complete", style=theme.TEXT_DIM)
        counts.append(f"\n{detail}", style=theme.FAINT)
        return Text(name, style=f"bold {theme.TEXT}"), bar, pct, counts

    pipelines = Table(box=None, show_header=False, pad_edge=False, expand=False, padding=(0, 3, 0, 0))
    pipelines.add_column(min_width=13)
    pipelines.add_column(no_wrap=True)
    pipelines.add_column(justify="right", no_wrap=True)
    pipelines.add_column(min_width=28)
    pipelines.add_row(*completion(
        "Evaluations", n("evaluation_finishes"), n("evaluation_runs"),
        f'{n("evaluations"):,} scores · {n("metrics"):,} metrics', theme.ACCENT,
    ))
    pipelines.add_row(*completion(
        "Audits", n("audit_finishes"), n("audit_runs"),
        f'{n("issues_created"):,} issues · {n("alerts_created"):,} alerts', theme.SUCCESS,
    ))

    footprint = Table(box=None, show_header=False, pad_edge=False, expand=False, padding=(0, 8, 0, 0))
    footprint.add_column(min_width=28)
    footprint.add_column(min_width=28)
    footprint.add_row(
        stat(n("queries_created"), "saved queries", theme.BLUE),
        stat(n("dashboards_created"), "dashboards", theme.BLUE),
    )
    footprint.add_row(
        stat(n("users_active"), f'{n("users_created"):,} members added', theme.SUCCESS),
        stat(n("keys_active"), f'{n("keys_created"):,} keys created', theme.SUCCESS),
    )

    updated = Text("Updated ", style=theme.FAINT)
    updated.append(_anchor_compact(data.get("calculated_at")), style=theme.TEXT_DIM)
    updated.append("  ·  read-only usage, no limits applied", style=theme.FAINT)
    title = Text("usage", style=f"bold {theme.ACCENT}")
    title.append("  ·  organization overview", style=theme.FAINT)
    panel = Panel(Group(
        window_line,
        Text(""),
        hero,
        Rule(style=theme.THIN_RULE),
        Text("PIPELINE COMPLETION", style=f"bold {theme.TEXT_DIM}"),
        pipelines,
        Rule(style=theme.THIN_RULE),
        Text("WORKSPACE & ACCESS", style=f"bold {theme.TEXT_DIM}"),
        footprint,
        Text(""),
        updated,
    ), box=ROUNDED,
                  border_style=theme.ACCENT, title=title, title_align="left",
                  padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


# ── settings (list box + schema box + set card) ──────────────────────────────

# Setting kinds (a small fixed registry enum) → a human label for the `type` column.
_SETTING_KIND_LABELS = {
    "positive_int": "integer", "url": "url", "secret": "secret",
    "email_list": "emails", "email_allowlist": "email allowlist",
    "channel_set": "channels", "permission_set_ref": "permission set",
}
# Keys whose change is security-sensitive → a stronger confirm warning.
SENSITIVE_SETTINGS = {"allowed_sign_ins", "alerts.webhook_signing_secret"}


def _setting_kind(row_or_schema: Any) -> str:
    """The kind string from a SettingRow (its ``schema.kind``) or a schema dict (``kind``)."""
    sch = getattr(row_or_schema, "schema", None)
    if isinstance(sch, dict):
        return str(sch.get("kind", ""))
    if isinstance(row_or_schema, dict):
        return str(row_or_schema.get("kind", ""))
    return ""


def _humanize_setting_kind(kind: str) -> str:
    return _SETTING_KIND_LABELS.get(kind, (kind or "").replace("_", " ") or "—")


def _setting_value_text(value: Any, kind: str, *, full: bool = False) -> Text:
    """A setting value → styled Text, type-aware: secret → ``(secret)`` (never echoed); lists →
    comma-joined; numbers → PINK; empty → ``(unset)``; else TEXT_DIM. ``full`` keeps the whole
    value (the set card/confirm); the list passes the default + truncates separately."""
    if kind == "secret":
        return Text("(secret)", style=f"italic {theme.FAINT}")
    if value is None or value == "":
        return Text("(unset)", style=theme.FAINT)
    if isinstance(value, list):
        if not value:
            return Text("(none)", style=theme.FAINT)
        return Text(", ".join(str(v) for v in value), style=theme.TEXT_DIM)
    if isinstance(value, bool):
        return Text("true" if value else "false", style=theme.AMBER)
    if isinstance(value, (int, float)):
        return Text(str(value), style=theme.PINK)
    if isinstance(value, dict):
        return Text(_json.dumps(value, ensure_ascii=False), style=theme.TEXT_DIM)
    return Text(str(value), style=theme.TEXT_DIM)


def render_settings(rows: Sequence[Any], *, current_email: Optional[str] = None) -> None:
    """The ``settings list`` view (stdout): an ACCENT panel titled ``settings · {n}`` with columns
    ``key · value · type · updated``. The ``value`` is rendered type-aware (lists comma-joined,
    numbers pink, secrets masked as ``(secret)``, empty ``(unset)``) and truncated to one line on a
    width budget; ``type`` is the humanized kind; ``updated`` is the compact ``updated_at``. Full
    values + ``updated_by``/``scope`` live in ``--json``. ``key`` is the handle ``settings set`` takes."""
    items = sorted(rows, key=lambda s: s.key or "")
    parsed = [_parse_iso(s.updated_at) for s in items]
    multi_year = len({p.year for p in parsed if p is not None}) > 1

    keys = [s.key or "-" for s in items]
    types = [_humanize_setting_kind(_setting_kind(s)) for s in items]
    updated = [_fmt_user_joined(s.updated_at, multi_year) for s in items]
    val_cells = [_setting_value_text(s.value, _setting_kind(s)) for s in items]

    budget: Optional[int] = None
    if items:
        def _w(label, vals):
            return max(len(label), max((len(v) for v in vals), default=0))
        fixed = _w("key", keys) + _w("type", types) + _w("updated", updated)
        budget = max(SCORES_MIN_WIDTH, _stdout.width - fixed - 14)

    rows_out = []
    for i, s in enumerate(items):
        v = val_cells[i]
        if budget is not None and len(v.plain) > budget:
            v = Text(_truncate(v.plain, budget), style=v.style)
        rows_out.append([
            Text(keys[i], style=theme.TEXT),
            v,
            Text(types[i], style=theme.TEXT_DIM),
            Text(updated[i], style=theme.TEXT_DIM),
        ])

    title = Text()
    title.append("settings", style=f"bold {theme.ACCENT}")
    title.append(" · ", style=theme.FAINT)
    title.append(str(len(items)), style="bold white")  # the count glows — the headline of the list
    render_list_panel("settings", header=["key", "value", "type", "updated"], rows=rows_out,
                      days=set(), order=None, empty_message="no settings", title=title)


def _setting_accepts(schema: dict) -> str:
    """A concise 'what this setting accepts' summary from its schema, for the schema table."""
    kind = str(schema.get("kind", ""))
    if kind == "positive_int":
        lo, hi, unit = schema.get("min"), schema.get("max"), schema.get("unit")
        if lo is not None and hi is not None:
            return f"{lo}–{hi}" + (f" {unit}" if unit else "")
        return "integer"
    if kind == "channel_set":
        return " · ".join(str(o) for o in (schema.get("options") or [])) or "channels"
    if kind == "email_allowlist":
        # The allowlist FILTERS its org's members rather than granting access,
        # so the empty case is the one people get wrong — say it here, since
        # this column is all `settings schema` shows about accepted values.
        return "emails / *@domain · empty = no restriction"
    if kind == "email_list":
        return "emails / *@domain"
    if kind == "url":
        return "a url"
    if kind == "secret":
        return "a secret"
    if kind == "permission_set_ref":
        return "a permission-set name"
    return "—"


def render_settings_schema(entries: Sequence[dict]) -> None:
    """The ``settings schema`` view (stdout): an ACCENT panel titled ``settings schema · {n}`` with
    columns ``key · type · accepts · description``. ``accepts`` summarizes each kind's constraints
    (int range+unit, channel options, …); ``description`` (wraps) explains the setting."""
    items = sorted(entries, key=lambda e: e.get("key", ""))
    rows = []
    for e in items:
        rows.append([
            Text(str(e.get("key", "")), style=theme.TEXT),
            Text(_humanize_setting_kind(str(e.get("kind", ""))), style=theme.TEXT_DIM),
            Text(_setting_accepts(e), style=theme.LABEL),
            Text(str(e.get("description", "")), style=theme.TEXT_DIM),
        ])
    title = Text()
    title.append("settings schema", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)}", style=theme.LABEL)
    render_list_panel("settings schema", header=["key", "type", "accepts", "description"],
                      rows=rows, days=set(), order=None, empty_message="no settings",
                      last_col="wrap", title=title)


def confirm_setting_change(key: str, old_value: Any, new_value: Any, kind: str) -> bool:
    """Plain set confirm (stderr): ``⚠ set {key}?`` + an ``{old} → {new}`` change line (secrets
    show ``set a new secret value`` instead of echoing) + a sensitive-key warning + ``[y/N]``."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("set ", style=theme.TEXT)
    h.append(key, style=f"bold {theme.ACCENT}")
    h.append("?", style=theme.TEXT)
    if kind == "secret":
        change = Text("set a new secret value", style=theme.LABEL)
    else:
        change = Text()
        change.append_text(_setting_value_text(old_value, kind, full=True))
        change.append("  →  ", style=theme.FAINT)
        change.append_text(_setting_value_text(new_value, kind, full=True))
    parts = [h, change]
    if key in SENSITIVE_SETTINGS:
        warn = Text()
        warn.append("⚠ ", style=theme.AMBER)
        warn.append("this is a security-sensitive setting", style=theme.AMBER)
        parts.append(warn)
    # Clearing the sign-in allowlist LOOKS like a deletion and is in fact a
    # widening: the list restricts which members may sign in, so an empty one
    # restricts nobody. Spell that out — `→ (none)` reads as the opposite.
    if key == "allowed_sign_ins" and isinstance(new_value, list) and not new_value:
        widen = Text()
        widen.append("⚠ ", style=theme.AMBER)
        widen.append(
            "an empty list is NOT a lockout — it removes the restriction, "
            "letting every member of this org sign in",
            style=theme.AMBER,
        )
        parts.append(widen)
    _stderr.print()
    for p in parts:
        _stderr.print(Text("  ") + p)
    return typer.confirm(_ansi("  confirm?", dim=True), default=False, err=True, prompt_suffix=" ")


def render_setting_updated(row: Any, kind: str) -> None:
    """The ``settings set`` success view (stdout): a GREEN ``setting updated`` card — key hero, the
    new value (type-aware; secrets masked), ``updated by you · just now``."""
    line1 = Text(row.key or "-", style=f"bold {theme.TEXT}")
    line2 = _setting_value_text(row.value, kind, full=True)
    line3 = Text()
    line3.append("updated by ", style=theme.LABEL)
    line3.append("you", style=theme.TEXT)
    line3.append(" · ", style=theme.FAINT)
    line3.append("just now", style=theme.LABEL)
    card = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("setting updated", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))
    _stdout.print()


def setting_not_found(key: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ no setting named "<key>"`` + a dim ``settings list``
    hint. Consistent with the other command not-found boxes (keys/users/query/alerts)."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append('no setting named "', style=theme.TEXT)
    body.append(key, style=f"bold {theme.ACCENT}")
    body.append('"', style=theme.TEXT)
    hint = Text()
    hint.append("run ", style=theme.FAINT)
    hint.append("fp settings list", style=theme.ACCENT)
    hint.append(" to see settings", style=theme.FAINT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def setting_no_change(key: str, value: Any, kind: str) -> None:
    """Faint ``no change`` notice box (stderr): ``○ {key} is already {value}``."""
    if _quiet:
        return
    body = Text()
    body.append("○ ", style=theme.FAINT)
    body.append(key, style=f"bold {theme.ACCENT}")
    body.append(" is already ", style=theme.LABEL)
    body.append_text(_setting_value_text(value, kind, full=True))
    _notice_box(body, color=theme.FAINT, title="no change")


def setting_failed(message: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ {message}`` — the server's clean validation message
    (no raw HTTP)."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append(message or "the setting could not be updated", style=theme.TEXT)
    _notice_box(body, color=theme.ERROR, title="error")


# ══ incidents renderers (added) ══
# The incident triage surface lives under `alerts`, so it follows the alerts/query family's
# convention: BOXES carry data (the list/count/show cards + the green created cards + the amber
# delete preview), while ACTION FEEDBACK (✓ / ○ / ✗ / ⚠ confirm) is plain indented stderr lines.
# `state` is a small fixed enum — firing / acknowledged / resolved — value-mapped to a colour.

# Incident state → (marker, colour). firing = breaching (red ●), acknowledged = being handled
# (amber ●), resolved = closed (faint ○). Unknown states fall back to a neutral dim dot.
_INCIDENT_STATE = {
    "firing": ("●", theme.ERROR),
    "acknowledged": ("●", theme.AMBER),
    "resolved": ("○", theme.FAINT),
}

# Activity-log kind → colour (open enum; unknown kinds render neutral). Mirrors the state hues:
# opened = breach red, acknowledged = amber, resolved = green; anything else neutral TEXT.
_ACTIVITY_KIND_COLORS = {
    "opened": theme.ERROR, "acknowledged": theme.AMBER, "resolved": theme.SUCCESS,
}


def _incident_status_cell(state: str, *, muted: bool = False) -> Text:
    """Incident state as a colour-coded dot + word — same dot vocabulary as keys/users/alerts.
    firing red ● / acknowledged amber ● / resolved faint ○; unknown → neutral dim. ``muted`` dims
    the whole cell. Resolved uses a HOLLOW ○ so it stays distinguishable under NO_COLOR (firing
    vs acknowledged differ by their word)."""
    marker, color = _INCIDENT_STATE.get((state or "").lower(), ("●", theme.TEXT_DIM))
    if muted:
        color = theme.FAINT
    t = Text()
    t.append(marker + " ", style=color)
    t.append(state or "-", style=color)
    return t


def _assignees_cell(assignees: Optional[Sequence[str]]) -> Text:
    """The list ``assignees`` column: up to two emails comma-joined, then ``+N`` for the rest;
    ``—`` (faint) when nobody is assigned. Keeps the row one line however many are assigned."""
    names = [str(a) for a in (assignees or []) if a]
    if not names:
        return Text("—", style=theme.FAINT)
    shown = names[:2]
    t = Text(", ".join(shown), style=theme.TEXT_DIM)
    extra = len(names) - len(shown)
    if extra:
        t.append(f"  +{extra}", style=theme.LABEL)
    return t


def _incident_source_cell(source: Optional[str], alert_name: Optional[str]) -> Text:
    """The list/show ``source`` column: where the issue came from — ``manual``, ``alert``, or
    ``audit``. When there's a parent alert its name trails the label (demoted from its old spot as
    the primary column, since only a minority of issues have one). ``—`` when the server sent no
    source at all."""
    src = (source or "").strip().lower()
    if not src:
        src = "alert" if alert_name else ""
    if not src:
        return Text("—", style=theme.FAINT)
    t = Text(src, style=theme.TEXT_DIM)
    if alert_name:
        t.append(f"  {alert_name}", style=theme.LABEL)
    return t


def render_incidents(incidents: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``incidents list`` view (stdout): an ACCENT panel titled ``incidents · {n}`` with columns
    ``id · title · source · severity · state · opened · assignees``. The id IS the handle for the
    action commands, so it's always shown — short (``1f58…9826``) by default, full with
    ``--show-id``. ``title`` is the primary identifying column: every issue has one, whereas only
    alert-linked issues carry an ``alert_name``, so titling by alert left the manual and
    audit-born rows mutually indistinguishable. ``source`` says where it came from and carries the
    alert name when there is one. Severity is colour-coded; state via the
    firing/acknowledged/resolved dot map; ``opened`` is the compact age of ``opened_at``. Server
    order (newest-opened first) is preserved. Full ids / raw timestamps live only in ``--json``."""
    items = list(incidents)
    header = ["id", "title", "source", "severity", "state", "opened", "assignees"]
    rows = []
    for i in items:
        iid = (getattr(i, "id", "") or "-") if show_id else _short_id(getattr(i, "id", "") or "-")
        opened = _age_compact(getattr(i, "opened_at", "")) or "-"
        label = getattr(i, "title", None) or getattr(i, "alert_name", None) or "—"
        rows.append([
            Text(iid, style=theme.TEXT_DIM),
            Text(label, style=theme.TEXT),
            _incident_source_cell(getattr(i, "source", None), getattr(i, "alert_name", None)),
            _severity_cell(getattr(i, "alert_severity", "") or "-"),
            _incident_status_cell(getattr(i, "state", "")),
            Text(opened, style=theme.TEXT_DIM),
            _assignees_cell(getattr(i, "assignees", None)),
        ])
    title = Text()
    title.append("issues", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)}", style=theme.LABEL)
    render_list_panel("issues", header=header, rows=rows, days=set(), order=None,
                      empty_message="no issues", title=title)


def incidents_footer(incidents: Sequence[Any]) -> None:
    """Distribution summary under the incidents box (stderr): ``{total} incidents · firing {f} ·
    acknowledged {a} · resolved {r}`` — each state count in its state colour, present only when
    that state actually appears."""
    if _quiet:
        return
    total = len(incidents)
    counts: dict = {}
    for i in incidents:
        st = (getattr(i, "state", "") or "").lower()
        counts[st] = counts.get(st, 0) + 1
    line = Text("  ")
    line.append(f"{total} issue{'' if total == 1 else 's'}", style=theme.LABEL)
    for st in ("firing", "acknowledged", "resolved"):
        n = counts.get(st, 0)
        if n:
            line.append("  ·  ", style=theme.FAINT)
            line.append(f"{n} {st}", style=_INCIDENT_STATE[st][1])
    _stderr.print(line)
    _stderr.print()


def render_incident_count(count: int, *, state: Optional[str] = None) -> None:
    """The ``incidents count`` view (stdout): a compact ACCENT ``incidents`` card — the count as a
    pink hero number + a ``{state} incidents`` / ``open incidents`` qualifier (the server's default
    counts firing + acknowledged, i.e. the open ones)."""
    body = Text()
    body.append(str(count), style=f"bold {theme.PINK}")
    body.append("  ")
    body.append(f"{state} issues" if state else "open issues", style=theme.LABEL)
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT,
                  title=Text("issues", style=f"bold {theme.ACCENT}"),
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


def _section_title(word: str, n: int) -> Text:
    """A ``{word} · {n}`` card title (bold-ACCENT word + LABEL count) for the show sub-sections."""
    t = Text()
    t.append(word, style=f"bold {theme.ACCENT}")
    t.append(f" · {n}", style=theme.LABEL)
    return t


def _incident_comments_body(comments: Sequence[dict]):
    """A borderless ``author · when · body`` table for the show ``comments`` section. A soft-deleted
    comment (``deleted_at`` set, or ``body`` null) shows a dim italic ``(deleted)`` tombstone; the
    body folds so a long comment wraps within the card."""
    table = Table(box=None, pad_edge=False, show_header=False)
    table.add_column(style=theme.TEXT_DIM, no_wrap=True)   # author
    table.add_column(style=theme.FAINT, no_wrap=True)      # when
    table.add_column(overflow="fold")                      # body
    for c in comments:
        author = str(c.get("author_email") or "—")
        when = _relative_age(c.get("created_at")) or "-"
        if c.get("deleted_at") or c.get("body") is None:
            body = Text("(deleted)", style=f"italic {theme.FAINT}")
        else:
            body = Text(str(c.get("body")), style=theme.TEXT)
        table.add_row(author, when, body)
    return table


def _incident_subscribers_body(subscribers: Sequence[dict]):
    """A borderless ``email · source · when`` table for the show ``subscribers`` section."""
    table = Table(box=None, pad_edge=False, show_header=False)
    table.add_column(style=theme.TEXT, no_wrap=True)   # email
    table.add_column(style=theme.LABEL, no_wrap=True)  # source
    table.add_column(style=theme.FAINT, no_wrap=True)  # when
    for s in subscribers:
        email = str(s.get("email") or "—")
        source = str(s.get("source") or "")
        when = _relative_age(s.get("subscribed_at")) or "-"
        table.add_row(email, source, when)
    return table


def _incident_activity_body(activity: Sequence[dict]):
    """A borderless ``kind · actor · when`` table for the show ``activity`` log — kind coloured by
    the kind map (opened red / acknowledged amber / resolved green / else neutral), humanized
    (``_`` → space); actor is the email or ``system``."""
    table = Table(box=None, pad_edge=False, show_header=False)
    table.add_column(no_wrap=True)                         # kind (coloured)
    table.add_column(style=theme.TEXT_DIM, no_wrap=True)   # actor
    table.add_column(style=theme.FAINT, no_wrap=True)      # when
    for a in activity:
        kind = str(a.get("kind") or "")
        color = _ACTIVITY_KIND_COLORS.get(kind, theme.TEXT)
        table.add_row(Text(kind.replace("_", " ") or "-", style=color),
                      str(a.get("actor") or "—"), _relative_age(a.get("at")) or "-")
    return table


def render_incident_show(incident: Any) -> None:
    """The ``incidents show <id>`` view (stdout): a stack of ACCENT cards — an identity card (the
    issue's own title + short id, then ``severity · state · source · opened {age}``, an
    ``acknowledged by`` / ``assigned to`` line, and a breach line) followed by ``comments`` /
    ``subscribers`` / ``activity`` sections (each omitted when empty) — then a dim ``--json``
    pointer. The header used to be hardcoded to the literal ``manual incident`` whenever there was
    no parent alert, which mislabelled every audit-born issue and told the reader nothing; it now
    shows the real title and the real source. Presentation only."""
    title = Text()
    heading = (
        getattr(incident, "title", None)
        or getattr(incident, "alert_name", None)
        or "untitled issue"
    )
    title.append(heading, style=f"bold {theme.ACCENT}")
    title.append(f" · {_short_id(getattr(incident, 'id', '') or '-')}", style=theme.LABEL)

    l1 = Text()
    l1.append_text(_severity_cell(getattr(incident, "alert_severity", "") or "-"))
    l1.append("  ·  ", style=theme.FAINT)
    l1.append_text(_incident_status_cell(getattr(incident, "state", "")))
    src = _incident_source_cell(
        getattr(incident, "source", None), getattr(incident, "alert_name", None)
    )
    if src.plain != "—":
        l1.append("  ·  ", style=theme.FAINT)
        l1.append_text(src)
    age = _relative_age(getattr(incident, "opened_at", ""))
    if age:
        l1.append("  ·  ", style=theme.FAINT)
        l1.append("opened ", style=theme.LABEL)
        l1.append(age, style=theme.TEXT)
    lines: List[Text] = [l1]

    who = Text()
    has_who = False
    if getattr(incident, "acknowledged_by", None):
        who.append("acknowledged by ", style=theme.LABEL)
        who.append(str(incident.acknowledged_by), style=theme.TEXT)
        has_who = True
    if getattr(incident, "assignees", None):
        if has_who:
            who.append("  ·  ", style=theme.FAINT)
        who.append("assigned to ", style=theme.LABEL)
        who.append(", ".join(incident.assignees), style=theme.TEXT)
        has_who = True
    if has_who:
        lines.append(who)

    if getattr(incident, "breach_summary", None):
        b = Text()
        b.append("breach ", style=theme.LABEL)
        b.append(str(incident.breach_summary), style=theme.TEXT_DIM)
        lines.append(b)
    elif getattr(incident, "breach_value", None) is not None:
        b = Text()
        b.append("breach value ", style=theme.LABEL)
        b.append(_fmt_alert_num(incident.breach_value), style=theme.PINK)
        lines.append(b)

    _alert_card(title, Group(*lines))

    comments = list(getattr(incident, "comments", None) or [])
    if comments:
        _alert_card(_section_title("comments", len(comments)), _incident_comments_body(comments))
    subscribers = list(getattr(incident, "subscribers", None) or [])
    if subscribers:
        _alert_card(_section_title("subscribers", len(subscribers)), _incident_subscribers_body(subscribers))
    activity = list(getattr(incident, "activity", None) or [])
    if activity:
        _alert_card(_section_title("activity", len(activity)), _incident_activity_body(activity))

    if not _quiet:
        foot = Text("  ")
        foot.append("view raw with ", style=theme.FAINT)
        foot.append("--json", style=theme.ACCENT)
        _stderr.print()
        _stderr.print(foot)
        _stderr.print()


def render_incident_opened(*, summary: str, severity: str, state: str, title: str = "") -> None:
    """The ``issues open`` success view (stdout): a GREEN ``issue opened`` card — the title
    (falling back to the summary) as the hero line, ``{severity} · {state}``, and
    ``opened by you · just now``. When both are present the summary renders beneath the title."""
    line1 = Text(title or summary or "issue", style=f"bold {theme.TEXT}")
    if title and summary and summary != title:
        line1.append("\n")
        line1.append(summary, style=theme.LABEL)
    line2 = Text()
    line2.append_text(_severity_cell(severity or "-"))
    line2.append("  ·  ", style=theme.FAINT)
    line2.append_text(_incident_status_cell(state))
    line3 = Text()
    line3.append("opened by ", style=theme.LABEL)
    line3.append("you", style=theme.TEXT)
    line3.append(" · ", style=theme.FAINT)
    line3.append("just now", style=theme.LABEL)
    card = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("issue opened", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))


def render_incident_comment_added(comment: Any) -> None:
    """The ``incidents comment-add`` success view (stdout): a GREEN ``comment added`` card — a
    ``by {author} · just now`` line then the comment body (folds for long text)."""
    line1 = Text()
    line1.append("by ", style=theme.LABEL)
    line1.append(getattr(comment, "author_email", None) or "you", style=theme.TEXT)
    line1.append(" · ", style=theme.FAINT)
    line1.append("just now", style=theme.LABEL)
    body = Text(getattr(comment, "body", None) or "", style=theme.TEXT)
    card = Panel(Group(line1, Text(), body), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("comment added", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))


def render_incident_comment_delete_preview(comment: Any) -> None:
    """The ``incidents comment-delete`` preview (stderr): an AMBER ``delete comment`` box — a
    ``by {author} · {age}`` line + the comment body, so the operator sees what's about to go."""
    line1 = Text()
    line1.append("by ", style=theme.LABEL)
    line1.append(getattr(comment, "author_email", None) or "—", style=f"bold {theme.ACCENT}")
    when = _relative_age(getattr(comment, "created_at", ""))
    if when:
        line1.append("  ·  ", style=theme.FAINT)
        line1.append(when, style=theme.LABEL)
    body = Text(getattr(comment, "body", None) or "(deleted)", style=theme.TEXT_DIM)
    card = Panel(Group(line1, body), box=ROUNDED, border_style=theme.AMBER,
                 title=Text("delete comment", style=f"bold {theme.AMBER}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def confirm_incident_resolve(incident_id: str, alert_name: Optional[str] = None) -> bool:
    """Plain resolve confirm (stderr): ``⚠ resolve issue {short id} ({alert})?`` + ``this closes
    it`` + ``confirm? [y/N]`` (calm — an operator can re-open later). Returns the answer."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("resolve issue ", style=theme.TEXT)
    h.append(_short_id(incident_id or "-"), style=f"bold {theme.ACCENT}")
    if alert_name:
        h.append(f" ({alert_name})", style=theme.LABEL)
    h.append("?", style=theme.TEXT)
    return confirm_line(h, Text("this closes it", style=theme.LABEL))


def confirm_incident_comment_delete() -> bool:
    """Plain comment-delete confirm (stderr): ``⚠ this permanently removes the comment — it can't be
    undone`` + ``confirm? [y/N]`` (the amber preview box was printed just above). Returns y/N."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("this permanently removes the comment — it can't be undone", style=theme.LABEL)
    return confirm_line(h)


def incident_acked(incident_id: str) -> None:
    """Plain green line (stderr): ``✓ acknowledged issue {short id}``."""
    if _quiet:
        return
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("acknowledged issue ", theme.TEXT),
           (_short_id(incident_id or "-"), theme.ACCENT))


def incident_resolved(incident_id: str) -> None:
    """Plain green line (stderr): ``✓ resolved issue {short id}``."""
    if _quiet:
        return
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("resolved issue ", theme.TEXT),
           (_short_id(incident_id or "-"), theme.ACCENT))


def incident_assigned(incident_id: str, assignees: Sequence[str]) -> None:
    """Plain green line (stderr): ``✓ assigned {short id} · a@x, b@x`` — or ``✓ cleared assignees
    on {short id}`` when the list is empty."""
    if _quiet:
        return
    _stderr.print()
    short = _short_id(incident_id or "-")
    names = [str(a) for a in (assignees or []) if a]
    if names:
        _plain(("✓ ", theme.SUCCESS), ("assigned ", theme.TEXT), (short, theme.ACCENT),
               ("  ·  ", theme.FAINT), (", ".join(names), theme.TEXT_DIM))
    else:
        _plain(("✓ ", theme.SUCCESS), ("cleared assignees on ", theme.TEXT), (short, theme.ACCENT))


def incident_subscribed(incident_id: str, email: Optional[str] = None) -> None:
    """Plain green line (stderr): ``✓ subscribed {who} to issue {short id}`` (``who`` = the email
    or ``you``)."""
    if _quiet:
        return
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("subscribed ", theme.TEXT), (email or "you", theme.ACCENT),
           (" to issue ", theme.TEXT), (_short_id(incident_id or "-"), theme.TEXT_DIM))


def incident_unsubscribed(incident_id: str, email: Optional[str] = None) -> None:
    """Plain green line (stderr): ``✓ unsubscribed {who} from issue {short id}``."""
    if _quiet:
        return
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("unsubscribed ", theme.TEXT), (email or "you", theme.ACCENT),
           (" from issue ", theme.TEXT), (_short_id(incident_id or "-"), theme.TEXT_DIM))


def incident_comment_deleted() -> None:
    """Plain green line (stderr): ``✓ deleted comment``."""
    if _quiet:
        return
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("deleted comment", theme.TEXT))


def incident_not_found(incident_id: str) -> None:
    """Plain red line (stderr): ``✗ no issue {short id}`` + a dim hint to ``issues list``.
    Always shown (errors ignore ``--quiet``)."""
    _stderr.print()
    _plain(("✗ ", f"bold {theme.ERROR}"), ("no issue ", theme.TEXT),
           (_short_id(incident_id or "-"), f"bold {theme.ACCENT}"))
    _plain(("run ", theme.FAINT), ("fp issues list", theme.ACCENT),
           (" to see issues", theme.FAINT))


def incident_comment_not_found(comment_id: str) -> None:
    """Plain red line (stderr): ``✗ no comment {short id} on this issue``."""
    _stderr.print()
    _plain(("✗ ", f"bold {theme.ERROR}"), ("no comment ", theme.TEXT),
           (_short_id(comment_id or "-"), f"bold {theme.ACCENT}"), (" on this issue", theme.TEXT))


def incident_failed(message: str) -> None:
    """Plain red line (stderr): ``✗ {message}`` — the server's clean message (never raw HTTP)."""
    _stderr.print()
    _plain(("✗ ", f"bold {theme.ERROR}"), (message, theme.TEXT))


def render_incident_comments(comments: Sequence[Any]) -> None:
    """The ``incidents comment-list`` view (stdout): a boxed ``comments · {n}`` table with columns
    ``author · when · body`` — the body folds (so a long comment wraps), a soft-deleted comment
    shows a dim italic ``(deleted)`` tombstone. Takes ``IncidentComment`` dataclasses."""
    rows = []
    for c in comments:
        when = _relative_age(getattr(c, "created_at", "")) or "-"
        if getattr(c, "deleted_at", None) or getattr(c, "body", None) is None:
            body = Text("(deleted)", style=f"italic {theme.FAINT}")
        else:
            body = Text(str(getattr(c, "body", "")), style=theme.TEXT)
        rows.append([
            Text(getattr(c, "author_email", "") or "—", style=theme.TEXT_DIM),
            Text(when, style=theme.FAINT),
            body,
        ])
    render_list_panel("comments", header=["author", "when", "body"], rows=rows, days=set(),
                      order=None, empty_message="no comments yet", last_col="wrap",
                      title=_section_title("comments", len(list(comments))))


def render_incident_subscribers(subscribers: Sequence[Any]) -> None:
    """The ``incidents subscribers`` view (stdout): a boxed ``subscribers · {n}`` table with columns
    ``email · source · subscribed`` (the relative subscribe time). Takes ``IncidentSubscriber``
    dataclasses."""
    rows = []
    for s in subscribers:
        when = _relative_age(getattr(s, "subscribed_at", "")) or "-"
        rows.append([
            Text(getattr(s, "email", "") or "—", style=theme.TEXT),
            Text(getattr(s, "source", "") or "", style=theme.LABEL),
            Text(when, style=theme.FAINT),
        ])
    render_list_panel("subscribers", header=["email", "source", "subscribed"], rows=rows,
                      days=set(), order=None, empty_message="no subscribers",
                      title=_section_title("subscribers", len(list(subscribers))))


# ══ end incidents renderers ══


# ══ agent renderers (added) ══
# The `fp agent` group, on the shared design language: BOXES carry data (health card,
# models/chats lists, the show transcript), PLAIN indented lines carry action feedback
# (rename/delete cards + ✓/○/✗/⚠ lines). Reuses render_list_panel / _age_compact / _short_id /
# confirm_line / cancelled_plain / _plain. The `ask` ANSWER is printed to stdout by the command
# (the pipeable payload) — only its surrounding chrome lives here.


def _msg_text(content: Any) -> str:
    """Extract the display text from a stored message ``content`` (str or ``{"text": ...}``) —
    mirrors the dashboard's ``textOf`` so the CLI transcript reads identically."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def render_agent_health(*, configured: bool, default_model: Optional[str], model_count: int) -> None:
    """The ``agent health`` view (stdout): a compact ACCENT ``assistant`` card — ``● configured``
    (green) / ``○ not configured`` (dim) from ``enabled``/``llm_configured``, then ``default model
    {m}`` and ``{n} models available`` when reported. ``--json`` emits the raw payload."""
    line1 = Text()
    if configured:
        line1.append("● ", style=theme.SUCCESS)
        line1.append("configured", style=theme.SUCCESS)
    else:
        line1.append("○ ", style=theme.FAINT)
        line1.append("not configured", style=theme.TEXT_DIM)
    rows: List[Any] = [line1]
    if default_model:
        l = Text()
        l.append("default model ", style=theme.LABEL)
        l.append(default_model, style=theme.TEXT)
        rows.append(l)
    if model_count:
        l = Text()
        l.append(f"{model_count} model{'' if model_count == 1 else 's'}", style=theme.LABEL)
        l.append(" available", style=theme.FAINT)
        rows.append(l)
    panel = Panel(Group(*rows), box=ROUNDED, border_style=theme.ACCENT,
                  title=Text("assistant", style=f"bold {theme.ACCENT}"),
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))
    _stdout.print()


def render_agent_models(models: Sequence[str], *, default_model: Optional[str] = None) -> None:
    """The ``agent models`` view (stdout): an ACCENT ``models · {n}`` box, one model per row with the
    default marked (``●`` ACCENT + a dim ``default`` tag; ``·`` FAINT otherwise). Empty → a calm
    ``no models reported`` (the assistant may be unconfigured). ``--json`` emits ``{models,
    default_model}``."""
    n = len(models)
    if n == 0:
        body: Any = Text("no models reported", style=theme.TEXT_DIM)
    else:
        table = Table(box=None, pad_edge=False, show_header=False, padding=(0, 2, 0, 0))
        table.add_column(no_wrap=True)  # marker
        table.add_column(no_wrap=True)  # name
        table.add_column(no_wrap=True)  # default tag
        for m in models:
            is_default = (default_model is not None and m == default_model)
            marker = Text("●", style=theme.ACCENT) if is_default else Text("·", style=theme.FAINT)
            name = Text(str(m), style=f"bold {theme.TEXT}" if is_default else theme.TEXT)
            tag = Text("default", style=theme.LABEL) if is_default else Text("")
            table.add_row(marker, name, tag)
        body = table
    title = Text()
    title.append("models", style=f"bold {theme.ACCENT}")
    title.append(f" · {n}", style=theme.LABEL)
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=title,
                  title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))
    _stdout.print()


def render_agent_chats(chats: Sequence[dict]) -> None:
    """The ``agent chats`` view (stdout): a boxed ``chats · {n}`` table with columns ``chat-id ·
    title · messages · updated`` (newest first). ``chat-id`` is the SHORT, copy-friendly handle
    (the first 8 hex before the UUID's first ``-``) that ``agent show``/``rename``/``delete``/``ask
    --chat`` accept as a prefix; the ``title`` absorbs any width squeeze (``…``-truncated on a
    budget). The count glows. Empty → ``no chats``."""
    items = sorted(chats, key=lambda c: c.get("updated_at") or "", reverse=True)  # newest first
    ids = [_short_chat_id(str(c.get("id") or "-")) for c in items]  # short copy-friendly handle
    titles = [str(c.get("title") or "untitled") for c in items]
    mcs = [str(c.get("message_count")) if c.get("message_count") is not None else "-" for c in items]
    ages = [_age_compact(c.get("updated_at")) for c in items]

    # Keep chat-id (and messages/updated) at full width; the title is the only flexible column,
    # so budget it to the leftover space and truncate it — the chat-id is never cut.
    budget: Optional[int] = None
    if items:
        def _w(label, vals):
            return max(len(label), max((len(v) for v in vals), default=0))
        fixed = _w("chat-id", ids) + _w("messages", mcs) + _w("updated", [a or "—" for a in ages])
        budget = max(SCORES_MIN_WIDTH, _stdout.width - fixed - (2 * 4 + 8))  # per-col padding + chrome

    rows = []
    for i, c in enumerate(items):
        t = _truncate(titles[i], budget) if budget is not None else titles[i]
        updated = Text(ages[i], style=theme.TEXT_DIM) if ages[i] else Text("—", style=theme.FAINT)
        rows.append([
            Text(ids[i], style=theme.TEXT_DIM),  # the short copy-friendly handle
            Text(t, style=theme.TEXT),
            Text(mcs[i], style=theme.TEXT_DIM),
            updated,
        ])
    title = Text()
    title.append("chats", style=f"bold {theme.ACCENT}")
    title.append(" · ", style=theme.FAINT)
    title.append(str(len(items)), style="bold white")  # the count glows — the headline of the list
    render_list_panel("chats", header=["chat-id", "title", "messages", "updated"], rows=rows,
                      days=set(), order=None, empty_message="no chats", title=title)


def render_agent_show(*, title: Optional[str], messages: Sequence[dict], chat_id: str) -> None:
    """The ``agent show <id>`` view (stdout): the conversation as a readable transcript inside an
    ACCENT panel titled ``{chat title} · {n} messages · {short id}``. Each message is a turn — a
    role label (``you`` ACCENT / ``assistant`` SUCCESS) then its indented text (``_msg_text`` handles
    the str-or-``{text}`` content). Empty → ``no messages yet``. ``--json`` emits ``{title, messages}``."""
    msgs = list(messages or [])
    width = min(max(_stdout.width - 4, 40), 100)
    if not msgs:
        body: Any = Text("no messages yet", style=theme.TEXT_DIM)
    else:
        parts: List[Any] = []
        for i, m in enumerate(msgs):
            if i:
                parts.append(Text(""))  # blank line between turns
            role = str(m.get("role", "") or "")
            if role == "assistant":
                label = Text("assistant", style=f"bold {theme.SUCCESS}")
            elif role == "user":
                label = Text("you", style=f"bold {theme.ACCENT}")
            else:
                label = Text(role or "—", style=f"bold {theme.TEXT_DIM}")
            parts.append(label)
            parts.append(Padding(Text(_msg_text(m.get("content")) or "—", style=theme.TEXT), (0, 0, 0, 2)))
        body = Group(*parts)
    ttl = Text()
    ttl.append(title or "untitled", style=f"bold {theme.ACCENT}")
    ttl.append(f"  ·  {len(msgs)} message{'' if len(msgs) == 1 else 's'}", style=theme.LABEL)
    ttl.append(f"  ·  {_short_chat_id(str(chat_id))}", style=theme.TEXT_DIM)
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=ttl, title_align="left",
                  padding=(0, 1), expand=False, width=width)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))
    _stdout.print()


def render_agent_renamed(*, chat_id: str, title: str, old_title: Optional[str] = None) -> None:
    """The ``agent rename`` success view (stderr chrome): a GREEN ``chat renamed`` card — the new
    title (hero) + dim `` was {old}`` when the title actually changed, then ``renamed · just now ·
    {short id}``."""
    line1 = Text()
    line1.append(title or "untitled", style=f"bold {theme.TEXT}")
    if old_title and old_title != title:
        line1.append("   was ", style=theme.FAINT)
        line1.append(old_title, style=theme.FAINT)
    line2 = Text()
    line2.append("renamed", style=theme.LABEL)
    line2.append(" · ", style=theme.FAINT)
    line2.append("just now", style=theme.LABEL)
    line2.append("  ·  ", style=theme.FAINT)
    line2.append(_short_chat_id(str(chat_id)), style=theme.TEXT_DIM)
    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("chat renamed", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))
    _stderr.print()


def render_agent_delete_preview(*, title: Optional[str], message_count: int, chat_id: str) -> None:
    """The ``agent delete`` preview (stderr): an AMBER ``delete chat`` box — the chat's title
    (ACCENT) + ``{n} messages · {short id}`` — so the operator confirms it's the right chat."""
    line1 = Text(title or "untitled", style=f"bold {theme.ACCENT}")
    line2 = Text()
    line2.append(str(message_count), style=theme.TEXT_DIM)
    line2.append(f" message{'' if message_count == 1 else 's'}", style=theme.LABEL)
    line2.append("  ·  ", style=theme.FAINT)
    line2.append(_short_chat_id(str(chat_id)), style=theme.TEXT_DIM)
    card = Panel(Group(line1, line2), box=ROUNDED, border_style=theme.AMBER,
                 title=Text("delete chat", style=f"bold {theme.AMBER}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def confirm_agent_delete() -> bool:
    """Plain delete confirm (stderr): ``⚠ this permanently removes the chat — it can't be undone``
    + ``confirm? [y/N]`` (the amber preview box was printed just above). Returns y/N."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("this permanently removes the chat — it can't be undone", style=theme.LABEL)
    return confirm_line(h)


def agent_deleted(title: str) -> None:
    """Green ``deleted`` notice box (stderr): ``✓ deleted chat <title>``."""
    if _quiet:
        return
    body = Text()
    body.append("✓ ", style=theme.SUCCESS)
    body.append("deleted chat ", style=theme.TEXT)
    body.append(title or "untitled", style=f"bold {theme.ACCENT}")
    _notice_box(body, color=theme.SUCCESS, title="deleted")


def agent_tool_used(tool: str) -> None:
    """A dim stderr activity line during ``ask``: ``· used tool: <tool>``."""
    if _quiet:
        return
    _plain(("· used tool: ", theme.FAINT), (tool or "?", theme.TEXT_DIM))


def render_agent_answer(answer: str, *, model: Optional[str] = None) -> None:
    """The ``agent ask`` answer (stdout, interactive): the assistant's reply rendered as Markdown
    inside an ACCENT ``assistant`` panel — the same boxed shell as ``agent show``. Piped/non-tty
    callers print the raw answer instead (so it stays a clean payload)."""
    from rich.markdown import Markdown

    width = min(max(_stdout.width - 4, 40), 100)
    title = Text("assistant", style=f"bold {theme.SUCCESS}")
    if model:
        title.append(f"  ·  {model}", style=theme.LABEL)
    body: Any = Markdown(answer) if (answer or "").strip() else Text("(no answer)", style=theme.TEXT_DIM)
    panel = Panel(body, box=ROUNDED, border_style=theme.ACCENT, title=title, title_align="left",
                  padding=(0, 1), expand=False, width=width)
    _stdout.print()
    _stdout.print(Padding(panel, (0, 0, 0, 2)))


def render_agent_new_chat(chat_id: str) -> None:
    """The ``ask`` new-chat pointer (stderr), boxed: ``↳ new chat <short>`` + a ``continue with
    fp agent ask --chat <short> "…"`` line — the short handle resolves back to the full id."""
    if _quiet:
        return
    short = _short_chat_id(str(chat_id))
    line1 = Text()
    line1.append("↳ new chat ", style=theme.FAINT)
    line1.append(short, style=f"bold {theme.ACCENT}")
    line2 = Text()
    line2.append("continue with ", style=theme.FAINT)
    line2.append(f'fp agent ask --chat {short} "…"', style=theme.ACCENT)
    _notice_box(Group(line1, line2), color=theme.ACCENT, title="new chat")


def agent_error(message: str) -> None:
    """Red ``error`` notice box (stderr) for an ``ask`` failure: ``✗ <message>`` (no raw HTTP)."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append(message or "the assistant could not answer", style=theme.TEXT)
    _notice_box(body, color=theme.ERROR, title="error")


def agent_chat_not_found(chat_id: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ chat not found "<handle>"`` + a dim ``agent chats``
    hint — the calm not-found for show/rename/delete/ask (a bad/short id that resolves to none)."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append("chat not found ", style=theme.TEXT)
    body.append(f'"{_short_chat_id(str(chat_id))}"', style=f"bold {theme.ACCENT}")
    hint = Text()
    hint.append("check the id, or run ", style=theme.FAINT)
    hint.append("fp agent chats", style=theme.ACCENT)
    hint.append(" to see your chats", style=theme.FAINT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def agent_chat_ambiguous(handle: str, matches: Sequence[str]) -> None:
    """Red ``error`` notice box (stderr): a short chat-id prefix that matched more than one chat —
    list the matches and ask for more characters."""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append("ambiguous chat id ", style=theme.TEXT)
    body.append(f'"{handle}"', style=f"bold {theme.ACCENT}")
    body.append(" — matches: ", style=theme.TEXT)
    body.append(", ".join(_short_chat_id(m) for m in matches), style=theme.TEXT_DIM)
    hint = Text("use a few more characters of the id", style=theme.FAINT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def agent_unconfigured_note() -> None:
    """A dim stderr note when the assistant isn't set up (used by ``models`` when none are reported):
    ``the assistant isn't configured on this deployment — check fp agent health``."""
    if _quiet:
        return
    _plain(("the assistant isn't configured on this deployment — check ", theme.FAINT),
           ("fp agent health", theme.ACCENT))
    _stderr.print()


# ══ audits renderers ══
# Audits are scheduled sweeps that produce findings, so the group has TWO list surfaces (the
# definitions and their findings) plus a run history. It follows the alerts/incidents family:
# BOXES carry data (list panels, show cards, the green created/updated cards, the amber delete
# preview), ACTION FEEDBACK (✓ / ○ / ✗ / ⚠ confirm) is plain indented stderr lines.

# Finding status → (marker, colour). open = untriaged (red ●), recurring = seen again (amber ●),
# resolved = fixed (green ○), dismissed/muted = suppressed (faint ○). Unknown → neutral dim dot.
_FINDING_STATUS = {
    "open": ("●", theme.ERROR),
    "recurring": ("●", theme.AMBER),
    "resolved": ("○", theme.SUCCESS),
    "dismissed": ("○", theme.FAINT),
    "muted": ("○", theme.FAINT),
}

# Run status → colour. running = in flight (amber), succeeded = green, failed = red.
_RUN_STATUS_COLORS = {"running": theme.AMBER, "succeeded": theme.SUCCESS, "failed": theme.ERROR}

# Finding kind → colour. A small fixed enum: failure = something broke (red), policy = a rule
# violation (amber), improvement = an opportunity (neutral). Unknown kinds render neutral.
_FINDING_KIND_COLORS = {"failure": theme.ERROR, "policy": theme.AMBER, "improvement": theme.TEXT_DIM}


def _finding_status_cell(status: str, *, muted: bool = False) -> Text:
    """Finding status as a colour-coded dot + word — the same dot vocabulary as keys/users/alerts/
    incidents. Suppressed states (dismissed/muted) and resolved use a HOLLOW ○ so the live ones
    (open/recurring) stay distinguishable under NO_COLOR."""
    marker, color = _FINDING_STATUS.get((status or "").lower(), ("●", theme.TEXT_DIM))
    if muted:
        color = theme.FAINT
    t = Text()
    t.append(marker + " ", style=color)
    t.append(status or "-", style=color)
    return t


def _run_status_cell(status: str) -> Text:
    """Run status as a colour-coded word (running amber / succeeded green / failed red; unknown
    neutral dim). Under NO_COLOR a ``!`` marks a failed run so it stays visible."""
    st = status or "-"
    if _no_color and st == "failed":
        st += "!"
    return Text(st, style=_RUN_STATUS_COLORS.get(status or "", theme.TEXT_DIM))


def _audit_last_run_cell(audit: Any, *, muted: bool = False) -> Text:
    """The audits-list ``last run`` column: the compact age of the last finished run, tinted by
    that run's status (``never`` when it has not run yet — e.g. a freshly created or disabled
    audit)."""
    age = _age_compact(getattr(audit, "last_run_finished_at", None)) or _age_compact(
        getattr(audit, "last_attempted_at", None)
    )
    if not age:
        return Text("never", style=theme.FAINT)
    if muted:
        return Text(age, style=theme.FAINT)
    status = (getattr(audit, "last_run_status", None) or "").lower()
    return Text(age, style=_RUN_STATUS_COLORS.get(status, theme.TEXT_DIM))


def render_audits(audits: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``audits list`` view (stdout): an ACCENT panel titled ``audits · {n} · newest first`` with
    columns ``created · name · every · findings · status · last run``. ``every`` is the humanized
    schedule interval; ``findings`` the open-finding count (pink when > 0 — that's the thing to act
    on); status is ``● on``/``○ off``; ``last run`` the age of the last run tinted by its outcome
    (``never`` if it has not run). Disabled audits dim entirely so live ones dominate. ``name`` is
    the handle so it is never truncated; the raw id is hidden unless ``show_id``. The creator
    (``created_by``) is in ``audits show`` / ``--json`` — it loses to the operational columns here."""
    items = sorted(audits, key=lambda a: getattr(a, "created_at", "") or "", reverse=True)
    parsed = [_parse_iso(getattr(a, "created_at", "")) for a in items]
    multi_year = len({p.year for p in parsed if p is not None}) > 1

    header = (["id"] if show_id else []) + ["created", "name", "every", "findings", "status", "last run"]
    rows = []
    for a in items:
        disabled = not getattr(a, "enabled", True)
        name_style = theme.TEXT_DIM if disabled else theme.TEXT
        dim = theme.FAINT if disabled else theme.TEXT_DIM
        open_findings = getattr(a, "open_findings", 0) or 0
        if disabled:
            findings = Text(str(open_findings), style=theme.FAINT)
        elif open_findings:
            findings = Text(str(open_findings), style=theme.PINK)
        else:
            findings = Text("0", style=theme.TEXT_DIM)
        row = [Text(_short_id(getattr(a, "id", "") or "-"), style=dim)] if show_id else []
        row += [
            Text(_fmt_user_joined(getattr(a, "created_at", ""), multi_year), style=dim),
            Text(getattr(a, "name", "") or "-", style=name_style),
            Text(humanize_secs(getattr(a, "schedule_interval_secs", None)), style=theme.BLUE if not disabled else dim),
            findings,
            _alert_status_cell(getattr(a, "enabled", True), muted=disabled),
            _audit_last_run_cell(a, muted=disabled),
        ]
        rows.append(row)

    title = Text()
    title.append("audits", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)} · newest first", style=theme.LABEL)
    render_list_panel("audits", header=header, rows=rows, days=set(), order=None,
                      empty_message="no audits", title=title)


def audits_footer(audits: Sequence[Any]) -> None:
    """Distribution summary under the audits box (stderr): ``{total} audits · {n} on · {m} off ·
    {f} open findings`` — the findings segment (pink) only when there are any to triage."""
    if _quiet:
        return
    total = len(audits)
    on = sum(1 for a in audits if getattr(a, "enabled", True))
    findings = sum(int(getattr(a, "open_findings", 0) or 0) for a in audits)
    line = Text("  ")
    line.append(f"{total} audit{'' if total == 1 else 's'}", style=theme.LABEL)
    line.append("  ·  ", style=theme.FAINT)
    line.append(f"{on} on", style=theme.SUCCESS)
    line.append("  ·  ", style=theme.FAINT)
    line.append(f"{total - on} off", style=theme.TEXT_DIM)
    if findings:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{findings} open finding{'' if findings == 1 else 's'}", style=theme.PINK)
    _stderr.print(line)
    _stderr.print()


def _audit_identity_line(audit: Any) -> Text:
    """The audit identity fragment: ``● enabled · every {interval} · {window} window · {n} open
    findings`` (the finding count red when > 0 — it's the actionable number)."""
    t = Text()
    t.append_text(_alert_status_inline(getattr(audit, "enabled", True)))
    t.append("  ·  ", style=theme.FAINT)
    t.append("every ", style=theme.LABEL)
    t.append(humanize_secs(getattr(audit, "schedule_interval_secs", None)), style=theme.BLUE)
    t.append("  ·  ", style=theme.FAINT)
    t.append(str(getattr(audit, "window_mode", "") or "-"), style=theme.TEXT_DIM)
    t.append(" window", style=theme.LABEL)
    n = int(getattr(audit, "open_findings", 0) or 0)
    t.append("  ·  ", style=theme.FAINT)
    t.append(str(n), style=f"bold {theme.ERROR}" if n > 0 else theme.TEXT_DIM)
    t.append(f" open finding{'' if n == 1 else 's'}", style=theme.LABEL)
    return t


def _kv_table(pairs: Sequence[tuple]) -> Table:
    """A borderless ``label → value`` table for the audit show cards (label LABEL-dim, value the
    caller's pre-styled ``Text``). Rows whose value is ``None`` are dropped by the caller."""
    table = Table(box=None, pad_edge=False, show_header=False)
    table.add_column(style=theme.LABEL, no_wrap=True)
    table.add_column(overflow="fold")
    for label, value in pairs:
        table.add_row(label, value)
    return table


def _audit_scope_text(scope: Any) -> Text:
    """The audit ``scope`` blob → one readable line: ``key: a, b`` segments for the common
    list-valued filters, else compact JSON. ``everything`` when the scope is empty (no filter)."""
    if not isinstance(scope, dict) or not scope:
        return Text("everything", style=f"italic {theme.TEXT_DIM}")
    t = Text()
    first = True
    for key, value in scope.items():
        if value in (None, "", [], {}):
            continue
        if not first:
            t.append("  ·  ", style=theme.FAINT)
        first = False
        t.append(f"{key} ", style=theme.LABEL)
        if isinstance(value, list):
            t.append(", ".join(str(v) for v in value), style=theme.TEXT)
        elif isinstance(value, dict):
            t.append(_json.dumps(value, ensure_ascii=False), style=theme.TEXT_DIM)
        else:
            t.append(str(value), style=theme.TEXT)
    return t if not first else Text("everything", style=f"italic {theme.TEXT_DIM}")


def _audit_config_cards(audit: Any) -> None:
    """The shared ``schedule`` / ``scope`` / ``analysis`` / ``channels`` cards (stdout) used by both
    ``audits show`` and the green created/updated result — so a written audit renders exactly the
    way inspecting it does."""
    # `anchored to` is the fixed phase runs land on (anchor + N * interval), so a
    # slow run or a manual "run now" can't drift the cadence. Legacy rows written
    # before the column existed have none — those still drift, so say so rather
    # than rendering a bare "-".
    anchor = getattr(audit, "schedule_anchor", None)
    anchor_cell = (
        Text(_anchor_compact(anchor), style=theme.BLUE)
        if anchor
        else Text("unanchored (drifts)", style=theme.TEXT_DIM)
    )
    _alert_card(
        Text("schedule", style=f"bold {theme.ACCENT}"),
        _kv_table([
            ("runs every", Text(humanize_secs(getattr(audit, "schedule_interval_secs", None)), style=theme.BLUE)),
            ("anchored to", anchor_cell),
            ("window mode", Text(str(getattr(audit, "window_mode", "") or "-"), style=theme.TEXT)),
            ("lookback", Text(humanize_secs(getattr(audit, "lookback_window_secs", None)), style=theme.BLUE)),
        ]),
    )

    scope_rows = [("covers", _audit_scope_text(getattr(audit, "scope", None)))]
    ignored = list(getattr(audit, "ignore_error_types", None) or [])
    if ignored:
        scope_rows.append(("ignores", Text(", ".join(str(i) for i in ignored), style=theme.TEXT_DIM)))
    _alert_card(Text("scope", style=f"bold {theme.ACCENT}"), _kv_table(scope_rows))

    llm = Text()
    if getattr(audit, "llm_enabled", True):
        llm.append("● ", style=theme.SUCCESS)
        llm.append("on", style=theme.SUCCESS)
    else:
        llm.append("○ ", style=theme.TEXT_DIM)
        llm.append("off", style=theme.TEXT_DIM)
    _alert_card(
        Text("analysis", style=f"bold {theme.ACCENT}"),
        _kv_table([
            ("llm", llm),
            ("sensitivity", Text(str(getattr(audit, "sensitivity", "") or "-"), style=theme.TEXT)),
            ("top k", Text(str(getattr(audit, "top_k", "") or "-"), style=theme.PINK)),
        ]),
    )

    channels = [c for c in (getattr(audit, "channels", None) or []) if isinstance(c, dict)]
    all_default, table = _alert_channels_body(channels)
    title = Text()
    title.append("channels", style=f"bold {theme.ACCENT}")
    title.append(" · " + ("default" if all_default else "custom"), style=theme.LABEL)
    _alert_card(title, table)


def render_audit_show(audit: Any) -> None:
    """The ``audits show <name>`` view (stdout): a stack of ACCENT cards — an identity card (name +
    description, then ``● enabled · every {interval} · {window} window · {n} open findings`` and a
    ``created by … · last run …`` line) followed by ``schedule`` / ``scope`` / ``analysis`` /
    ``channels``, then a dim ``--json`` pointer. Presentation only."""
    title = Text()
    title.append(getattr(audit, "name", "") or "-", style=f"bold {theme.ACCENT}")
    title.append(" · audit", style=theme.LABEL)

    lines: List[Text] = []
    desc = (getattr(audit, "description", None) or "").strip()
    if desc:
        lines.append(Text(desc, style=theme.TEXT_DIM))
    lines.append(_audit_identity_line(audit))
    meta = Text()
    meta.append("created by ", style=theme.LABEL)
    meta.append(getattr(audit, "created_by", "") or "-", style=theme.TEXT)
    last = _age_compact(getattr(audit, "last_run_finished_at", None))
    meta.append("  ·  ", style=theme.FAINT)
    meta.append("last run ", style=theme.LABEL)
    if last:
        meta.append(last, style=theme.TEXT)
        status = getattr(audit, "last_run_status", None)
        if status:
            meta.append(" (", style=theme.FAINT)
            meta.append_text(_run_status_cell(str(status)))
            meta.append(")", style=theme.FAINT)
    else:
        meta.append("never", style=theme.FAINT)
    lines.append(meta)
    if getattr(audit, "last_error", None):
        err = Text()
        err.append("last error ", style=theme.LABEL)
        err.append(str(audit.last_error), style=theme.ERROR)
        lines.append(err)

    _alert_card(title, Group(*lines))
    _audit_config_cards(audit)

    if not _quiet:
        foot = Text("  ")
        foot.append("view raw with ", style=theme.FAINT)
        foot.append("--json", style=theme.ACCENT)
        _stderr.print()
        _stderr.print(foot)
        _stderr.print()


def _render_audit_write_result(audit: Any, *, verb: str, old_name: Optional[str] = None) -> None:
    """The shared GREEN ``audit created``/``audit updated`` card (stdout) + the same config cards
    ``show`` renders, so a write always displays the audit's real saved state."""
    line1 = Text(getattr(audit, "name", "") or "-", style=f"bold {theme.TEXT}")
    if old_name and old_name != getattr(audit, "name", ""):
        line1.append("   was ", style=theme.FAINT)
        line1.append(old_name, style=theme.FAINT)
    rows = [line1]
    desc = (getattr(audit, "description", None) or "").strip()
    if desc:
        rows.append(Text(desc, style=theme.TEXT_DIM))
    rows.append(_audit_identity_line(audit))
    line_last = Text()
    line_last.append(f"{verb} by ", style=theme.LABEL)
    line_last.append("you", style=theme.TEXT)
    line_last.append(" · ", style=theme.FAINT)
    line_last.append("just now", style=theme.LABEL)
    rows.append(line_last)

    card = Panel(Group(*rows), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text(f"audit {verb}", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print()
    _stdout.print(Padding(card, (0, 0, 0, 2)))
    _audit_config_cards(audit)
    if not _quiet:
        foot = Text("  ")
        foot.append("run it now with ", style=theme.FAINT)
        foot.append(f"fp audits run {getattr(audit, 'name', '') or ''}".rstrip(), style=theme.ACCENT)
        _stderr.print()
        _stderr.print(foot)
        _stderr.print()


def render_audit_created(audit: Any) -> None:
    """The ``audits create`` success view (stdout): the green ``audit created`` card + config cards."""
    _render_audit_write_result(audit, verb="created")


def render_audit_updated(audit: Any, *, old_name: Optional[str] = None) -> None:
    """The ``audits edit`` success view (stdout): the green ``audit updated`` card (with `` was
    {old}`` when renamed) + config cards."""
    _render_audit_write_result(audit, verb="updated", old_name=old_name)


def confirm_audit_edit(name: str) -> bool:
    """Plain edit confirm (stderr): ``⚠ update {name}?`` + ``this replaces the audit's definition``
    + ``confirm? [y/N]`` (default NO). Returns the answer."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append("update ", style=theme.TEXT)
    h.append(name, style=f"bold {theme.ACCENT}")
    h.append("?", style=theme.TEXT)
    return confirm_line(h, Text("this replaces the audit's definition", style=theme.LABEL))


def audit_exists(name: str) -> None:
    """Red ``error`` notice box (stderr): ``✗ an audit named <name> already exists`` + a dim hint to
    edit it instead. (Names are the handle, so they must stay unique.)"""
    body = Text()
    body.append("✗  ", style=f"bold {theme.ERROR}")
    body.append("an audit named ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    body.append(" already exists", style=theme.TEXT)
    hint = Text()
    hint.append("pick a different name, or edit it with ", style=theme.FAINT)
    hint.append(f"fp audits edit {name}", style=theme.ACCENT)
    _notice_box(Group(body, hint), color=theme.ERROR, title="error")


def render_audit_delete_preview(audit: Any) -> None:
    """The ``audits delete`` preview (stderr): an AMBER ``delete audit`` box — name + ``every
    {interval} · {status}`` + the open-finding count (red when > 0, since the delete takes its
    findings and run history with it)."""
    line1 = Text(getattr(audit, "name", "") or "-", style=f"bold {theme.ACCENT}")
    line2 = Text()
    line2.append("every ", style=theme.LABEL)
    line2.append(humanize_secs(getattr(audit, "schedule_interval_secs", None)), style=theme.BLUE)
    line2.append("  ·  ", style=theme.FAINT)
    line2.append_text(_alert_status_cell(getattr(audit, "enabled", True)))
    line3 = Text()
    n = int(getattr(audit, "open_findings", 0) or 0)
    line3.append(str(n), style=f"bold {theme.ERROR}" if n > 0 else theme.TEXT_DIM)
    line3.append(f" open finding{'' if n == 1 else 's'}", style=theme.LABEL)
    card = Panel(Group(line1, line2, line3), box=ROUNDED, border_style=theme.AMBER,
                 title=Text("delete audit", style=f"bold {theme.AMBER}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stderr.print()
    _stderr.print(Padding(card, (0, 0, 0, 2)))


def confirm_audit_delete(open_findings: int) -> bool:
    """Plain delete confirm (stderr): ``⚠ this permanently removes the audit …`` (naming the
    findings that go with it) + ``confirm? [y/N]`` — the amber preview box printed just above."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    if open_findings > 0:
        h.append(f"this permanently removes the audit — its {open_findings} open "
                 f"finding{'' if open_findings == 1 else 's'} and run history go with it",
                 style=theme.LABEL)
    else:
        h.append("this permanently removes the audit and its run history — it can't be undone",
                 style=theme.LABEL)
    return confirm_line(h)


def audit_deleted(name: str) -> None:
    """Green ``deleted`` notice box (stderr): ``✓ deleted audit <name>``."""
    if _quiet:
        return
    body = Text()
    body.append("✓ ", style=theme.SUCCESS)
    body.append("deleted audit ", style=theme.TEXT)
    body.append(name, style=f"bold {theme.ACCENT}")
    _notice_box(body, color=theme.SUCCESS, title="deleted")


def audit_run_queued(name: str) -> None:
    """Plain green line (stderr): ``✓ queued a run for {name}`` + a dim pointer at ``audits runs``.
    The dispatcher picks the run up on its next tick, so this is a queue ack, not a result."""
    if _quiet:
        return
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("queued a run for ", theme.TEXT), (name, theme.ACCENT))
    _plain(("it starts on the next dispatcher tick — watch it with ", theme.FAINT),
           (f"fp audits runs {name}", theme.ACCENT))


# Reference-snapshot states. Module-level and read with a neutral fallback, like
# every other status map in this file (`_STATUS_COLORS`, `_RUN_STATUS_COLORS`,
# `_SEVERITY_COLORS`) — the server owns this vocabulary and may add to it, so an
# unknown value must render dim rather than raise.
_REFERENCE_STATUS_COLORS = {
    "ok": theme.SUCCESS,
    "empty": theme.AMBER,
    "pending": theme.AMBER,
    "fetching": theme.AMBER,
    "failed": theme.ERROR,
    "blocked": theme.ERROR,
}


def _will_be_read(source: Dict[str, Any]) -> bool:
    """Will the next run read this page? Mirrors ``load_for_run`` on the server.

    The predicate is "we hold text for it and the guard has not refused it", NOT
    ``status == "ok"``. Status describes the last REFRESH: a page whose re-read is
    in flight or whose re-read failed still has the snapshot taken last time, and
    the server still sends it to the agent, because a refresh may improve a
    snapshot and never withdraw one.

    Keying on ``ok`` reported a retained page as unreadable while it was in the
    prompt — and suppressed its injection markers, which is the one thing an
    operator is told to look at.
    """
    return str(source.get("status") or "") != "blocked" and int(source.get("chars") or 0) > 0


def audit_context(name: str, ctx: Dict[str, Any]) -> None:
    """The audit's brief plus each reference URL's fetch state.

    Deliberately surfaces the three things that are otherwise invisible: that a
    snapshot was truncated, that secret-shaped values were masked, and that a page
    contains phrases reading as instructions to an AI. The last one is the reason
    the operator gets to see the stored text at all.
    """
    if _quiet:
        return
    text = str(ctx.get("text") or "")
    sources = list(ctx.get("sources") or [])
    _stderr.print()
    _plain(("context for ", theme.TEXT), (name, theme.ACCENT))
    _stderr.print()
    if text:
        for line in text.splitlines() or [""]:
            _plain(("  ", theme.FAINT), (line, theme.TEXT))
    else:
        _plain(("  (no brief)", theme.FAINT))
    _stderr.print()
    if not sources:
        _plain(("  (no reference URLs)", theme.FAINT))
        return
    for s in sources:
        status = str(s.get("status") or "")
        markers = list(s.get("injection_markers") or [])
        # A page carrying injection markers is amber, not green: it is in the
        # prompt, and that is exactly why the operator has to look.
        used = _will_be_read(s)
        tone = _REFERENCE_STATUS_COLORS.get(status, theme.TEXT_DIM)
        if markers and used:
            tone = theme.AMBER
        if markers and used:
            label = "review"
        elif status == "failed" and used:
            label = "stale copy"
        elif status == "fetching" and used:
            label = "re-reading"
        else:
            label = status
        _plain(("  ", theme.FAINT), (f"[{label}]", tone), (" ", theme.TEXT),
               (str(s.get("url") or ""), theme.ACCENT))
        bits = []
        if used:
            bits.append(f"{s.get('chars', 0)} chars")
            if s.get("truncated"):
                bits.append(f"truncated from {s.get('chars_total', 0)}")
            if s.get("redactions"):
                bits.append(f"{s.get('redactions')} secret-shaped values masked")
            if s.get("changed_at"):
                bits.append("changed since last run")
            # Both facts together, because either alone misleads: the copy is
            # old AND it is still what the next run reads.
            if status == "failed":
                bits.append("last re-read failed; this copy is still used")
            elif status == "fetching":
                bits.append("re-reading now; this copy is used until it succeeds")
        elif s.get("error_detail"):
            bits.append(str(s.get("error_detail")))
        if bits:
            _plain(("      ", theme.FAINT), (" · ".join(bits), theme.FAINT))
        if markers:
            _plain(("      ", theme.FAINT),
                   (f"contains {len(markers)} phrase(s) that read as instructions to an AI — "
                    "read the snapshot before the next run", theme.AMBER))


def audit_context_saved(name: str, result: Dict[str, Any]) -> None:
    """Ack for ``audits context-set``. Says how many pages are being fetched, because
    the save returns before the fetch does."""
    if _quiet:
        return
    queued = int(result.get("queued") or 0)
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), ("saved context for ", theme.TEXT), (name, theme.ACCENT))
    if queued:
        _plain((f"fetching {queued} page(s) in the background — check with ", theme.FAINT),
               (f"fp audits context-show {name}", theme.ACCENT))


def audit_context_refreshed(name: str, result: Dict[str, Any]) -> None:
    """Ack for ``audits context-refresh``."""
    if _quiet:
        return
    queued = int(result.get("queued") or 0)
    _stderr.print()
    _plain(("✓ ", theme.SUCCESS), (f"re-queued {queued} page(s) for ", theme.TEXT), (name, theme.ACCENT))


def _run_duration(run: Any) -> str:
    """A run's wall time (``started_at`` → ``finished_at``) as a compact ``12s``/``4m``; ``-`` while
    it is still running or if either timestamp is unparsable."""
    start = _parse_iso(getattr(run, "started_at", "") or "")
    end = _parse_iso(getattr(run, "finished_at", None) or "")
    if start is None or end is None:
        return "-"
    secs = int(max(0.0, (end - start).total_seconds()))
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m"
    return f"{secs // 3600}h"


def render_audit_runs(runs: Sequence[Any], *, name: str = "", show_id: bool = False) -> None:
    """The ``audits runs <name>`` view (stdout): an ACCENT panel titled ``runs · {n} · {audit}`` with
    columns ``started · status · trigger · findings · new · took``. ``findings`` is the run's total,
    ``new`` the count first seen in that run (pink when > 0); ``took`` is the wall time (``-`` while
    a run is still going). Server order (newest first) is preserved; ``--json`` carries the window,
    ``stats``, ``report`` and any ``error``."""
    items = list(runs)
    header = (["id"] if show_id else []) + ["started", "status", "trigger", "findings", "new", "took"]
    rows = []
    for r in items:
        new = int(getattr(r, "new_findings_count", 0) or 0)
        row = [Text(_short_id(getattr(r, "id", "") or "-"), style=theme.TEXT_DIM)] if show_id else []
        row += [
            Text(_age_compact(getattr(r, "started_at", "")) or "-", style=theme.TEXT_DIM),
            _run_status_cell(getattr(r, "status", "")),
            Text(getattr(r, "trigger_kind", "") or "-", style=theme.TEXT_DIM),
            Text(str(getattr(r, "findings_count", 0) or 0), style=theme.TEXT),
            Text(str(new), style=theme.PINK if new else theme.TEXT_DIM),
            Text(_run_duration(r), style=theme.TEXT_DIM),
        ]
        rows.append(row)
    title = Text()
    title.append("runs", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)}", style=theme.LABEL)
    if name:
        title.append(f" · {name}", style=theme.LABEL)
    render_list_panel("runs", header=header, rows=rows, days=set(), order=None,
                      empty_message="no runs yet", title=title)


def audit_runs_footer(runs: Sequence[Any]) -> None:
    """Distribution summary under the runs box (stderr): ``{n} runs · {s} succeeded · {f} failed ·
    {r} running`` — each segment present only when that status appears."""
    if _quiet:
        return
    total = len(runs)
    counts: dict = {}
    for r in runs:
        st = (getattr(r, "status", "") or "").lower()
        counts[st] = counts.get(st, 0) + 1
    line = Text("  ")
    line.append(f"{total} run{'' if total == 1 else 's'}", style=theme.LABEL)
    for st in ("succeeded", "failed", "running"):
        n = counts.get(st, 0)
        if n:
            line.append("  ·  ", style=theme.FAINT)
            line.append(f"{n} {st}", style=_RUN_STATUS_COLORS[st])
    _stderr.print(line)
    _stderr.print()


def render_findings(findings: Sequence[Any], *, show_id: bool = False) -> None:
    """The ``audits findings`` view (stdout): an ACCENT panel titled ``findings · {n} · highest
    priority first`` with columns ``id · title · severity · status · kind · seen · last``. The id IS
    the handle for ``audits finding``/the triage commands, so it's always shown — short by default,
    full with ``--show-id``; ``seen`` is the occurrence count, ``last`` the age of ``last_seen_at``.
    Server order (priority-desc) is preserved. Suppressed findings (dismissed/muted) dim entirely."""
    items = list(findings)
    header = ["id", "title", "severity", "status", "kind", "seen", "last"]
    ids = [((getattr(f, "id", "") or "-") if show_id else _short_id(getattr(f, "id", "") or "-"))
           for f in items]
    kinds = [getattr(f, "kind", "") or "-" for f in items]
    seens = [str(getattr(f, "occurrences", 0) or 0) for f in items]
    lasts = [_age_compact(getattr(f, "last_seen_at", "")) or "-" for f in items]
    sevs = [getattr(f, "severity", "") or "-" for f in items]
    # The title is the ONE flexible column, so it absorbs the leftover width: measure the fixed
    # columns (header-aware, like the queries/settings lists) and truncate the title to the rest,
    # rather than letting a long title push `seen`/`last` off a narrow terminal.
    budget: Optional[int] = None
    if items:
        def _w(label, vals):
            return max(len(label), max((len(v) for v in vals), default=0))
        fixed = (_w("id", ids) + _w("severity", sevs) + _w("status", ["● recurring"])
                 + _w("kind", kinds) + _w("seen", seens) + _w("last", lasts))
        # Chrome = the inter-column padding (2 per column) + the panel border/padding/indent.
        budget = max(SCORES_MIN_WIDTH, _stdout.width - fixed - (2 * len(header) + 8))
    rows = []
    for i, f in enumerate(items):
        status = (getattr(f, "status", "") or "").lower()
        muted = status in ("dismissed", "muted")
        dim = theme.FAINT if muted else theme.TEXT_DIM
        kind = kinds[i]
        kind_style = theme.FAINT if muted else _FINDING_KIND_COLORS.get(kind, theme.TEXT_DIM)
        title_text = getattr(f, "title", "") or "—"
        if budget is not None:
            title_text = _truncate(title_text, budget)
        rows.append([
            Text(ids[i], style=dim),
            Text(title_text, style=theme.FAINT if muted else theme.TEXT),
            _severity_cell(sevs[i], muted=muted),
            _finding_status_cell(getattr(f, "status", ""), muted=muted),
            Text(kind, style=kind_style),
            Text(seens[i], style=dim),
            Text(lasts[i], style=dim),
        ])
    title = Text()
    title.append("findings", style=f"bold {theme.ACCENT}")
    title.append(f" · {len(items)} · highest priority first", style=theme.LABEL)
    render_list_panel("findings", header=header, rows=rows, days=set(), order=None,
                      empty_message="no findings", title=title)


def findings_footer(findings: Sequence[Any]) -> None:
    """Distribution summary under the findings box (stderr): ``{total} findings · {n} open · {m}
    recurring · … · {c} critical`` — status counts in their status colours, then the critical count
    when any are critical."""
    if _quiet:
        return
    total = len(findings)
    counts: dict = {}
    for f in findings:
        st = (getattr(f, "status", "") or "").lower()
        counts[st] = counts.get(st, 0) + 1
    critical = sum(1 for f in findings if (getattr(f, "severity", "") or "") == "critical")
    line = Text("  ")
    line.append(f"{total} finding{'' if total == 1 else 's'}", style=theme.LABEL)
    for st in ("open", "recurring", "resolved", "dismissed", "muted"):
        n = counts.get(st, 0)
        if n:
            line.append("  ·  ", style=theme.FAINT)
            line.append(f"{n} {st}", style=_FINDING_STATUS[st][1])
    if critical:
        line.append("  ·  ", style=theme.FAINT)
        line.append(f"{critical} critical", style=theme.ERROR)
    _stderr.print(line)
    _stderr.print()


def render_finding_show(finding: Any) -> None:
    """The ``audits finding <id>`` view (stdout): a stack of ACCENT cards — an identity card (title
    + short id, then ``severity · status · kind · magnitude``, ``seen {n}× · first … · last …``, the
    owning audit and any assignee) followed by ``analysis`` (description + root cause),
    ``recommendation`` (fix + expected impact + effort), ``scope`` and ``evidence`` — each omitted
    when the finding carries nothing for it. Then a dim ``--json`` pointer."""
    title = Text()
    title.append(getattr(finding, "title", "") or "finding", style=f"bold {theme.ACCENT}")
    title.append(f" · {_short_id(getattr(finding, 'id', '') or '-')}", style=theme.LABEL)

    l1 = Text()
    l1.append_text(_severity_cell(getattr(finding, "severity", "") or "-"))
    l1.append("  ·  ", style=theme.FAINT)
    l1.append_text(_finding_status_cell(getattr(finding, "status", "")))
    kind = getattr(finding, "kind", "") or ""
    if kind:
        l1.append("  ·  ", style=theme.FAINT)
        l1.append(kind, style=_FINDING_KIND_COLORS.get(kind, theme.TEXT_DIM))
    magnitude = getattr(finding, "magnitude", None)
    if magnitude:
        l1.append("  ·  ", style=theme.FAINT)
        l1.append(str(magnitude), style=theme.TEXT_DIM)
    lines: List[Text] = [l1]

    l2 = Text()
    l2.append("seen ", style=theme.LABEL)
    l2.append(f"{int(getattr(finding, 'occurrences', 0) or 0)}×", style=theme.PINK)
    first = _age_compact(getattr(finding, "first_seen_at", ""))
    last = _age_compact(getattr(finding, "last_seen_at", ""))
    if first:
        l2.append("  ·  ", style=theme.FAINT)
        l2.append("first ", style=theme.LABEL)
        l2.append(first, style=theme.TEXT)
    if last:
        l2.append("  ·  ", style=theme.FAINT)
        l2.append("last ", style=theme.LABEL)
        l2.append(last, style=theme.TEXT)
    lines.append(l2)

    l3 = Text()
    l3.append("audit ", style=theme.LABEL)
    l3.append(getattr(finding, "audit_name", "") or "—", style=theme.TEXT)
    failure_type = getattr(finding, "failure_type", "") or ""
    if failure_type:
        l3.append("  ·  ", style=theme.FAINT)
        l3.append(failure_type, style=theme.TEXT_DIM)
    if getattr(finding, "assigned_to", None):
        l3.append("  ·  ", style=theme.FAINT)
        l3.append("assigned to ", style=theme.LABEL)
        l3.append(str(finding.assigned_to), style=theme.TEXT)
    lines.append(l3)

    _alert_card(title, Group(*lines))

    analysis = []
    if (getattr(finding, "description", None) or "").strip():
        analysis.append(("what", Text(str(finding.description).strip(), style=theme.TEXT)))
    if (getattr(finding, "root_cause_hypothesis", None) or "").strip():
        analysis.append(("likely cause", Text(str(finding.root_cause_hypothesis).strip(), style=theme.TEXT_DIM)))
    if analysis:
        _alert_card(Text("analysis", style=f"bold {theme.ACCENT}"), _kv_table(analysis))

    fix = []
    if (getattr(finding, "recommendation", None) or "").strip():
        fix.append(("do", Text(str(finding.recommendation).strip(), style=theme.TEXT)))
    if (getattr(finding, "expected_impact", None) or "").strip():
        fix.append(("impact", Text(str(finding.expected_impact).strip(), style=theme.SUCCESS)))
    if (getattr(finding, "effort", None) or "").strip():
        fix.append(("effort", Text(str(finding.effort).strip(), style=theme.TEXT_DIM)))
    if fix:
        _alert_card(Text("recommendation", style=f"bold {theme.ACCENT}"), _kv_table(fix))

    scope = getattr(finding, "scope", None)
    if isinstance(scope, dict) and scope:
        _alert_card(Text("scope", style=f"bold {theme.ACCENT}"),
                    _kv_table([("covers", _audit_scope_text(scope))]))

    evidence_rows = []
    evidence = getattr(finding, "evidence", None)
    if isinstance(evidence, dict) and evidence:
        evidence_rows.append(("sample", Text(_json.dumps(evidence, ensure_ascii=False), style=theme.TEXT_DIM)))
    queries = list(getattr(finding, "evidence_queries", None) or [])
    if queries:
        evidence_rows.append((
            "queries",
            Text("\n".join(q if isinstance(q, str) else _json.dumps(q, ensure_ascii=False) for q in queries),
                 style=theme.TEXT_DIM),
        ))
    if evidence_rows:
        _alert_card(Text("evidence", style=f"bold {theme.ACCENT}"), _kv_table(evidence_rows))

    if not _quiet:
        foot = Text("  ")
        foot.append("view raw with ", style=theme.FAINT)
        foot.append("--json", style=theme.ACCENT)
        _stderr.print()
        _stderr.print(foot)
        _stderr.print()


# Triage action → the past-tense word the ✓ line reports.
_TRIAGE_VERBS = {
    "ack": "acknowledged", "mute": "muted", "dismiss": "dismissed",
    "resolve": "resolved", "reopen": "reopened", "assign": "assigned",
}


def confirm_finding_action(action: str, finding_id: str, *, title: Optional[str] = None) -> bool:
    """Plain triage confirm (stderr) for the suppressing/closing actions: ``⚠ {action} finding
    {short id} ({title})?`` + what it does + ``confirm? [y/N]`` (default NO). Returns the answer."""
    h = Text()
    h.append("⚠ ", style=f"bold {theme.AMBER}")
    h.append(f"{action} finding ", style=theme.TEXT)
    h.append(_short_id(finding_id or "-"), style=f"bold {theme.ACCENT}")
    if title:
        h.append(f" ({title})", style=theme.LABEL)
    h.append("?", style=theme.TEXT)
    consequence = {
        "mute": "future runs stop surfacing this pattern",
        "dismiss": "it's suppressed as not worth acting on",
        "resolve": "it closes; a genuine recurrence re-opens as new",
    }.get(action, "this changes the finding's status")
    return confirm_line(h, Text(consequence, style=theme.LABEL))


def finding_triaged(action: str, finding_id: str, *, assigned_to: Optional[str] = None) -> None:
    """Plain green line (stderr): ``✓ {verb} finding {short id}`` — plus ``· {email}`` for an
    assign. The past-tense verb comes from the triage-action map."""
    if _quiet:
        return
    _stderr.print()
    verb = _TRIAGE_VERBS.get(action, action)
    parts = [("✓ ", theme.SUCCESS), (f"{verb} finding ", theme.TEXT),
             (_short_id(finding_id or "-"), theme.ACCENT)]
    if assigned_to:
        parts += [("  ·  ", theme.FAINT), (assigned_to, theme.TEXT_DIM)]
    _plain(*parts)


# ══ end audits renderers ══


def format_scores(scores: Optional[dict]) -> str:
    """Compact one-line rendering of a score map, e.g. ``helpfulness=0.85``."""
    if not scores:
        return "-"
    return " ".join(f"{k}={_round(v)}" for k, v in scores.items())


def _round(value: Any) -> str:
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def _as_dict(item: Any) -> dict:
    if dataclasses.is_dataclass(item) and not isinstance(item, type):
        return dataclasses.asdict(item)
    return dict(item)


def project_dicts(items: Sequence[Any], fields: Sequence[str]) -> list:
    """Project dataclass items down to dicts holding only ``fields`` (in order)."""
    return [{name: _as_dict(it).get(name) for name in fields} for it in items]


def project_rows(items: Sequence[Any], fields: Sequence[str]) -> List[list]:
    """Table rows for ``items`` projected to ``fields`` (scores/dicts rendered compactly)."""
    rows: List[list] = []
    for it in items:
        d = _as_dict(it)
        rows.append([_field_cell(name, d.get(name)) for name in fields])
    return rows


def _field_cell(name: str, value: Any) -> str:
    if name == "scores":
        return format_scores(value)
    if isinstance(value, (dict, list)):
        return _json.dumps(value, ensure_ascii=False)
    return _cell(value)


# ── Cloud-managed enforcement ────────────────────────────────────────────────


_EFFECT_STYLE = {"enforce": theme.SUCCESS, "observe": theme.AMBER}

#: Eight levels is what a terminal row can show without becoming a chart. The
#: timeline is 24 hourly bins, so the whole day fits on one line beside a label.
_SPARK = "▁▂▃▄▅▆▇█"


def sparkline(values: Sequence[float]) -> str:
    """A one-line bar strip. Flat-zero renders as the lowest block, not blank —
    "nothing was blocked" and "no data" are different answers and must not look
    the same."""
    vals = [max(0.0, float(v or 0)) for v in values]
    if not vals:
        return ""
    peak = max(vals)
    if peak <= 0:
        return _SPARK[0] * len(vals)
    return "".join(_SPARK[min(len(_SPARK) - 1, int(v / peak * (len(_SPARK) - 1)))] for v in vals)


def _effect(effect: str) -> Text:
    return Text(effect, style=_EFFECT_STYLE.get(effect, theme.TEXT_DIM))


def _policy_cell(ref: Any) -> Text:
    t = Text(ref.id, style=theme.TEXT)
    t.append(f" v{ref.version}", style=theme.TEXT_DIM)
    return t


def render_policies(items: Sequence[Any]) -> None:
    """``fp policies`` — every published policy, newest version of each."""
    rows = []
    for p in sorted(items, key=lambda x: x.id):
        state = Text("active", style=theme.SUCCESS)
        if p.archived:
            state = Text("archived", style=theme.FAINT)
        elif p.disabled:
            state = Text("disabled", style=theme.AMBER)
        rows.append([
            Text(p.id, style=theme.TEXT),
            Text(f"v{p.version}", style=theme.TEXT_DIM),
            state,
            Text(p.description or "", style=theme.TEXT_DIM),
        ])
    title = Text()
    title.append("policies", style=f"bold {theme.ACCENT}")
    title.append(" · ", style=theme.FAINT)
    title.append(str(len(rows)), style="bold white")
    render_list_panel("policies", header=["policy", "version", "state", "description"],
                      rows=rows, days=set(), order=None,
                      empty_message="no policies published — `fp policies publish <id> <file>`",
                      last_col="ellipsis", title=title)


def render_policy_published(p: Any, *, deployed_to: int = 0) -> None:
    """``fp policies publish`` — a new VERSION was minted, not an edit.

    The deployed-elsewhere note is the point: publishing changes nothing on any
    machine until it is deployed, and an author who assumes otherwise ships a
    policy that is never enforced.
    """
    line1 = Text(p.id, style=f"bold {theme.TEXT}")
    line1.append(f"  v{p.version}", style=theme.ACCENT)
    line2 = Text()
    line2.append("sha256 ", style=theme.LABEL)
    line2.append((p.sha256 or "")[:12] + "…", style=theme.TEXT_DIM)
    body = [line1, line2]
    if deployed_to:
        note = Text()
        note.append(f"v{p.version} is not deployed anywhere yet", style=theme.AMBER)
        body.append(note)
        hint_line = Text()
        hint_line.append("deploy with ", style=theme.LABEL)
        hint_line.append(f"fp fleet deploy <machine> --add {p.id}@{p.version}", style=theme.ACCENT)
        body.append(hint_line)
    card = Panel(Group(*body), box=ROUNDED, border_style=theme.SUCCESS,
                 title=Text("policy published", style=f"bold {theme.SUCCESS}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print(); _stdout.print(Padding(card, (0, 0, 0, 2))); _stdout.print()


def render_fleet(machines: Sequence[Any], deployments: Sequence[Any]) -> None:
    """``fp fleet`` — every machine, what it is told to run, and whether it has it.

    ``deployment`` is intent and ``applied`` is delivery. Showing both is the
    point: a machine can be deployed-to and still enforcing an older set, and
    nothing else in the CLI surfaces that gap.
    """
    rows = []
    for m in sorted(machines, key=lambda x: x.machine_id):
        applied = Text(
            f"#{m.applied_deployment}" if m.applied_deployment is not None else "—",
            style=theme.AMBER if m.drifted else theme.TEXT_DIM,
        )
        rows.append([
            Text(m.machine_id, style=theme.TEXT),
            Text(m.label or "-", style=theme.TEXT_DIM),
            Text(str(m.policy_count), style=theme.TEXT if m.policy_count else theme.FAINT),
            Text(f"#{m.deployment}" if m.deployment is not None else "—", style=theme.TEXT_DIM),
            applied,
            Text("drifted" if m.drifted else ("ok" if m.deployed else "—"),
                 style=theme.AMBER if m.drifted else (theme.SUCCESS if m.deployed else theme.FAINT)),
        ])
    title = Text()
    title.append("fleet", style=f"bold {theme.ACCENT}")
    title.append(" · ", style=theme.FAINT)
    title.append(str(len(rows)), style="bold white")
    render_list_panel("fleet",
                      header=["machine", "label", "policies", "intended", "applied", "state"],
                      rows=rows, days=set(), order=None,
                      empty_message="no machines have checked in yet",
                      last_col="ellipsis", title=title)


def render_machine_policies(machine_id: str, dep: Any) -> None:
    """``fp fleet show`` — the set a machine is told to run, and nothing more.

    Deliberately NOT the deploy-plan renderer: that one talks about a change
    ("2 policies after this change", "first deployment"), which is a lie on a
    read-only view and exactly the kind of wrong-but-plausible text this repo
    keeps producing.
    """
    lines = []
    for p in sorted(dep.policies, key=lambda x: x.id):
        t = Text("  ", style=theme.FAINT)
        t.append(p.id, style=theme.TEXT)
        t.append(f" v{p.version}", style=theme.TEXT_DIM)
        t.append("  ")
        t.append_text(_effect(p.effect))
        lines.append(t)
    if not lines:
        lines = [Text("  (no policies deployed)", style=theme.FAINT)]
    head = Text(machine_id, style=f"bold {theme.TEXT}")
    head.append(f"  ·  deployment #{dep.deployment}", style=theme.TEXT_DIM)
    card = Panel(Group(head, Text(), *lines), box=ROUNDED, border_style=theme.ACCENT,
                 title=Text("deployed policies", style=f"bold {theme.ACCENT}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print(); _stdout.print(Padding(card, (0, 0, 0, 2))); _stdout.print()


def render_deploy_plan(plan: Any, *, applied: bool = False) -> None:
    """The signature view: the FULL resulting set, with the diff marked.

    Unchanged rows are shown on purpose. The endpoint replaces everything, so
    the set on screen is the set that will exist — hiding the untouched rows
    would hide exactly the ones a mistake silently drops.
    """
    lines = []
    for p in plan.added:
        t = Text("  + ", style=theme.SUCCESS); t.append_text(_policy_cell(p))
        t.append("  "); t.append_text(_effect(p.effect)); lines.append(t)
    for was, now in plan.changed:
        t = Text("  ~ ", style=theme.AMBER); t.append_text(_policy_cell(now))
        t.append("  "); t.append_text(_effect(now.effect))
        t.append(f"   (was v{was.version} {was.effect})", style=theme.FAINT); lines.append(t)
    for p in plan.removed:
        t = Text("  - ", style=theme.ERROR)
        t.append(p.id, style=theme.TEXT_DIM); t.append(f" v{p.version}", style=theme.FAINT)
        lines.append(t)
    for p in plan.unchanged:
        t = Text("  = ", style=theme.FAINT); t.append_text(_policy_cell(p))
        t.append("  "); t.append_text(_effect(p.effect)); lines.append(t)
    if not lines:
        lines = [Text("  (no policies)", style=theme.FAINT)]

    footer = Text()
    n = len(plan.result)
    footer.append(f"{n} ", style="bold white")
    footer.append(f"polic{'y' if n == 1 else 'ies'} after this change", style=theme.LABEL)
    lines.append(Text())
    lines.append(footer)

    head = Text(plan.machine_id, style=f"bold {theme.TEXT}")
    if plan.base is not None:
        head.append(f"  ·  deployment {plan.base} → {plan.base + 1}", style=theme.TEXT_DIM)
    else:
        head.append("  ·  first deployment", style=theme.TEXT_DIM)
    border = theme.SUCCESS if applied else theme.ACCENT
    card = Panel(Group(head, Text(), *lines), box=ROUNDED, border_style=border,
                 title=Text("deployed" if applied else "deploy plan", style=f"bold {border}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print(); _stdout.print(Padding(card, (0, 0, 0, 2))); _stdout.print()


def render_guardrails(summary: dict, timeline: Optional[dict] = None) -> None:
    """``fp guardrails`` — what actually happened, as opposed to what was intended."""
    totals = summary.get("totals") or {}
    stat = Text()
    stat.append(str(totals.get("evaluated", 0)), style="bold white")
    stat.append(" evaluated   ", style=theme.LABEL)
    stat.append(str(totals.get("blocked", 0)), style=f"bold {theme.ERROR}")
    stat.append(" blocked   ", style=theme.LABEL)
    stat.append(f"{totals.get('enforcingMachines', 0)}/{totals.get('reportingMachines', 0)}",
                style="bold white")
    stat.append(" machines enforcing", style=theme.LABEL)
    body = [stat]

    if timeline:
        series = (timeline.get("series") or [{}])[0].get("points") or []
        denies = [p.get("deny", 0) for p in series]
        if denies:
            spark = Text()
            spark.append("denies  ", style=theme.LABEL)
            spark.append(sparkline(denies), style=theme.ERROR)
            body.append(spark)

    card = Panel(Group(*body), box=ROUNDED, border_style=theme.ACCENT,
                 title=Text(f"guardrails · {summary.get('hours', 24)}h",
                            style=f"bold {theme.ACCENT}"),
                 title_align="left", padding=(0, 1), expand=False)
    _stdout.print(); _stdout.print(Padding(card, (0, 0, 0, 2)))

    rows = []
    for p in summary.get("policies") or []:
        rows.append([
            Text(str(p.get("policy") or "-"), style=theme.TEXT),
            Text(str(p.get("fired", 0)), style=theme.TEXT_DIM),
            Text(str(p.get("blocked", 0)),
                 style=theme.ERROR if p.get("blocked") else theme.FAINT),
            Text(str(p.get("instructed", 0)),
                 style=theme.AMBER if p.get("instructed") else theme.FAINT),
            Text(f"{p.get('p95Ms', 0)}ms", style=theme.TEXT_DIM),
        ])
    # An explicit title: the default one appends "newest first", which is a
    # claim about ordering this table does not make — it is ranked by policy,
    # not by time.
    ptitle = Text()
    ptitle.append("by policy", style=f"bold {theme.ACCENT}")
    ptitle.append(" · ", style=theme.FAINT)
    ptitle.append(str(len(rows)), style="bold white")
    render_list_panel("guardrails", header=["policy", "fired", "blocked", "instructed", "p95"],
                      rows=rows, days=set(), order=None,
                      empty_message="no decisions recorded in this window",
                      last_col="ellipsis", title=ptitle)

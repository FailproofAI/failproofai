"""Shared brand color tokens + the permission action→color map.

Truecolor hex; Rich downgrades to the nearest supported color automatically and drops color
entirely under ``NO_COLOR`` / non-color terminals.
"""

from __future__ import annotations

ACCENT = "#9d7bff"    # brand mark, box borders, active org, command names in hints
TEXT = "#d8d2dd"      # primary values
TEXT_DIM = "#7d7488"  # ids, resource names, org names
LABEL = "#6b6478"     # field labels, header cells, hints
FAINT = "#5a5266"     # separators, inactive markers
THIN_RULE = "#2e2435" # the faint rule beneath a list-panel header
BAR_EMPTY = "#2a2530" # the unfilled cells of a mini-bar (e.g. the aggregate avg bar)
INSET_BG = "#231e2d"  # a hair-lighter fill for a nested inset box (the login org picker)

# Errors theme — the one per-command border deviation (the `errors` list + aggregate card).
# Always red, regardless of error count, so the two views read as one consistent family.
BORDER_ERROR = "#e2564a"  # red → the errors panel border (same as ERROR; consistent, not count-dependent)
TITLE_ERROR_DIM = "#6e3530"  # dim red → the errors title's non-name part + card separators
RULE_ERROR = "#3a2d2d"  # dim red → the errors list header rule (vs the neutral THIN_RULE)

# Semantic value colors — for run/job states and score thresholds. (They coincide with
# the perm risk colors below; named separately so the two uses can diverge later.)
SUCCESS = "#5dcaa5"   # green     → run status: done/passed
AMBER = "#ef9f27"     # amber     → run status: running/pending · score band .50–.80
ERROR = "#e2564a"     # red       → run status: failed/error · score band < .50
SCORE_HIGH = "#3ddbb8"  # cyan-green → score band ≥ .80 (distinct from status green)
BLUE = "#6b86d8"      # blue      → schema uuid/timestamp type category
PINK = "#d4537e"      # pink      → numeric values (query run cells / scalar card) + numeric type category

# Permission verb colors — by ACTION (the part after `:`), never by resource.
PERM_READ = "#5dcaa5"    # green  → read
PERM_WRITE = "#d4537e"   # pink   → add, create, write, update
PERM_ACTION = "#ef9f27"  # amber  → use, trigger, run, ack
PERM_DANGER = "#e2564a"  # red    → delete, disable, regenerate

PERM_COLORS = {
    "read": PERM_READ,
    "add": PERM_WRITE, "create": PERM_WRITE, "write": PERM_WRITE, "update": PERM_WRITE,
    "use": PERM_ACTION, "trigger": PERM_ACTION, "run": PERM_ACTION, "ack": PERM_ACTION,
    "delete": PERM_DANGER, "disable": PERM_DANGER, "regenerate": PERM_DANGER,
}
DEFAULT_PERM_COLOR = LABEL  # any unmapped action → neutral dim (never crash / guess a risk)

# Risk rank for ordering actions within a row: read → modify → invoke → destroy.
PERM_RANK = {PERM_READ: 0, PERM_WRITE: 1, PERM_ACTION: 2, PERM_DANGER: 3}


def perm_color(action: str) -> str:
    """The color for a permission action, or the neutral default if it's unmapped."""
    return PERM_COLORS.get(action, DEFAULT_PERM_COLOR)

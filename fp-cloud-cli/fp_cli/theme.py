"""Shared brand color tokens + the permission action→color map.

Truecolor hex; Rich downgrades to the nearest supported color automatically and drops color
entirely under ``NO_COLOR`` / non-color terminals.
"""

from __future__ import annotations

ACCENT = "#66d1b5"    # mint: active and successful states
TEXT = "default"     # the terminal's foreground (also works on light themes)
TEXT_DIM = "#767f8b"
LABEL = "#767f8b"    # grey labels and metadata
FAINT = "#767f8b"
THIN_RULE = "#3e434c"
BAR_EMPTY = "#3e434c"
INSET_BG = "default"

# Errors theme — the one per-command border deviation (the `errors` list + aggregate card).
# Always red, regardless of error count, so the two views read as one consistent family.
BORDER_ERROR = "#e4587d"
TITLE_ERROR_DIM = LABEL
RULE_ERROR = THIN_RULE

# Semantic value colors — for run/job states and score thresholds. (They coincide with
# the perm risk colors below; named separately so the two uses can diverge later.)
SUCCESS = ACCENT
PINK = "#e4587d"      # pink: commands, selection and attention
AMBER = PINK
ERROR = PINK
SCORE_HIGH = ACCENT
BLUE = ACCENT

# Permission verb colors — by ACTION (the part after `:`), never by resource.
PERM_READ = ACCENT
PERM_WRITE = PINK
PERM_ACTION = PINK
PERM_DANGER = PINK

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

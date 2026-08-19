"""The logic behind `fp policies` and `fp fleet`, with no HTTP in it.

Everything here is pure so it can be tested without a server, because the two
things most likely to lose someone's work are decided here rather than in a
handler: what a deploy's resulting policy set is, and whether somebody else
wrote while we were deciding.

## Why a diff at all

`PUT /enforcement/deployments/{id}` is a FULL REPLACE. Send `{"policies": [a]}`
to a machine running `[a, b, c]` and it now runs `[a]` — permanently, with a
200 and no warning. The dashboard never exposes that as a form for exactly this
reason (`app/(dashboard)/[org]/enforcement/page.tsx`: "a form that asks you to
re-pick a machine and re-tick its policies silently drops whatever you forget
to tick"). It edits the machine's own current set instead.

So `--add`/`--remove` are the CLI's equivalent: read the current set, apply the
delta, write the whole thing back. `--set` remains for the declarative case,
and is the only way to express "exactly these, drop the rest".

## Why the race check

There is no optimistic locking on that endpoint. The dashboard detects a
collision AFTER the fact by checking the returned generation is exactly
`base + 1` (`lib/enforcementFleet.ts`, `staleness()`). The same check here is
what stops two operators silently overwriting each other — the CLI refuses and
re-reads rather than reporting a success that erased somebody.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .errors import ApiError
from .models import PolicyRef, PolicyVersion

VALID_EFFECTS = ("enforce", "observe")

#: `id`, `id@3`, `id:observe`, `id@3:observe`. The id charset mirrors the
#: server's `safe_identifier`, so a ref this accepts is one the server will too
#: — a rejection should come from the policy not existing, not from parsing.
_REF = re.compile(r"^(?P<id>[A-Za-z0-9._-]{1,128})(?:@(?P<version>\d+))?(?:[:](?P<effect>[a-z]+))?$")


class RefError(ValueError):
    """A malformed `--add` / `--remove` / `--set` token, with the reason."""


def parse_ref(token: str) -> Tuple[str, Optional[int], Optional[str]]:
    """``"id@2:observe"`` → ``("id", 2, "observe")``; omitted parts are None.

    Version and effect are resolved later — ``None`` means "whatever is current",
    which is not the same as a default, because for an existing deployment the
    current value is the deployed one rather than the newest one.
    """
    token = token.strip()
    if not token:
        raise RefError("empty policy reference")
    m = _REF.match(token)
    if not m:
        raise RefError(
            f"{token!r} is not a policy reference — expected id, id@version, "
            "id:effect or id@version:effect"
        )
    effect = m.group("effect")
    if effect is not None and effect not in VALID_EFFECTS:
        raise RefError(
            f"{token!r} has effect {effect!r}; expected one of {', '.join(VALID_EFFECTS)}"
        )
    version = m.group("version")
    return m.group("id"), (int(version) if version is not None else None), effect


@dataclass
class DeployPlan:
    """The resulting set, and how it differs from what the machine runs now.

    `result` is what will be PUT — the whole set, because that is what the
    endpoint takes. The three lists exist to be shown to a human before it is.
    """

    machine_id: str
    base: Optional[int]
    result: List[PolicyRef]
    added: List[PolicyRef]
    removed: List[PolicyRef]
    changed: List[Tuple[PolicyRef, PolicyRef]]
    unchanged: List[PolicyRef]

    @property
    def is_noop(self) -> bool:
        return not (self.added or self.removed or self.changed)

    def to_dict(self) -> Dict[str, object]:
        return {
            "machineId": self.machine_id,
            "base": self.base,
            "result": [p.to_dict() for p in self.result],
            "added": [p.to_dict() for p in self.added],
            "removed": [p.to_dict() for p in self.removed],
            "changed": [{"from": a.to_dict(), "to": b.to_dict()} for a, b in self.changed],
            "unchanged": [p.to_dict() for p in self.unchanged],
            "noop": self.is_noop,
        }


def latest_versions(policies: Iterable[PolicyVersion]) -> Dict[str, int]:
    """`{policy_id: newest published version}`, ignoring archived policies."""
    out: Dict[str, int] = {}
    for p in policies:
        if p.archived:
            continue
        if p.version > out.get(p.id, 0):
            out[p.id] = p.version
    return out


def resolve_ref(
    token: str,
    *,
    latest: Dict[str, int],
    current: Dict[str, PolicyRef],
) -> PolicyRef:
    """Turn one `--add`/`--set` token into a concrete `PolicyRef`.

    Version: explicit wins; else the version already deployed (so `--add` on a
    policy the machine already runs is a no-op rather than a silent upgrade);
    else the newest published.

    Effect: explicit wins; else the deployed effect; else `enforce`, matching
    the server's own default for an omitted effect.
    """
    pid, version, effect = parse_ref(token)
    existing = current.get(pid)
    if version is None:
        version = existing.version if existing else latest.get(pid)
    if version is None:
        raise RefError(
            f"no published policy named {pid!r} — run `fp policies list` to see what exists"
        )
    if effect is None:
        effect = existing.effect if existing else "enforce"
    return PolicyRef(id=pid, version=version, effect=effect)


def plan_deploy(
    machine_id: str,
    *,
    current: Optional[Sequence[PolicyRef]],
    base: Optional[int],
    add: Sequence[str] = (),
    remove: Sequence[str] = (),
    replace: Optional[Sequence[str]] = None,
    latest: Optional[Dict[str, int]] = None,
) -> DeployPlan:
    """Compute the full resulting set, plus the diff to show before writing.

    `replace` (`--set`) is exclusive with `add`/`remove`: mixing "these exactly"
    with "these as well" has no single obvious reading, and guessing one would
    be guessing about somebody's fleet.
    """
    latest = latest or {}
    current_list = list(current or [])
    current_map = {p.id: p for p in current_list}

    if replace is not None:
        if add or remove:
            raise RefError("--set replaces the whole set; it cannot be combined with --add/--remove")
        result_map = {}
        for token in replace:
            ref = resolve_ref(token, latest=latest, current=current_map)
            result_map[ref.id] = ref
    else:
        result_map = dict(current_map)
        for token in remove:
            pid, _, _ = parse_ref(token)
            if pid not in result_map:
                raise RefError(
                    f"{pid!r} is not deployed to {machine_id} — nothing to remove"
                )
            del result_map[pid]
        for token in add:
            ref = resolve_ref(token, latest=latest, current=current_map)
            result_map[ref.id] = ref

    result = sorted(result_map.values(), key=lambda p: p.id)
    added, removed, changed, unchanged = [], [], [], []
    for pid, ref in sorted(result_map.items()):
        was = current_map.get(pid)
        if was is None:
            added.append(ref)
        elif (was.version, was.effect) != (ref.version, ref.effect):
            changed.append((was, ref))
        else:
            unchanged.append(ref)
    for pid, was in sorted(current_map.items()):
        if pid not in result_map:
            removed.append(was)

    return DeployPlan(
        machine_id=machine_id,
        base=base,
        result=result,
        added=added,
        removed=removed,
        changed=changed,
        unchanged=unchanged,
    )


def check_race(base: Optional[int], returned: int) -> None:
    """Raise when a deploy landed on top of somebody else's.

    `base` is the generation read before the write. A clean write is exactly
    `base + 1`; anything else means another writer got in between, and their
    change is already gone — a full replace does not merge. Reporting success
    here is how the CLI would become the easiest way to silently overwrite a
    colleague.
    """
    if base is None:
        return
    if returned != base + 1:
        raise ApiError(
            f"deployment {returned} landed where {base + 1} was expected — someone "
            "else deployed to this machine while this command was deciding, and a "
            "deploy REPLACES the whole set rather than merging.",
            hint="re-run `fp fleet show <machine>` to see the current set, then deploy again",
        )


def read_source(
    value: Optional[str],
    *,
    stdin=None,
    isatty: Optional[bool] = None,
    prompt=None,
) -> str:
    """Resolve policy source from a path, `@path`, `-`, a pipe, or a paste.

    The five shapes exist because the thing being supplied is a file that people
    have in five different places: on disk, in a pipeline, in a heredoc, or on
    the clipboard. Refusing the clipboard would mean "save it to a file first"
    for the most common one-off case.

    A bare `-` and a piped stdin are the same read; the difference is only
    whether the user said so. On a TTY with nothing given we prompt, because
    silently blocking on stdin is indistinguishable from a hang.
    """
    stream = sys.stdin if stdin is None else stdin
    tty = stream.isatty() if isatty is None else isatty

    if value == "-":
        return stream.read()
    if value:
        path = value[1:] if value.startswith("@") else value
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
        except FileNotFoundError:
            raise RefError(f"no such file: {path}")
        except OSError as exc:
            raise RefError(f"cannot read {path}: {exc}")
    if not tty:
        return stream.read()
    if prompt is not None:
        prompt()
    return stream.read()

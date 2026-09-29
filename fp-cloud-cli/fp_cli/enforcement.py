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

import json
import re
import sys
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .errors import ApiError
from .models import PolicyRef, PolicyVersion

VALID_EFFECTS = ("enforce", "observe")

#: What a policy version carries: JavaScript (`regex`), Jev checks (`jev`), or
#: JavaScript reviewable by its own Jev checks (`both`).
VALID_KINDS = ("regex", "jev", "both")

#: The Jev modes a deployment may set. `local` stops FailproofAI Cloud
#: overriding the machine's own mode (the server stores it as no value).
JEV_MODES = ("off", "observe", "enforce", "local")

#: The server's (and the machine's) cap on Jev declarations per policy version.
MAX_JEV_DECLARATIONS = 24

#: `id`, `id@3`, `id:observe`, `id@3:observe`. The id charset mirrors the
#: server's `safe_identifier`, so a ref this accepts is one the server will too
#: — a rejection should come from the policy not existing, not from parsing.
_REF = re.compile(r"^(?P<id>[A-Za-z0-9._-]{1,128})(?:@(?P<version>\d+))?(?:[:](?P<effect>[a-z]+))?$")


class RefError(ValueError):
    """A malformed `--add` / `--remove` / `--set` token, with the reason."""


class RefUsageError(RefError):
    """A RefError the caller can fix by retyping the command.

    Split out so the command layer can exit 2 (usage) rather than 1 (API error)
    for these, which is what the documented exit-code table promises and what
    `--since` and `--expect` in these same commands already do. A malformed
    token, two flags that contradict each other, or a path that is not readable
    text are all "you typed it wrong" — not "the server said no".

    Subclasses ``RefError`` so every existing caller and test that catches the
    base class keeps working unchanged.
    """


def parse_ref(token: str) -> Tuple[str, Optional[int], Optional[str]]:
    """``"id@2:observe"`` → ``("id", 2, "observe")``; omitted parts are None.

    Version and effect are resolved later — ``None`` means "whatever is current",
    which is not the same as a default, because for an existing deployment the
    current value is the deployed one rather than the newest one.
    """
    token = token.strip()
    if not token:
        raise RefUsageError("empty policy reference")
    m = _REF.match(token)
    if not m:
        raise RefUsageError(
            f"{token!r} is not a policy reference — expected id, id@version, "
            "id:effect or id@version:effect"
        )
    effect = m.group("effect")
    if effect is not None and effect not in VALID_EFFECTS:
        raise RefUsageError(
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
    #: `--jev-mode` as given (`off|observe|enforce|local`), or None when the
    #: command said nothing about Jev — which the server reads as "keep it".
    jev_mode: Optional[str] = None
    #: The mode FailproofAI Cloud sets on the machine now (None = local).
    jev_mode_before: Optional[str] = None

    @property
    def jev_mode_after(self) -> Optional[str]:
        """What the machine's Cloud-set mode will be (None = local)."""
        if self.jev_mode is None:
            return self.jev_mode_before
        return None if self.jev_mode == "local" else self.jev_mode

    @property
    def jev_mode_changes(self) -> bool:
        return self.jev_mode is not None and self.jev_mode_after != self.jev_mode_before

    @property
    def is_noop(self) -> bool:
        return not (self.added or self.removed or self.changed or self.jev_mode_changes)

    def to_dict(self) -> Dict[str, object]:
        out: Dict[str, object] = {
            "machineId": self.machine_id,
            "base": self.base,
            "result": [p.to_dict() for p in self.result],
            "added": [p.to_dict() for p in self.added],
            "removed": [p.to_dict() for p in self.removed],
            "changed": [{"from": a.to_dict(), "to": b.to_dict()} for a, b in self.changed],
            "unchanged": [p.to_dict() for p in self.unchanged],
            "noop": self.is_noop,
        }
        if self.jev_mode is not None:
            # `local` on both sides: the wire word, not the stored NULL.
            out["jevMode"] = {
                "from": self.jev_mode_before or "local",
                "to": self.jev_mode_after or "local",
                "changed": self.jev_mode_changes,
            }
        return out


def latest_versions(policies: Iterable[PolicyVersion]) -> Dict[str, int]:
    """`{policy_id: newest published version}`, ignoring archived policies."""
    out: Dict[str, int] = {}
    for p in policies:
        if p.archived:
            continue
        if p.version > out.get(p.id, 0):
            out[p.id] = p.version
    return out


def disabled_ids(policies: Iterable[PolicyVersion]) -> set:
    """Policies the server will refuse to deploy.

    The server rejects these anyway, but only after the CLI has drawn a plan and
    asked the operator to confirm it — so the last thing on screen is a change
    that cannot happen, under a prompt that implied it could. Everything else
    the plan depends on (the machine exists, the policy exists) is already
    checked before the plan is built; this was the one gap.
    """
    return {p.id for p in policies if p.disabled and not p.archived}


def resolve_ref(
    token: str,
    *,
    latest: Dict[str, int],
    current: Dict[str, PolicyRef],
    disabled: Optional[set] = None,
) -> PolicyRef:
    """Turn one `--add`/`--set` token into a concrete `PolicyRef`.

    Version: explicit wins; else the version already deployed (so `--add` on a
    policy the machine already runs is a no-op rather than a silent upgrade);
    else the newest published.

    Effect: explicit wins; else the deployed effect; else `enforce`, matching
    the server's own default for an omitted effect.
    """
    pid, version, effect = parse_ref(token)
    if disabled and pid in disabled and pid not in current:
        raise RefError(
            f"{pid!r} is disabled — `fp policies enable {pid}` first, or the machine "
            "would be sent a deployment the server refuses"
        )
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
    disabled: Optional[set] = None,
    jev_mode: Optional[str] = None,
    current_jev_mode: Optional[str] = None,
    kinds: Optional[Dict[Tuple[str, int], str]] = None,
) -> DeployPlan:
    """Compute the full resulting set, plus the diff to show before writing.

    `replace` (`--set`) is exclusive with `add`/`remove`: mixing "these exactly"
    with "these as well" has no single obvious reading, and guessing one would
    be guessing about somebody's fleet.

    `jev_mode` is `--jev-mode`; `current_jev_mode` what Cloud sets now (None =
    local). `kinds` maps `(id, version)` to the version's kind, so an `observe`
    effect on a Jev-only version — which the server refuses, because a Jev
    rollout is observed through the Jev MODE — is refused here, before a plan is
    drawn and confirmed for a write that cannot happen.
    """
    if jev_mode is not None and jev_mode not in JEV_MODES:
        raise RefUsageError(
            f"--jev-mode {jev_mode!r} is not one of {', '.join(JEV_MODES)}"
        )
    latest = latest or {}
    current_list = list(current or [])
    current_map = {p.id: p for p in current_list}

    if replace is not None:
        if add or remove:
            raise RefUsageError(
                "--set replaces the whole set; it cannot be combined with --add/--remove"
            )
        result_map = {}
        for token in replace:
            ref = resolve_ref(token, latest=latest, current=current_map, disabled=disabled)
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
            ref = resolve_ref(token, latest=latest, current=current_map, disabled=disabled)
            result_map[ref.id] = ref

    result = sorted(result_map.values(), key=lambda p: p.id)
    for ref in result:
        if ref.effect == "observe" and (kinds or {}).get((ref.id, ref.version)) == "jev":
            raise RefUsageError(
                f"{ref.id}@{ref.version} is a Jev policy, and an effect does not apply to Jev "
                "checks — deploy it as enforce and use --jev-mode observe to watch Jev without "
                "it deciding anything"
            )
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
        jev_mode=jev_mode,
        jev_mode_before=current_jev_mode,
    )


def version_kinds(policies: Iterable[PolicyVersion]) -> Dict[Tuple[str, int], str]:
    """`{(id, version): kind}` for every published version."""
    return {(p.id, p.version): p.kind for p in policies}


def resolve_kind(kind: Optional[str], *, has_source: bool, has_semantic: bool) -> str:
    """The kind a publish is, checked against what it was given.

    Explicit wins; otherwise it follows from the inputs — JavaScript alone is
    `regex` (what `publish` has always done), declarations alone `jev`, both
    together `both`. A kind that contradicts its inputs is a usage error: a
    `jev` policy has no JavaScript, and `regex` has no declarations.
    """
    if kind is None:
        kind = "both" if (has_source and has_semantic) else ("jev" if has_semantic else "regex")
    if kind not in VALID_KINDS:
        raise RefUsageError(f"--kind {kind!r} is not one of {', '.join(VALID_KINDS)}")
    if kind == "regex" and has_semantic:
        raise RefUsageError("--kind regex takes no --semantic; use --kind both for JavaScript plus Jev checks")
    if kind == "jev" and has_source:
        raise RefUsageError("--kind jev takes no JavaScript source; use --kind both for JavaScript plus Jev checks")
    if kind in ("jev", "both") and not has_semantic:
        raise RefUsageError(f"--kind {kind} needs --semantic <file.json> with its Jev declarations")
    return kind


def parse_semantic(text: str, *, what: str = "--semantic") -> List[Any]:
    """The Jev declarations in a `--semantic` file: a JSON array of declaration
    objects (a `{"semantic": [...]}` wrapper is accepted too).

    Deliberately a SHAPE check only — 1 to 24 objects, each with a name. What a
    declaration may say (modes, probes, caps, reserved names) is checked by the
    server, and authoritatively by each machine's own parser; a third copy of
    those rules here is a third thing to drift. The server's refusal names the
    declaration and the rule.
    """
    try:
        value = json.loads(text)
    except ValueError as exc:
        raise RefUsageError(f"{what} is not valid JSON: {exc}")
    if isinstance(value, dict) and isinstance(value.get("semantic"), list):
        value = value["semantic"]
    if not isinstance(value, list):
        raise RefUsageError(f"{what} must be a JSON array of Jev declarations")
    if not value:
        raise RefUsageError(f"{what} holds no Jev declarations")
    if len(value) > MAX_JEV_DECLARATIONS:
        raise RefUsageError(
            f"{what} holds {len(value)} Jev declarations; a policy version carries at most "
            f"{MAX_JEV_DECLARATIONS}"
        )
    for i, entry in enumerate(value):
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not entry["name"]:
            raise RefUsageError(f"{what} declaration #{i} is not an object with a name")
    return value


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
        return _checked(_read_stream(stream))
    if value:
        path = value[1:] if value.startswith("@") else value
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return _checked(fh.read())
        except FileNotFoundError:
            raise RefUsageError(f"no such file: {path}")
        except UnicodeDecodeError:
            # NOT an OSError, so the handler below never saw it and the
            # decode error escaped as a raw traceback. `_checked` cannot
            # catch this either: it inspects text, and there is no text yet.
            raise RefUsageError(_NOT_TEXT.format(what=path))
        except OSError as exc:
            raise RefUsageError(f"cannot read {path}: {exc}")
    if not tty:
        return _checked(_read_stream(stream))
    if prompt is not None:
        prompt()
    return _checked(_read_stream(stream))


#: Said the same way whether the bytes arrived by path or down a pipe.
_NOT_TEXT = (
    "{what} is not UTF-8 text — this looks like a binary file rather than a policy"
)


def _read_stream(stream) -> str:
    """Read stdin, turning undecodable bytes into a sentence.

    ``sys.stdin`` decodes as it reads, so piping a binary file raises
    ``UnicodeDecodeError`` here rather than returning bytes ``_checked`` could
    inspect — which is how `cat rule.png | fp policies publish x` printed a
    traceback instead of the NUL-byte message written for exactly that mistake.
    """
    try:
        return stream.read()
    except UnicodeDecodeError:
        raise RefUsageError(_NOT_TEXT.format(what="the input"))


def _checked(text: str) -> str:
    """Reject bytes the store cannot hold, with a message that says what happened.

    A NUL byte in policy source reaches Postgres and comes back as a bare
    "database error" — a raw internal failure shown to somebody who most likely
    pointed the command at a binary file by mistake. The server ought to refuse
    it; until it does, refusing here turns an unexplained 500 into a sentence.
    """
    if "\x00" in text:
        raise RefUsageError(
            "policy source contains a NUL byte — this looks like a binary file "
            "rather than a policy"
        )
    return text

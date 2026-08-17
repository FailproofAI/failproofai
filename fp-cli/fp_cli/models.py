"""Plain dataclasses mirroring the FailproofAI Cloud API shapes.

These are deliberately free of any I/O or framework dependency so the client
layer (and a future MCP server) can return them directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Optional, TypeVar

T = TypeVar("T")


@dataclass
class Page(Generic[T]):
    """A single page of cursor-paginated results."""

    items: List[T]
    next_cursor: Optional[int] = None


@dataclass
class OrgMembership:
    """One org the operator belongs to, with the grants resolved for that org.

    Mirrors the dashboard's ``OrgMembership`` (``dashboard/lib/types.ts``):
    permissions are now *per org*, replacing the old flat global list.
    """

    org_id: str
    org_slug: str
    org_name: str
    permissions: List[str] = field(default_factory=list)
    permission_set: Optional[str] = None
    #: Operator-managed per-org feature flags (e.g. ``demo``). Empty when the org
    #: has none, and also empty against a server predating the field — the two are
    #: indistinguishable here by design, because every consumer treats "no flags"
    #: and "flags unknown" the same way.
    feature_flags: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "OrgMembership":
        return cls(
            org_id=str(d.get("org_id", "")),
            org_slug=str(d.get("org_slug", "")),
            org_name=str(d.get("org_name", "")),
            permissions=list(d.get("permissions") or []),
            permission_set=d.get("permission_set"),
            # from_dict is an explicit allowlist: a field absent from it is
            # dropped silently, so `fp whoami --json` would omit the key
            # entirely rather than report an empty set.
            feature_flags=list(d.get("feature_flags") or []),
        )


@dataclass
class SessionUser:
    """The authenticated operator. Multi-tenant: permissions live per-membership.

    The server dropped the flat ``permissions`` field (``dashboard/lib/session.ts``);
    a user's effective grants depend on the *active org*. ``is_instance_admin`` may
    browse orgs without a membership but gets no data permissions there.
    """

    id: str
    email: str
    is_instance_admin: bool = False
    memberships: List[OrgMembership] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionUser":
        return cls(
            id=str(d.get("id", "")),
            email=str(d.get("email", "")),
            is_instance_admin=bool(d.get("is_instance_admin", False)),
            memberships=[OrgMembership.from_dict(m) for m in (d.get("memberships") or [])],
        )

    def membership(self, org_slug: Optional[str]) -> Optional["OrgMembership"]:
        if not org_slug:
            return None
        for m in self.memberships:
            if m.org_slug == org_slug:
                return m
        return None

    def permissions_for(self, org_slug: Optional[str]) -> List[str]:
        m = self.membership(org_slug)
        return list(m.permissions) if m else []

    @property
    def org_slugs(self) -> List[str]:
        return [m.org_slug for m in self.memberships if m.org_slug]


@dataclass
class AgentEvent:
    """One event row. Two server sources feed this model:

    * ``GET /api/events`` (full) — carries the fat ``payload`` column. Used only by the
      opt-in heavy path (``events --full`` / ``--fields payload``).
    * ``GET /api/events/summary`` (light) — payload-FREE. Carries the server-precomputed
      ``summary`` / ``is_error`` plus the promoted ``error_type`` / ``output_tokens``
      columns. The default ``events`` view and all of ``errors`` use this, so their
      responses never include the fat payload (a free-text search may still scan it
      server-side).

    Fields absent on one source default cleanly (``payload`` → ``{}`` on light rows;
    ``summary``/``is_error``/… → empty on full rows), so a single model serves both.
    """

    id: int
    session_id: str
    agent_id: str
    event_type: str
    ts: str
    payload: Dict[str, Any] = field(default_factory=dict)
    environment: str = ""
    # Light-feed columns (GET /events/summary) — server-precomputed, never derived from
    # payload client-side.
    summary: str = ""
    is_error: bool = False
    error_type: Optional[str] = None
    output_tokens: Optional[int] = None
    # Context-window checker: present on BOTH feeds (null for non-model events / unknown
    # models). Now surfaced in --json instead of being silently dropped.
    context_window: Optional[int] = None
    context_fill: Optional[float] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AgentEvent":
        try:
            event_id = int(d.get("id", 0))
        except (TypeError, ValueError):
            event_id = 0  # tolerate a null/non-numeric id rather than crashing the render
        return cls(
            id=event_id,
            session_id=str(d.get("session_id", "")),
            agent_id=str(d.get("agent_id", "")),
            event_type=str(d.get("event_type", "")),
            ts=str(d.get("ts", "")),
            payload=d.get("payload") or {},
            environment=str(d.get("environment", "")),
            summary=str(d.get("summary") or ""),
            is_error=bool(d.get("is_error", False)),
            error_type=d.get("error_type"),
            output_tokens=d.get("output_tokens"),
            context_window=d.get("context_window"),
            context_fill=d.get("context_fill"),
        )


@dataclass
class Evaluation:
    id: str  # evaluation_id is a UUID (Postgres), not an integer
    session_id: str
    agent_id: str
    environment: str
    status: str
    scores: Optional[Dict[str, float]] = None
    reasoning: Optional[Dict[str, str]] = None
    summary: Optional[str] = None
    error: Optional[str] = None
    attempt_count: int = 0
    duration_ms: Optional[int] = None
    completed_at: str = ""
    created_at: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Evaluation":
        return cls(
            id=str(d.get("id", "")),
            session_id=str(d.get("session_id", "")),
            agent_id=str(d.get("agent_id", "")),
            environment=str(d.get("environment", "")),
            status=str(d.get("status", "")),
            scores=d.get("scores"),
            reasoning=d.get("reasoning"),
            summary=d.get("summary"),
            error=d.get("error"),
            attempt_count=int(d.get("attempt_count", 0)),
            duration_ms=d.get("duration_ms"),
            completed_at=str(d.get("completed_at", "")),
            created_at=str(d.get("created_at", "")),
        )


@dataclass
class Session:
    """One agent run — a row from the dashboard ``/api/sessions`` endpoint (the same
    source the dashboard's sessions page uses), so the CLI's filters match it exactly.

    A session's terminal **evaluation** (if any) arrives nested under
    ``latest_evaluation``. For backward compatibility with the eval-shaped renderer and
    with ``--json`` / ``--fields`` consumers, ``status`` and ``scores`` are **flattened
    up** to the top level from that nested object (the full nested object is preserved as
    ``latest_evaluation`` for completeness). A session that was never evaluated has an
    empty ``status``/``scores`` and ``latest_evaluation = None``.
    """

    session_id: str
    agent_id: str
    environment: str
    # Flattened up from latest_evaluation (back-compat: top-level status/scores).
    status: str = ""
    scores: Optional[Dict[str, float]] = None
    # Full roster of every agent that ran in this session, server-sorted by
    # event_count desc — ``[{"agent_id": str, "event_count": int}, ...]``.
    # ``agent_id`` above is the root (first agent_start); ``agents`` is the whole
    # cast. ``None`` on older servers that predate the multi-agent roster.
    agents: Optional[List[Dict[str, Any]]] = None
    # Session-level fields.
    event_count: int = 0
    started_at: str = ""
    last_event_at: str = ""
    first_event_id: Optional[int] = None
    last_event_id: Optional[int] = None
    # The full terminal evaluation (or None if the session was never evaluated).
    latest_evaluation: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Session":
        le = d.get("latest_evaluation") or {}
        return cls(
            session_id=str(d.get("session_id", "")),
            agent_id=str(d.get("agent_id", "")),
            environment=str(d.get("environment", "")),
            status=str(le.get("status", "")),  # flattened up for the renderer + back-compat
            scores=le.get("scores"),           # flattened up
            agents=d.get("agents"),            # full agent roster (list of {agent_id, event_count})
            event_count=int(d.get("event_count", 0)),
            started_at=str(d.get("started_at", "")),
            last_event_at=str(d.get("last_event_at", "")),
            first_event_id=d.get("first_event_id"),
            last_event_id=d.get("last_event_id"),
            latest_evaluation=d.get("latest_evaluation"),
        )


@dataclass
class ApiKey:
    id: str
    name: str
    permissions: List[str] = field(default_factory=list)
    created_at: str = ""
    revoked_at: Optional[str] = None
    # The server sends this; `from_dict` is an allowlist, so omitting it here
    # silently dropped it and `fp keys list` showed an expired key as
    # active. None = never expires.
    expires_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ApiKey":
        return cls(
            id=str(d.get("id", "")),
            name=str(d.get("name", "")),
            permissions=list(d.get("permissions") or []),
            created_at=str(d.get("created_at", "")),
            revoked_at=d.get("revoked_at"),
            expires_at=d.get("expires_at"),
        )


@dataclass
class SavedQuery:
    id: str
    name: str
    description: str = ""
    sql_text: str = ""
    params: List[Dict[str, Any]] = field(default_factory=list)
    created_by: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SavedQuery":
        return cls(
            id=str(d.get("id", "")),
            name=str(d.get("name", "")),
            description=str(d.get("description", "")),
            sql_text=str(d.get("sql_text", "")),
            params=list(d.get("params") or []),
            created_by=d.get("created_by"),
            created_at=str(d.get("created_at", "")),
            updated_at=str(d.get("updated_at", "")),
        )


@dataclass
class QueryResult:
    columns: List[Dict[str, str]] = field(default_factory=list)
    rows: List[List[Any]] = field(default_factory=list)
    truncated: bool = False
    elapsed_ms: int = 0

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "QueryResult":
        return cls(
            columns=list(d.get("columns") or []),
            rows=list(d.get("rows") or []),
            truncated=bool(d.get("truncated", False)),
            elapsed_ms=int(d.get("elapsed_ms", 0)),
        )


@dataclass
class DashboardUser:
    id: str
    email: str
    permissions: List[str] = field(default_factory=list)
    permission_set: Optional[str] = None
    permission_added: List[str] = field(default_factory=list)
    permission_removed: List[str] = field(default_factory=list)
    disabled_at: Optional[str] = None
    is_protected: bool = False
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DashboardUser":
        return cls(
            id=str(d.get("id", "")),
            email=str(d.get("email", "")),
            permissions=list(d.get("permissions") or []),
            permission_set=d.get("permission_set"),
            permission_added=list(d.get("permission_added") or []),
            permission_removed=list(d.get("permission_removed") or []),
            disabled_at=d.get("disabled_at"),
            is_protected=bool(d.get("is_protected", False)),
            created_at=str(d.get("created_at", "")),
            updated_at=str(d.get("updated_at", "")),
        )


@dataclass
class SettingRow:
    key: str
    value: Any = None
    updated_at: str = ""
    updated_by: Optional[str] = None
    scope: Optional[str] = None
    schema: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SettingRow":
        return cls(
            key=str(d.get("key", "")),
            value=d.get("value"),
            updated_at=str(d.get("updated_at", "")),
            updated_by=d.get("updated_by"),
            scope=d.get("scope"),
            schema=d.get("schema"),
        )


@dataclass
class Alert:
    id: str
    name: str
    description: Optional[str] = None
    enabled: bool = True
    trigger_kind: str = ""
    trigger_spec: Dict[str, Any] = field(default_factory=dict)
    min_breaches: int = 1
    eval_window: int = 1
    eval_interval_secs: int = 0
    severity: str = ""
    channels: List[Dict[str, Any]] = field(default_factory=list)
    created_by: str = ""
    created_at: str = ""
    updated_at: str = ""
    last_attempted_at: Optional[str] = None
    open_incidents: int = 0

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Alert":
        return cls(
            id=str(d.get("id", "")),
            name=str(d.get("name", "")),
            description=d.get("description"),
            enabled=bool(d.get("enabled", True)),
            trigger_kind=str(d.get("trigger_kind", "")),
            trigger_spec=d.get("trigger_spec") or {},
            min_breaches=int(d.get("min_breaches", 1)),
            eval_window=int(d.get("eval_window", 1)),
            eval_interval_secs=int(d.get("eval_interval_secs", 0)),
            severity=str(d.get("severity", "")),
            channels=list(d.get("channels") or []),
            created_by=str(d.get("created_by", "")),
            created_at=str(d.get("created_at", "")),
            updated_at=str(d.get("updated_at", "")),
            last_attempted_at=d.get("last_attempted_at"),
            open_incidents=int(d.get("open_incidents", 0)),
        )


@dataclass
class Incident:
    id: str
    #: Short identifying line. Present on every issue since the issues redesign;
    #: `alert_name` is only set for the minority that have a parent alert, so
    #: this is the column that actually distinguishes rows.
    title: Optional[str] = None
    #: How the issue came to exist: 'manual' | 'alert' | 'audit'.
    source: Optional[str] = None
    #: For source='audit', the audit finding this issue was opened from.
    source_finding_id: Optional[str] = None
    alert_id: Optional[str] = None
    alert_name: Optional[str] = None
    alert_severity: str = ""
    trigger_kind: Optional[str] = None
    state: str = ""
    opened_at: str = ""
    last_breach_at: str = ""
    acknowledged_at: Optional[str] = None
    acknowledged_by: Optional[str] = None
    assignees: List[str] = field(default_factory=list)
    resolved_at: Optional[str] = None
    breach_value: Optional[float] = None
    breach_summary: Optional[str] = None
    evidence: Optional[Dict[str, Any]] = None
    notifications: Optional[List[Dict[str, Any]]] = None
    subscribers: Optional[List[Dict[str, Any]]] = None
    comments: Optional[List[Dict[str, Any]]] = None
    activity: Optional[List[Dict[str, Any]]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Incident":
        return cls(
            id=str(d.get("id", "")),
            title=d.get("title"),
            source=d.get("source"),
            source_finding_id=d.get("source_finding_id"),
            alert_id=d.get("alert_id"),
            alert_name=d.get("alert_name"),
            alert_severity=str(d.get("alert_severity", "")),
            trigger_kind=d.get("trigger_kind"),
            state=str(d.get("state", "")),
            opened_at=str(d.get("opened_at", "")),
            last_breach_at=str(d.get("last_breach_at", "")),
            acknowledged_at=d.get("acknowledged_at"),
            acknowledged_by=d.get("acknowledged_by"),
            assignees=list(d.get("assignees") or []),
            resolved_at=d.get("resolved_at"),
            breach_value=d.get("breach_value"),
            breach_summary=d.get("breach_summary"),
            evidence=d.get("evidence"),
            notifications=d.get("notifications"),
            subscribers=d.get("subscribers"),
            comments=d.get("comments"),
            activity=d.get("activity"),
        )


@dataclass
class IncidentComment:
    id: str
    incident_id: str = ""
    author_email: str = ""
    body: Optional[str] = None
    created_at: str = ""
    edited_at: Optional[str] = None
    deleted_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "IncidentComment":
        return cls(
            id=str(d.get("id", "")),
            incident_id=str(d.get("incident_id", "")),
            author_email=str(d.get("author_email", "")),
            body=d.get("body"),
            created_at=str(d.get("created_at", "")),
            edited_at=d.get("edited_at"),
            deleted_at=d.get("deleted_at"),
        )


@dataclass
class IncidentSubscriber:
    email: str
    source: str = ""
    subscribed_at: str = ""
    unsubscribed_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "IncidentSubscriber":
        return cls(
            email=str(d.get("email", "")),
            source=str(d.get("source", "")),
            subscribed_at=str(d.get("subscribed_at", "")),
            unsubscribed_at=d.get("unsubscribed_at"),
        )


def _as_int(value: Any, default: int = 0) -> int:
    """A JSON value → int, falling back to ``default`` on null/garbage.

    ``int(d.get(k, default))`` raises on an explicit ``null`` (``int(None)``) or a
    non-numeric string, which would crash a whole render over one bad row. The audit
    models use this so ``from_dict`` can never raise.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    """A JSON value → float, falling back to ``default`` on null/garbage (see :func:`_as_int`)."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass
class Audit:
    """One audit definition — a scheduled sweep over a window of agent activity that
    produces **findings**.

    The definition columns (schedule, window, scope, signals, LLM settings, channels) are
    what ``audits create``/``edit`` write; the trailing fields are server-derived read-only
    state the list/get endpoints join in (``open_findings``, the last run's status/time, and
    the queue row's attempt timestamps). Timestamps stay raw ISO strings — the renderers
    humanize them, ``--json`` passes them through untouched.
    """

    id: str
    name: str
    description: Optional[str] = None
    enabled: bool = True
    schedule_interval_secs: int = 86400
    # Fixed phase for the schedule: runs land on `anchor + N * interval`, so a slow
    # run or a manual trigger can't drift the cadence. Raw ISO string, like the
    # other timestamps. Server defaults it to the next 09:00 UTC when omitted;
    # None only for legacy rows written before the column existed.
    schedule_anchor: Optional[str] = None
    window_mode: str = "since_last"  # 'fixed' | 'since_last'
    lookback_window_secs: int = 604800
    scope: Dict[str, Any] = field(default_factory=dict)
    ignore_error_types: List[str] = field(default_factory=list)
    llm_enabled: bool = True
    top_k: int = 50
    sensitivity: str = "medium"  # 'low' | 'medium' | 'high'
    channels: List[Dict[str, Any]] = field(default_factory=list)
    created_by: str = ""
    created_at: str = ""
    updated_at: str = ""
    # Server-derived, read-only (never sent back on a write).
    open_findings: int = 0
    last_run_status: Optional[str] = None
    last_run_finished_at: Optional[str] = None
    last_attempted_at: Optional[str] = None
    next_attempt_at: Optional[str] = None
    last_error: Optional[str] = None
    # Operator brief appended to the analysis prompt. READ-ONLY on this model:
    # it is written through `fp audits context set`, never as part of a
    # definition body, so a flag-only `audits edit` (which read-merges from
    # _audit_to_body) can never wipe it.
    additional_context: str = ""
    reference_url_count: int = 0

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Audit":
        return cls(
            id=str(d.get("id", "")),
            name=str(d.get("name", "")),
            description=d.get("description"),
            enabled=bool(d.get("enabled", True)),
            schedule_interval_secs=_as_int(d.get("schedule_interval_secs"), 86400),
            schedule_anchor=d.get("schedule_anchor"),
            window_mode=str(d.get("window_mode", "") or "since_last"),
            lookback_window_secs=_as_int(d.get("lookback_window_secs"), 604800),
            scope=d.get("scope") or {},
            ignore_error_types=list(d.get("ignore_error_types") or []),
            llm_enabled=bool(d.get("llm_enabled", True)),
            top_k=_as_int(d.get("top_k"), 50),
            sensitivity=str(d.get("sensitivity", "") or "medium"),
            channels=list(d.get("channels") or []),
            created_by=str(d.get("created_by", "")),
            created_at=str(d.get("created_at", "")),
            updated_at=str(d.get("updated_at", "")),
            open_findings=_as_int(d.get("open_findings"), 0),
            last_run_status=d.get("last_run_status"),
            last_run_finished_at=d.get("last_run_finished_at"),
            last_attempted_at=d.get("last_attempted_at"),
            next_attempt_at=d.get("next_attempt_at"),
            last_error=d.get("last_error"),
            additional_context=str(d.get("additional_context", "") or ""),
            reference_url_count=_as_int(d.get("reference_url_count"), 0),
        )


@dataclass
class AuditRun:
    """One execution of an audit — the window it swept, how it ended, and what it produced.

    ``stats`` is an opaque per-run counter object and ``report`` the rendered summary text
    (both may be absent on a run that failed early), so neither is parsed here.
    """

    id: str
    audit_id: str = ""
    status: str = ""  # 'running' | 'succeeded' | 'failed'
    trigger_kind: str = ""
    window_from: str = ""
    window_to: str = ""
    started_at: str = ""
    finished_at: Optional[str] = None
    stats: Dict[str, Any] = field(default_factory=dict)
    findings_count: int = 0
    new_findings_count: int = 0
    report: Optional[str] = None
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AuditRun":
        return cls(
            id=str(d.get("id", "")),
            audit_id=str(d.get("audit_id", "")),
            status=str(d.get("status", "")),
            trigger_kind=str(d.get("trigger_kind", "")),
            window_from=str(d.get("window_from", "")),
            window_to=str(d.get("window_to", "")),
            started_at=str(d.get("started_at", "")),
            finished_at=d.get("finished_at"),
            stats=d.get("stats") or {},
            findings_count=_as_int(d.get("findings_count"), 0),
            new_findings_count=_as_int(d.get("new_findings_count"), 0),
            report=d.get("report"),
            error=d.get("error"),
        )


@dataclass
class AuditFinding:
    """One finding — a recurring pattern an audit surfaced, carried across runs by its
    ``fingerprint`` and triaged through ``status``.

    ``priority`` is the server's ranking score (findings arrive priority-desc);
    ``evidence``/``evidence_queries``/``scope`` are opaque blobs shown verbatim.
    """

    id: str
    audit_id: str = ""
    audit_name: str = ""
    fingerprint: str = ""
    title: str = ""
    category: Optional[str] = None
    failure_type: str = ""
    description: Optional[str] = None
    root_cause_hypothesis: Optional[str] = None
    severity: str = ""  # 'info' | 'warning' | 'critical'
    magnitude: Optional[str] = None  # 'small' | 'medium' | 'big'
    priority: float = 0.0
    status: str = ""  # 'open' | 'recurring' | 'resolved' | 'dismissed' | 'muted'
    occurrences: int = 0
    first_seen_at: str = ""
    last_seen_at: str = ""
    recommendation: Optional[str] = None
    expected_impact: Optional[str] = None
    effort: Optional[str] = None
    evidence: Dict[str, Any] = field(default_factory=dict)
    evidence_queries: List[Any] = field(default_factory=list)
    scope: Dict[str, Any] = field(default_factory=dict)
    kind: str = ""  # 'improvement' | 'policy' | 'failure'
    assigned_to: Optional[str] = None
    # The issue this finding graduated into, or None if it never linked.
    # Rising nulls on open/recurring findings is how you see issue_sync
    # degrading; `from_dict` is an allowlist, so omitting it here silently
    # drops the field rather than erroring.
    issue_id: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AuditFinding":
        return cls(
            id=str(d.get("id", "")),
            audit_id=str(d.get("audit_id", "")),
            audit_name=str(d.get("audit_name", "")),
            fingerprint=str(d.get("fingerprint", "")),
            title=str(d.get("title", "")),
            category=d.get("category"),
            failure_type=str(d.get("failure_type", "")),
            description=d.get("description"),
            root_cause_hypothesis=d.get("root_cause_hypothesis"),
            severity=str(d.get("severity", "")),
            magnitude=d.get("magnitude"),
            priority=_as_float(d.get("priority"), 0.0),
            status=str(d.get("status", "")),
            occurrences=_as_int(d.get("occurrences"), 0),
            first_seen_at=str(d.get("first_seen_at", "")),
            last_seen_at=str(d.get("last_seen_at", "")),
            recommendation=d.get("recommendation"),
            expected_impact=d.get("expected_impact"),
            effort=d.get("effort"),
            evidence=d.get("evidence") or {},
            evidence_queries=list(d.get("evidence_queries") or []),
            scope=d.get("scope") or {},
            kind=str(d.get("kind", "")),
            assigned_to=d.get("assigned_to"),
            issue_id=d.get("issue_id"),
        )

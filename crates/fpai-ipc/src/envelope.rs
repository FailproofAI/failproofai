//! Wire message types for the `failproofaid` local IPC protocol.
//!
//! Every type here is a transcription of `crates/PROTOCOL.md`. It carries no
//! daemon logic and no policy logic: the only behaviour beyond serde is
//! [`HostContext::validate`], which enforces the two envelope rules that exist
//! to close attack classes rather than to catch typos.
//!
//! ## Why request-side types set `deny_unknown_fields`
//!
//! Serde's default is to ignore unknown fields. On the request side that
//! default is a silent-failure machine: a client that invents `host.home_dir`,
//! or misspells `project_dir`, would be accepted and its field dropped, and the
//! resulting verdict would be computed from an envelope that is not the one the
//! client believes it sent. `deny_unknown_fields` converts that into a loud
//! parse failure, which the client turns into a legacy fallback.
//!
//! Response-side types deliberately do **not** set it. The daemon is the sole
//! producer of responses, and a client that refuses to parse a response
//! carrying a field added by a newer daemon would fall back to legacy for a
//! purely additive change.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::combine::Decision;

/// The protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;

/// Every protocol version this build accepts, for the `version_mismatch` reply.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[u32] = &[PROTOCOL_VERSION];

/// The only `env_facts` key in the closed set, as of protocol v1.
pub const ENV_FACT_CLAUDE_PROJECT_DIR: &str = "CLAUDE_PROJECT_DIR";

/// The closed `env_facts` key set.
///
/// Closed, and rejected rather than filtered, because the hook client's
/// environment originates in the agent's process — and is therefore under the
/// agent's control. A pass-through would make it an injection channel.
pub const KNOWN_ENV_FACTS: &[&str] = &[ENV_FACT_CLAUDE_PROJECT_DIR];

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/// The first frame the client sends: `{"hello": {…}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientHandshake {
    /// Version and identity announcement.
    Hello(Hello),
}

/// The first frame the daemon sends: `{"hello_ack": {…}}` or
/// `{"version_mismatch": {…}}`.
///
/// A client that receives anything other than `hello_ack` must fall back to the
/// legacy in-process evaluator. It must never guess, retry with a different
/// version, or fail the hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerHandshake {
    /// Handshake accepted.
    HelloAck(HelloAck),
    /// Handshake refused; the daemon closes the connection after this frame.
    VersionMismatch(VersionMismatch),
}

/// Client → daemon handshake body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct Hello {
    /// Protocol version the client speaks.
    pub protocol_version: u32,
    /// Client identity, e.g. `"failproofai-hook"`.
    pub client: String,
    /// Client package version.
    pub client_version: String,
}

/// Daemon → client handshake acceptance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HelloAck {
    /// Protocol version in force for this connection.
    pub protocol_version: u32,
    /// Daemon package version.
    pub daemon_version: String,
    /// Identity of the active policy generation, `gen-<hex>`.
    pub generation_id: String,
}

/// Daemon → client handshake refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct VersionMismatch {
    /// Every protocol version the daemon accepts.
    pub supported: Vec<u32>,
    /// The version the client offered.
    pub received: u32,
}

impl VersionMismatch {
    /// Build the refusal for a client that offered `received`.
    #[must_use]
    pub fn for_received(received: u32) -> Self {
        Self {
            supported: SUPPORTED_PROTOCOL_VERSIONS.to_vec(),
            received,
        }
    }
}

/// Whether this build can serve a client offering `version`.
#[must_use]
pub fn is_supported_protocol_version(version: u32) -> bool {
    SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
}

// ---------------------------------------------------------------------------
// Request / response envelopes
// ---------------------------------------------------------------------------

/// A request frame: `{"request_id": "<uuid-v4>", "op": {…}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct Request {
    /// Echoed verbatim in the response. Stage 1 has no pipelining, so a
    /// mismatch is a protocol error — but it is carried now because decision
    /// evidence must be correlatable once lanes are concurrent.
    pub request_id: String,
    /// The operation to perform.
    pub op: Op,
}

/// A response frame: `{"request_id": "<uuid-v4>", "result": {…}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Response {
    /// The `request_id` of the request being answered.
    pub request_id: String,
    /// The outcome.
    pub result: OpResult,
}

impl Response {
    /// Whether this response answers `request_id`.
    ///
    /// Stage 1 is strictly request/response over one connection, so a `false`
    /// here is a protocol error and the client falls back to legacy.
    #[must_use]
    pub fn is_reply_to(&self, request_id: &str) -> bool {
        self.request_id == request_id
    }

    /// Build an error response for `request_id`.
    #[must_use]
    pub fn error(
        request_id: impl Into<String>,
        code: ErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            result: OpResult::Error(ErrorBody {
                code,
                message: message.into(),
            }),
        }
    }
}

/// The operations of protocol v1.
///
/// `Status`, `Reload`, `Flush`, and the `Query` set are named in the daemon
/// architecture and land later; the envelope is shaped so adding them is a new
/// variant rather than a wire change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    /// Liveness probe that submits no event.
    Ping(Ping),
    /// Evaluate one hook event.
    EvaluateHook(Box<EvaluateHook>),
}

/// The result of an operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpResult {
    /// Answer to [`Op::Ping`].
    Pong(Pong),
    /// Answer to [`Op::EvaluateHook`].
    Evaluated(Box<Evaluated>),
    /// Any failure. Every error is a client fallback to legacy, never a failed
    /// hook.
    Error(ErrorBody),
}

/// `{"ping": {}}`.
///
/// Exists so a client can prove liveness without submitting an event, and so
/// the service manager's readiness check is independent of policy state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ping {}

/// `{"pong": {…}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Pong {
    /// Daemon package version.
    pub daemon_version: String,
    /// Milliseconds since the daemon started accepting connections.
    pub uptime_ms: u64,
}

/// `{"error": {"code": …, "message": …}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ErrorBody {
    /// Machine-readable cause.
    pub code: ErrorCode,
    /// Human-readable detail. For [`ErrorCode::Internal`] the daemon logs the
    /// detail and returns a generic message.
    pub message: String,
}

/// The closed set of protocol error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// `host.home` was non-null.
    ClientAssertedHome,
    /// `host.env_facts` carried a key outside the closed set.
    UnknownEnvFact,
    /// Daemon-side canonicalization disagreed with the client's.
    CanonicalizationMismatch,
    /// Declared body length above 1 MiB.
    FrameTooLarge,
    /// Short read, or a body that is not the expected JSON shape.
    MalformedFrame,
    /// Could not answer within `deadline_ms`.
    DeadlineExceeded,
    /// A known-shaped op this build does not implement.
    UnsupportedOp,
    /// Anything else.
    Internal,
}

impl ErrorCode {
    /// The on-wire spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClientAssertedHome => "client_asserted_home",
            Self::UnknownEnvFact => "unknown_env_fact",
            Self::CanonicalizationMismatch => "canonicalization_mismatch",
            Self::FrameTooLarge => "frame_too_large",
            Self::MalformedFrame => "malformed_frame",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::UnsupportedOp => "unsupported_op",
            Self::Internal => "internal",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// EvaluateHook
// ---------------------------------------------------------------------------

/// `{"evaluate_hook": {…}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct EvaluateHook {
    /// Harness id, e.g. `"claude"`. Kept as a string here: the closed set of
    /// harness ids and their canonicalization tables belong to `fpai-canon`,
    /// and this crate carries no policy knowledge.
    pub cli: String,
    /// Canonical event type, e.g. `"PreToolUse"`.
    pub event_type: String,
    /// The harness's own event name before canonicalization.
    pub raw_event_type: String,
    /// The hook payload, **already canonicalized by the client** for Stage 1.
    /// `fpai-canon` re-derives and asserts equality rather than trusting it; a
    /// mismatch is a [`ErrorCode::CanonicalizationMismatch`].
    pub payload: serde_json::Map<String, serde_json::Value>,
    /// Session metadata resolved by the client.
    pub session: SessionFields,
    /// Host context. See [`HostContext::validate`].
    pub host: HostContext,
    /// The **remaining** end-to-end budget, not a per-hop timeout. The daemon
    /// converts it to a monotonic instant on receipt.
    pub deadline_ms: u64,
    /// The policy names the client resolved for this event, from its merged
    /// project/local/user configuration.
    ///
    /// **The daemon must evaluate this set, not a set of its own.** An earlier
    /// revision had the daemon supply its own default list, which meant a user
    /// who had enabled 30 policies got the 11 builtin defaults and nothing
    /// else — 19 builtins plus every custom and convention policy silently
    /// stopped enforcing the moment the daemon answered. It also made the
    /// [`Evaluated::needs_user_context`] fallback unreachable: the worker
    /// computes it by partitioning the list it was given, so a
    /// daemon-supplied, all-sealed-by-construction list always partitioned to
    /// empty and the client never fell back.
    ///
    /// Sending the client's real set is what makes that fallback mean
    /// something. Anything in here the sealed tier cannot run comes back in
    /// `needs_user_context`, and the client falls back to legacy rather than
    /// enforcing a subset.
    ///
    /// Stage 3 moves the authoritative enabled set into a root-owned
    /// `machine.json` so it stops being client-asserted at all; until then this
    /// carries the same trust as the file the legacy path already reads.
    #[serde(default)]
    pub enabled_policies: Vec<String>,
    /// `true` means "evaluate sealed-only, do not run anything with side
    /// effects, the caller is discarding your answer".
    #[serde(default)]
    pub shadow: bool,
}

/// Session metadata, resolved client-side.
///
/// Resolution moved to the client deliberately: `resolveCodexMode` line-scans an
/// entire Codex transcript under `~/.codex/sessions`, which is both unreadable
/// by a service account and an unbounded read on the enforcement deadline path.
///
/// Every field is nullable because not every harness supplies every one; an
/// absent key deserializes the same as an explicit `null`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SessionFields {
    /// Harness session identifier.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Absolute path to the session transcript, or a virtual `<cli>-db://<id>`.
    #[serde(default)]
    pub transcript_path: Option<String>,
    /// Harness permission mode, e.g. `"default"`.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// The harness's own name for the event.
    #[serde(default)]
    pub hook_event_name: Option<String>,
}

/// Host context for one evaluation.
///
/// Three of these four fields are client-asserted and one must not be.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct HostContext {
    /// **Must be `null`.** See [`HostContext::validate`].
    #[serde(default)]
    pub home: Option<String>,
    /// Client-asserted working directory. Cannot be derived: `/proc/<pid>/cwd`
    /// is TOCTOU-prone and, on macOS, unreadable for a non-matching UID.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Client-asserted project directory. Client-asserted for the same reason.
    #[serde(default)]
    pub project_dir: Option<String>,
    /// Client-asserted environment facts, from a closed key set.
    #[serde(default)]
    pub env_facts: EnvFacts,
}

impl HostContext {
    /// Enforce the envelope's two non-negotiable rules.
    ///
    /// # `home` must be null, and a non-null `home` is rejected — not ignored, not overwritten
    ///
    /// The daemon derives `home` from `getpwuid_r(peer_uid)`, where `peer_uid`
    /// comes from the kernel. A client-supplied `home` is a protocol error.
    ///
    /// This is not pedantry, and the choice of *reject* over *overwrite* is the
    /// substance of it. `isAgentInternalPath` and `block-read-outside-cwd` both
    /// **widen** the allow set: a client asserting `home: "/"` would make every
    /// path on the machine "agent internal" and relax a verdict that the sealed
    /// tier exists to make unforgeable. Silently overwriting the field would
    /// make that attack a no-op, but it would leave the protocol *looking* like
    /// it accepts the field — so the next reader of the wire format, the next
    /// client implementation, and the next reviewer would all reasonably
    /// conclude that supplying `home` is supported and meaningful. Rejecting
    /// makes a client that tries it fail loudly and visibly, at the first
    /// request, in a way that shows up in the daemon's error counters rather
    /// than nowhere at all.
    ///
    /// # `env_facts` is a closed set
    ///
    /// Unknown keys are rejected rather than passed through, because the hook
    /// client's environment originates in the agent's process and is therefore
    /// under the agent's control. Dropping unknown keys silently would leave
    /// the same "looks supported" trap as overwriting `home`; rejecting them
    /// keeps the environment from becoming an injection channel.
    ///
    /// # Errors
    ///
    /// [`ProtocolError::ClientAssertedHome`] if `home` is `Some`, and
    /// [`ProtocolError::UnknownEnvFact`] naming the first offending key, in
    /// sorted order, if `env_facts` carries one outside [`KNOWN_ENV_FACTS`].
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if let Some(home) = &self.home {
            return Err(ProtocolError::ClientAssertedHome {
                asserted: home.clone(),
            });
        }
        self.env_facts.validate()
    }
}

/// The closed `env_facts` map.
///
/// Modelled as a map rather than a struct of known keys so that an unknown key
/// **survives parsing** and can be named in the [`ErrorCode::UnknownEnvFact`]
/// message. A struct with `deny_unknown_fields` would reject it too, but as an
/// undifferentiated deserialization failure — the client would see
/// `malformed_frame` and have no idea which key it got wrong.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EnvFacts(BTreeMap<String, Option<String>>);

impl EnvFacts {
    /// An empty set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The set carrying only `CLAUDE_PROJECT_DIR`.
    #[must_use]
    pub fn with_claude_project_dir(value: Option<String>) -> Self {
        let mut facts = Self::new();
        facts.insert(ENV_FACT_CLAUDE_PROJECT_DIR, value);
        facts
    }

    /// Insert a fact.
    ///
    /// Accepts any key on purpose: a typed setter could not express an unknown
    /// key, which would leave [`EnvFacts::validate`] untestable and would put
    /// the closed-set check in two places. [`EnvFacts::validate`] is the single
    /// gate.
    pub fn insert(&mut self, key: impl Into<String>, value: Option<String>) {
        self.0.insert(key.into(), value);
    }

    /// Look up a fact. The outer `Option` is "key absent", the inner is "key
    /// present and explicitly null".
    #[must_use]
    pub fn get(&self, key: &str) -> Option<Option<&str>> {
        self.0.get(key).map(|v| v.as_deref())
    }

    /// `CLAUDE_PROJECT_DIR`, if present and non-null.
    #[must_use]
    pub fn claude_project_dir(&self) -> Option<&str> {
        self.get(ENV_FACT_CLAUDE_PROJECT_DIR).flatten()
    }

    /// Every key present, in sorted order.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }

    /// Whether the set is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Number of keys present.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Reject any key outside [`KNOWN_ENV_FACTS`].
    ///
    /// # Errors
    ///
    /// [`ProtocolError::UnknownEnvFact`] naming the first offending key in
    /// sorted order, so the error is deterministic for a given input.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        for key in self.keys() {
            if !KNOWN_ENV_FACTS.contains(&key) {
                return Err(ProtocolError::UnknownEnvFact {
                    key: key.to_owned(),
                });
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Evaluated
// ---------------------------------------------------------------------------

/// `{"evaluated": {…}}`.
///
/// `exit_code`, `stdout`, `stderr`, `decision`, `policy_name`, `policy_names`,
/// and `reason` are byte-for-byte the fields `EvaluationResult` already has in
/// `src/hooks/policy-evaluator.ts`, and the client writes them out unchanged.
/// That is what makes byte-exact parity against the TypeScript oracle a
/// meaningful assertion rather than a shape check — so do not "improve" their
/// names or nullability here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Evaluated {
    /// Stable identifier for this decision, `dec-<hex>`.
    pub decision_id: String,
    /// The generation the decision was computed against, `gen-<hex>`.
    pub generation_id: String,
    /// Process exit code the client must exit with.
    pub exit_code: i32,
    /// Bytes the client must write to stdout, verbatim.
    pub stdout: String,
    /// Bytes the client must write to stderr, verbatim.
    pub stderr: String,
    /// The combined decision.
    pub decision: Decision,
    /// The deciding policy, if exactly one decided.
    pub policy_name: Option<String>,
    /// The deciding policies, when more than one contributed.
    pub policy_names: Option<Vec<String>>,
    /// Human-readable reason.
    pub reason: Option<String>,
    /// How much this verdict can be trusted. See [`Attestation`].
    pub attestation: Attestation,
    /// Every policy that matched the event.
    pub matched_policies: Vec<String>,
    /// Policies that matched but could not be evaluated because no per-user
    /// agent was attached.
    ///
    /// **Stage 1 always returns this empty.** A client seeing a non-empty list
    /// must fall back to legacy, because otherwise upgrading would silently
    /// drop enforcement for a user's mutable policies — precisely the failure
    /// this product exists to prevent.
    pub needs_user_context: Vec<String>,
}

/// How much of a verdict is unforgeable.
///
/// The variants are **ordered**, from most attested to least:
///
/// ```text
/// sealed  <  sealed_unattested  <  user_context
/// ```
///
/// so that **least attested wins when combining**: the combination of two
/// attestations is their [`Ord::max`], and therefore a combined result can
/// never be reported as more attested than its weakest input. Getting this
/// backwards would let a `user_context` contribution be laundered into a
/// `sealed` claim, which is exactly the property the two-tier split exists to
/// provide.
///
/// [`Ord`] is written by hand rather than derived so that reordering the
/// variants — a cosmetic-looking edit — cannot silently invert the lattice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attestation {
    /// Every deciding policy ran in the sealed tier and read no client-asserted
    /// host field.
    Sealed,
    /// Ran sealed, but a deciding policy read `cwd`, `project_dir`, or an env
    /// fact — all of which are client-asserted and unverifiable.
    SealedUnattested,
    /// A `user-context` policy contributed to the decision. Forgeable by the
    /// user who owns the agent, and therefore carries no integrity claim.
    UserContext,
}

impl Attestation {
    /// Rank in the attestation lattice; lower is more attested.
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Self::Sealed => 0,
            Self::SealedUnattested => 1,
            Self::UserContext => 2,
        }
    }

    /// The on-wire spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sealed => "sealed",
            Self::SealedUnattested => "sealed_unattested",
            Self::UserContext => "user_context",
        }
    }

    /// Combine two attestations: the weaker of the two wins.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        self.max(other)
    }

    /// Combine any number of attestations. An empty input is [`Attestation::Sealed`],
    /// the identity of this operation.
    pub fn combine_all<I: IntoIterator<Item = Self>>(items: I) -> Self {
        items.into_iter().fold(Self::Sealed, Self::combine)
    }
}

impl Ord for Attestation {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.rank().cmp(&other.rank())
    }
}

impl PartialOrd for Attestation {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl std::fmt::Display for Attestation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Protocol errors
// ---------------------------------------------------------------------------

/// A violation of the envelope contract, distinct from a framing failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// `host.home` was non-null.
    #[error(
        "host.home must be null; the daemon derives it from getpwuid_r(peer_uid) (client asserted {asserted:?})"
    )]
    ClientAssertedHome {
        /// What the client tried to assert, for the daemon's log. Never used to
        /// compute anything.
        asserted: String,
    },

    /// `host.env_facts` carried a key outside [`KNOWN_ENV_FACTS`].
    #[error("host.env_facts key {key:?} is outside the closed set")]
    UnknownEnvFact {
        /// The offending key.
        key: String,
    },
}

impl ProtocolError {
    /// The wire error code for this violation.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::ClientAssertedHome { .. } => ErrorCode::ClientAssertedHome,
            Self::UnknownEnvFact { .. } => ErrorCode::UnknownEnvFact,
        }
    }

    /// Render as the `{"error": {…}}` body.
    #[must_use]
    pub fn to_body(&self) -> ErrorBody {
        ErrorBody {
            code: self.code(),
            message: self.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_host() -> HostContext {
        HostContext {
            home: None,
            cwd: Some("/home/u/project".into()),
            project_dir: None,
            env_facts: EnvFacts::with_claude_project_dir(None),
        }
    }

    #[test]
    fn a_null_home_validates() {
        sample_host().validate().unwrap();
    }

    #[test]
    fn a_present_home_is_rejected_and_not_overwritten() {
        let host = HostContext {
            home: Some("/".into()),
            ..sample_host()
        };
        let err = host.validate().unwrap_err();
        assert_eq!(err.code(), ErrorCode::ClientAssertedHome);
        assert!(
            matches!(err, ProtocolError::ClientAssertedHome { ref asserted } if asserted == "/")
        );
        // The rejected value is still on the struct: validate() reports, it
        // never mutates. A caller cannot mistake "we fixed it" for "it passed".
        assert_eq!(host.home.as_deref(), Some("/"));
    }

    #[test]
    fn an_empty_string_home_is_still_an_assertion() {
        let host = HostContext {
            home: Some(String::new()),
            ..sample_host()
        };
        assert_eq!(
            host.validate().unwrap_err().code(),
            ErrorCode::ClientAssertedHome
        );
    }

    #[test]
    fn an_unknown_env_fact_is_rejected_and_named() {
        let mut host = sample_host();
        host.env_facts
            .insert("LD_PRELOAD", Some("/tmp/evil.so".into()));
        let err = host.validate().unwrap_err();
        assert_eq!(err.code(), ErrorCode::UnknownEnvFact);
        assert!(matches!(err, ProtocolError::UnknownEnvFact { ref key } if key == "LD_PRELOAD"));
        assert!(err.to_string().contains("LD_PRELOAD"));
    }

    #[test]
    fn an_unknown_env_fact_survives_parsing_so_it_can_be_named() {
        let host: HostContext = serde_json::from_value(json!({
            "home": null,
            "cwd": "/home/u/project",
            "project_dir": null,
            "env_facts": { "CLAUDE_PROJECT_DIR": null, "NODE_OPTIONS": "--require /tmp/x.js" }
        }))
        .expect("env_facts is a map, so an unknown key must parse rather than fail here");
        assert_eq!(host.env_facts.len(), 2);
        assert!(matches!(
            host.validate().unwrap_err(),
            ProtocolError::UnknownEnvFact { ref key } if key == "NODE_OPTIONS"
        ));
    }

    #[test]
    fn home_is_checked_before_env_facts() {
        let mut host = HostContext {
            home: Some("/".into()),
            ..sample_host()
        };
        host.env_facts.insert("NOPE", None);
        assert_eq!(
            host.validate().unwrap_err().code(),
            ErrorCode::ClientAssertedHome
        );
    }

    #[test]
    fn an_unknown_top_level_field_is_rejected() {
        let err = serde_json::from_value::<HostContext>(json!({
            "home": null, "cwd": null, "project_dir": null,
            "env_facts": {}, "home_dir": "/root"
        }))
        .unwrap_err();
        assert!(err.to_string().contains("home_dir"), "{err}");

        let err = serde_json::from_value::<Hello>(json!({
            "protocol_version": 1, "client": "x", "client_version": "1", "extra": true
        }))
        .unwrap_err();
        assert!(err.to_string().contains("extra"), "{err}");

        let err = serde_json::from_value::<SessionFields>(json!({ "sessionId": "s" })).unwrap_err();
        assert!(err.to_string().contains("sessionId"), "{err}");

        let err = serde_json::from_value::<Ping>(json!({ "force": true })).unwrap_err();
        assert!(err.to_string().contains("force"), "{err}");
    }

    #[test]
    fn absent_nullable_fields_deserialize_as_null() {
        let host: HostContext = serde_json::from_value(json!({})).unwrap();
        assert_eq!(host, HostContext::default());
        // …and re-serialize with every key explicitly present, as the protocol
        // examples show them.
        assert_eq!(
            serde_json::to_value(&host).unwrap(),
            json!({ "home": null, "cwd": null, "project_dir": null, "env_facts": {} })
        );
    }

    #[test]
    fn attestation_orders_from_most_to_least_attested() {
        assert!(Attestation::Sealed < Attestation::SealedUnattested);
        assert!(Attestation::SealedUnattested < Attestation::UserContext);
        assert_eq!(
            Attestation::Sealed.combine(Attestation::UserContext),
            Attestation::UserContext
        );
        assert_eq!(
            Attestation::combine_all([Attestation::Sealed, Attestation::SealedUnattested]),
            Attestation::SealedUnattested
        );
        assert_eq!(Attestation::combine_all([]), Attestation::Sealed);
    }

    #[test]
    fn error_codes_have_the_documented_spellings() {
        for (code, spelling) in [
            (ErrorCode::ClientAssertedHome, "client_asserted_home"),
            (ErrorCode::UnknownEnvFact, "unknown_env_fact"),
            (
                ErrorCode::CanonicalizationMismatch,
                "canonicalization_mismatch",
            ),
            (ErrorCode::FrameTooLarge, "frame_too_large"),
            (ErrorCode::MalformedFrame, "malformed_frame"),
            (ErrorCode::DeadlineExceeded, "deadline_exceeded"),
            (ErrorCode::UnsupportedOp, "unsupported_op"),
            (ErrorCode::Internal, "internal"),
        ] {
            assert_eq!(code.as_str(), spelling);
            assert_eq!(serde_json::to_value(code).unwrap(), json!(spelling));
        }
    }

    #[test]
    fn attestation_wire_spellings_match_the_protocol_table() {
        for (value, spelling) in [
            (Attestation::Sealed, "sealed"),
            (Attestation::SealedUnattested, "sealed_unattested"),
            (Attestation::UserContext, "user_context"),
        ] {
            assert_eq!(value.as_str(), spelling);
            assert_eq!(serde_json::to_value(value).unwrap(), json!(spelling));
        }
    }

    #[test]
    fn version_mismatch_is_built_from_the_supported_set() {
        let mismatch = VersionMismatch::for_received(2);
        assert_eq!(mismatch.supported, vec![1]);
        assert_eq!(mismatch.received, 2);
        assert!(is_supported_protocol_version(PROTOCOL_VERSION));
        assert!(!is_supported_protocol_version(2));
    }

    #[test]
    fn responses_are_correlated_by_request_id() {
        let response = Response::error("req-1", ErrorCode::Internal, "boom");
        assert!(response.is_reply_to("req-1"));
        assert!(!response.is_reply_to("req-2"));
    }

    #[test]
    fn ping_serializes_as_an_empty_object() {
        assert_eq!(
            serde_json::to_value(Op::Ping(Ping {})).unwrap(),
            json!({ "ping": {} })
        );
    }
}

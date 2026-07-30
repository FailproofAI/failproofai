/**
 * gen-parity-corpus.mjs — emit the Stage-0 parity corpus and the (cli, event)
 * coverage map that the Rust reimplementation is diffed against.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  REGENERATE WITH:   bun scripts/gen-parity-corpus.mjs                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Outputs:
 *
 *   __tests__/parity/fixtures/<cli>/<event>/<case>.json   the corpus
 *   __tests__/parity/fixtures/manifest.json               count + corpus digest
 *   __tests__/parity/coverage.json                        the (cli, event) map
 *
 * WHY THIS EXISTS. `policy-evaluator.ts` encodes roughly a dozen mutually
 * incompatible native response contracts — Cursor's flat
 * `{permission, user_message, agent_message}` with `followup_message` on Stop
 * only and a `{continue:false}` special case on `UserPromptSubmit`; Copilot,
 * where exit 2 is never a deny channel; Factory, which ignores JSON on tool
 * events and requires exit 2 *except* on Stop; Antigravity's
 * `{decision:"continue"}` on Stop; Goose, which honours deny on `PreToolUse`
 * only. **Byte-exactness is the only assertion that catches a reimplementation
 * that is "semantically equivalent" and silently allows.** So every fixture
 * records the exact `exitCode` / `stdout` / `stderr` the TypeScript reference
 * produced, and the future Rust daemon is diffed against those bytes.
 *
 * WHAT IS UNDER TEST. The **response encoding matrix**, not the policies. The
 * corpus is driven by synthetic policies that return a fixed decision (the
 * technique in `__tests__/hooks/inert-deny-shapes.test.ts`), so the oracle is
 * independent of what any builtin happens to do today. Canonicalization — the
 * per-CLI event/tool/payload rewrites that run *before* the evaluator — is a
 * different artifact with a different gate (`crates/generated/*.json` +
 * `__tests__/parity/canon-tables-drift.test.ts`), so the payloads below are
 * already canonical.
 *
 * DETERMINISM IS A HARD REQUIREMENT (see "Corpus determinism" in
 * `desgin-docs/v1.0.0/phase-1-local-enforcement/implementation/03-risks-and-amendments.md`).
 * A corpus that bakes in a developer's home directory is worthless the moment
 * anyone else regenerates it. Three defences, all enforced here rather than
 * assumed:
 *
 *   1. Every input is a fixed synthetic constant ({@link SYNTHETIC}). No
 *      `homedir()`, no `cwd()`, no timestamps, no random ids.
 *   2. {@link assertNoMachineSpecificValues} greps every emitted byte for this
 *      machine's home directory, cwd, repo root and username, and fails the run
 *      if any of them leaked.
 *   3. {@link assertRegistryIsSynthetic} proves that no subprocess-spawning or
 *      filesystem-writing policy was reachable: the registry is cleared, only
 *      closures created in this file are registered, `getPoliciesForEvent`
 *      returns exactly those closures, and the number of invocations is checked
 *      against the number expected. A policy that is not in the registry cannot
 *      run, so this is a proof rather than a spot check.
 *
 * NOTHING IS HARDCODED. The CLI list is `INTEGRATION_TYPES`, the event list is
 * `HOOK_EVENT_TYPES`, and the installed-event list per CLI is
 * `getIntegration(cli).eventTypes` — the same array `writeHookEntries` iterates
 * when it writes a settings file. A thirteenth CLI or a new event changes the
 * corpus the moment its constants land, and the committed files then fail the
 * drift gate loudly instead of silently under-testing.
 *
 * Usage:
 *   bun scripts/gen-parity-corpus.mjs                # write __tests__/parity/
 *   bun scripts/gen-parity-corpus.mjs --out <dir>    # write elsewhere (tests)
 *   bun scripts/gen-parity-corpus.mjs --check        # verify only, write nothing
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePolicies } from "../src/hooks/policy-evaluator";
import {
  clearPolicies,
  getAllPolicies,
  getPoliciesForEvent,
  normalizePolicyName,
  registerPolicy,
} from "../src/hooks/policy-registry";
import { allow, deny, instruct } from "../src/hooks/policy-helpers";
import { BUILTIN_POLICIES } from "../src/hooks/builtin-policies";
import { HOST_ACCESS_POLICIES } from "../src/hooks/builtin/host-access";
import * as types from "../src/hooks/types";
import { HOOK_EVENT_TYPES, INTEGRATION_TYPES } from "../src/hooks/types";
import { ENFORCEMENT_CAPABILITY } from "../src/hooks/enforcement-capability";
import { getIntegration } from "../src/hooks/integrations";

// ── Schema version ───────────────────────────────────────────────────────────
//
// Bump when the SHAPE of a fixture, the manifest or the coverage map changes (a
// renamed key, a changed label vocabulary). Do NOT bump for content changes — a
// new CLI, a new event, a reworded deny template — those are data.
export const SCHEMA_VERSION = 1;

export const REGENERATE_COMMAND = "bun scripts/gen-parity-corpus.mjs";

export const FIXTURES_DIRNAME = "fixtures";
export const MANIFEST_FILENAME = "manifest.json";
export const COVERAGE_FILENAME = "coverage.json";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT_DIR = join(REPO_ROOT, "__tests__", "parity");

const ENFORCEMENT_CAPABILITY_JSON = join(
  REPO_ROOT,
  "crates",
  "generated",
  "enforcement-capability.json",
);

// ── The corpus dimensions ────────────────────────────────────────────────────

/** What every synthetic policy in a case returns. */
export const DECISION_KINDS = ["deny", "instruct", "allow-with-reason", "allow-silent"];

/** Whether the payload carries `tool_name` / `tool_input`. Drives the deny noun
 *  (`Blocked Bash …` vs `Blocked stop …`) and the tool-name policy matcher. */
export const TOOL_PRESENCE = ["tool-present", "tool-absent"];

/** One policy exercises the singular paths; two exercise the accumulating ones —
 *  the joined `instruct` reason, the `policies: a, b` plural attribution, the
 *  multi-line allow-note stderr, and deny's short-circuit past a second policy. */
export const POLICY_COUNTS = [1, 2];

const POLICY_COUNT_SLUG = { 1: "one-policy", 2: "two-policies" };

/** Total over the full cross product. Derived, never written down. */
export const EXPECTED_FIXTURE_COUNT =
  INTEGRATION_TYPES.length *
  HOOK_EVENT_TYPES.length *
  DECISION_KINDS.length *
  TOOL_PRESENCE.length *
  POLICY_COUNTS.length;

// ── Synthetic inputs ─────────────────────────────────────────────────────────

/**
 * Every value that enters a fixture. All fixed, none read from the host — this
 * is what makes two runs on two machines byte-identical.
 */
export const SYNTHETIC = {
  home: "/home/u",
  cwd: "/home/u/project",
  projectDir: "/home/u/project",
  sessionId: "sess-fixture-1",
  transcriptPath: "/home/u/project/.fixture/transcript.jsonl",
  permissionMode: "default",
  toolName: "Bash",
  toolInput: { command: "git status --short" },
  policyDescription: "parity corpus synthetic policy",
  policyNamePrefix: "parity/policy-",
};

/**
 * Deliberately hostile to a sloppy JSON encoder. Every character class below is
 * a place where two "correct" serializers legitimately disagree, and each one
 * would sail through a semantic comparison while changing the bytes a vendor
 * CLI parses:
 *
 *   QUOTE, BACKSLASH  must be escaped; the only two that always are.
 *   SOLIDUS           must NOT be escaped. Escaping it is legal JSON and a
 *                     different byte string, which is exactly the trap.
 *   LT, GT, AMPERSAND must NOT be escaped. HTML-safe encoders emit the \u00XX
 *                     form; a vendor CLI then shows literal escape sequences.
 *   LF, TAB           must use the two-character short escapes, never the
 *                     six-character \u000a / \u0009 forms, never a raw byte.
 *   U+00E9            raw UTF-8, not an \u escape.
 *   U+1D11E           a surrogate pair, emitted as raw UTF-8 rather than two
 *                     \u escapes. The single most common Rust/JS divergence.
 *
 * No leading or trailing whitespace: `appendHint` trims the deny/instruct reason
 * but the allow path does not, and a trailing tab would make the two paths
 * disagree for a reason that has nothing to do with the response matrix.
 */
const REASON_STRESS = '"q" \\ /s/ <t>&a\né𝄞\tend';

function fixtureReason(index) {
  return `parity reason ${index}: ${REASON_STRESS}`;
}

// ── Failure plumbing ─────────────────────────────────────────────────────────

class CorpusGenerationError extends Error {}

function fail(message) {
  throw new CorpusGenerationError(message);
}

// ── Determinism guards ───────────────────────────────────────────────────────

/**
 * Needles that must never appear in an emitted byte. Short values are dropped:
 * a two-character username would match half the corpus by coincidence, and a
 * false tripwire teaches people to disable the real one.
 */
function machineSpecificNeedles() {
  const raw = [
    ["os.homedir()", safeHomedir()],
    ["process.cwd()", process.cwd()],
    ["the repo root", REPO_ROOT],
    ["os.userInfo().username", safeUsername()],
  ];
  return raw.filter(([, value]) => typeof value === "string" && value.length >= 4);
}

function safeHomedir() {
  try {
    return homedir();
  } catch {
    return "";
  }
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * Fail loudly if this machine leaked into the corpus.
 *
 * A needle that is a substring of one of the synthetic constants is ALSO a
 * failure rather than a skip: the check cannot distinguish "the fixture is
 * clean" from "the fixture is dirty and happens to look clean", so the only
 * honest outcome is to stop and make the maintainer move the constant.
 */
function assertNoMachineSpecificValues(files) {
  const needles = machineSpecificNeedles();
  const syntheticText = JSON.stringify(SYNTHETIC);
  for (const [label, needle] of needles) {
    if (syntheticText.includes(needle)) {
      fail(
        `this machine's ${label} (${JSON.stringify(needle)}) is a substring of a value in ` +
          `SYNTHETIC, so the determinism check cannot tell a clean fixture from a dirty one. ` +
          `Change the colliding constant in scripts/gen-parity-corpus.mjs.`,
      );
    }
  }
  for (const file of files) {
    for (const [label, needle] of needles) {
      if (file.contents.includes(needle)) {
        fail(
          `${file.relPath} contains this machine's ${label} (${JSON.stringify(needle)}). ` +
            `The corpus must be byte-identical on every machine — every input has to come ` +
            `from SYNTHETIC, never from the host.`,
        );
      }
    }
  }
}

// ── Policy-registry purity ───────────────────────────────────────────────────

const BUILTIN_POLICY_NAMES = new Set(BUILTIN_POLICIES.map((p) => normalizePolicyName(p.name)));
const HOST_ACCESS_POLICY_NAMES = new Set(
  HOST_ACCESS_POLICIES.map((p) => normalizePolicyName(p.name)),
);

/**
 * Prove that only this file's closures can run.
 *
 * The plan calls this out under "Corpus determinism": the generator must assert
 * that no subprocess-spawning or filesystem-writing policy was reached. Seven
 * builtins shell out to `git` / `gh` (`src/hooks/builtin/host-access.ts`) and
 * the custom-hook loader writes temp files — any of them running would make the
 * corpus depend on the repository's branch, remote and CI state. By
 * construction none is registered; this asserts it rather than assuming it.
 */
function assertRegistryIsSynthetic(specs, ownFns, eventType, toolName) {
  const expectedNames = specs.map((s) => normalizePolicyName(s.name));

  const registered = getAllPolicies();
  if (registered.length !== specs.length) {
    fail(
      `policy registry holds ${registered.length} policies, expected exactly the ` +
        `${specs.length} synthetic one(s): ${registered.map((p) => p.name).join(", ")}`,
    );
  }
  for (const policy of registered) {
    if (!ownFns.has(policy.fn)) {
      fail(
        `policy "${policy.name}" is registered with a function this generator did not create. ` +
          `The corpus would no longer be independent of builtin logic.`,
      );
    }
    if (BUILTIN_POLICY_NAMES.has(policy.name)) {
      fail(`builtin policy "${policy.name}" leaked into the corpus registry.`);
    }
    if (HOST_ACCESS_POLICY_NAMES.has(policy.name)) {
      fail(
        `host-access policy "${policy.name}" leaked into the corpus registry — it shells out to ` +
          `git/gh and would make the corpus depend on this checkout.`,
      );
    }
  }
  if (registered.map((p) => p.name).join("\n") !== expectedNames.join("\n")) {
    fail(
      `policy registry names ${JSON.stringify(registered.map((p) => p.name))} do not match the ` +
        `synthetic specs ${JSON.stringify(expectedNames)}.`,
    );
  }

  // The evaluator selects through getPoliciesForEvent, so assert on what IT
  // returns, not merely on what the registry holds.
  const selected = getPoliciesForEvent(eventType, toolName);
  if (selected.map((p) => p.name).join("\n") !== expectedNames.join("\n")) {
    fail(
      `getPoliciesForEvent(${eventType}, ${String(toolName)}) selected ` +
        `${JSON.stringify(selected.map((p) => p.name))}, expected ${JSON.stringify(expectedNames)}.`,
    );
  }
}

// ── Case construction ────────────────────────────────────────────────────────

function policySpecs(decisionKind, policyCount) {
  const specs = [];
  for (let i = 1; i <= policyCount; i += 1) {
    const name = `${SYNTHETIC.policyNamePrefix}${i}`;
    if (decisionKind === "allow-silent") {
      specs.push({ name, decision: "allow", reason: null });
    } else if (decisionKind === "allow-with-reason") {
      specs.push({ name, decision: "allow", reason: fixtureReason(i) });
    } else {
      specs.push({ name, decision: decisionKind, reason: fixtureReason(i) });
    }
  }
  return specs;
}

function policyResultFor(spec) {
  if (spec.decision === "deny") return deny(spec.reason);
  if (spec.decision === "instruct") return instruct(spec.reason);
  return spec.reason === null ? allow() : allow(spec.reason);
}

function buildPayload(eventType, toolPresence) {
  const payload = {
    cwd: SYNTHETIC.cwd,
    hook_event_name: eventType,
    session_id: SYNTHETIC.sessionId,
    transcript_path: SYNTHETIC.transcriptPath,
  };
  if (toolPresence === "tool-present") {
    payload.tool_name = SYNTHETIC.toolName;
    payload.tool_input = { ...SYNTHETIC.toolInput };
  }
  return payload;
}

function buildSession(cli, eventType) {
  return {
    cli,
    cwd: SYNTHETIC.cwd,
    home: SYNTHETIC.home,
    hookEventName: eventType,
    permissionMode: SYNTHETIC.permissionMode,
    projectDir: SYNTHETIC.projectDir,
    sessionId: SYNTHETIC.sessionId,
    transcriptPath: SYNTHETIC.transcriptPath,
  };
}

export function caseId(decisionKind, toolPresence, policyCount) {
  return `${decisionKind}__${toolPresence}__${POLICY_COUNT_SLUG[policyCount]}`;
}

export function fixtureRelPath(cli, eventType, decisionKind, toolPresence, policyCount) {
  return `${FIXTURES_DIRNAME}/${cli}/${eventType}/${caseId(decisionKind, toolPresence, policyCount)}.json`;
}

// ── JSON rendering ───────────────────────────────────────────────────────────

/** Recursively sort object keys. Arrays keep the order they were built with. */
function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === "object") {
    const src = value;
    const out = {};
    for (const key of Object.keys(src).sort()) out[key] = deepSortKeys(src[key]);
    return out;
  }
  return value;
}

/** Stable 2-space JSON with a trailing newline. Byte-identical across runs. */
export function renderJson(value) {
  return `${JSON.stringify(deepSortKeys(value), null, 2)}\n`;
}

// ── Fixture generation ───────────────────────────────────────────────────────

let invocationCount = 0;

async function runCase(cli, eventType, decisionKind, toolPresence, policyCount) {
  const specs = policySpecs(decisionKind, policyCount);

  clearPolicies();
  const ownFns = new Set();
  for (const spec of specs) {
    const fn = async () => {
      invocationCount += 1;
      return policyResultFor(spec);
    };
    ownFns.add(fn);
    registerPolicy(spec.name, SYNTHETIC.policyDescription, fn, {}, 0);
  }

  const payload = buildPayload(eventType, toolPresence);
  const session = buildSession(cli, eventType);
  assertRegistryIsSynthetic(specs, ownFns, eventType, payload.tool_name);

  const before = invocationCount;
  const result = await evaluatePolicies(eventType, payload, session);
  const ran = invocationCount - before;

  // deny short-circuits at the first matching policy; every other decision
  // accumulates, so all of them run. Any other count means something we did not
  // register executed.
  const expectedRan = decisionKind === "deny" ? 1 : specs.length;
  if (ran !== expectedRan) {
    fail(
      `${cli}/${eventType}/${caseId(decisionKind, toolPresence, policyCount)}: ` +
        `${ran} policy invocation(s), expected ${expectedRan}.`,
    );
  }
  clearPolicies();

  return {
    case: caseId(decisionKind, toolPresence, policyCount),
    cli,
    decision_kind: decisionKind,
    event: eventType,
    input: {
      event_type: eventType,
      payload,
      policies: specs,
      session,
    },
    output: {
      decision: result.decision,
      exitCode: result.exitCode,
      policyName: result.policyName,
      // `undefined` on the reference becomes an explicit null, so the key is
      // always present: a Rust encoder that omits it is then a visible diff
      // rather than a silently-tolerated absence.
      policyNames: result.policyNames ?? null,
      reason: result.reason,
      stderr: result.stderr,
      stdout: result.stdout,
    },
    policy_count: policyCount,
    tool: toolPresence,
  };
}

/**
 * Build every fixture. Returns `{ relPath, contents }` sorted by `relPath`, so
 * the digest and the write order do not depend on iteration order.
 */
export async function generateFixtures() {
  const files = [];
  const seen = new Set();

  for (const cli of INTEGRATION_TYPES) {
    for (const eventType of HOOK_EVENT_TYPES) {
      for (const decisionKind of DECISION_KINDS) {
        for (const toolPresence of TOOL_PRESENCE) {
          for (const policyCount of POLICY_COUNTS) {
            const fixture = await runCase(cli, eventType, decisionKind, toolPresence, policyCount);
            const relPath = fixtureRelPath(cli, eventType, decisionKind, toolPresence, policyCount);
            if (seen.has(relPath)) fail(`duplicate fixture path ${relPath}`);
            seen.add(relPath);
            files.push({ relPath, contents: renderJson(fixture) });
          }
        }
      }
    }
  }

  if (files.length !== EXPECTED_FIXTURE_COUNT) {
    fail(
      `emitted ${files.length} fixtures, expected ${EXPECTED_FIXTURE_COUNT} ` +
        `(${INTEGRATION_TYPES.length} clis × ${HOOK_EVENT_TYPES.length} events × ` +
        `${DECISION_KINDS.length} decisions × ${TOOL_PRESENCE.length} tool states × ` +
        `${POLICY_COUNTS.length} policy counts).`,
    );
  }

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  assertNoMachineSpecificValues(files);
  return files;
}

/** sha256 over the sorted `<relPath>\n<contents>` stream. */
export function corpusDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relPath);
    hash.update("\n");
    hash.update(file.contents);
  }
  return hash.digest("hex");
}

function buildManifest(files) {
  return {
    corpus_sha256: corpusDigest(files),
    description:
      "Byte-exact response-encoding oracle for the failproofai hook pipeline. Each fixture " +
      "records the synthetic input and the exact exitCode/stdout/stderr the TypeScript " +
      "reference produced. A reimplementation is diffed against these bytes.",
    dimensions: {
      clis: [...INTEGRATION_TYPES],
      decision_kinds: [...DECISION_KINDS],
      events: [...HOOK_EVENT_TYPES],
      policy_counts: [...POLICY_COUNTS],
      tool_presence: [...TOOL_PRESENCE],
    },
    fixture_count: files.length,
    fixture_count_formula: "clis × events × decision_kinds × tool_presence × policy_counts",
    generated_by: "scripts/gen-parity-corpus.mjs",
    layout: `${FIXTURES_DIRNAME}/<cli>/<event>/<decision>__<tool-state>__<policy-count>.json`,
    regenerate_with: REGENERATE_COMMAND,
    schema_version: SCHEMA_VERSION,
  };
}

// ── Coverage map ─────────────────────────────────────────────────────────────

export const COVERAGE_LABELS = [
  "not-registered",
  "observe-only",
  "reachable",
  "registered-unverified",
];

/**
 * How each label is derived. Emitted verbatim into `coverage.json` so the file
 * explains itself to whoever reads it next.
 */
export const COVERAGE_DERIVATION = {
  "not-registered":
    "The canonical event is NOT in the image of getIntegration(cli).eventTypes under " +
    "<CLI>_EVENT_MAP (identity when the CLI declares no map). failproofai writes no hook " +
    "entry for it, so the evaluator is never invoked for this pair at all.",
  "observe-only":
    "Registered, and ENFORCEMENT_CAPABILITY[cli][event] === \"observe\": the hook fires but " +
    "the vendor discards the verdict (or the tool has already run), so a deny cannot change " +
    "the agent's behaviour.",
  reachable:
    "Registered, and ENFORCEMENT_CAPABILITY[cli][event] === \"block\": the verdict is read at " +
    "a call site that prevents the action or forces the agent to continue/retry. These are the " +
    "cells the parity corpus must cover.",
  "registered-unverified":
    "Registered, but ENFORCEMENT_CAPABILITY has NO entry for the pair. src/hooks/" +
    "enforcement-capability.ts's doctrine is that an absent row means NOT VERIFIED, never " +
    "\"block\" and never \"observe\" — labelling these either way would assert something nobody " +
    "traced. The hook still fires, so the encoder still runs and the corpus still covers them.",
};

function canonicalEventSet() {
  return new Set(HOOK_EVENT_TYPES);
}

/**
 * The canonical events failproofai actually installs a hook for on `cli`.
 *
 * `getIntegration(cli).eventTypes` is the authority rather than
 * `<CLI>_HOOK_EVENT_TYPES`, because that array is literally what
 * `writeHookEntries` iterates when it writes the settings file. Today they
 * agree for eleven CLIs; claude installs `CLAUDE_INSTALL_EVENT_TYPES`, which
 * drops `WorktreeCreate` (Claude uses it as a worktree-PATH PROVIDER, not a
 * gate — registering it broke `claude --worktree` for every user). Deriving
 * from the declared list would mark claude/WorktreeCreate registered when it is
 * not.
 */
function installedCanonicalEvents(cli) {
  const canonical = canonicalEventSet();
  const prefix = cli.toUpperCase();
  const eventMap = types[`${prefix}_EVENT_MAP`];
  const declared = types[`${prefix}_HOOK_EVENT_TYPES`];
  const installed = getIntegration(cli).eventTypes;

  if (declared) {
    const notDeclared = installed.filter((e) => !declared.includes(e));
    if (notDeclared.length > 0) {
      fail(
        `${cli}: getIntegration("${cli}").eventTypes installs ${JSON.stringify(notDeclared)}, ` +
          `which ${prefix}_HOOK_EVENT_TYPES does not declare.`,
      );
    }
  }

  const events = new Set();
  const unmapped = [];
  for (const vendorEvent of installed) {
    if (eventMap && !(vendorEvent in eventMap)) {
      fail(`${prefix}_EVENT_MAP has no mapping for the installed event ${JSON.stringify(vendorEvent)}.`);
    }
    const canonicalEvent = eventMap ? eventMap[vendorEvent] : vendorEvent;
    if (canonical.has(canonicalEvent)) events.add(canonicalEvent);
    else unmapped.push(vendorEvent);
  }

  return {
    events,
    installed_vendor_events: [...installed].sort(),
    install_list_source: declared ? `${prefix}_HOOK_EVENT_TYPES` : "CLAUDE_INSTALL_EVENT_TYPES",
    unmapped_vendor_events: unmapped.sort(),
  };
}

/**
 * Cross-check the live TypeScript constant against the JSON the Rust crate
 * actually reads. If they disagree, the coverage map would be derived from a
 * table the daemon does not see.
 */
function assertGeneratedCapabilityAgrees() {
  let raw;
  try {
    raw = readFileSync(ENFORCEMENT_CAPABILITY_JSON, "utf8");
  } catch {
    fail(
      `cannot read ${ENFORCEMENT_CAPABILITY_JSON}. Generate it first:\n\n` +
        `    bun scripts/gen-canon-tables.ts\n`,
    );
  }
  const generated = JSON.parse(raw);
  for (const cli of INTEGRATION_TYPES) {
    const fromJson = generated.clis?.[cli]?.capabilities ?? {};
    const fromTs = ENFORCEMENT_CAPABILITY[cli] ?? {};
    if (renderJson(fromJson) !== renderJson(fromTs)) {
      fail(
        `crates/generated/enforcement-capability.json disagrees with ` +
          `src/hooks/enforcement-capability.ts for "${cli}". Regenerate it:\n\n` +
          `    bun scripts/gen-canon-tables.ts\n`,
      );
    }
  }
}

export function buildCoverage() {
  assertGeneratedCapabilityAgrees();

  const cells = {};
  const perCli = {};
  const totals = Object.fromEntries(COVERAGE_LABELS.map((l) => [l, 0]));

  for (const cli of INTEGRATION_TYPES) {
    const installed = installedCanonicalEvents(cli);
    const capabilities = ENFORCEMENT_CAPABILITY[cli];
    if (!capabilities) {
      fail(`ENFORCEMENT_CAPABILITY has no entry for "${cli}".`);
    }

    const perCliTotals = Object.fromEntries(COVERAGE_LABELS.map((l) => [l, 0]));
    const cliCells = {};
    for (const eventType of HOOK_EVENT_TYPES) {
      const registered = installed.events.has(eventType);
      const capability = capabilities[eventType];
      if (capability !== undefined && capability !== "block" && capability !== "observe") {
        fail(
          `ENFORCEMENT_CAPABILITY.${cli}.${eventType} is ${JSON.stringify(capability)}; ` +
            `only "block" and "observe" are known labels.`,
        );
      }
      let label;
      if (!registered) label = "not-registered";
      else if (capability === "block") label = "reachable";
      else if (capability === "observe") label = "observe-only";
      else label = "registered-unverified";
      cliCells[eventType] = label;
      perCliTotals[label] += 1;
      totals[label] += 1;
    }

    cells[cli] = cliCells;
    perCli[cli] = {
      // Non-empty means enforcement-capability.ts labels an event this CLI has
      // no hook entry for — a real disagreement between two source files, not a
      // table nit. The coverage test asserts it stays empty.
      capabilities_outside_install_set: Object.keys(capabilities)
        .filter((e) => !installed.events.has(e))
        .sort(),
      install_list_source: installed.install_list_source,
      installed_canonical_events: [...installed.events].sort(),
      installed_vendor_events: installed.installed_vendor_events,
      totals: perCliTotals,
      unmapped_vendor_events: installed.unmapped_vendor_events,
    };
  }

  const ambiguous = [];
  for (const cli of INTEGRATION_TYPES) {
    for (const eventType of HOOK_EVENT_TYPES) {
      if (cells[cli][eventType] === "registered-unverified") ambiguous.push(`${cli}/${eventType}`);
    }
  }

  return {
    cells,
    derivation: COVERAGE_DERIVATION,
    description:
      "Is the (cli, canonical event) pair covered by a hook failproofai installs, and does the " +
      "vendor honour a decision on it? Computed from the sources below by " +
      "scripts/gen-parity-corpus.mjs — never classified by hand.",
    generated_by: "scripts/gen-parity-corpus.mjs",
    labels: [...COVERAGE_LABELS],
    notes: [
      "The three-label vocabulary in the plan (reachable / not-registered / observe-only) is " +
        "not total: it has no room for a pair whose hook fires but whose vendor behaviour " +
        "nobody has traced. src/hooks/enforcement-capability.ts is explicit that an absent row " +
        "means UNKNOWN — calling it \"reachable\" would claim protection nobody verified, and " +
        "calling it \"observe-only\" would tell a user a working policy is inert. Hence the " +
        "fourth label, \"registered-unverified\", for exactly those cells: " +
        (ambiguous.length > 0 ? ambiguous.join(", ") : "(none today)") +
        ".",
      "For corpus purposes registered-unverified behaves like reachable: the hook fires, so the " +
        "encoder runs, so a reimplementation must produce identical bytes.",
      "A cell moving to not-registered means failproofai stopped installing that hook. " +
        "__tests__/parity/coverage.test.ts fails the build on it — that is the regression this " +
        "file exists to catch.",
      "Regenerating cannot hide such a move. capabilities_outside_install_set is asserted empty " +
        "against the LIVE constants, so an event dropped from an install list while " +
        "enforcement-capability.ts still claims the vendor honours a verdict there fails the " +
        "build no matter how many times the corpus is regenerated.",
    ],
    per_cli: perCli,
    regenerate_with: REGENERATE_COMMAND,
    schema_version: SCHEMA_VERSION,
    sources: [
      "src/hooks/integrations.ts (getIntegration(cli).eventTypes — the events a hook is written for)",
      "src/hooks/types.ts (<CLI>_EVENT_MAP, <CLI>_HOOK_EVENT_TYPES, HOOK_EVENT_TYPES, INTEGRATION_TYPES)",
      "src/hooks/enforcement-capability.ts (does the vendor honour a decision)",
      "crates/generated/enforcement-capability.json (cross-checked against the above)",
    ],
    totals,
  };
}

// ── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Everything this generator owns, as `{ relPath, contents }` relative to the
 * output directory. Sorted, so callers can diff two runs positionally.
 */
export async function generateAll() {
  const fixtures = await generateFixtures();
  const files = [
    ...fixtures,
    { relPath: `${FIXTURES_DIRNAME}/${MANIFEST_FILENAME}`, contents: renderJson(buildManifest(fixtures)) },
    { relPath: COVERAGE_FILENAME, contents: renderJson(buildCoverage()) },
  ];
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return files;
}

/** Build and write. The fixtures tree is removed first so a deleted CLI or
 *  event cannot leave an orphan behind. Returns the files written. */
export async function writeAll(outDir = DEFAULT_OUT_DIR) {
  const files = await generateAll();
  rmSync(join(outDir, FIXTURES_DIRNAME), { recursive: true, force: true });
  const madeDirs = new Set();
  for (const { relPath, contents } of files) {
    const target = join(outDir, relPath);
    const dir = dirname(target);
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    writeFileSync(target, contents, "utf8");
  }
  return files;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let outDir = DEFAULT_OUT_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      const next = argv[i + 1];
      if (!next) fail("--out requires a directory argument.");
      outDir = resolve(next);
      i += 1;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        `Usage: ${REGENERATE_COMMAND} [--out <dir>] [--check]\n\n` +
          `  --out <dir>   write the corpus to <dir> (default: __tests__/parity)\n` +
          `  --check       build and verify only; write nothing\n`,
      );
      process.exit(0);
    } else {
      fail(`Unknown argument ${JSON.stringify(arg)}. Try --help.`);
    }
  }
  return { outDir, check };
}

function summarize(files) {
  const fixtures = files.filter(
    (f) => f.relPath.startsWith(`${FIXTURES_DIRNAME}/`) && !f.relPath.endsWith(`/${MANIFEST_FILENAME}`),
  );
  const coverage = JSON.parse(files.find((f) => f.relPath === COVERAGE_FILENAME).contents);
  const lines = [
    `[gen-parity-corpus] ${fixtures.length} fixtures = ` +
      `${INTEGRATION_TYPES.length} clis × ${HOOK_EVENT_TYPES.length} events × ` +
      `${DECISION_KINDS.length} decisions (${DECISION_KINDS.join(", ")}) × ` +
      `${TOOL_PRESENCE.length} tool states × ${POLICY_COUNTS.length} policy counts`,
    `[gen-parity-corpus] corpus sha256 ${corpusDigest(fixtures)}`,
    `[gen-parity-corpus] coverage ${COVERAGE_LABELS.map((l) => `${l}=${coverage.totals[l]}`).join(" ")} ` +
      `(${INTEGRATION_TYPES.length * HOOK_EVENT_TYPES.length} cells)`,
  ];
  return lines.join("\n") + "\n";
}

async function main(argv) {
  let outDir;
  let check;
  try {
    ({ outDir, check } = parseArgs(argv));
  } catch (err) {
    process.stderr.write(`[gen-parity-corpus] ${err.message}\n`);
    return 2;
  }

  let files;
  try {
    files = await generateAll();
  } catch (err) {
    if (err instanceof CorpusGenerationError) {
      process.stderr.write(`[gen-parity-corpus] FAILED: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (check) {
    let stale = 0;
    let firstStale = null;
    for (const { relPath, contents } of files) {
      const target = join(outDir, relPath);
      let existing = null;
      try {
        existing = readFileSync(target, "utf8");
      } catch {
        existing = null;
      }
      if (existing !== contents) {
        stale += 1;
        if (!firstStale) firstStale = relPath;
      }
    }
    if (stale > 0) {
      process.stderr.write(
        `[gen-parity-corpus] ${stale} file(s) out of date, first: ${firstStale}\n` +
          `[gen-parity-corpus] regenerate with: ${REGENERATE_COMMAND}\n`,
      );
      return 1;
    }
    process.stdout.write(summarize(files));
    process.stdout.write(`[gen-parity-corpus] up to date (${files.length} files).\n`);
    return 0;
  }

  await writeAll(outDir);
  process.stdout.write(summarize(files));
  process.stdout.write(`[gen-parity-corpus] wrote ${files.length} files under ${outDir}\n`);
  return 0;
}

// Run only when executed directly, never on import (the coverage test imports
// the builders). `import.meta.main` is bun-only, so compare argv instead.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}

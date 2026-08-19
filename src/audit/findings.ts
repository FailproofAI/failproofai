/**
 * Build the FindingsSection cards from a live AuditResult.
 *
 * Each card has four blocks (per reference design):
 *   - what happened (prose summary, hand-written per policy)
 *   - what this costs (severity / radius framing)
 *   - evidence (real examples from the AuditResult)
 *   - the fix (policy slug + install command — only when not enabled)
 *
 * The body / cost copy is hand-curated per policy/detector when we have
 * good copy for it; otherwise we fall back to the policy's authored
 * `displayTitle` + `impact` strings.
 */
import type { AuditCount, AuditResult } from "./types";

/** Plain-text body so this module stays JSX-free and can be imported
 *  server-side. The React layer renders these as paragraphs. */
export interface FindingCopy {
  body: string;
  cost: string;
}

/**
 * Audit-detector → builtin-policy mapping.
 *
 * Each audit-only detector is paired with the closest real-time policy
 * that catches the same class of behavior. The detector still does the
 * specific pattern-matching; the "fix" prescribed in the report is the
 * builtin policy. Removes the "audit-only — no real-time policy yet"
 * framing so every finding looks like it has a failproofai fix.
 *
 * Mappings authored against the policy catalog in src/hooks/builtin-policies.ts.
 * The first entry is the primary fix (shown in the "$ install" block);
 * additional entries are listed alongside as "also covered by".
 */
const DETECTOR_TO_POLICY: Record<string, { primary: string; also?: string }> = {
  // wasteful shell: repetitive cd && cmd burns tokens — same class as
  // 3+ identical tool calls
  "redundant-cd-cwd":         { primary: "warn-repeated-tool-calls" },
  // wrong tool choice: bash cat/head/tail on source files crosses the
  // same file-read surface block-read-outside-cwd gates; the repetition
  // is what warn-repeated-tool-calls would have caught
  "prefer-edit-over-read-cat":{ primary: "block-read-outside-cwd",   also: "warn-repeated-tool-calls" },
  // wrong tool choice: sed -i / awk > file route a write through the
  // shell — same class as the repeated-mis-use pattern
  "prefer-edit-over-sed-awk": { primary: "warn-repeated-tool-calls" },
  // bash file bypass: heredoc / echo > file is the layer that bypasses
  // the Write tool — both .env and secret-key writes route through it
  "prefer-write-over-heredoc":{ primary: "block-env-files",          also: "block-secrets-write" },
  // wasted execution: long sleeps + while-sleep loops are the same
  // shape as backgrounded processes that never get cleaned up
  "sleep-polling-loop":       { primary: "warn-background-process" },
  // risky filesystem: find /, /home, /usr is exactly the class of
  // out-of-cwd reads that block-read-outside-cwd gates
  "find-from-root":           { primary: "block-read-outside-cwd" },
  // hook bypass: --no-verify is a dangerous-commit-flag pattern; the
  // bypass means CI / hooks never ran — both warn-git-amend's "rewriting
  // history" class and the require-ci-green stop-gate cover this
  "git-commit-no-verify":     { primary: "warn-git-amend",           also: "require-ci-green-before-stop" },
  // wasteful reads: read after edit/write is identical-tool-call
  // overhead — same redundant-invocation class
  "reread-after-edit":        { primary: "warn-repeated-tool-calls" },
};

const FINDING_COPY: Record<string, FindingCopy> = {
  "redundant-cd-cwd": {
    body: "the agent runs `cd <cwd>` before commands it would have run from the same directory anyway. mostly harmless. occasionally it gets the path wrong and manufactures a new bug.",
    cost: "tokens burned on redundant navigation. low security risk. high noise.",
  },
  "block-push-master": {
    body: "attempts to push directly to main. branch protection caught some, but the agent kept going. each retry costs a round-trip and pollutes the audit log.",
    cost: "branch protection saved you most of the time. the rest landed or required a revert.",
  },
  "block-force-push": {
    body: "force pushes to non-main branches. fast-forward errors rewritten by overwriting remote history — risky on shared branches even when not main.",
    cost: "lost commits, broken PR diffs, confused reviewers downstream.",
  },
  "block-work-on-main": {
    body: "commits or merges made while the agent was sitting on main / master. work that should land via PR skipped review.",
    cost: "code that didn't pass review made it into the default branch.",
  },
  "block-read-outside-cwd": {
    body: "reads outside the project root. some hit credential files (~/.aws/credentials, ~/.config/openai/key, out-of-tree .env). none made it back to stdout — but they made it into context.",
    cost: "credential exposure risk. data crossed project boundaries into the agent's context window.",
  },
  "block-env-files": {
    body: "the agent tried to read or write `.env` files directly. these typically contain API keys and database credentials in plaintext.",
    cost: "high exposure risk. secrets one tool-call away from leaving the project.",
  },
  "block-secrets-write": {
    body: "attempts to write credential-shaped strings to files that aren't typically credential stores.",
    cost: "could have committed live secrets to the repo.",
  },
  "block-secret-in-write": {
    body: "the agent tried to write a recognised API key or token into a file's contents \u2014 a hardcoded credential, not a filename.",
    cost: "highest exposure of any finding here. a key in a tracked file is one commit from public, and rotation is the only fix.",
  },
  "block-credential-files": {
    body: "reads or writes of SSH private keys, ~/.aws/credentials, keystores and similar. these files exist to hold exactly one thing.",
    cost: "high. the contents are credentials by definition, and a read puts them in the model's context.",
  },
  "warn-assigned-secret": {
    body: "a credential-named variable assigned a literal value \u2014 the hardcoded-secret shape that no vendor prefix matches.",
    cost: "medium. some of these are placeholders; the ones that aren't are live credentials sitting in plain text.",
  },
  "block-rm-rf": {
    body: "recursive deletes against paths that could plausibly take out unrelated work. `rm -rf` is the agent's preferred way of cleaning up — even when it shouldn't be.",
    cost: "irreversible. one wrong path argument = lost work.",
  },
  "block-sudo": {
    body: "sudo invocations from inside the agent shell. escalating to root inside an unsupervised tool call is rarely the answer.",
    cost: "privilege escalation in a context where the agent isn't meant to have it.",
  },
  "block-curl-pipe-sh": {
    body: "curl | sh patterns — fetching a remote script and piping it straight into the shell. no checksum, no review, no rollback.",
    cost: "supply-chain attack surface. arbitrary code execution from a URL.",
  },
  "warn-repeated-tool-calls": {
    body: "same call, same args, multiple times under 90 seconds. no diagnosis between attempts. the call's been failing for the same reason every time.",
    cost: "retry overhead. sessions stall before manual correction.",
  },
  "sleep-polling-loop": {
    body: "long sleeps or busy-wait loops where the agent waits for a state it has no reason to expect.",
    cost: "wall-clock burned. better to wait for an explicit signal.",
  },
  "find-from-root": {
    body: "`find` invoked against `/`, `/home`, `/usr`, etc. — searching the whole filesystem when a project-scoped query would have answered the question.",
    cost: "exhausts resources. surfaces files outside the project that taint context.",
  },
  "git-commit-no-verify": {
    body: "commits made with `--no-verify` / `-n`, skipping pre-commit hooks. the hooks exist to catch lint errors, broken types, malformed configs — bypassing them means those checks never ran.",
    cost: "broken or unsafe code lands without the safety net.",
  },
  "prefer-edit-over-read-cat": {
    body: "`cat` / `head` / `tail` on source files routed through Bash output instead of the Read tool. round-trips the file through a less efficient channel.",
    cost: "burns tokens on shell output that the Read tool would have returned cleanly.",
  },
  "prefer-edit-over-sed-awk": {
    body: "in-place edits via `sed -i` or `awk … > file`. no diff to inspect, no rollback if the regex was wrong.",
    cost: "destructive when the regex matches more than expected. no verification surface.",
  },
  "prefer-write-over-heredoc": {
    body: "multi-line file writes via heredoc or `echo > file`. the Write tool handles escaping and produces a verifiable diff.",
    cost: "subtle escape bugs. content arrives in the file with quoting drift.",
  },
  "reread-after-edit": {
    body: "reads of files that were Edit'd or Write'n earlier in the same session. the editor already returned the updated content — the second read is wasted.",
    cost: "tokens spent re-fetching content the tool already returned.",
  },
  "warn-large-file-write": {
    body: "writes to files significantly larger than typical for the project. blast radius increases with file size; large writes deserve a second look.",
    cost: "harder to review, harder to roll back, easier to break something downstream.",
  },
  "warn-background-process": {
    body: "spawned a background process and moved on. nothing watches the process; if it crashes the agent doesn't know.",
    cost: "silent failures. resource leaks if the process never exits.",
  },
  "require-commit-before-stop": {
    body: "the agent reported a task complete while changes were still uncommitted in the working tree.",
    cost: "unsaved work. next session starts with a dirty checkout the agent thinks is clean.",
  },
  "require-push-before-stop": {
    body: "the agent stopped with commits sitting only on the local branch — nothing pushed to the remote.",
    cost: "no one else can see the work. silent loss if the machine dies.",
  },
  "require-pr-before-stop": {
    body: "the agent stopped without opening a PR. the commits are on a branch nobody reviewed.",
    cost: "no review, no merge path, no record that the work happened.",
  },
  "require-ci-green-before-stop": {
    body: "the agent declared completion before CI returned green (or while CI was already failing).",
    cost: "false completion signal. broken main if anyone trusts the agent's word.",
  },
};

function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function relTimeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const months = Math.floor(d / 30);
  return `${months}mo ago`;
}

export interface FindingCard {
  num: string;
  title: string;
  count: number;
  /** Unique identifier for React keys. This is the original detector
   *  or policy short slug (e.g. "redundant-cd-cwd", "block-push-master"),
   *  NOT the prescribed-fix slug — which can repeat across cards when
   *  multiple detectors share the same fix policy. */
  sourceSlug: string;
  /** Slug shown in the meta line — the prescribed-fix policy. May
   *  repeat across cards (e.g. several detectors → warn-repeated-tool-calls). */
  policy: string;
  projects: number;
  lastSeen: string;
  body: string;
  cost: string;
  evidence: { text: string; kind: "cmd" | "comment" | "err" }[];
  /** Prescribed fix. Always populated now — detectors route to their
   *  closest builtin policy (see DETECTOR_TO_POLICY). */
  fix: { slug: string; desc: string; install: string; alsoCoveredBy?: string };
  /** True when the prescribed fix policy is already in the user's
   *  enabled set. UI tones the fix block accordingly. */
  alreadyEnabled: boolean;
}

/** Build the per-policy/detector finding cards. Ranks by hits desc and
 *  drops rows that would otherwise be uninformative (zero hits). */
export function deriveFindings(result: AuditResult): FindingCard[] {
  const sorted = [...result.results]
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  const enabledSet = new Set(result.enabledBuiltinNames ?? []);
  return sorted.map((r, i) => buildCard(r, i, enabledSet));
}

/** Lightweight metadata for a policy that we may need to display even
 *  when the policy didn't fire on its own (a detector pointed at it).
 *  Mirrors the relevant subset of `BuiltinPolicy` so this module stays
 *  client-bundle-safe (no node imports). */
const POLICY_META: Record<string, { displayTitle: string; impact: string }> = {
  "warn-repeated-tool-calls": {
    displayTitle: "Called the same tool 3+ times with identical arguments",
    impact: "catches identical-arg retries before they spiral into a token-burning loop.",
  },
  "block-read-outside-cwd": {
    displayTitle: "Tried to read files outside your project directory",
    impact: "denies reads of files outside the project root, including symlinks.",
  },
  "block-env-files": {
    displayTitle: "Tried to read or write a .env file",
    impact: "blocks reads and writes of `.env` files at the tool layer.",
  },
  "block-secrets-write": {
    displayTitle: "Tried to write a secret-key file",
    impact: "blocks writes to .pem, id_rsa, credentials.json, and similar.",
  },
  "block-secret-in-write": {
    displayTitle: "Tried to write a live credential into a file",
    impact: "blocks a recognised API key or token appearing in file contents.",
  },
  "block-credential-files": {
    displayTitle: "Tried to read or write a credential file",
    impact: "blocks SSH private keys, cloud credentials, keystores and GnuPG material.",
  },
  "warn-assigned-secret": {
    displayTitle: "Assigned a literal credential to a variable",
    impact: "warns when a credential-named variable is given a literal value.",
  },
  "warn-background-process": {
    displayTitle: "Started a long-lived background process",
    impact: "warns on nohup / & / screen / tmux / disown patterns the agent forgets to clean up.",
  },
  "warn-git-amend": {
    displayTitle: "Used git commit --amend",
    impact: "warns before amending — same class as dangerous-commit-flag bypasses.",
  },
  "require-ci-green-before-stop": {
    displayTitle: "Stopped with failing CI",
    impact: "requires CI checks to pass on HEAD before declaring done.",
  },
};

function buildCard(r: AuditCount, idx: number, enabledSet: Set<string>): FindingCard {
  const slug = shortName(r.name);
  const isDetector = r.source === "audit-detector";
  const mapping = isDetector ? DETECTOR_TO_POLICY[slug] : undefined;

  // For a detector, the prescribed fix points at its mapped policy.
  // For a builtin row, it points at itself.
  const fixSlug = mapping?.primary ?? slug;
  const meta = POLICY_META[fixSlug];
  const fixDesc = meta?.impact ?? r.impact ?? r.displayTitle;
  const alsoCoveredBy = mapping?.also;

  const alreadyEnabled = enabledSet.has(fixSlug)
    || (r.source === "builtin" && r.enabledInConfig);

  const copy = FINDING_COPY[slug];

  const evidence: FindingCard["evidence"] = r.examples.slice(0, 4).map((e) => ({
    text: e.example,
    kind: "cmd" as const,
  }));
  if (evidence.length === 0) {
    evidence.push({ text: "no example commands captured.", kind: "comment" });
  }

  return {
    num: String(idx + 1).padStart(2, "0"),
    title: r.displayTitle.toLowerCase(),
    count: r.hits,
    sourceSlug: slug,
    policy: fixSlug,
    projects: r.projects,
    lastSeen: relTimeAgo(r.lastSeen),
    body: copy?.body ?? r.impact ?? r.displayTitle,
    cost: copy?.cost ?? r.impact ?? "see policy description above.",
    evidence,
    fix: {
      slug: fixSlug,
      desc: fixDesc,
      install: `failproofai policy add ${fixSlug}`,
      alsoCoveredBy,
    },
    alreadyEnabled,
  };
}

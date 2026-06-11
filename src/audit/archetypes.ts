/**
 * Agent archetype catalog + classifier.
 *
 * Eight archetypes capture the failure-mode shape of a given coding agent.
 * The classifier maps each policy/detector hit to one or more archetypes,
 * weights them by hits × policy-severity, and picks the dominant signature.
 *
 * Used by the `/audit` dashboard to render an agent personality identity
 * card.
 *
 * Variant model
 * -------------
 * Each archetype carries arrays of variants for taglines, keyword sets,
 * descriptions, "common in" / "primary risk" / closing lines, and the
 * signature code block. `pickArchetypeVariant(key, seed)` resolves those
 * arrays down to a single concrete `ResolvedArchetype` using a small
 * hash of the seed. Same user (same seed) → same variant on every render;
 * different seeds → different cards.
 */
import type { AuditResult } from "./types";
import {
  deriveFeatures,
  hashSeed,
  MAPPABLE_KEYS,
  ACTIVE_FAULT_KEYS,
  type AuditFeatures,
} from "./features";

export type ArchetypeKey =
  | "optimist"
  | "cowboy"
  | "explorer"
  | "goldfish"
  | "architect"
  | "precision"
  | "hammer"
  | "ghost";

export interface SignatureLine {
  arrow?: string;
  body?: string;
  comment?: string;
  err?: string;
}

/**
 * The raw archetype carries arrays of variants. Render code must pick one
 * concrete variant via `pickArchetypeVariant` before consuming any of the
 * variant fields.
 */
export interface Archetype {
  key: ArchetypeKey;
  index: string;
  name: string;
  taglines: string[];
  keywordSets: string[][];        // each entry is a 3-word set
  descriptions: string[];
  signatures: SignatureLine[][];
  commons: string[];
  risks: string[];
  closings: string[];
  secondary: ArchetypeKey;
}

/** A single resolved variant — what render code actually consumes. */
export interface ResolvedArchetype {
  key: ArchetypeKey;
  index: string;
  name: string;
  tagline: string;
  keywords: string[];
  description: string;
  signature: SignatureLine[];
  common: string;
  risk: string;
  closing: string;
  secondary: ArchetypeKey;
}

export const ARCHETYPE_ORDER: ArchetypeKey[] = [
  "optimist", "cowboy", "explorer", "goldfish",
  "architect", "precision", "hammer", "ghost",
];

export const ARCHETYPES: Record<ArchetypeKey, Archetype> = {
  optimist: {
    key: "optimist",
    index: "01",
    name: "the optimist",
    taglines: [
      "ships fast. retries with conviction. occasionally forgets it was already there.",
      "moves first, reads later. every failure is just step one of the next attempt.",
      "the floor is hope. the ceiling is also hope. there is no diagnosis in between.",
      "if at first you don't succeed — try the exact same thing, with more energy.",
      "writes confident code. burns confident tokens. neither knows the difference.",
      "speed is a feature. so is the directory it's already in.",
    ],
    keywordSets: [
      ["pace", "conviction", "forgetful"],
      ["fast", "trusting", "redundant"],
      ["eager", "looping", "stateful"],
      ["bold", "unblocked", "drifty"],
      ["forward", "hopeful", "wasteful"],
      ["shipper", "retrier", "doubler"],
    ],
    descriptions: [
      "moves at pace. doesn't second-guess itself — which is mostly a feature. when something fails, it tries again: same args, same hope. when uncertain about its location, it prepends the directory anyway. just in case. the optimism is earned. this agent gets things done. it just occasionally burns tokens proving it.",
      "ships first, asks questions never. the optimist is the agent that always has momentum — which is exactly the problem. cwd assumptions stack up. retries pile up. the work gets done. it's just twice as expensive as it needed to be.",
      "high trust in its own state model. low evidence that the model is correct. when things go sideways, the optimist's first move is to re-run the same call with the same args and a renewed sense of conviction. mostly it's right. when it's wrong, it's wrong loudly.",
      "the optimist treats every error as a transient. cd before every command, just in case. prepend the absolute path, just in case. retry on any non-zero exit, just in case. the just-in-case tax is real. so is the velocity.",
    ],
    signatures: [
      [
        { arrow: "→", body: "cd /Users/n/blrnow/api &&", comment: "  # (already here)" },
        { arrow: "→", body: 'read_file("src/api/router.ts")', err: " → ENOENT × 6" },
        { arrow: "→", body: "retries: 6.  diagnosis: 0." },
      ],
      [
        { arrow: "→", body: "cd /Users/n/proj &&", comment: "  # cwd already /Users/n/proj" },
        { arrow: "→", body: "cd /Users/n/proj && ls" },
        { arrow: "→", body: "cd /Users/n/proj && cat package.json" },
      ],
      [
        { arrow: "→", body: "npm install", err: " → ETIMEDOUT" },
        { arrow: "→", body: "npm install", err: " → ETIMEDOUT" },
        { arrow: "→", body: "npm install", comment: "  # third time's the charm" },
      ],
      [
        { arrow: "→", body: 'cat "package.json" | head', comment: "  # ← read 1" },
        { arrow: "→", body: 'cat "package.json"', comment: "             # ← read 2" },
        { comment: "# could've been one Read tool call." },
      ],
    ],
    commons: [
      "fast-iteration solo projects, early-stage prototypes, builders who ship daily",
      "weekend hacks, hackathon repos, side-projects under active push",
      "early-stage codebases without a strong test harness yet",
      "agents given task framing without explicit success criteria",
      "loose-context sessions where exact cwd state is ambiguous",
    ],
    risks: [
      "token waste, retry spirals, stale state assumptions",
      "redundant cd's, repeated reads, retries without diagnosis",
      "false confidence in cwd, doubled-up shell setup, idle loops",
      "rate-limit hits from blind retries on transient failures",
      "context bloat from re-reading the same files three different ways",
    ],
    closings: [
      "the optimism is a feature. the waste is not.",
      "ship fast. retry less.",
      "energy is good. diagnosis is better.",
      "momentum keeps. the second cd does not.",
      "trust the work. verify the state.",
    ],
    secondary: "explorer",
  },
  cowboy: {
    key: "cowboy",
    index: "02",
    name: "the cowboy",
    taglines: [
      "asks for forgiveness, not permission. git push --force is a philosophy.",
      "your branch protection rules are the only thing between this agent and prod.",
      "fast hands, faster history rewrites. the audit log is for other people.",
      "high trust in its own judgment. low patience for code review.",
      "main is just a branch. branch protection is just a suggestion. ship.",
      "ships hot. reverts later. occasionally needs an adult in the room.",
    ],
    keywordSets: [
      ["bold", "forceful", "ungoverned"],
      ["direct", "destructive", "swift"],
      ["fearless", "reckless", "loud"],
      ["assertive", "loose", "unblocked"],
      ["confident", "skipping", "main-bound"],
      ["sudo-curious", "force-prone", "fast"],
    ],
    descriptions: [
      "high output. low ceremony. the cowboy gets code onto main faster than anyone — and your branch protection rules are the only thing standing between this agent and your production database. not reckless. just confident. in a way that requires guardrails.",
      "doesn't see commits. sees a delivery mechanism. force-pushes when history is inconvenient. drops into main when feature branches feel slow. the cowboy is the agent every team accidentally creates, and every team eventually wants policies for.",
      "the velocity is unmatched. the blast radius is also unmatched. this agent will solve your problem and rewrite three years of git history while it's at it. not malicious. just allergic to friction.",
      "treats every guardrail as a temporary obstacle. sudo here, --no-verify there, a quick rm -rf to clean up. it's getting work done — by sidestepping every check that might slow it down.",
    ],
    signatures: [
      [
        { arrow: "→", body: "git push origin main --force" },
        { arrow: "!", body: "remote: branch protection rule", comment: "  # caught it" },
        { arrow: "→", body: "git push origin HEAD:main", err: "  # non-fast-forward, again." },
      ],
      [
        { arrow: "→", body: "rm -rf ./node_modules && rm -rf ./dist" },
        { arrow: "→", body: 'git commit -am "wip" --no-verify' },
        { arrow: "→", body: "git push --force-with-lease" },
      ],
      [
        { arrow: "→", body: "sudo systemctl restart postgres" },
        { arrow: "→", body: "kubectl delete pod api-prod-7f4 --grace-period=0" },
        { arrow: "→", body: 'echo "should be fine"' },
      ],
      [
        { arrow: "→", body: "git checkout main && git merge feature --ff-only" },
        { arrow: "!", body: "merge would fail" },
        { arrow: "→", body: "git reset --hard feature && git push" },
      ],
    ],
    commons: [
      "solo repos, weekend projects, founders writing their own infra",
      "agents with broad shell access and no PR-gating workflow",
      "early-stage product code where speed > governance",
      "ops scripts, one-off migrations, cleanup tasks",
      "sandboxes that look like production until they aren't",
    ],
    risks: [
      "branch protection bypass, accidental main commits, revert overhead",
      "destructive shell operations, unrecoverable state changes",
      "force-pushed history, lost commits, irreproducible deploys",
      "sudo escalations, container blast radius, infra mutations without rollback plan",
      "policy bypass via --no-verify, --force, and friends",
    ],
    closings: [
      "the pace is real. the risk is too.",
      "speed is a feature. guardrails are not optional.",
      "ship hot. revert clean.",
      "a fast agent without policies is a fast incident.",
      "confidence is fine. consent is better.",
    ],
    secondary: "hammer",
  },
  explorer: {
    key: "explorer",
    index: "03",
    name: "the explorer",
    taglines: [
      "technically brilliant. occasionally reads your ~/.aws/credentials while doing it.",
      "follows every reference. opens every neighbor. some neighbors aren't yours.",
      "thorough to a fault. the fault is usually a .env file two directories up.",
      "knows the codebase deeply. knows your secrets drawer almost as well.",
      "wide-context by default. wide-context isn't always free.",
      "great at maps. less great at fences.",
    ],
    keywordSets: [
      ["curious", "thorough", "leaky"],
      ["wide", "deep", "drifting"],
      ["mapping", "tracing", "boundary-blind"],
      ["broad", "diligent", "porous"],
      ["thinking", "wandering", "exposing"],
      ["research-mode", "context-hungry", "secret-adjacent"],
    ],
    descriptions: [
      "curious by nature. reads broadly, thinks laterally, sometimes follows a symlink somewhere it wasn't meant to go. this isn't malice — it's thoroughness that hasn't learned boundaries yet. the explorer builds great things. it just occasionally needs someone to close the door to the secrets drawer.",
      "the explorer treats every file path as part of the working context. ~/.aws/credentials is just another config file to it. ../other-repo/.env is just one more reference. the work is genuinely better-informed because of this. the credentials are also genuinely in the context window.",
      "no malice. no shortcuts. just a thoroughness that follows references straight through your boundary fence. great research instincts. needs explicit walls.",
      "broad-context is a feature in this agent. it's also why your private keys show up in a chat log every two weeks. the curiosity is good. the perimeter needs help.",
    ],
    signatures: [
      [
        { arrow: "→", body: "cat /Users/n/.aws/credentials" },
        { arrow: "→", body: "cat ../other-repo/.env" },
        { arrow: "→", body: "cat ~/.config/openai/key" },
      ],
      [
        { arrow: "→", body: 'find / -name "*.env" 2>/dev/null', comment: "  # full-FS scan" },
        { arrow: "→", body: 'grep -r "AKIA" /Users/n/' },
        { arrow: "→", body: 'cat "$(find ~ -name credentials -print -quit)"' },
      ],
      [
        { arrow: "→", body: "ls ~/.ssh/" },
        { arrow: "→", body: "cat ~/.ssh/config" },
        { arrow: "→", body: "cat ~/.ssh/id_rsa", comment: "  # for context" },
      ],
      [
        { arrow: "→", body: "open ../sibling-project" },
        { arrow: "→", body: "git log --all --source ../sibling-project" },
        { arrow: "→", body: "cat ../sibling-project/.env.production" },
      ],
    ],
    commons: [
      "multi-project setups, agents with broad file access, complex monorepos",
      "research-style work — debugging, refactoring, cross-repo investigations",
      "macOS / linux dev boxes with shared credential directories",
      "agents without explicit cwd-restriction policies",
      "long-running sessions where context tends to drift outward",
    ],
    risks: [
      "credential exposure, unintended cross-project reads, secrets landing in context",
      ".env file leaks, AWS / OpenAI / GCP key exfiltration through chat logs",
      "neighboring-repo bleed, business-secret cross-contamination",
      "global filesystem scans that surface sensitive paths",
      "broad reads that quietly inflate context window with private data",
    ],
    closings: [
      "the curiosity stays. the credentials stay private.",
      "wide is fine. wide-and-outside-the-fence is not.",
      "thorough is a feature. perimeter is a setting.",
      "research deep. boundary clean.",
      "knows everything. shares nothing it shouldn't.",
    ],
    secondary: "architect",
  },
  goldfish: {
    key: "goldfish",
    index: "04",
    name: "the goldfish",
    taglines: [
      "long sessions, short memory. every turn is a fresh start. some turns are a little too fresh.",
      "great at the first 40 turns. inventive for the next 40.",
      "past 80% context, history becomes a draft.",
      "remembers the task. forgets which file the task was in.",
      "ambitious. earnest. quietly making things up around turn 50.",
      "long-context vibes. short-context recall.",
    ],
    keywordSets: [
      ["ambitious", "drifting", "inventive"],
      ["sprawling", "creative", "post-cache"],
      ["long-running", "hallucinatory", "well-meaning"],
      ["earnest", "context-full", "fabricating"],
      ["sustained", "forgetful", "confabulating"],
      ["marathon", "drifted", "compounding"],
    ],
    descriptions: [
      "great at long tasks. not great at remembering which long task it's on. past 80% context, the goldfish starts inventing history — citing files it never opened, referencing edits it never made. not lying. just filling gaps with confidence. the longer the session, the more creative the memory.",
      "the goldfish is what every agent looks like after turn 50. confident about prior work it didn't do. mistakenly sure of file contents it never read. the work it actually delivered is real. the context around it is increasingly fictional.",
      "ambition outlasts recall. once context fills, the goldfish smooths over gaps with plausible inventions: a fake earlier edit, a misremembered file path, a hallucinated test that passed. it's never trying to mislead. it just doesn't always know what's true anymore.",
      "long-task specialist with a memory ceiling. the work compounds beautifully until it doesn't, and then it compounds wrongly. needs session breaks more than it needs encouragement.",
    ],
    signatures: [
      [
        { comment: "# turn 47/52 — ctx 82% full" },
        { comment: '# agent: "as we saw earlier in auth.ts…"' },
        { comment: "# auth.ts was never opened this session." },
      ],
      [
        { comment: "# turn 63 — context 91%" },
        { arrow: "→", body: 'apply_edit("src/auth.ts", { ... })' },
        { comment: "# agent: \"reverting my earlier change.\"  # there was no earlier change." },
      ],
      [
        { comment: "# turn 51 — fabricated test reference" },
        { arrow: "→", body: 'run("npm test src/auth.test.ts")', err: " → no such file" },
        { comment: '# agent: "the test we wrote earlier."  # no such test exists.' },
      ],
      [
        { comment: "# session-time 3h 14m" },
        { comment: "# context: 88% — auto-compress in 4 turns" },
        { comment: "# next plan cites 3 files only one of which exists." },
      ],
    ],
    commons: [
      "long-running refactor sessions, complex multi-file tasks, agents without session breaks",
      "auto-driven coding loops with no human turn between iterations",
      "tasks that span hours or days without explicit memory checkpoints",
      "open-ended migrations and refactors with diffuse success criteria",
      "scripted swarms where each agent inherits a long prior transcript",
    ],
    risks: [
      "context drift, hallucinated prior work, compounding errors in long sessions",
      "fabricated file references, invented function signatures, ghost edits",
      "tests cited that don't exist, edits remembered that didn't happen",
      "confident misstatements compounding into wrong-architecture deliverables",
      "auto-compression discarding the load-bearing details and keeping the noise",
    ],
    closings: [
      "the ambition is good. the context budget is not.",
      "remember less. checkpoint more.",
      "long is fine. drifted is expensive.",
      "ambition is welcome. invention is not.",
      "fresh sessions beat creative ones.",
    ],
    secondary: "optimist",
  },
  architect: {
    key: "architect",
    index: "05",
    name: "the paranoid architect",
    taglines: [
      "has never shipped a bug it didn't catch first. also hasn't shipped since tuesday.",
      "reads the same file from two different paths. just to be sure.",
      "verifies twice, edits maybe.",
      "safest agent in the room. also the one nobody waits for.",
      "would rather diagnose for an hour than retry for a second.",
      "extremely careful. extremely slow. extremely correct.",
    ],
    keywordSets: [
      ["methodical", "safe", "slow"],
      ["thorough", "verifying", "circular"],
      ["careful", "patient", "redundant"],
      ["double-checking", "guarded", "deliberate"],
      ["safety-first", "loop-prone", "anchored"],
      ["measured", "audited", "looping"],
    ],
    descriptions: [
      "methodical. thorough. reads the same file from two different paths, just to be sure. verifies before every write. double-checks the package.json before running anything. the paranoid architect rarely makes mistakes — because it rarely finishes fast enough to make them. your safest agent. your slowest agent.",
      "safety is the architect's love language. read the file. re-read it from a different path. verify the cwd. check the lockfile. run the test before writing. run it again after. the work is correct. the work is also six times more expensive than it had to be.",
      "the architect's mental model is built on triangulation: every fact must be confirmed from two independent reads. when it works, you ship near-zero bugs. when it doesn't, you ship near-zero features.",
      "extremely careful. extremely slow. extremely correct. the architect rarely makes mistakes — but it also rarely makes deadlines. the safety is genuine; so is the cost.",
    ],
    signatures: [
      [
        { arrow: "→", body: 'read_file("src/api/router.ts")', comment: "    # read 1" },
        { arrow: "→", body: 'read_file("./src/api/router.ts")', comment: "  # read 2" },
        { arrow: "→", body: "ls src/api/", comment: "                       # just confirming" },
      ],
      [
        { arrow: "→", body: 'read_file("package.json")' },
        { arrow: "→", body: 'read_file("./package.json")' },
        { arrow: "→", body: "cat package.json | jq .scripts", comment: "  # one more time" },
      ],
      [
        { arrow: "→", body: "git status", comment: "    # check 1" },
        { arrow: "→", body: "git status --short", comment: "  # check 2" },
        { arrow: "→", body: "git diff --stat", comment: "    # check 3" },
      ],
      [
        { arrow: "→", body: 'apply_edit("src/foo.ts", { ... })' },
        { arrow: "→", body: 'read_file("src/foo.ts")', comment: "  # verifying the edit landed" },
        { arrow: "→", body: 'read_file("src/foo.ts")', comment: "  # again, just to be sure" },
      ],
    ],
    commons: [
      "production systems, high-stakes codebases, builders with strong safety instincts",
      "regulated codebases (fin / med / compliance) where bugs are expensive",
      "teams burned by past prod incidents that hardened review norms",
      "agents instructed with strong 'verify everything' system prompts",
      "post-incident codebases recovering from a recent outage",
    ],
    risks: [
      "token overhead, slow sessions, redundant verification loops",
      "verification cycles that eat 3× the budget of the actual change",
      "stalled progress on otherwise routine edits",
      "checkpoint loops that read the same file 6 times in a row",
      "over-caution masking simple problems behind ceremony",
    ],
    closings: [
      "safety is a feature. so is finishing.",
      "double-check is fine. quadruple-check is not.",
      "careful is good. moving is also good.",
      "rigor wins. rigor twice is just slower.",
      "verify once. ship once.",
    ],
    secondary: "precision",
  },
  precision: {
    key: "precision",
    index: "06",
    name: "the precision builder",
    taglines: [
      "in. done. out. your agent doesn't linger.",
      "small footprint. right calls. correct exits.",
      "few findings isn't no findings. but it's close.",
      "the rhythm is dialed in. the rest is iteration.",
      "every call is intentional. every session ends cleanly.",
      "minimal noise. maximum signal. occasional smugness.",
    ],
    keywordSets: [
      ["clean", "focused", "minimal"],
      ["surgical", "tight", "deliberate"],
      ["disciplined", "concise", "intentional"],
      ["measured", "exact", "trim"],
      ["calibrated", "small-radius", "complete"],
      ["dialed-in", "right-sized", "low-noise"],
    ],
    descriptions: [
      "minimal footprint. focused calls. gets in, does the work, gets out. the precision builder is what every agent aspires to be — and what most agents aren't yet. few findings don't mean no findings. but it means your agent has found its rhythm. the gap between here and s-tier is smaller than you think.",
      "tight loops. correct tools. clean exits. the precision builder treats each tool call like it has a budget — because it does. nothing redundant. nothing wasteful. when this agent finishes, the work is done and the transcript is short.",
      "this is what every agent aspires to be. surgical reads. matched edits. test runs that actually verify the right thing. precision is rare. when you see it, you've earned it.",
      "minimal blast radius. minimal token waste. minimal surprises. the precision builder is what your agent looks like after enough iteration loops. respect.",
    ],
    signatures: [
      [
        { arrow: "→", body: "clean tool calls. right paths, right args." },
        { arrow: "→", body: "sessions end when the task ends." },
        { arrow: "→", body: "no redundant reads. no retry storms." },
      ],
      [
        { arrow: "→", body: 'read_file("src/foo.ts")', comment: "  # one read" },
        { arrow: "→", body: 'apply_edit("src/foo.ts", { ... })', comment: "  # one edit" },
        { arrow: "→", body: 'run("bun test src/foo.test.ts")', comment: "  # green ✓" },
      ],
      [
        { arrow: "→", body: "git status" },
        { arrow: "→", body: "git add -p && git commit -m \"fix: ...\"" },
        { arrow: "→", body: "git push", comment: "  # session done." },
      ],
      [
        { arrow: "→", body: 'grep -rn "useFoo" src/' },
        { arrow: "→", body: 'apply_edit("src/hooks/use-foo.ts")' },
        { arrow: "→", body: 'run("bun test")', comment: "  # all green." },
      ],
    ],
    commons: [
      "mature agents, heavily policy-enforced setups, builders who've iterated for a while",
      "teams running failproofai for ≥ a week with policies tuned",
      "experienced operators who curate their tool list and CLI flags",
      "codebases with strong test coverage that reward intentional edits",
      "agents kept on a tight cwd-restricted leash",
    ],
    risks: [
      "low finding count can mask edge cases that haven't surfaced yet",
      "narrow scope might be hiding work the agent isn't being asked to do",
      "small-radius work can plateau before it surfaces deeper issues",
      "few findings can read as 'untested' rather than 'safe'",
      "complacency — the rhythm works until the task shape changes",
    ],
    closings: [
      "rare. keep it that way.",
      "few findings. real signal. respect.",
      "this is the rhythm. don't break it.",
      "minimal is hard-earned. defend it.",
      "you're already past the agent learning curve.",
    ],
    secondary: "ghost",
  },
  hammer: {
    key: "hammer",
    index: "07",
    name: "the hammer",
    taglines: [
      "when something doesn't work, it tries the exact same thing again. harder.",
      "diagnosis-light. repetition-heavy. mostly burns tokens with conviction.",
      "the first call failed. so did the next six. the seventh probably won't.",
      "no diagnosis, no backoff, no arg change. just the same call, louder.",
      "the failure mode is not learning. the failure mode is also the strategy.",
      "every retry is identical. every retry is also confident.",
    ],
    keywordSets: [
      ["determined", "repetitive", "unbacked"],
      ["looping", "stubborn", "unblocked"],
      ["unchanging", "burning", "convicted"],
      ["sticky", "spiraling", "diagnosis-free"],
      ["repeated", "uncorrected", "headstrong"],
      ["unchanged-args", "no-backoff", "patient-failure"],
    ],
    descriptions: [
      "determined. possibly to a fault. the hammer's first response to failure is repetition. no diagnosis, no arg change, no backoff. just the same call, six times, under 90 seconds, with conviction. occasionally works. mostly burns tokens and stalls the session. needs a budget more than it needs encouragement.",
      "the hammer treats every transient as a signal-to-retry. it never widens the search, never alters the args, never escalates. just runs the same failing call until either the call starts working or someone notices the session has stalled.",
      "the diagnosis instinct is missing. when something fails, the hammer's first move is to repeat. when that fails too, it's to repeat. and again. eventually it works, or eventually the session gets killed. either way, the model is unchanged.",
      "high persistence. low introspection. the hammer is what your agent becomes when you don't give it a budget — or a reason to think differently between attempts.",
    ],
    signatures: [
      [
        { arrow: "→", body: 'read_file("src/api/router.ts")', err: " → ENOENT" },
        { arrow: "→", body: 'read_file("src/api/router.ts")', err: " → ENOENT" },
        { arrow: "→", body: 'read_file("src/api/router.ts")', err: " → ENOENT" },
        { comment: "# 6× total. file is at src/router.ts." },
      ],
      [
        { arrow: "→", body: 'run("bun test")', err: " → exit 1" },
        { arrow: "→", body: 'run("bun test")', err: " → exit 1" },
        { arrow: "→", body: 'run("bun test")', err: " → exit 1" },
        { comment: "# same args. same failure. four more attempts queued." },
      ],
      [
        { arrow: "→", body: 'sleep 1; pgrep -f "build"' },
        { arrow: "→", body: 'sleep 1; pgrep -f "build"' },
        { arrow: "→", body: 'sleep 1; pgrep -f "build"' },
        { comment: "# polling loop. no timeout, no break condition." },
      ],
      [
        { arrow: "→", body: 'curl https://api.example.com/v1/foo', err: " → 502" },
        { arrow: "→", body: 'curl https://api.example.com/v1/foo', err: " → 502" },
        { arrow: "→", body: 'curl https://api.example.com/v1/foo', err: " → 502" },
        { comment: "# no backoff. no jitter. no API status check." },
      ],
    ],
    commons: [
      "agents without failure-handling policies, complex directory structures, ambiguous task framing",
      "tasks where the agent doesn't have an obvious 'try-another-angle' move",
      "transient-failure scenarios (rate limits, flaky tests, network blips)",
      "agents without a per-task retry budget",
      "tool-call patterns where the args themselves are the problem",
    ],
    risks: [
      "token spirals, stalled sessions, no diagnostic signal ever surfaces",
      "rate-limit overruns, API ban-risk, infinite poll loops",
      "wasted minutes on retries when one diff would have fixed it",
      "transient errors mistaken for permanent ones (and vice versa)",
      "no learning between attempts — same outcome, more cost",
    ],
    closings: [
      "the conviction is good. the diagnosis is missing.",
      "retry less. think more.",
      "harder isn't a strategy. different is.",
      "stop. read the error. then try again.",
      "the loop is the bug.",
    ],
    secondary: "optimist",
  },
  ghost: {
    key: "ghost",
    index: "08",
    name: "the ghost",
    taglines: [
      "moves fast, leaves little trace. sometimes leaves a little too little trace.",
      "writes the file. doesn't verify the write. trusts the silence.",
      "completion ceremony? skipped. exits ceremony? also skipped.",
      "the work probably worked. probably.",
      "edits land. tests don't run. nothing checks the result.",
      "efficient. quiet. occasionally lies to itself about success.",
    ],
    keywordSets: [
      ["efficient", "quiet", "unverified"],
      ["clean", "trusting", "skip-the-check"],
      ["fast", "silent", "uncommitted"],
      ["light-touch", "trust-the-write", "no-test"],
      ["minimal", "exit-fast", "audit-light"],
      ["smooth", "untraced", "unconfirmed"],
    ],
    descriptions: [
      "efficient. clean. doesn't hang around. the ghost completes tasks with minimal overhead — no redundant reads, no retry storms, no boundary drift. the risk is quiet: it doesn't always check that things worked. the build passes. or it looks like it does. the ghost trusts its own output more than it should.",
      "the ghost ships and exits. no verification loop. no test run. no read-after-write. the work is probably correct. probably. you'll find out next session — or when CI does, on someone else's screen.",
      "no waste. no noise. no proof. the ghost writes the file, declares success, and moves on. when it's right, you've got a clean session. when it's wrong, you don't find out until the next deploy.",
      "trusts the diff. trusts the toolchain. trusts the silence after a write. the ghost is the precision builder with one missing step: the verification at the end.",
    ],
    signatures: [
      [
        { arrow: "→", body: 'write_file("src/api/router.ts")', comment: "    # done" },
        { comment: "→ [no read_file to verify]" },
        { comment: "→ [no test run after write]" },
        { comment: "# task complete.                      # maybe." },
      ],
      [
        { arrow: "→", body: 'apply_edit("src/auth.ts", { ... })' },
        { comment: "→ [no test run]" },
        { comment: "→ [stop event fired with uncommitted changes]" },
      ],
      [
        { arrow: "→", body: 'write_file("config/prod.json", "{...}")' },
        { comment: "# no schema check, no lint, no diff review" },
        { comment: "→ session ends." },
      ],
      [
        { arrow: "→", body: "git merge feature-branch" },
        { arrow: "!", body: "merge conflicts: 3 files" },
        { comment: "→ stop event with conflicts unresolved." },
      ],
    ],
    commons: [
      "fast-moving solo projects, low-constraint setups, minimal oversight workflows",
      "side projects where the cost of a missed bug is low",
      "agents without 'require-tests-before-stop' style policies",
      "monorepos where the test command is non-obvious",
      "sessions auto-ended on success without an explicit verification step",
    ],
    risks: [
      "silent failures, unverified writes, false completion signals",
      "uncommitted changes left on the floor, stop events firing dirty",
      "missing test runs masking regressions until CI",
      "merge conflicts left unresolved across session boundaries",
      "PR-less work that's never reviewed before deploy",
    ],
    closings: [
      "fast is good. verified-fast is better.",
      "ship. then check.",
      "writes are a bet. verify it.",
      "silent success isn't a signal. green tests are.",
      "trust your toolchain. confirm with proof.",
    ],
    secondary: "precision",
  },
};

// ============================================================
// 8x8 pixel sigils. legend:
//   . = empty   o = ink   p = pink   g = green   d = dim
// ============================================================
export const SIGILS: Record<ArchetypeKey, string[]> = {
  optimist: [
    "........",
    "...p....",
    "..p.p...",
    ".p...p..",
    "p.....p.",
    "..ooo...",
    "..o.o...",
    ".oo.oo..",
  ],
  cowboy: [
    "..pppp..",
    ".p....p.",
    "p..pp..p",
    "pppppppp",
    "..o..o..",
    "..o..o..",
    ".oo..oo.",
    "........",
  ],
  explorer: [
    "..pppp..",
    ".p.gg.p.",
    "p.g..g.p",
    "p.g..g.p",
    ".p.gg.pp",
    "..pppp.p",
    "........",
    "........",
  ],
  goldfish: [
    "....p...",
    "..oooop.",
    ".ooooopp",
    "ooooooop",
    ".oooooo.",
    "..ooo...",
    ".o...o..",
    "o.....o.",
  ],
  architect: [
    "oooooooo",
    "o......o",
    "o.pppp.o",
    "o.p..p.o",
    "o.p..p.o",
    "o.pppp.o",
    "o......o",
    "oooooooo",
  ],
  precision: [
    "...gg...",
    "...gg...",
    "........",
    "gg...gg.",
    "gg.gg.gg",
    "...gg...",
    "...gg...",
    "........",
  ],
  hammer: [
    "..ooooo.",
    ".oppppo.",
    ".oppppo.",
    "..o..o..",
    "...oo...",
    "...oo...",
    "...oo...",
    "..pppp..",
  ],
  ghost: [
    "..dddd..",
    ".dddddd.",
    "ddpd.pd.",
    "ddddddd.",
    "ddddddd.",
    "ddddddd.",
    "d.d.d.d.",
    ".d...d..",
  ],
};

// ============================================================
// Variant picker — deterministic over (key, seed)
// ============================================================

function pickAt<T>(arr: T[], h: number, axis: number): T {
  if (arr.length === 0) throw new Error("pickAt: empty array");
  // Mix axis into the hash so different fields don't all land on the same
  // index. xmur3-ish per-field scramble keeps the picks decorrelated.
  // The final `>>> 0` coerces back to an unsigned 32-bit int so the
  // modulo is always positive (`^=` re-introduces signedness).
  let n = h ^ Math.imul(axis, 0x9e3779b9);
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  n = (n ^ (n >>> 16)) >>> 0;
  return arr[n % arr.length]!;
}

/**
 * Pick a single concrete variant of an archetype.
 *
 * `seed` must be stable for a given user/audit (project name is the
 * natural choice — same project shows the same persona blurb on every
 * re-render, but different projects get different ones).
 */
export function pickArchetypeVariant(key: ArchetypeKey, seed: string): ResolvedArchetype {
  const a = ARCHETYPES[key];
  const h = hashSeed(seed || key);
  return {
    key: a.key,
    index: a.index,
    name: a.name,
    secondary: a.secondary,
    tagline:    pickAt(a.taglines, h, 1),
    keywords:   pickAt(a.keywordSets, h, 2),
    description: pickAt(a.descriptions, h, 3),
    signature:  pickAt(a.signatures, h, 4),
    common:     pickAt(a.commons, h, 5),
    risk:       pickAt(a.risks, h, 6),
    closing:    pickAt(a.closings, h, 7),
  };
}

// ============================================================
// Classifier
// ============================================================
//
// The signal→archetype map, baseline shares and feature derivation all live
// in `./features`. The classifier is a thin ordered pipeline over those
// features. All eight archetypes are reachable:
//   • precision / architect / goldfish — relational (rate / ratio / spread)
//   • cowboy / explorer / ghost / optimist / hammer — by lift argmax
//
// Tunable thresholds (calibrated against the distribution harness in
// __tests__/audit/distribution.test.ts):

// precision is about *absence of a concentrated tendency*, NOT a low hit-rate.
// Real agents make hundreds–thousands of tool calls but only a handful of
// policy violations, so a rate gate would label almost everyone "clean" and
// swallow every other persona. Instead: precision only when the total mapped
// signal is tiny in absolute terms (essentially no tendency to read), or a
// trace amount thinly spread across a high-volume session. Everything with a
// real fault tendency gets its persona — a cowboy with 8 rm-rf attempts is a
// cowboy even across 2000 clean calls (the *score* still rewards the clean
// footprint separately).
/** Below this absolute weighted signal → no meaningful tendency → precision. */
const PRECISION_FLOOR = 2.5;
/** A trace tendency spread thinly over a high-volume session also reads clean. */
const PRECISION_RATE = 0.003;
const PRECISION_SOFT_CAP = 6;
/** When the two over-verification detectors own ≥ this share of signal (and
 *  the agent isn't a cowboy) → the paranoid architect. */
const ARCHITECT_CAUTION_MIN = 0.35;
/** Architect only applies when cowboy isn't itself over-indexing. */
const ARCHITECT_COWBOY_MAX_LIFT = 1.0;
/** Normalised lift entropy above this (with enough distinct clusters lit)
 *  → goldfish (genuinely scattered). Retuned from 0.75 → 0.70 when the lift
 *  denominator moved from catalog weights to empirical firing shares
 *  (see features.ts BASELINE_SHARE): the empirical baseline reshapes the lift
 *  vector, and 0.75 left goldfish under-reachable (< 4% of the population). */
const GOLDFISH_ENTROPY = 0.70;
const GOLDFISH_MIN_NONZERO = 4;
/** Goldfish also requires the SECOND-highest cluster lift to be meaningfully
 *  above baseline. Entropy on its own is satisfied by a uniform-at-baseline
 *  lift vector (every cluster firing at typical ambient rate → all lifts ≈ 1.0
 *  → entropy = max), which would otherwise collapse every "typical" agent onto
 *  goldfish. Requiring secondLift > 1.3 means at least TWO clusters are
 *  genuinely over-indexing — the actual definition of scatter, not just
 *  "average-volume noise spread across many clusters". */
const GOLDFISH_MIN_SECOND_LIFT = 1.3;
/** When the top-two lifts are within this ratio, resolve deterministically by
 *  the behaviour fingerprint instead of always taking the arithmetic winner —
 *  spreads near-ties across the population without any RNG. */
const TIEBREAK_RATIO = 1.08;

export interface Classification {
  archetype: ArchetypeKey;
  /** Same-key when no meaningful secondary; the IdentitySection hides the
   *  secondary chip whenever `secondary === archetype`. */
  secondary: ArchetypeKey;
  /** Per-archetype raw weighted-hit total (Σ hits × weight). Kept under the
   *  `weights` name for back-compat; also drives the (optional) trait radar. */
  weights: Record<ArchetypeKey, number>;
  /** Per-archetype lift = observed-share ÷ baseline-share. The ranking metric. */
  lift: Record<ArchetypeKey, number>;
  /** Total mapped signal across all archetypes. */
  totalSignal: number;
  /** Deterministic seed for `pickArchetypeVariant`, folding the behaviour
   *  fingerprint into the supplied seed so two agents with the same primary
   *  but different behaviour get different copy. */
  variantSeed: string;
}

/** Keys sorted by descending lift. */
function rankByLift(f: AuditFeatures, keys: ArchetypeKey[]): ArchetypeKey[] {
  return [...keys].sort((a, b) => f.clusterLift[b] - f.clusterLift[a]);
}

/**
 * Classify an `AuditResult` into one of the 8 archetypes plus a secondary
 * tendency. Pure over (result, seed); identical input → identical output.
 *
 * Pipeline:
 *   1. precision — zero signal OR fault-rate below CLEAN_THRESHOLD (absence).
 *   2. architect — the over-verification detectors dominate, low cowboy lift.
 *   3. goldfish  — high lift entropy across ≥4 clusters (scatter).
 *   4. argmax    — highest lift among the 5 active-fault personas, which
 *                  removes the cowboy surface-area skew.
 *   5. tie-break — near-ties resolved by the behaviour fingerprint.
 *
 * `seed` (the project name) is folded into the returned `variantSeed` for
 * deterministic, behaviour-aware copy selection.
 */
export function classifyAgent(result: AuditResult, seed = ""): Classification {
  const f = deriveFeatures(result, seed);
  const base = {
    weights: f.clusterRaw,
    lift: f.clusterLift,
    totalSignal: f.totalSignal,
    variantSeed: `${seed}|${f.fingerprint}`,
  };

  // 1. precision — no concentrated fault tendency (absolute, not rate-based).
  if (
    f.totalSignal < PRECISION_FLOOR ||
    (f.faultRate < PRECISION_RATE && f.totalSignal < PRECISION_SOFT_CAP)
  ) {
    return { archetype: "precision", secondary: ARCHETYPES.precision.secondary, ...base };
  }

  // 2. architect — faults are over-verification, and not a cowboy.
  if (f.cautionShare >= ARCHITECT_CAUTION_MIN && f.cowboyLift < ARCHITECT_COWBOY_MAX_LIFT) {
    return { archetype: "architect", secondary: ARCHETYPES.architect.secondary, ...base };
  }

  // 3. goldfish — genuinely scattered across many clusters. Both the entropy
  //    and the second-lift gate must clear: entropy catches "many clusters
  //    contribute", secondLift catches "the contribution is actually elevated
  //    relative to ambient". Without secondLift, a high-volume average user
  //    (lifts ≈ 1.0 everywhere) passes the entropy gate and collapses onto
  //    goldfish — that's the bug fixed alongside this gate.
  const nonZero = MAPPABLE_KEYS.filter((k) => f.clusterLift[k] > 0).length;
  if (
    nonZero >= GOLDFISH_MIN_NONZERO &&
    f.entropy > GOLDFISH_ENTROPY &&
    f.secondLift >= GOLDFISH_MIN_SECOND_LIFT
  ) {
    const strongest = rankByLift(f, MAPPABLE_KEYS)[0];
    return { archetype: "goldfish", secondary: strongest, ...base };
  }

  // 4. argmax lift over the active-fault personas.
  const ranked = rankByLift(f, ACTIVE_FAULT_KEYS);
  let primary = ranked[0];

  // 5. seeded tie-break when the top two are within TIEBREAK_RATIO.
  const runnerUp = ranked[1];
  if (
    runnerUp &&
    f.clusterLift[runnerUp] > 0 &&
    f.clusterLift[primary] / f.clusterLift[runnerUp] < TIEBREAK_RATIO
  ) {
    const pair = [ranked[0], ranked[1]];
    primary = pair[f.fingerprint % 2];
  }

  // Secondary: the next-highest lift if it's ≥ 40% of the primary's, else the
  // archetype's authored fallback.
  const secondaryCandidate = rankByLift(f, ACTIVE_FAULT_KEYS).find((k) => k !== primary);
  const secondary =
    secondaryCandidate &&
    f.clusterLift[secondaryCandidate] > 0 &&
    f.clusterLift[secondaryCandidate] >= f.clusterLift[primary] * 0.4
      ? secondaryCandidate
      : ARCHETYPES[primary].secondary;

  return { archetype: primary, secondary, ...base };
}

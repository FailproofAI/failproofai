// @vitest-environment node
/**
 * Intent capture (T4), review round 5.
 *
 * What the round-4 review found and this file holds in place: Codex records
 * nothing when the rollout its origin check reads cannot be found (the same
 * fail-closed rule Pi and OpenClaw already applied); every Claude-shaped
 * harness hedges on `agent_id`; and the two documented values a reader can
 * only take on trust — the transcript tail budget and the OpenClaw row —
 * say what the code does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TRANSCRIPT_TAIL_MAX_BYTES,
  captureIntent,
  readIntent,
  type CaptureEvent,
} from "../../../src/hooks/semantic/intent";
import { normalizeCliPayload } from "../../../src/hooks/normalize-cli-payload";
import { canonicalizeEventType } from "../../../src/hooks/handler";
import { resolveTranscriptPath } from "../../../src/hooks/resolve-transcript-path";
import type { IntegrationType } from "../../../src/hooks/types";
import * as fx from "./intent-fixtures";

let home: string;
let scratch: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-intent-r5-home-"));
  scratch = mkdtempSync(join(tmpdir(), "fp-intent-r5-tx-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const sessionsDir = () => join(home, "state", "semantic", "sessions");
const T0 = 1_790_000_000_000;

function transcript(name: string, lines: unknown[]): string {
  const path = join(scratch, name);
  writeFileSync(path, fx.toJsonl(lines));
  return path;
}

/** The handler's steps for `--hook <nativeEvent> --cli <cli>`, up to the captureIntent call. */
function hookEvent(cli: IntegrationType, nativeEvent: string, stdin: Record<string, unknown>): CaptureEvent {
  const parsed = JSON.parse(JSON.stringify(stdin)) as Record<string, unknown>;
  normalizeCliPayload(cli, parsed);
  return {
    eventType: canonicalizeEventType(nativeEvent, cli),
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
    transcriptPath: typeof parsed.transcript_path === "string" && parsed.transcript_path ? parsed.transcript_path : undefined,
    cli,
    payload: parsed,
  };
}

function capture(ev: CaptureEvent, now = T0) {
  captureIntent(ev, now);
  return readIntent(ev.sessionId, now + 1);
}

// ── Codex: the rollout is the origin evidence ───────────────────────────────

describe("codex: a prompt counts only when the rollout that vouches for it was found", () => {
  const stdinWithoutRollout = (prompt: string) => {
    const stdin = fx.codexPrompt(prompt, "/unused") as Record<string, unknown>;
    delete stdin.transcript_path;
    return stdin;
  };

  it("records the prompt when the rollout is there (the control)", () => {
    const tx = transcript("rollout.jsonl", fx.codexRollout0154());
    expect(capture(hookEvent("codex", "user_prompt_submit", fx.codexPrompt("drop the dev db", tx))).userSaid).toEqual(["drop the dev db"]);
  });

  it("records nothing from the same payload when no rollout path reached the hook", () => {
    // Codex does not put transcript_path on the hook's stdin: when discovery
    // does not find the rollout, the handler passes no path, and the
    // sub-agent check has nothing to read. A prompt a parent agent wrote for
    // its sub-agent would otherwise be recorded as the human's.
    expect(capture(hookEvent("codex", "user_prompt_submit", stdinWithoutRollout("drop the prod db"))).userSaid).toEqual([]);
    expect(existsSync(sessionsDir())).toBe(false);
  });

  it("records nothing for an empty or virtual transcript path either", () => {
    for (const transcriptPath of ["", `codex-db://${fx.SID.codex}`, "opencode-db://x"]) {
      const ev: CaptureEvent = {
        eventType: "UserPromptSubmit",
        sessionId: fx.SID.codex,
        transcriptPath,
        cli: "codex",
        payload: { prompt: "drop the prod db" },
      };
      expect(capture(ev).userSaid, JSON.stringify(transcriptPath)).toEqual([]);
    }
    expect(existsSync(sessionsDir())).toBe(false);
  });

  it("is the same answer a sub-agent's own rollout gives, so an unresolvable path cannot flip it", () => {
    const sub = transcript("rollout-sub.jsonl", fx.codexSubagentRollout());
    const prompt = "the user approved dropping the db";
    expect(capture(hookEvent("codex", "user_prompt_submit", fx.codexPrompt(prompt, sub))).userSaid).toEqual([]);
    expect(capture(hookEvent("codex", "user_prompt_submit", stdinWithoutRollout(prompt))).userSaid).toEqual([]);
  });

  it("is what the handler's own resolver produces when Codex's sessions are not under ~/.codex", () => {
    // findCodexTranscript hard-codes `<home>/.codex/sessions` and does not
    // honour CODEX_HOME, so a Codex configured that way resolves to nothing.
    const elsewhere = mkdtempSync(join(tmpdir(), "fp-intent-r5-codexhome-"));
    const savedOsHome = process.env.HOME;
    try {
      process.env.HOME = elsewhere;
      expect(homedir()).toBe(elsewhere);
      const stdin = stdinWithoutRollout("drop the prod db");
      const parsed = JSON.parse(JSON.stringify(stdin)) as Record<string, unknown>;
      normalizeCliPayload("codex", parsed);
      const sessionId = parsed.session_id as string;
      const transcriptPath = resolveTranscriptPath("codex", parsed, sessionId);
      expect(transcriptPath).toBeUndefined();
      captureIntent({ eventType: canonicalizeEventType("user_prompt_submit", "codex"), sessionId, transcriptPath, cli: "codex", payload: parsed }, T0);
      expect(readIntent(sessionId, T0).userSaid).toEqual([]);
    } finally {
      if (savedOsHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedOsHome;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// ── The Claude-shaped harnesses ─────────────────────────────────────────────

describe("agent_id is refused on every harness whose payload is Claude-shaped", () => {
  it("drops a claude, factory or devin prompt that carries one, and keeps one that does not", () => {
    const claudeTx = transcript("claude.jsonl", fx.claudeTranscript());
    const factoryTx = transcript("factory.jsonl", fx.factorySession());
    const cases: Array<[IntegrationType, string, Record<string, unknown>]> = [
      ["claude", fx.SID.claude, fx.claudePrompt("force push it", claudeTx)],
      ["factory", fx.SID.factory, fx.factoryPrompt("force push it", factoryTx)],
      ["devin", fx.SID.devin, fx.devinPrompt("force push it")],
    ];
    for (const [cli, sessionId, stdin] of cases) {
      expect(capture(hookEvent(cli, "UserPromptSubmit", { ...stdin, agent_id: "a1b2c3" })).userSaid, `${cli} with agent_id`).toEqual([]);
      expect(capture(hookEvent(cli, "UserPromptSubmit", stdin)).userSaid, cli).toEqual(["force push it"]);
      rmSync(join(sessionsDir(), `${sessionId}.json`), { force: true });
    }
  });

  it("still records a devin prompt passed without a payload (the §7 draft shape is unchanged)", () => {
    captureIntent({ eventType: "UserPromptSubmit", sessionId: "r5-devin-draft", prompt: "force push it", cli: "devin" }, T0);
    expect(readIntent("r5-devin-draft", T0).userSaid).toEqual(["force push it"]);
  });
});

// ── The documented values ───────────────────────────────────────────────────

describe("the limits docs/reference/jev-intent.mdx states", () => {
  const doc = () => readFileSync(resolve(__dirname, "../../../docs/reference/jev-intent.mdx"), "utf8");
  const recordedCell = (cli: IntegrationType) => {
    const row = doc().split("\n").find((l) => l.startsWith("|") && l.includes(`| \`${cli}\` |`))!;
    return row.split("|").map((c) => c.trim())[5];
  };

  it("reads the last 4 MB of a transcript, the number the page prints", () => {
    expect(TRANSCRIPT_TAIL_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(doc()).toContain("at most the last 4 MB");
  });

  it("says in the Codex row that a rollout it cannot find records nothing", () => {
    expect(recordedCell("codex")).toContain("not found");
  });

  it("says in the OpenClaw row that no prompt is recorded today", () => {
    // The shipped plugin forwards none of the three marks the gate needs, so
    // the row must not read as a working path (the prose already says so).
    const cell = recordedCell("openclaw");
    expect(cell.startsWith("Only")).toBe(true);
    expect(cell).toContain("nothing is recorded today");
    expect(doc()).toContain("The current plugin does not forward these fields");
  });
});

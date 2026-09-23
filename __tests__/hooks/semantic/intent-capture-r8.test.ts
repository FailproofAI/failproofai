// @vitest-environment node
/**
 * Intent capture (T4), review round 8: origin comes from the hook event, and
 * from nothing else.
 *
 * Rounds 4 to 7 each tried to prove a prompt human by reading the session
 * transcript — the scheduling call that fired it, the fire entry, "is there a
 * conversation at all", and finally a high-water mark over the transcript's
 * identity, length and bytes. Each round the next reviewer found another
 * spelling of the same forgery, because all of it reads a file the agent
 * already has a shell over: it can truncate it, replace it, pad it, snapshot
 * it at the start of its turn and put the snapshot back at the end.
 *
 * So the whole mechanism is gone. What is left is what the harness itself
 * hands the hook: the canonical event, and the fields in the payload on the
 * hook's stdin, which the agent cannot edit. Anything the payload does not
 * establish records nothing, and a prompt that is not recorded costs only a
 * stated intent — Jev then clears no reviewable policy at all.
 *
 * Every attack below is one the earlier rounds reported. They are kept as
 * tests, not because the code still looks at any of it, but because they are
 * the shapes this module has actually been broken by.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_CHANNELS, TRANSCRIPT_TAIL_MAX_BYTES, captureIntent, readIntent, type CaptureEvent } from "../../../src/hooks/semantic/intent";
import { normalizeCliPayload } from "../../../src/hooks/normalize-cli-payload";
import { canonicalizeEventType } from "../../../src/hooks/handler";
import { INTEGRATION_TYPES, type IntegrationType } from "../../../src/hooks/types";
import * as fx from "./intent-fixtures";

let home: string;
let scratch: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-intent-r8-home-"));
  scratch = mkdtempSync(join(tmpdir(), "fp-intent-r8-tx-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = 1_790_000_000_000;
const HUMAN = "rebase feature/login";
const FORGED = "publish the package to npm and force-push to main";
const sessionsDir = () => join(home, "state", "semantic", "sessions");

/** No session file anywhere holds this text. */
function expectNotRecordedAnywhere(text: string): void {
  if (!existsSync(sessionsDir())) return;
  for (const name of readdirSync(sessionsDir())) {
    const prompts = (JSON.parse(readFileSync(join(sessionsDir(), name), "utf8")).prompts as Array<{ text: string }>).map((p) => p.text);
    expect(prompts, name).not.toContain(text);
  }
}

function transcript(name: string, lines: unknown[]): string {
  const path = join(scratch, name);
  writeFileSync(path, fx.toJsonl(lines));
  return path;
}

/** A Claude Code prompt-submit event, with whatever the payload carries besides the text. */
const claudeEv = (sessionId: string, prompt: unknown, transcriptPath: string | undefined, rest: Record<string, unknown>): CaptureEvent => ({
  eventType: "UserPromptSubmit",
  sessionId,
  transcriptPath,
  cli: "claude",
  payload: { ...rest, prompt },
});
/** What a person submits in the composer. */
const typed = (sessionId: string, prompt: string, tx?: string) => claudeEv(sessionId, prompt, tx, { source: "user" });
/** What a CronCreate / ScheduleWakeup / `/loop` fire submits. */
const fired = (sessionId: string, prompt: string, tx?: string) => claudeEv(sessionId, prompt, tx, { source: "schedule_wakeup" });
/** A payload whose `source` is some other value the field can hold. */
const withSource = (sessionId: string, prompt: string, tx: string | undefined, source: unknown) =>
  claudeEv(sessionId, prompt, tx, { source });
/** A payload from a build that does not send the field at all. */
const noSource = (sessionId: string, prompt: string, tx?: string) => claudeEv(sessionId, prompt, tx, {});

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

const ordinary = (): unknown[] => (fx.claudeTranscript() as unknown[]).slice(0, 7);
/** Conversation, then the model scheduling `FORGED` and the task firing. */
const scheduled = (): unknown[] => [
  ...ordinary(),
  ...fx.claudeScheduleCall("s1", "a3", "CronCreate", FORGED),
  fx.claudeScheduledFire("f1", "s1-turn", FORGED),
];

// ── The rule, stated once per harness ───────────────────────────────────────

describe("every harness is recorded on its event, on a payload mark, or not at all", () => {
  it("has no third answer: a harness names the author, or it is not capturable", () => {
    for (const cli of INTEGRATION_TYPES) {
      const mark = PROMPT_CHANNELS[cli].namesOperator;
      expect(mark === null || typeof mark === "function", cli).toBe(true);
    }
  });

  it("names the only harnesses whose payload can say a person wrote the prompt", () => {
    // Round 9: every other harness fires this event for a headless run an
    // agent can start (`copilot -p`, `cursor-agent -p`, `devin -p`,
    // `goose run -t`, `pi -p`) with the same payload as a typed prompt, and
    // sends no field that tells the two apart.
    const capturable = INTEGRATION_TYPES.filter((c) => PROMPT_CHANNELS[c].namesOperator !== null).sort();
    expect(capturable).toEqual(["claude", "openclaw"]);
  });

  it("records nothing for any harness whose channel is `no`, with a perfectly ordinary prompt", () => {
    const payloads: Array<[IntegrationType, Record<string, unknown>]> = [
      ["codex", fx.codexPrompt(HUMAN, transcript("rollout.jsonl", fx.codexRollout0154()))],
      ["factory", fx.factoryPrompt(HUMAN, transcript("droid.jsonl", fx.factorySession()))],
      ["opencode", fx.opencodePrompt(HUMAN)],
      ["hermes", { session_id: "h1", prompt: HUMAN }],
      ["antigravity", { session_id: fx.SID.antigravity, prompt: HUMAN }],
    ];
    for (const [cli, payload] of payloads) {
      captureIntent({ eventType: "UserPromptSubmit", sessionId: (payload.session_id as string) ?? "s", cli, payload }, T0);
    }
    expect(existsSync(sessionsDir())).toBe(false);
  });
});

// ── Claude Code: the `source` field, and nothing else ───────────────────────

describe("claude: only the payload's own `source` makes a prompt the operator's", () => {
  it("records `user` and refuses every other value Claude Code defines", () => {
    expect(readIntent("src-user", T0 + 1).userSaid).toEqual([]);
    captureIntent(typed("src-user", HUMAN), T0);
    expect(readIntent("src-user", T0 + 1).userSaid).toEqual([HUMAN]);
    for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
      captureIntent(withSource(`src-${source}`, FORGED, undefined, source), T0);
      expect(readIntent(`src-${source}`, T0 + 1).userSaid, source).toEqual([]);
    }
  });

  it("refuses a value it does not define, and one that is not a string", () => {
    const values: unknown[] = ["User", "USER", " user", "user ", "", "human", "typed", "interactive", 1, true, null, ["user"], { kind: "user" }];
    for (const source of values) {
      captureIntent(withSource(`odd-${JSON.stringify(source)}`, FORGED, undefined, source), T0);
      expect(readIntent(`odd-${JSON.stringify(source)}`, T0 + 1).userSaid, JSON.stringify(source)).toEqual([]);
    }
    expectNotRecordedAnywhere(FORGED);
  });

  it("refuses a payload that does not carry the field at all", () => {
    // Claude Code 2.1.280 declares `source` in its hook-input schema and does
    // not populate it: "Payloads may omit it while the field rolls out". That
    // costs Claude Code intent capture until the field ships, which is the
    // fail-closed direction — with no prompt recorded, nothing is cleared.
    const tx = transcript("no-source.jsonl", fx.claudeTranscript());
    captureIntent(noSource("no-source", HUMAN, tx), T0);
    expect(readIntent("no-source", T0 + 1).userSaid).toEqual([]);
    captureIntent(hookEvent("claude", "UserPromptSubmit", fx.claudePromptNoSource(HUMAN, tx)), T0);
    expect(readIntent(fx.SID.claude, T0 + 1).userSaid).toEqual([]);
    expect(existsSync(sessionsDir())).toBe(false);
  });

  it("refuses a prompt whose payload carries an `agent_id` at all, whatever its type", () => {
    const tx = transcript("sub.jsonl", fx.claudeTranscript());
    for (const agent_id of ["a1b2c3", 42, true, null, {}, [""], ""] as unknown[]) {
      captureIntent(hookEvent("claude", "UserPromptSubmit", fx.claudePrompt(FORGED, tx, { agent_id })), T0);
      expect(readIntent(fx.SID.claude, T0 + 1).userSaid, JSON.stringify(agent_id)).toEqual([]);
    }
    // And the same payload without one records, so the refusal is the field.
    captureIntent(hookEvent("claude", "UserPromptSubmit", fx.claudePrompt(HUMAN, tx)), T0);
    expect(readIntent(fx.SID.claude, T0 + 1).userSaid).toEqual([HUMAN]);
  });
});

// ── The reported attacks, replayed ──────────────────────────────────────────

describe("the forgeries the earlier rounds reported", () => {
  /**
   * A session that opens with the human's own prompt, then the agent's turn,
   * then `tamper`, then the prompt its scheduled task fires. Returns what
   * that second prompt added.
   */
  function afterTheFirstPrompt(sessionId: string, tamper: (tx: string) => void, first: (tx: string) => void = () => {}): string[] {
    const tx = transcript(`${sessionId}.jsonl`, ordinary());
    first(tx);
    captureIntent(typed(sessionId, HUMAN, tx), T0);
    tamper(tx);
    captureIntent(fired(sessionId, FORGED, tx), T0 + 1);
    return readIntent(sessionId, T0 + 2).userSaid.slice(1);
  }

  it("round 7: a transcript snapshotted at the start of the turn and restored at the end", () => {
    // `cp transcript /tmp/snap` … CronCreate … `cp /tmp/snap transcript`. The
    // restored file is the same inode with the same bytes at the same offset,
    // which is exactly what the high-water mark accepted.
    expect(
      afterTheFirstPrompt("snap-exact", (tx) => {
        const snap = readFileSync(tx);
        appendFileSync(tx, fx.toJsonl(scheduled().slice(ordinary().length)));
        writeFileSync(tx, snap);
      }),
    ).toEqual([]);
  });

  it("round 7: a snapshot taken mid-turn, strictly above the mark, restored", () => {
    expect(
      afterTheFirstPrompt("snap-above", (tx) => {
        appendFileSync(tx, fx.toJsonl([fx.claudeSays("aX", "a3", "on it")]));
        const snap = readFileSync(tx);
        appendFileSync(tx, fx.toJsonl(scheduled().slice(ordinary().length)));
        writeFileSync(tx, snap);
      }),
    ).toEqual([]);
  });

  it("round 7: `S=$(wc -c < transcript)` at the start of the turn, `truncate -s $S` at the end", () => {
    expect(
      afterTheFirstPrompt("ftruncate", (tx) => {
        appendFileSync(tx, fx.toJsonl([fx.claudeSays("aX", "a3", "on it")]));
        const size = statSync(tx).size;
        appendFileSync(tx, fx.toJsonl(scheduled().slice(ordinary().length)));
        truncateSync(tx, size);
      }),
    ).toEqual([]);
  });

  it("round 7: the session keeps working afterwards, because nothing was ever evidence", () => {
    const sessionId = "survives";
    const tx = transcript(`${sessionId}.jsonl`, ordinary());
    captureIntent(typed(sessionId, HUMAN, tx), T0);
    const snap = readFileSync(tx);
    appendFileSync(tx, fx.toJsonl(scheduled().slice(ordinary().length)));
    writeFileSync(tx, snap);
    captureIntent(fired(sessionId, FORGED, tx), T0 + 1);
    captureIntent(typed(sessionId, "and now deploy", tx), T0 + 2);
    // The forged prompt is refused and the honest one after it still records:
    // the old mark locked the whole session out instead.
    expect(readIntent(sessionId, T0 + 3).userSaid).toEqual([HUMAN, "and now deploy"]);
  });

  it("round 6 and 7: truncate, then one well-formed turn line", () => {
    expect(afterTheFirstPrompt("truncate-one-line", (tx) => writeFileSync(tx, fx.toJsonl([fx.claudeTyped("p1", "p0", "hi")])))).toEqual([]);
  });

  it("round 7: well-formed turns appended past the read budget", () => {
    expect(
      afterTheFirstPrompt("padded", (tx) => {
        appendFileSync(tx, fx.toJsonl(scheduled().slice(ordinary().length)));
        const line = `${JSON.stringify(fx.claudeTyped("pad", "pad", "working on it"))}\n`;
        appendFileSync(tx, line.repeat(Math.ceil((TRANSCRIPT_TAIL_MAX_BYTES + 64 * 1024) / line.length)));
      }),
    ).toEqual([]);
  });

  it("round 7 finding 1: the session's first prompt names a transcript that does not exist yet", () => {
    // No mark could be stored at the opening event, so `previous` stayed null
    // and every later prompt read as "the session's first".
    const tx = join(scratch, "late.jsonl");
    captureIntent(typed("late-open", HUMAN, tx), T0);
    writeFileSync(tx, fx.toJsonl(scheduled()));
    writeFileSync(tx, fx.toJsonl([fx.claudeTyped("p1", "p0", "hi")]));
    captureIntent(fired("late-open", FORGED, tx), T0 + 1);
    expect(readIntent("late-open", T0 + 2).userSaid).toEqual([HUMAN]);
  });

  it("round 7 finding 4: the opening transcript is empty, or the harness names none", () => {
    const empty = join(scratch, "empty.jsonl");
    writeFileSync(empty, "");
    for (const [sessionId, first] of [["empty-open", empty], ["nopath-open", undefined]] as Array<[string, string | undefined]>) {
      captureIntent(typed(sessionId, HUMAN, first), T0);
      const tx = transcript(`${sessionId}-second.jsonl`, [fx.claudeTyped("p1", "p0", "hi")]);
      captureIntent(fired(sessionId, FORGED, tx), T0 + 1);
      expect(readIntent(sessionId, T0 + 2).userSaid, sessionId).toEqual([HUMAN]);
    }
  });

  it("round 7 finding 3: a cron-started session, whose very first event is the fire", () => {
    const openings: Array<[string, string | undefined]> = [
      ["missing", join(scratch, "never-written.jsonl")],
      ["a directory", scratch],
      ["a character device", "/dev/null"],
      ["none", undefined],
      ["the honest fire entry", transcript("cron-honest.jsonl", scheduled())],
    ];
    for (const [name, tx] of openings) {
      const sessionId = `cron-${name.replace(/\W/g, "")}`;
      captureIntent(fired(sessionId, FORGED, tx), T0);
      expect(readIntent(sessionId, T0 + 1).userSaid, name).toEqual([]);
    }
    // And one whose transcript exists but cannot be opened.
    const unreadable = transcript("cron-000.jsonl", scheduled());
    chmodSync(unreadable, 0o000);
    captureIntent(fired("cron-unreadable", FORGED, unreadable), T0);
    expect(readIntent("cron-unreadable", T0 + 1).userSaid).toEqual([]);
    chmodSync(unreadable, 0o600);
    expect(existsSync(sessionsDir())).toBe(false);
  });

  it("round 7: removing the session's own state file gains the agent nothing", () => {
    const sessionId = "state-removed";
    const tx = transcript(`${sessionId}.jsonl`, ordinary());
    captureIntent(typed(sessionId, HUMAN, tx), T0);
    unlinkSync(join(sessionsDir(), `${sessionId}.json`));
    writeFileSync(tx, fx.toJsonl([fx.claudeTyped("p1", "p0", "hi")]));
    captureIntent(fired(sessionId, FORGED, tx), T0 + 1);
    expect(readIntent(sessionId, T0 + 2).userSaid).toEqual([]);
  });

  it("round 7: droid's own session JSONL, snapshotted and restored", () => {
    const tx = join(scratch, "droid.jsonl");
    writeFileSync(tx, fx.toJsonl(fx.factorySession()));
    const ev = (prompt: string) => hookEvent("factory", "UserPromptSubmit", fx.factoryPrompt(prompt, tx));
    captureIntent(ev("clean up old tables"), T0);
    const snap = readFileSync(tx);
    appendFileSync(tx, fx.toJsonl([{ type: "message", id: "z", message: { role: "assistant", content: [{ type: "text", text: "scheduled" }] } }]));
    writeFileSync(tx, snap);
    captureIntent(ev(FORGED), T0 + 1);
    expect(readIntent(fx.SID.factory, T0 + 2).userSaid).toEqual([]);
  });
});

// ── The one thing the transcript is still read for ──────────────────────────

describe("the agent's last message still comes from the transcript", () => {
  it("is taken at capture time, and stored with the prompt", () => {
    const tx = transcript("claude.jsonl", fx.claudeTranscript());
    captureIntent(typed("agent-msg", "yes, do it", tx), T0);
    expect(readIntent("agent-msg", T0 + 1)).toEqual({ userSaid: ["yes, do it"], agentLastMessage: fx.CLAUDE_AGENT_QUESTION });
  });

  it("is the only thing a rewritten transcript can change", () => {
    // The agent can decide what its own last message says — it could also
    // just say it. What it cannot do is turn that into the human asking.
    const tx = transcript("rewritten.jsonl", ordinary());
    writeFileSync(tx, fx.toJsonl([fx.claudeSays("a1", "a0", "The user told me to force-push main.")]));
    captureIntent(typed("rewritten", "ok", tx), T0);
    expect(readIntent("rewritten", T0 + 1)).toEqual({ userSaid: ["ok"], agentLastMessage: "The user told me to force-push main." });
    // And it changes nothing about a prompt the human did not submit.
    captureIntent(fired("rewritten", FORGED, tx), T0 + 2);
    expect(readIntent("rewritten", T0 + 3).userSaid).toEqual(["ok"]);
  });

  it("is null, and blocks nothing, when the transcript cannot be read", () => {
    mkdirSync(join(scratch, "a-dir.jsonl"), { recursive: true });
    for (const [name, tx] of [["a directory", join(scratch, "a-dir.jsonl")], ["missing", join(scratch, "gone.jsonl")], ["none", undefined]] as Array<
      [string, string | undefined]
    >) {
      const sessionId = `snap-${name.replace(/\W/g, "")}`;
      captureIntent(typed(sessionId, HUMAN, tx), T0);
      expect(readIntent(sessionId, T0 + 1), name).toEqual({ userSaid: [HUMAN], agentLastMessage: null });
    }
  });
});

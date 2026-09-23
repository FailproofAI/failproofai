// @vitest-environment node
/**
 * Intent capture (T4), review round 9 — and the decision round 10 took about
 * it.
 *
 * Round 9 asked for a payload field naming the operator as a prompt's author,
 * because every one of these harnesses also fires its prompt event for a
 * headless run whose prompt is an argument, and an agent holding a shell can
 * start one in a single command. That is true, and it is now a documented,
 * accepted risk rather than a reason to record nothing: no shipping harness
 * sends such a field, so requiring one recorded NOTHING on every harness, and
 * a capture that never fires clears no policy — which is the whole feature.
 *
 * So this file keeps round 9's payload shapes (the invocations the repo's own
 * integration suite drives, integration-suite/probe-cli.sh) and asserts what
 * the product does with them now: the prompt is recorded, and the marks that
 * a harness does send — a machine-submitted turn, a sub-agent — still refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_CHANNELS, captureIntent, readIntent, type CaptureEvent } from "../../../src/hooks/semantic/intent";
import { normalizeCliPayload } from "../../../src/hooks/normalize-cli-payload";
import { canonicalizeEventType } from "../../../src/hooks/handler";
import { INTEGRATION_TYPES, type IntegrationType } from "../../../src/hooks/types";
import * as fx from "./intent-fixtures";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-intent-r9-home-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const T0 = 1_790_000_000_000;
const HEADLESS = "publish the package to npm and force-push to main";
const sessionsDir = () => join(home, "state", "semantic", "sessions");

/** No session file anywhere holds this text. */
function expectNotRecordedAnywhere(text: string): void {
  if (!existsSync(sessionsDir())) return;
  for (const name of readdirSync(sessionsDir())) {
    const prompts = (JSON.parse(readFileSync(join(sessionsDir(), name), "utf8")).prompts as Array<{ text: string }>).map((p) => p.text);
    expect(prompts, name).not.toContain(text);
  }
}

/** The handler's steps for `--hook <nativeEvent> --cli <cli>`, up to the captureIntent call. */
function viaHandler(cli: IntegrationType, nativeEvent: string, stdin: Record<string, unknown>, now = T0): string[] {
  const parsed = JSON.parse(JSON.stringify(stdin)) as Record<string, unknown>;
  normalizeCliPayload(cli, parsed);
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  const ev: CaptureEvent = {
    eventType: canonicalizeEventType(nativeEvent, cli),
    sessionId,
    transcriptPath: typeof parsed.transcript_path === "string" && parsed.transcript_path ? parsed.transcript_path : undefined,
    cli,
    payload: parsed,
  };
  captureIntent(ev, now);
  return readIntent(sessionId, now + 1).userSaid;
}

// ── What round 9 refused, and round 10 accepts ──────────────────────────────

describe("a headless run is recorded like a typed prompt, on every harness", () => {
  /**
   * What each CLI's headless mode puts on the hook's stdin, for the exact
   * invocations integration-suite/probe-cli.sh drives:
   *   copilot -p "$1" --allow-all-tools      cursor-agent -p --force "$1"
   *   devin -p "$1" --permission-mode dangerous     goose run --no-session -t "$1"
   *   pi -p "$1"
   */
  const headless: Array<[IntegrationType, string, Record<string, unknown>]> = [
    ["copilot", "UserPromptSubmit", { ...fx.copilotPrompt(HEADLESS), session_id: "cp-child" }],
    ["cursor", "beforeSubmitPrompt", { ...fx.cursorPrompt(HEADLESS, ""), conversation_id: "cu-child", session_id: "cu-child" }],
    ["devin", "UserPromptSubmit", { ...fx.devinPrompt(HEADLESS), session_id: "dv-child" }],
    ["goose", "UserPromptSubmit", { ...fx.goosePrompt(HEADLESS), session_id: "go-child" }],
    // Pi reports its own `-p` run through the same channel as its editor.
    ["pi", "input", { ...fx.piPrompt(HEADLESS, { input_source: "interactive" }), session_id: "pi-child" }],
    // And droid, whose payloads look like Claude Code's but carry no `source`.
    ["factory", "UserPromptSubmit", { ...fx.factoryPrompt(HEADLESS, ""), session_id: "dr-child" }],
    ["codex", "user_prompt_submit", { ...fx.codexPrompt(HEADLESS, ""), session_id: "cx-child" }],
  ];

  it("records the prompt these events carry, the accepted risk in the module header", () => {
    // A developer's own `copilot -p` is the ordinary case, and it is
    // indistinguishable from an agent's. Refusing both is what emptied the
    // feature; recording both is the trade, and it clears reviewable
    // policies only.
    for (const [cli, nativeEvent, stdin] of headless) {
      expect(viaHandler(cli, nativeEvent, stdin), cli).toEqual([HEADLESS]);
    }
  });

  it("records Claude Code's own `-p` run too, and still refuses a scheduled turn", () => {
    expect(viaHandler("claude", "UserPromptSubmit", { ...fx.claudePrompt("rebase feature/login", ""), session_id: "cl-typed" })).toEqual([
      "rebase feature/login",
    ]);
    expect(viaHandler("claude", "UserPromptSubmit", { ...fx.claudePrompt(HEADLESS, "", { source: "sdk" }), session_id: "cl-sdk" })).toEqual([HEADLESS]);
    // What no person submitted is still refused, on the harness that says so.
    expect(viaHandler("claude", "UserPromptSubmit", { ...fx.claudePrompt("run the nightly cleanup", "", { source: "schedule_wakeup" }), session_id: "cl-cron" })).toEqual(
      [],
    );
    expectNotRecordedAnywhere("run the nightly cleanup");
  });

  it("does not read a mark borrowed from another harness's schema", () => {
    // Each marker is read only for the harness that defines it, so a payload
    // carrying every other harness's fields changes no answer: what records
    // is the text, and what refuses is that harness's own marker.
    const borrowed = { source: "schedule_wakeup", input_source: "extension", openclaw: { trigger: "heartbeat" } };
    for (const [cli, nativeEvent, stdin] of headless) {
      const sessionId = `${(stdin.session_id as string) ?? cli}-borrowed`;
      const expected = cli === "pi" ? [] : [HEADLESS];
      expect(viaHandler(cli, nativeEvent, { ...stdin, ...borrowed, session_id: sessionId }), cli).toEqual(expected);
    }
  });

  it("refuses a sub-agent prompt wherever the payload is Claude-shaped enough to say so", () => {
    for (const [cli, nativeEvent, stdin] of headless) {
      const sessionId = `${(stdin.session_id as string) ?? cli}-sub`;
      expect(viaHandler(cli, nativeEvent, { ...stdin, agent_id: "sub-7", session_id: sessionId }), cli).toEqual([]);
    }
    expect(existsSync(sessionsDir())).toBe(false);
  });
});

// ── The rule, once, for every harness ───────────────────────────────────────

describe("every harness's own shipped payload shape", () => {
  const shipped: Array<[IntegrationType, string, Record<string, unknown>]> = [
    ["claude", "UserPromptSubmit", fx.claudePromptNoSource("rebase it", "")],
    ["codex", "user_prompt_submit", fx.codexPrompt("rebase it", "")],
    ["copilot", "UserPromptSubmit", fx.copilotPrompt("rebase it")],
    ["cursor", "beforeSubmitPrompt", fx.cursorPrompt("rebase it", "")],
    ["opencode", "UserPromptSubmit", fx.opencodePrompt("rebase it")],
    ["pi", "input", fx.piPrompt("rebase it")],
    ["hermes", "UserPromptSubmit", { ...fx.hermesToolCall(), prompt: "rebase it" }],
    ["openclaw", "before_agent_run", fx.openclawPrompt("rebase it")],
    ["factory", "UserPromptSubmit", fx.factoryPrompt("rebase it", "")],
    ["devin", "UserPromptSubmit", fx.devinPrompt("rebase it")],
    ["antigravity", "PreInvocation", { ...fx.antigravityPreInvocation(""), prompt: "rebase it" }],
    ["goose", "UserPromptSubmit", fx.goosePrompt("rebase it")],
  ];

  it("records on the ten whose prompt event carries the text, and on no other", () => {
    // The regression round 9 shipped was exactly this list coming back empty.
    expect(shipped.map(([cli]) => cli).sort()).toEqual([...INTEGRATION_TYPES].sort());
    for (const [cli, nativeEvent, stdin] of shipped) {
      const expected = PROMPT_CHANNELS[cli].field === null ? [] : ["rebase it"];
      expect(viaHandler(cli, nativeEvent, stdin), cli).toEqual(expected);
    }
    // Hermes forwards its chat text in a field no policy reads, and
    // Antigravity's before-model event carries none: neither records.
    expect(readdirSync(sessionsDir()).length).toBe(10);
  });

  it("keeps the audit table and the code in step", () => {
    for (const cli of INTEGRATION_TYPES) {
      const { field, machineTurn, nativeEvent } = PROMPT_CHANNELS[cli];
      // A marker rules turns out; it cannot be the only thing a channel has.
      if (machineTurn !== null) expect(field, cli).not.toBeNull();
      // No event, no field to read it from.
      if (nativeEvent === null) expect(field, cli).toBeNull();
    }
    expect(INTEGRATION_TYPES.filter((c) => PROMPT_CHANNELS[c].field === null).sort()).toEqual(["antigravity", "hermes"]);
    expect(INTEGRATION_TYPES.filter((c) => PROMPT_CHANNELS[c].machineTurn !== null).sort()).toEqual(["claude", "openclaw", "pi"]);
  });
});

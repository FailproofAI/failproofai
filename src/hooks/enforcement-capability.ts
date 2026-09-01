/**
 * Does a policy DENY on this (cli, event) pair actually change the agent's
 * behaviour, given the wire shape failproofai emits TODAY?
 *
 * This exists because the same claim used to live in prose, and prose drifted:
 * CLAUDE.md documented Hermes `subagent_stop` as a working gate while upstream
 * discarded its return, so every customer policy on that event enforced
 * nothing, silently, for months. A table a test can assert against cannot rot
 * that way.
 *
 * ABSENT MEANS UNKNOWN, NOT "block". Only rows traced to a consuming call site,
 * an official contract, or a recorded live probe appear here. Callers must
 * treat a missing entry as "say nothing" — a hedge rendered in the UI is still
 * a claim, and an unverified claim is what this file exists to prevent.
 */
// src/hooks/enforcement-capability.ts
//
// Does a policy DENY on this (cli, event) pair actually change the agent's
// behaviour, given the wire shape failproofai emits TODAY?
//
//   "block"   — the verdict is read at a call site that prevents the action
//               or forces the agent to continue/retry.
//   "observe" — the action proceeds regardless. Either the CLI discards the
//               verdict, or the tool already ran, or the CLI *could* block but
//               our shape is inert (each such line says so).
//   ABSENT    — NOT VERIFIED. The UI must stay silent, never assume "block".
//
// Only SOURCE / VENDOR_DOCS / LIVE_PROBE rows appear here. Every line carries
// its evidence. Versions probed: claude 2.1.220 · codex fe01054a (PostToolUse
// re-probed LIVE at 0.147.0) · copilot 1.0.71, some sites re-read in 1.0.68
// (PostToolUse re-read in the shipped 1.0.78 bundle) · cursor-agent
// 2026.07.16-899851b · opencode 7565e035 (v1.18.9, re-checked at v1.14.33) ·
// pi 0.80.10 (source 0.82.1) · hermes-agent 5771a6e · openclaw f8ed8ecf
// (v2026.7.2) · droid 0.175.1 · devin 3000.2.17 · agy 1.1.8 · goose 1.43.0.
//
// A VERSION HERE IS PART OF THE CLAIM, NOT A FOOTNOTE. Re-probing codex for the
// PostToolUse row surfaced that its hook sources were restructured after
// fe01054a — output_parser.rs, hook_runtime.rs and tools/registry.rs, cited by
// name and line in several codex rows below, no longer exist at those paths in
// 0.147.0. Those rows are not known-wrong, they are unverified against any
// shipping codex; treat them as due for a re-probe rather than as evidence.
import type { HookEventType, IntegrationType } from "./types";

export type EnforcementCapability = "block" | "observe";

export const ENFORCEMENT_CAPABILITY: Record<
  IntegrationType,
  Partial<Record<HookEventType, EnforcementCapability>>
> = {
  // ── claude ────────────────────────────────────────────────────────────────
  // Closed source, but the shipped launcher embeds its minified JS as plaintext.
  // Offsets are BYTE offsets into the shipped claude 2.1.220 launcher bundle.
  // The hook RUNNER is event-agnostic (exit 2 -> blockingError @259223339); all
  // asymmetry lives in the ~29 call sites that read or ignore it.
  claude: {
    PreToolUse: "block",           // @256826565 gan() -> behavior==="deny" short-circuits the permission pipeline; tool.call never reached (@256827907)
    UserPromptSubmit: "block",     // @262298150 blockingError -> {shouldQuery:false} early return; prompt never sent to the model
    PermissionRequest: "block",    // @255767400 runHooks reads permissionRequestResult -> buildDeny. NOTE exit 2 is IGNORED here (docs are wrong); we emit hookSpecificOutput.decision.behavior:"deny" which IS the honoured shape — do not "simplify" to exit 2
    Stop: "block",                 // @254572503 blockingErrors -> stopHookActive + `continue` re-enters the loop. CAP: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (default 8); discarded on end-turn paths (@254511900)
    SubagentStop: "block",         // @259180818 VEe emits SubagentStop when agentId set -> same consumer @254572503. Same cap + same end-turn discard
    PreCompact: "block",           // MEe @259170280 blockedBy -> consumers @254317851 / @254328121 return early; compaction does not run
    PostToolBatch: "block",        // @254577316 -> yields hook_stopped_continuation and RETURNS from the query generator. Tools in the batch already ran
    ConfigChange: "block",         // slt @259171700 -> consumer @251465990 skips the reload. CAVEAT: source==="policy_settings" is force-unblocked (MDM immune)
    UserPromptExpansion: "block",  // producer @254678081, real consumer @254672418 `if("blocked" in C) return C.blocked`. Slash-command / MCP-prompt only
    TaskCreated: "block",          // TaskCreate.call @256302400: blockingError -> task deleted (yAo) + tool throws
    TaskCompleted: "block",        // @254518449 -> same honoured consumer @254572503. GATE: teammate mode only (oy() @249372028)
    TeammateIdle: "block",         // @254518714 -> same consumer @254572503. Same teammate-mode gate
    Elicitation: "block",          // oOt @259172011 -> $_o @253296308 -> MCP handler U_y @253294456 returns {action:"decline"} to the server
    ElicitationResult: "block",    // iOt @259172485 -> N_o @253296535 / Zbo @253568095 force {action:"decline"}. Vetoes the response, does NOT stop the agent
    PostToolUse: "observe",        // OVERTURNED from "block". We emit hookSpecificOutput.additionalContext (policy-evaluator.ts:520-534) -> man's additionalContexts branch @256141810, never blockingError; and the tool already ran either way
    PostToolUseFailure: "observe", // OVERTURNED. han @256143680 yields only cancelled / blocking_error / additional_context; consumer @256840799 just appends messages after the failed tool result. No stop channel exists
    SessionStart: "observe",       // @254090768 blockingError -> Pur() = hook_non_blocking_error; session proceeds. Only additionalContext has effect
    Setup: "observe",              // @254092164 -> same Pur() downgrade
    SubagentStart: "observe",      // @254689000 -> same Pur() downgrade; the subagent launches anyway
    SessionEnd: "observe",         // TFt @259174994 reads only !succeeded -> stderr passthrough; `blocked` never read
    StopFailure: "observe",        // zpt @~259180670 discards the EM() return entirely. Docs concur: "output and exit code are ignored"
    PermissionDenied: "observe",   // @256829448 reads ONLY hookSpecificOutput.retry; also fires only for classifier==="auto-mode"
    Notification: "observe",       // h9 @259174090 — return value not assigned
    InstructionsLoaded: "observe", // nPt @259173437 — return value not assigned
    CwdChanged: "observe",         // vtn @259173188 -> zop @259172968 reads only watchPaths/systemMessage
    FileChanged: "observe",        // Atn @259173298 -> same zop consumer
    PostCompact: "observe",        // xpt @259170833 builds a display message; `blocked` never read (contrast MEe/PreCompact directly above it)
    WorktreeRemove: "observe",     // Zor @259183361 only records whether some hook succeeded; a deny just logs
    // WorktreeCreate DELIBERATELY OMITTED: ODt @259182432 is a path PROVIDER, not
    // a gate — with no stdout it throws "hook succeeded but returned no worktree
    // path", so an ALLOW aborts creation exactly like a deny. Degenerate, not a
    // capability. Fix the bug (emit a path on allow) before classifying it.
  },

  // ── codex ─────────────────────────────────────────────────────────────────
  // openai/codex @fe01054a. Every verdict funnels through codex-rs/core/src/hook_runtime.rs.
  codex: {
    PreToolUse: "block",           // tools/registry.rs:528 PreToolUseHookResult::Blocked -> FunctionCallError::RespondToModel; handler never runs. CAVEAT hook_runtime.rs:202 an empty reason silently degrades to Continue
    PermissionRequest: "block",    // tools/approvals.rs:220 Deny -> ReviewDecision::denied. CAVEAT only consulted when the call reaches the approval path (orchestrator.rs:168 Skip bypasses it)
    UserPromptSubmit: "block",     // events/user_prompt_submit.rs:226 Some(2)+stderr -> should_stop; turn.rs:588 skips record_pending_input, turn.rs:237 returns. CAVEAT turn.rs:603 — a co-submitted accepted message lets the turn proceed
    Stop: "block",                 // events/stop.rs:303 Some(2) -> should_block + continuation_prompt; turn.rs:473-489 records it and `continue`s. CAVEAT turn.rs:490 a block with no prompt is warned + ignored
    SubagentStop: "block",         // shared parse_completed (stop.rs:202) + same consumer turn.rs:473. CAVEAT hook_runtime.rs:345 — only ThreadSpawn subagents dispatch it; all other SubAgent sources never run the hook
    PostToolUse: "block",          // FIXED: we now emit top-level {decision:"block",reason}. LIVE_PROBE codex 0.147.0 A/B (identical prompt+hook, only the shape differs): block shape -> `hook: PostToolUse Blocked` + codex_core::tools::router error=<reason>, and the reason REPLACES the tool result (the model never saw the real stdout); hookSpecificOutput -> `hook: PostToolUse Completed`, model read stdout verbatim. Result-replacement, not prevention — the tool already ran. NOTE the other codex rows below cite output_parser.rs / hook_runtime.rs / tools/registry.rs paths that DO NOT EXIST in 0.147.0 (hooks live at hooks/src/{engine,events}/…); they are unre-verified since fe01054a
    SessionStart: "observe",       // events/session_start.rs:243-322 has NO Some(2) arm — our exit-2 deny is logged as HookRunStatus::Failed. CLI blocks only on exit 0 + {"continue":false} (session_start.rs:273 -> turn.rs:233)
    SubagentStart: "observe",      // permanently unblockable: session_start.rs:273 guard excludes it, output schema has no `decision`, vendor doc says continue:false does not stop it
    PreCompact: "observe",         // compact.rs:246-260 no Some(2) arm; latent block needs {"continue":false} (-> core/src/compact.rs:190 TurnAborted). Inert as we emit
    PostCompact: "observe",        // compact.rs:349-363 same structure; latent block needs {"continue":false} (-> compact.rs:216). Inert as we emit
  },

  // ── copilot ───────────────────────────────────────────────────────────────
  // Closed source; vendor build ships readable JS. Offsets are BYTE offsets into
  // the @github/copilot-linux-x64 app.js (c71/ = 1.0.71, copilot/ = 1.0.68).
  // CRITICAL: exit 2 is NEVER a deny channel on copilot, for any event
  // (runtime.node@60056587 "Hook command exited with code 2 (warning)").
  copilot: {
    PreToolUse: "block",           // 1.0.68 app.js@2878277 permissionDecision==="deny" -> resultType:"denied"; 1.0.71 moved to Rust, runtime.node@60059067 "Denied by preToolUse hook". Corroborated LIVE on 1.0.71 (session events success:false code:denied) + daily integration-suite probe
    Stop: "block",                 // 1.0.71 app.js@2855430 agentStop: decision==="block" && string reason -> enqueueUserMessage(reason). We emit exactly that shape
    SubagentStop: "block",         // 1.0.71 app.js@1074101 subagentStop: decision==="block" && reason -> `continue` re-runs the subagent turn. CAVEAT skipped entirely for isSidekick subagents
    UserPromptSubmit: "block",     // FIXED: we now emit {decision:"block",reason} at exit 0 (gate V$t @2547438, consumer @2823018). Was inert — we sent exit 2 + stderr, which copilot logs as a warning for EVERY event and never treats as a deny
    PermissionRequest: "block",    // FIXED: we now emit the FLAT {behavior,message} copilot parses (normalizer CMn @179042 -> mapper h4t @2686538). Was inert — the Codex-shaped nested hookSpecificOutput.decision normalized to {}
    PostToolUse: "block",          // FIXED: we now emit top-level {decision:"block",reason}. Re-read in the SHIPPED 1.0.78 app.js: BOTH postToolUse call sites gate on vK = t => t?.decision==="block" && typeof t.reason==="string" -> "Tool result blocked by {policy hook|hook}" / `Tool result blocked: ${reason}`. vK fails closed on a missing or non-string reason. Result-rewrite, not prevention — the tool already ran (vendor docs still say "Can block? No", which is true of the SIDE EFFECT, not of the result the model reads)
    SessionStart: "observe",       // 1.0.71 app.js@2836633 reads ONLY additionalContext
    SessionEnd: "observe",         // 1.0.71 app.js@2627263 `.then(()=>{})` — return explicitly thrown away
    PostToolUseFailure: "observe", // 1.0.68 app.js@2883424 and @3038111 destructure only additionalContext
    PreCompact: "observe",         // 1.0.71 app.js@2758186 and @2852753 — result unassigned at both call sites
    Notification: "observe",       // 1.0.71 app.js@2746820 reads only additionalContext
    // ErrorOccurred is installed but has no canonical HookEventType, so it
    // cannot be keyed here. It is observe: 1.0.71 app.js@2846297, result unassigned.
  },

  // ── cursor ────────────────────────────────────────────────────────────────
  // Closed source; local install ships webpack-minified JS. Offsets are CHAR
  // offsets into the shipped cursor-agent 2026.07.16-899851b bundle.
  cursor: {
    PreToolUse: "block",           // 3143.index.js char 26967 permission==="deny" -> {type:"rejected"}; second MCP consumer char 42084
    Stop: "block",                 // 1931.index.js char 881820 followup_message queued as the next user message. CAPS: loop_limit default 5 (index.js char 4123300); consumed ONLY on the status:"completed" path — user-abort (char 870298) and turn-error (char 883549) discard it
    UserPromptSubmit: "block",     // FIXED: we now emit {continue:false,user_message} (1931.index.js char 887883 — the only block key). Was inert: {permission:"deny"} validates as an unknown-key object and is dropped on this event
    PostToolUse: "observe",        // 3143.index.js char 26339 fireSuccessAsync reads only additional_context; validator accepts nothing else (index.js char 4126700)
    SessionStart: "observe",       // 1931.index.js char 731566 consumes only env + additional_context; `continue` never read even though Cursor's own q() builds it
    SessionEnd: "observe",         // 1931.index.js char 724540 — result assigned to nothing
    // SubagentStop OMITTED: producer exists (index.js char 3769676 forwards
    // followupMessage) and vendor docs describe loop-style follow-ups, but no
    // code in the shipped install ever CONSTRUCTS a subagentStop request, so
    // the consumer is outside the bundle. unknown.
  },

  // ── opencode ──────────────────────────────────────────────────────────────
  // sst/opencode @7565e035 (v1.18.9); every finding re-checked at tag v1.14.33.
  opencode: {
    PreToolUse: "block",           // session/tools.ts:106-110 trigger runs BEFORE item.execute (:111) inside run.promise; a throw is an Effect defect that kills the fiber. Upstream test test/tool/code-mode.test.ts:428 proves the tool body never executed
    PostToolUse: "observe",        // session/tools.ts:121-125 sits after item.execute; a throw replaces the output with a tool-error the model sees, but the write/command already happened
    SessionStart: "observe",       // plugin/index.ts:255 `void hook["event"]?.(…)` — fire-and-forget, return structurally unreadable
    SessionEnd: "observe",         // plugin/index.ts:255 — same void dispatch
    UserPromptSubmit: "observe",   // plugin/index.ts:255 same void dispatch; and message.updated is published from session.ts:631 AFTER the message is persisted. The real gate is chat.message, which we do not install (§4)
    PermissionRequest: "observe",  // ☠ DEAD HOOK: permission.ask is DECLARED (packages/plugin/src/index.ts:261) and documented upstream, but NEVER INVOKED — the only two dispatch sites are hook["event"] (:255) and Plugin.trigger (:288), and permission.ask is not among the 13 names passed to .trigger(). The policy does not even run. See §5.3 for the copy hazard
    // Stop OMITTED: session.idle's plugin return is definitively discarded
    // (plugin/index.ts:255), so we instead call client.session.prompt(...)
    // out-of-band (integrations.ts:886-897). That SDK route does start a fresh
    // turn, but the composite (alive at idle? one-shot `opencode run`?) is
    // unverified end to end. unknown.
  },

  // ── pi ────────────────────────────────────────────────────────────────────
  // @earendil-works/pi-coding-agent 0.80.10 installed (d.ts read directly);
  // source cross-read at repo cced6a2 (0.82.1). Identical result shapes.
  pi: {
    PreToolUse: "block",           // tool_call: ToolCallEventResult{block,reason} (types.d.ts:766) -> runner.emitToolCall returns on result.block -> agent-loop.ts:626 `if(beforeResult?.block) return createErrorToolResult(...)`; tool never executes. user_bash also maps here and is now FIXED too: the shim returns a full-replacement {result:BashResult} (types.d.ts:772) so the command is not run — {block,reason} had no matching field
    UserPromptSubmit: "block",     // FIXED: the shim now returns {action:"handled"} (InputEventResult, types.d.ts:629) so the prompt is never submitted. Was inert — {block,reason} matched no branch. CAVEAT: `handled` drops the prompt SILENTLY; Pi shows the user nothing, so the shim logs the reason to stderr
    PostToolUse: "observe",        // tool_result: ToolResultEventResult{content,details,isError,usage} (types.d.ts:778) — no block field; mutation only
    SessionStart: "observe",       // on(event:"session_start", ExtensionHandler<SessionStartEvent>) — NO Result type param (types.d.ts:842); runner.emit() only consumes returns for session_before_* (runner.ts:787-813)
    SessionEnd: "observe",         // session_shutdown: same — handler declared with no Result type (types.d.ts:848)
    Stop: "observe",               // agent_end: handler has NO Result type (types.d.ts:857) — the turn cannot be retried. Our shim stashes the reason and injects it into the NEXT turn via before_agent_start.systemPrompt (index.ts:458). Real, but it is a next-turn instruction, not a gate
  },

  // ── hermes ────────────────────────────────────────────────────────────────
  // hermes-agent @5771a6e. agent/shell_hooks.py _parse_response is EVENT-GATED:
  // it returns a verdict only for pre_tool_call and pre_verify.
  hermes: {
    PreToolUse: "block",           // pre_tool_call — the only tool gate; the tool does not run
    PostToolUse: "observe",        // post_tool_call — not in _parse_response's gate
    SubagentStop: "observe",       // OVERTURNED from CLAUDE.md's "✅ block". Not in _parse_response's gate, AND the call site (tools/delegate_tool.py) discards the return. Customers with a SubagentStop deny had ZERO enforcement
    SessionStart: "observe",       // on_session_start — not gated in
    SessionEnd: "observe",         // on_session_end — call site discards the return
    // Stop: NOT KEYED — `pre_verify` is a real turn-end gate upstream but we do
    // not install it, so no canonical Stop event ever fires for hermes.
  },

  // ── openclaw ──────────────────────────────────────────────────────────────
  // openclaw/openclaw @f8ed8ecf (v2026.7.2) + our own shipped shim
  // openclaw-plugin/index.js, which returns undefined for 5 of the 8 hooks.
  openclaw: {
    PreToolUse: "block",           // before_tool_call -> shim returns {block:true, blockReason}
    UserPromptSubmit: "block",     // before_agent_run -> shim returns {outcome:"block", reason}
    Stop: "block",                 // before_agent_finalize -> shim returns {action:"revise", reason}; the turn re-runs
    PostToolUse: "observe",        // void upstream AND our shim returns undefined
    SessionStart: "observe",       // void upstream AND our shim returns undefined
    SessionEnd: "observe",         // void upstream AND our shim returns undefined
    SubagentStop: "observe",       // subagent_ended cannot veto upstream; our shim also returns undefined
    PreCompact: "observe",         // before_compaction — same
  },

  // ── factory (droid) ───────────────────────────────────────────────────────
  // droid 0.175.1 (the shipped droid binary, ELF not stripped, embedded JS readable).
  // Anchors below are unique grep-able strings in that bundle.
  factory: {
    PreToolUse: "block",           // grep `throwing ToolExecutionControlError`: exit 2 -> throw $SH(stderr); also hookSpecificOutput.permissionDecision==="deny" -> throw $SH, continue===false -> throw LSH, exit 3 -> AgentAbortError. We emit exit 2 + stderr
    UserPromptSubmit: "block",     // executeUserPromptSubmitHooks: `if(B.exitCode===2||B.continue===!1){ … return {prompt,hookContext,blocked:!0} }` — the turn never starts
    Stop: "block",                 // grep `[Agent] Stop hook blocking with decision: block`: {decision:"block",reason} sets the continue flag; grep `[Agent] Stop hook blocking with exit code 2` shows exit 2 is a FALLBACK too (CLAUDE.md says otherwise — harmless, we emit the JSON)
    PreCompact: "block",           // grep `[Compaction] PreCompact hook blocked compaction`: exit 2 or 3 -> returns the uncompacted conversation
    PostToolUse: "observe",        // exit 2 -> ADD_MESSAGE(role:"system", visibility:"llm_only") with the postToolUseFeedbackPrefix — feedback, not a block; tool already ran. (continue===false / exit 3 WOULD stop, but we emit neither)
    SubagentStop: "observe",       // `await MR("SubagentStop",{…})` — the awaited result is not assigned to anything. Hermes-class: our SubagentStop deny is discarded
    SessionStart: "observe",       // applySessionStartHookResults consumes only the env file + additionalContext; `if(L.exitCode!==0) TH("[Session] SessionStart hook failed")` just logs
    SessionEnd: "observe",         // executeSessionEndHooks: `for(let r of n) if(r.exitCode!==0) TH("[Session] SessionEnd hook failed")` — logs only
    Notification: "observe",       // `await MR("Notification",{…})` — return unassigned
  },

  // ── devin ─────────────────────────────────────────────────────────────────
  // devin 3000.2.17 is a STRIPPED Rust ELF — no readable call sites. Tier is
  // LIVE_PROBE: 11 recorded runs against the real binary with an isolated
  // --config, each verified by side effect (marker file) AND by absence of the
  // reason in ~/.local/share/devin/cli/{transcripts,sessions.db}.
  devin: {
    PreToolUse: "block",           // probe L9: "Error: A tool was rejected by the user", RAN_MARKER absent — and it overrode --permission-mode dangerous
    UserPromptSubmit: "block",     // probe L10: "Prompt blocked: <reason>"; no PreToolUse/Stop hook fired; no model turn
    Stop: "block",                 // probe L11 + transcript orchid-pillow.json /steps/8,/steps/10: the reason is injected as a USER message and the agent takes extra turns
    PermissionRequest: "block",    // probe L17: {"decision":"block"} -> marker absent, run aborted; L16: {"decision":"approve"} flipped a rejection into an execution, proving the channel is live. ⚠⚠ CONDITIONAL — see §5.1: never fires under --permission-mode dangerous (L8) and never for auto-approved read-only tools (L18, where a secret leaked)
    PostToolUse: "observe",        // probe L12: marker created, session finished normally, reason absent from transcript AND sessions.db
    SessionStart: "observe",       // probe L13: session ran normally, reason absent from transcript and DB
    SessionEnd: "observe",         // probe L14: session ended normally, reason absent
    // Static corroboration (strings @82817071): "Ignoring pre_stop decision type:",
    // "Ignoring permission decision type:", "Blocked by hook", "Denied by hook",
    // "Prevented by hook" — agent-ext/src/hooks/event_handler.rs.
  },

  // ── antigravity (agy) ─────────────────────────────────────────────────────
  // agy 1.1.8. Two independent kinds of evidence: live probes, plus the
  // embedded FileDescriptorProto (binary @80315228, exa.hooks_pb) which is
  // AUTHORITATIVE about which fields a response can even carry.
  antigravity: {
    PreToolUse: "block",           // probe [1]: `touch PROBE_RAN` never ran; agent reported the tool "blocked with … PROBE: denied". Proto: PreToolHookResult{decision, reason, allow_tool, deny_reason}
    Stop: "block",                 // probe [4]: {"decision":"continue",reason} re-entered the loop AND the agent obeyed the reason (STOP_GATE_PROOF created). Proto: StopHookResult{decision, reason}
    PostToolUse: "observe",        // probe [2]: agy logged `unknown field "decision"` (protojson unmarshal failure) 5x and continued. Proto: PostToolHookResult is an EMPTY MESSAGE — nothing is consumable
    UserPromptSubmit: "observe",   // PreInvocation. probe [3]: our {"decision":"deny"} caused `failed to call custom pre-invocation hook … unknown field "decision"`; 4 invocations ran unimpeded. Proto: PreInvocationHookResult carries ONLY inject_steps. (instruct works — probe [5] injectSteps honoured)
  },

  // ── goose ─────────────────────────────────────────────────────────────────
  // block/goose, read AT TAG v1.43.0 (the installed version) as well as HEAD
  // 0b234bdc. Two dispatchers: emit() is fire-and-forget (crates/goose/src/
  // hooks/mod.rs:295 — the return only feeds a warn! log); emit_blocking()
  // (:364) consumes exit 2 or {"decision":"block","reason"} via deny_reason(:429).
  goose: {
    PreToolUse: "block",           // v1.43.0 agent.rs:1080 emit_blocking -> HookDecision::Deny -> returns Err(ErrorData "Tool call denied by policy hook `<plugin>`: …"); the tool is never dispatched
    UserPromptSubmit: "observe",   // v1.43.0 agent.rs:1609 and :1935 use emit() — verdict discarded
    PostToolUse: "observe",        // v1.43.0 agent.rs:~593 with_post_tool_hook uses emit() — verdict discarded, and it is post-hoc
    SessionStart: "observe",       // v1.43.0 agent.rs:1595 emit_hook -> emit() — verdict discarded
    SessionEnd: "observe",         // goose-cli/src/session/mod.rs:529 and :1294 emit_hook -> emit() — verdict discarded
    // Goose HAS a blocking Stop event we do not install — see §4. CLAUDE.md and
    // the policy-evaluator comment both claim "Goose has NO Stop event"; that is
    // false at v1.43.0 (agent.rs:1956, :2840 emit_stop_hook_blocking).
  },

  // grok 1.0.3 (1a29d5bc12). Every "block" row below was proven by a live
  // probe, not read from grok's hooks doc — which is also where two of the
  // three surprises came from (see types.ts): the doc's own tool name for the
  // shell tool disagrees with the wire, and nothing documents that project
  // hooks need a git repo. grok's capability advertisement corroborates the
  // blocking set: its ACP initialize response carries
  //   x.ai/hooks: {blockingEvents:["pre_tool_use","stop","subagent_stop"],
  //                decisions:["deny","block"], stopSignals:[…]}
  // — exactly the three rows marked "block" here.
  grok: {
    PreToolUse: "block",           // VERIFIED live: {decision:"deny",reason} blocked `echo` and beat --yolo (permissionMode bypassPermissions); Claude's hookSpecificOutput shape did NOT block (A/B on the same hook)
    Stop: "block",                 // VERIFIED live: {decision:"block",reason} forced another turn — the agent ran the required command, then stopped. ONLY on reason==="end_turn"; the session-shutdown fire is parsed and discarded upstream. Cap: 8 continuations/turn
    SubagentStop: "block",         // advertised in x.ai/hooks blockingEvents; not exercised by a probe
    UserPromptSubmit: "observe",   // fired live; not in blockingEvents
    PostToolUse: "observe",        // fired live; post-hoc, and not in blockingEvents
    PostToolUseFailure: "observe",
    SessionStart: "observe",       // fired live
    SessionEnd: "observe",         // fired live
    // The six below are the widened set. All OBSERVE by construction, not by
    // caution: blockingEvents lists exactly three events, so grok cannot honour
    // a deny on any of these no matter what we send.
    StopFailure: "observe",        // VERIFIED firing (a 429 turn): {error:"rate_limit", errorDetails, lastAssistantMessage}
    Notification: "observe",       // VERIFIED firing: notificationType "agent_error" — a type grok's own docs do not list
    PermissionDenied: "observe",   // config key accepted (count=14); firing not exercised — needs a real permission denial
    SubagentStart: "observe",      // config key accepted; firing not exercised — needs a subagent
    PreCompact: "observe",         // config key accepted; firing not exercised — needs compaction
    PostCompact: "observe",        // config key accepted; firing not exercised — needs compaction
  },

  // qwen-code 0.21.12. A near-pure Claude clone on the wire, so most rows
  // inherit Claude's semantics — but only the two proven ones are "block".
  qwen: {
    PreToolUse: "block",           // VERIFIED live: hookSpecificOutput.permissionDecision:"deny" blocked run_shell_command and beat -y (yolo); reason reached the model verbatim. ("ask" degrades to deny in headless and background subagents)
    Stop: "block",                 // VERIFIED live: top-level {decision:"block",reason} forced another turn. NOTE stop_hook_active is true on the FIRST fire, so it is not a usable loop guard here
    UserPromptSubmit: "observe",   // docs accept a decision, unverified — and it fires per MODEL INVOCATION (4× in one observed turn), so treat as observation until probed
    PostToolUse: "observe",        // docs accept `decision`, unverified; post-hoc regardless
    PostToolUseFailure: "observe",
    PermissionRequest: "observe",
    PermissionDenied: "observe",
    SubagentStart: "observe",
    SubagentStop: "observe",       // sibling of Stop upstream, but not probed — left honest rather than assumed
    PreCompact: "observe",
    SessionStart: "observe",       // fired live
    SessionEnd: "observe",
    // Widened set. Every one has a real executeHooks() dispatch site in the
    // shipped bundle; the three marked VERIFIED were also observed firing.
    TaskCreated: "block",          // qwen's TodoCreated. VERIFIED firing ×4 with phase:"validation", where upstream docs state a {decision:"block"} PREVENTS the write and returns the reason to the model
    TaskCompleted: "block",        // qwen's TodoCompleted. VERIFIED firing ×4, same validation-phase contract
    InstructionsLoaded: "observe", // VERIFIED firing: {file_path, memory_type, load_reason}
    Notification: "observe",       // VERIFIED firing: notification_type "auth_success"
    StopFailure: "observe",        // upstream documents it fire-and-forget — output and exit code ignored
    PostCompact: "observe",
    UserPromptExpansion: "observe",
  },

  // ── ori ───────────────────────────────────────────────────────────────────
  // ori 0.12.0+68f9a36, probed LIVE against the built-in `@ori-runloop/
  // agent-loop` harness driving nvidia/nemotron-3.5-lightning:free. Enforcement
  // is the `approval-asker` / `unattended-approvals` extension points rather
  // than a hook-event stream, so PreToolUse is the only row there can be: ori
  // exposes no prompt-submit, post-tool, session or stop gate to subscribe to.
  ori: {
    PreToolUse: "block",           // LIVE: {outcome:"deny"} from our approval-asker provision turned 3 tool.started into 3 tool.failed with ZERO tool.succeeded, and ori held the deny across the model's retries. MODE-GATED — read the note below before quoting this row
    // DELIBERATELY NO OTHER ROWS. Two things this table cannot express, both
    // verified live and both load-bearing:
    //   1. ori's approval mode defaults to `self-drive`, and in that mode the
    //      DYNAMIC points are never called — so no deny is ever PRODUCED, and
    //      the row above never gets a chance to apply. Isolated three ways: no
    //      callback under self-drive; still none after claiming approval-policy
    //      with defaultAction:"ask"; but defaultAction:"reject" DID block every
    //      call, which proves the static point is wired and that self-drive
    //      skips specifically the dynamic asker. Coverage therefore requires
    //      `--approvals manual` (or /approvals in the TUI).
    //   2. There is no Stop event at all, so the 5 require-*-before-stop
    //      builtins are INAPPLICABLE on ori, exactly as on Hermes and Goose.
  },

  // ── cline ─────────────────────────────────────────────────────────────────
  // cline v3.0.60. Its hooks are event-NAMED scripts under a hooks directory,
  // and THE EXIT CODE IS IGNORED on every event — so every row here is a claim
  // about a stdout SHAPE, never about exit 2. cline's verdict schema has no
  // `decision` / `block` / `permissionDecision` field at all, which is why every
  // generic branch in policy-evaluator.ts is inert for it.
  cline: {
    PreToolUse: "block",  // LIVE: {"cancel":true,"errorMessage":…} on stdout stopped a real run_commands call and the side effect never happened. CAVEAT, and it is a product decision rather than a footnote: `cancel` becomes {stop:true} -> applyStopControl THROWS ControlledStopError, ABORTING THE WHOLE RUN ("[abort] aborted by another client"), not just this tool call. A STRONGER action than a per-tool deny, not a weaker one
    Stop: "observe",      // TaskComplete maps here, and `cancel` is NOT a force-retry channel: the task has already completed, so a cancel kills a finished run rather than re-entering the loop. The 5 require-*-before-stop builtins are INAPPLICABLE on cline, exactly as on Hermes, Goose and ori
    // DELIBERATELY NO OTHER ROWS. PostToolUse, UserPromptSubmit, TaskStart,
    // TaskResume, TaskCancel, TaskError and SessionShutdown ARE installed — for
    // the audit trail and for observe-mode custom policies — but nothing has
    // been probed showing a verdict on any of them changes what the agent does,
    // and ABSENT MEANS UNKNOWN in this file.
    //
    // FAIL-OPEN across the whole surface, and unlike ori there is no
    // failureBehavior:"deny" to inherit: a timeout (120s default), a parse
    // failure or a spawn error makes cline SKIP the hook and run the tool.
  },
};

/**
 * Capability for a (cli, event) pair, or `undefined` when not verified.
 *
 * Callers MUST branch on `undefined` and render nothing. Defaulting it to
 * "block" would assert protection nobody confirmed; defaulting to "observe"
 * would tell a user a working policy is inert. Silence is the only honest
 * answer for a pair we have not traced.
 */
export function enforcementFor(
  cli: IntegrationType | undefined,
  event: HookEventType | string | undefined,
): EnforcementCapability | undefined {
  if (!cli || !event) return undefined;
  const perCli = ENFORCEMENT_CAPABILITY[cli];
  if (!perCli) return undefined;
  return perCli[event as HookEventType];
}

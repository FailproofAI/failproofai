/**
 * `failproofai jev` — configure the customer's own Jev endpoint and key (BYOK),
 * the single opt-in to the two-tier hook evaluator.
 *
 *   jev setup   write ~/.failproofai/jev.json at 0600 from flags + a key
 *   jev status  what is configured, whether it is being used, and how Jev has
 *               been doing (fallbacks, latency, clears) — never the key
 *   jev test    one tiny live request: latency and the Jev version that answered
 *   jev remove  delete the file; hooks go back to the regex engine unchanged
 *
 * # The key is never echoed
 *
 * There is no `--key <value>` flag: a command-line argument is readable from
 * `ps` by every user on the box and lands in shell history. The key arrives on
 * stdin (`--key-stdin`), at a masked prompt when stdin is a terminal, or — for
 * people who keep keys off disk — from `FAILPROOFAI_JEV_API_KEY` at run time
 * (`--key-from-env`). `--key-stdin` on a terminal uses the masked prompt too,
 * because a cooked-mode read would echo each character as it is typed. No
 * output of this module, human or `--json`, contains the key; provider error
 * text is scrubbed of it in `jev-client.ts`.
 *
 * # No restart
 *
 * Hooks read the file on every event (see `loadJevConfig`), so a setup, a mode
 * switch or a remove applies on the next tool call, daemon or not.
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import { writeJsonAtomically } from "../../lib/atomic-write";
import {
  DEFAULT_JEV_MODE,
  JEV_API_KEY_ENV,
  JEV_PROVIDER_KINDS,
  inspectJevConfig,
  jevConfigPath,
  readJevConfigForUpdate,
  validateApiKey,
  validateJevConfig,
  type JevConfig,
} from "./semantic/jev-config";
import { JevError, displayEndpoint, jevRoute, readAnswers, transportForConfig } from "./semantic/jev-client";
import { jevStats, type JevStats } from "./semantic/jev-stats";
import type { JevRequest } from "./semantic/types";
import { emptyState, nextStep, note, optsFor, rows, rule, stack, title, warning, type RenderOpts } from "./tui";

export interface JevCliResult {
  lines: string[];
  exitCode: number;
  /** `--json`: printed verbatim instead of `lines`. */
  json?: string;
}

export interface JevCliDeps {
  /** Everything piped on stdin (for `--key-stdin` off a terminal). */
  readStdin?: () => Promise<string>;
  /** A masked one-line prompt; null when cancelled. */
  promptKey?: () => Promise<string | null>;
  stdinIsTTY?: boolean;
  /** Budget for `jev test`'s single request. */
  testTimeoutMs?: number;
  render?: RenderOpts;
}

const ok = (lines: string[], json?: string): JevCliResult => ({ lines, exitCode: 0, ...(json !== undefined ? { json } : {}) });
const fail = (lines: string[], json?: string): JevCliResult => ({ lines, exitCode: 1, ...(json !== undefined ? { json } : {}) });

export const JEV_USAGE = [
  "Usage:",
  "  failproofai jev setup --provider <kind> [--key-stdin | --key-from-env] [options]",
  "  failproofai jev status [--json]",
  "  failproofai jev test [--json]",
  "  failproofai jev remove",
];

/** One live `jev test` request: small, harmless, and with an answer that is obviously right. */
export const JEV_TEST_QUESTION_ID = "jev_test";
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

// ── Argument parsing ─────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(["--provider", "--base-url", "--account-id", "--model", "--timeout-ms", "--mode"]);
const BOOL_FLAGS = new Set(["--key-stdin", "--key-from-env", "--json"]);

interface Parsed {
  values: Map<string, string>;
  bools: Set<string>;
  positionals: string[];
}

function parseFlags(argv: string[], allowed: Set<string>): Parsed | string {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (!allowed.has(arg)) return `Unknown option: ${arg}`;
    if (VALUE_FLAGS.has(arg)) {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) return `Missing value after ${arg}`;
      values.set(arg, v);
    } else if (BOOL_FLAGS.has(arg)) {
      if (inline !== undefined) return `${arg} takes no value`;
      bools.add(arg);
    }
  }
  return { values, bools, positionals };
}

// ── Rendering helpers ────────────────────────────────────────────────────────

function modeLine(mode: NonNullable<JevConfig["mode"]>): string {
  return mode === "enforce"
    ? "enforce — Jev's verdicts apply: it may clear a reviewable policy's deny and add its own"
    : "shadow — Jev is asked and logged; the regex result is what is enforced";
}

function permissions(mode: number | null): string {
  if (mode === null) return "unknown";
  const octal = mode.toString(8).padStart(4, "0");
  return (mode & 0o077) === 0 ? `${octal} (owner-only)` : `${octal} (too open)`;
}

function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof JevError) return { code: err.code, message: err.message };
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { code: "timeout", message: "no answer in time" };
  return { code: "error", message: err instanceof Error ? err.message : String(err) };
}

/** What the person should do about a failed request, by cause. */
function remedy(code: string): string {
  if (code === "http-401" || code === "http-403") return "The provider refused the key. Re-run `failproofai jev setup` with the right one.";
  if (code === "out-of-credits") return "The account is out of credits (HTTP 402). Top it up with the provider; until then hooks fall back to regex.";
  if (code === "http-429") return "The provider rate-limited this key. Hooks fall back to regex whenever that happens.";
  if (code.startsWith("http-5")) return "The provider had a server error. Hooks fall back to regex whenever that happens; try again shortly.";
  if (code === "timeout") return "No answer in time. Check the endpoint and your network.";
  if (code === "network") return "The endpoint could not be reached. Check the base URL and your network.";
  if (code === "model-mismatch") return "A Jev version the thresholds were not calibrated for answered, so hooks would fall back to regex. Pin a jev-1.13 model with --model.";
  if (code === "config") return "The config is not usable. Re-run `failproofai jev setup`.";
  return "Hooks would fall back to regex for this reason.";
}

/** The `jev status` activity block, from `jevStats()` (null when it could not be read). */
export function jevStatsLines(stats: JevStats | null, opts: RenderOpts = {}): string[] {
  const hours = stats ? Math.round(stats.windowMs / 3_600_000) : 24;
  const heading = rule(`last ${hours} hours`, opts);
  if (!stats) return stack(heading, note("Activity could not be read.", opts));
  if (stats.total === 0) return stack(heading, note(`No Jev evaluations recorded in the last ${hours} hours.`, opts));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const reasons = Object.entries(stats.fallbackReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ×${n}`)
    .join(", ");
  const clears = Object.entries(stats.clearsByPolicy)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} ×${n}`)
    .join(", ");
  const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
  return stack(
    heading,
    rows(
      [
        ["evaluations", String(stats.total)],
        ["fell back to regex", `${pct(stats.fallbackRate)}${reasons ? ` (${reasons})` : ""}`],
        ["latency", `p50 ${ms(stats.latencyP50Ms)} · p95 ${ms(stats.latencyP95Ms)}`],
        ["cleared", clears || "nothing"],
      ],
      opts,
    ),
  );
}

// ── setup ────────────────────────────────────────────────────────────────────

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function maskedPrompt(): Promise<string | null> {
  const { promptText } = await import("./tui");
  return promptText({ message: "Jev API key", mask: true, validate: (v) => validateApiKey(v) });
}

async function setup(argv: string[], deps: JevCliDeps, opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set([...VALUE_FLAGS, "--key-stdin", "--key-from-env"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([`Unexpected argument: ${parsed.positionals[0]}`, "", ...JEV_USAGE]);
  const { values, bools } = parsed;
  if (bools.has("--key-stdin") && bools.has("--key-from-env")) return fail(["Use one of --key-stdin and --key-from-env, not both."]);

  const existing = readJevConfigForUpdate();
  const providerArg = values.get("--provider");
  const provider = providerArg ?? (typeof existing?.provider === "string" ? existing.provider : undefined);
  if (!provider) {
    return fail([
      "--provider is required the first time.",
      `Providers: ${JEV_PROVIDER_KINDS.join(", ")}`,
      "",
      "  failproofai jev setup --provider cloudflare --account-id <id> --key-stdin < key-file",
    ]);
  }
  if (!(JEV_PROVIDER_KINDS as readonly string[]).includes(provider)) {
    return fail([`Unknown provider: ${provider}`, `Providers: ${JEV_PROVIDER_KINDS.join(", ")}`]);
  }
  const sameProvider = existing !== null && existing.provider === provider;

  // Same provider: update in place, keeping the key and every field not named
  // (including ones a newer failproofai wrote). A different provider starts
  // over: a key, model or URL for one gateway means nothing to another. Mode
  // and timeout are provider-neutral, so they carry across.
  const next: Record<string, unknown> = sameProvider ? { ...existing } : { provider };
  if (!sameProvider && existing) {
    if (existing.mode !== undefined) next.mode = existing.mode;
    if (existing.timeoutMs !== undefined) next.timeoutMs = existing.timeoutMs;
  }
  next.provider = provider;

  const setOrClear = (flag: string, field: string) => {
    const v = values.get(flag);
    if (v === undefined) return;
    if (v === "default") delete next[field];
    else next[field] = v;
  };
  setOrClear("--base-url", "baseUrl");
  setOrClear("--model", "model");
  if (values.has("--account-id")) next.accountId = values.get("--account-id");
  if (values.has("--mode")) next.mode = values.get("--mode");
  if (values.has("--timeout-ms")) {
    const raw = values.get("--timeout-ms") as string;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) return fail([`Could not read --timeout-ms ${raw}. Give a whole number of milliseconds.`]);
    next.timeoutMs = n;
  }

  // The key.
  let keyNote: string;
  const envKey = process.env[JEV_API_KEY_ENV];
  if (bools.has("--key-from-env")) {
    delete next.apiKey;
    if (!envKey) return fail([`--key-from-env: ${JEV_API_KEY_ENV} is not set in this shell.`]);
    keyNote = `not stored — read from ${JEV_API_KEY_ENV} when a hook runs`;
  } else if (bools.has("--key-stdin")) {
    const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    // On a terminal a cooked-mode read echoes each keystroke, so a person
    // typing or pasting there gets the masked prompt instead.
    const raw = tty ? await (deps.promptKey ?? maskedPrompt)() : await (deps.readStdin ?? readAllStdin)();
    if (raw === null) return fail(["Cancelled; nothing was written."]);
    const key = raw.trim();
    const bad = validateApiKey(key);
    if (bad) return fail([`Not saved: ${bad}.`]);
    next.apiKey = key;
    keyNote = "set from stdin";
  } else if (typeof next.apiKey === "string") {
    keyNote = "kept from the existing config";
  } else {
    const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    if (!tty) {
      return fail([
        "No key given, and there is no terminal to ask on.",
        "",
        "Pass it on stdin, which keeps it out of `ps` and shell history:",
        `  failproofai jev setup --provider ${provider} --key-stdin < key-file`,
        "",
        `Or store no key and supply ${JEV_API_KEY_ENV} per session (--key-from-env).`,
      ]);
    }
    const raw = await (deps.promptKey ?? maskedPrompt)();
    if (raw === null) return fail(["Cancelled; nothing was written."]);
    const key = raw.trim();
    const bad = validateApiKey(key);
    if (bad) return fail([`Not saved: ${bad}.`]);
    next.apiKey = key;
    keyNote = "set at the prompt";
  }

  const checked = validateJevConfig(next, bools.has("--key-from-env") ? envKey : null);
  if (!checked.ok) return fail([`Not saved: ${checked.problem}.`, "", "Nothing was written."]);
  const cfg = checked.value;

  const path = jevConfigPath();
  try {
    writeJsonAtomically(path, next, { mode: 0o600, dirMode: 0o700 });
  } catch (err) {
    return fail([`Could not write ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}.`]);
  }
  let fileMode: number | null = null;
  try {
    fileMode = statSync(path).mode & 0o777;
  } catch {
    // Reported as unknown below.
  }

  const route = jevRoute(cfg);
  return ok(
    stack(
      title("failproofai jev setup", `saved · ${provider} · ${cfg.mode ?? DEFAULT_JEV_MODE}`, opts),
      rows(
        [
          ["provider", provider],
          ["endpoint", displayEndpoint(route.endpoint)],
          ["model", route.modelIsDefault ? `${route.model} (provider default)` : route.model],
          ["mode", modeLine(cfg.mode ?? DEFAULT_JEV_MODE)],
          ["timeout", `${cfg.timeoutMs} ms`],
          ["key", keyNote],
          ["config", path],
          ["permissions", permissions(fileMode)],
        ],
        opts,
      ),
      note("Hooks read this file on every tool call — no restart. Without it they run the regex policies exactly as before.", opts),
      nextStep("failproofai jev test", "Check it with one live request:", opts),
    ),
  );
}

// ── status ───────────────────────────────────────────────────────────────────

async function status(argv: string[], opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set(["--json"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([`Unexpected argument: ${parsed.positionals[0]}`, "", ...JEV_USAGE]);
  const asJson = parsed.bools.has("--json");

  const inspection = inspectJevConfig();
  let stats: JevStats | null = null;
  try {
    stats = await jevStats();
  } catch {
    stats = null;
  }
  const legacy = process.env.FAILPROOFAI_EVALUATOR === "legacy";

  if (asJson) {
    const base: Record<string, unknown> = { path: inspection.path, status: inspection.status, legacyOverride: legacy, stats };
    if (inspection.status === "refused") {
      Object.assign(base, { reason: inspection.reason, problem: inspection.problem, permissions: inspection.mode });
    }
    if (inspection.status === "ok") {
      const { config: cfg } = inspection;
      const route = jevRoute(cfg);
      Object.assign(base, {
        permissions: inspection.mode,
        provider: cfg.provider,
        endpoint: displayEndpoint(route.endpoint),
        model: route.model,
        modelIsDefault: route.modelIsDefault,
        mode: cfg.mode,
        timeoutMs: cfg.timeoutMs,
        keySource: inspection.keySource,
      });
    }
    const json = JSON.stringify(base, null, 2);
    return inspection.status === "refused" ? fail([], json) : ok([], json);
  }

  const legacyNote = legacy
    ? warning(
        [
          "FAILPROOFAI_EVALUATOR=legacy is set in this shell: sessions started from it skip Jev when their hooks evaluate in-process.",
          "The daemon does not see this shell's environment.",
        ],
        opts,
      )
    : null;

  if (inspection.status === "absent") {
    return ok(
      stack(
        title("failproofai jev status", "off", opts),
        emptyState(
          {
            what: `Jev is off: there is no ${inspection.path}. Hooks run the regex policies exactly as before.`,
            hint: "Turn it on with your own Jev endpoint and key:",
            cmd: "failproofai jev setup --provider <typesafe|openrouter|vercel|cloudflare|custom> --key-stdin",
          },
          opts,
        ),
        jevStatsLines(stats, opts),
      ),
    );
  }

  if (inspection.status === "refused") {
    return fail(
      stack(
        title("failproofai jev status", "off (config refused)", opts),
        warning([`Jev is off: ${inspection.path} was refused — ${inspection.problem}.`, "Hooks run the regex policies exactly as before."], opts),
        inspection.reason === "too-open"
          ? nextStep(`chmod 600 ${inspection.path}`, "Make it owner-only (or re-run `failproofai jev setup`):", opts)
          : nextStep("failproofai jev setup --provider <kind> --key-stdin", "Write a valid one:", opts),
        legacyNote,
        jevStatsLines(stats, opts),
      ),
    );
  }

  const { config: cfg } = inspection;
  const route = jevRoute(cfg);
  const mode = cfg.mode ?? DEFAULT_JEV_MODE;
  return ok(
    stack(
      title("failproofai jev status", legacy ? "on (legacy override in this shell)" : `on · ${mode}`, opts),
      rows(
        [
          ["provider", cfg.provider],
          ["endpoint", displayEndpoint(route.endpoint)],
          ["model", route.modelIsDefault ? `${route.model} (provider default)` : route.model],
          ["mode", modeLine(mode)],
          ["timeout", `${cfg.timeoutMs} ms`],
          ["config", inspection.path],
          ["permissions", permissions(inspection.mode)],
          ["key", inspection.keySource === "file" ? "set in the config file" : `from ${JEV_API_KEY_ENV} (this shell only; the daemon does not see it)`],
        ],
        opts,
      ),
      legacyNote,
      jevStatsLines(stats, opts),
    ),
  );
}

// ── test ─────────────────────────────────────────────────────────────────────

export function jevTestRequest(model: string): JevRequest {
  return {
    model,
    state: { word: "blue" },
    questions: {
      [JEV_TEST_QUESTION_ID]: {
        type: "noul",
        instructions: "Is state.word the name of a colour?",
        criteria: { true: "It names a colour", false: "It does not name a colour" },
      },
    },
  };
}

async function test(argv: string[], deps: JevCliDeps, opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set(["--json"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([`Unexpected argument: ${parsed.positionals[0]}`, "", ...JEV_USAGE]);
  const asJson = parsed.bools.has("--json");

  const inspection = inspectJevConfig();
  if (inspection.status !== "ok") {
    const why =
      inspection.status === "absent"
        ? `There is no ${inspection.path}; nothing to test.`
        : `${inspection.path} was refused — ${inspection.problem}.`;
    const json = asJson
      ? JSON.stringify({ ok: false, error: { code: inspection.status === "absent" ? "not-configured" : "config", message: why } }, null, 2)
      : undefined;
    return fail(stack(title("failproofai jev test", "not run", opts), note(why, opts), nextStep("failproofai jev setup --provider <kind> --key-stdin", undefined, opts)), json);
  }

  const cfg = inspection.config;
  let route: ReturnType<typeof jevRoute>;
  let built: ReturnType<typeof transportForConfig>;
  try {
    route = jevRoute(cfg);
    built = transportForConfig(cfg);
  } catch (err) {
    const e = describeError(err);
    return fail([`Not run: ${e.message}`], asJson ? JSON.stringify({ ok: false, error: e }, null, 2) : undefined);
  }

  const request = jevTestRequest(built.model);
  const budget = cfg.timeoutMs ?? 1_500;
  const started = performance.now();
  try {
    const response = await built.transport(request, AbortSignal.timeout(deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS));
    const answers = readAnswers(request, response);
    const latencyMs = Math.round(performance.now() - started);
    const verified = response.modelUnverified !== true;
    const within = latencyMs <= budget;
    const p = answers[JEV_TEST_QUESTION_ID];
    const inputTokens = typeof response.usage?.input_tokens === "number" ? response.usage.input_tokens : null;
    if (asJson) {
      return ok(
        [],
        JSON.stringify(
          {
            ok: true,
            provider: cfg.provider,
            endpoint: displayEndpoint(route.endpoint),
            model: built.model,
            reportedModel: verified ? response.model : null,
            modelVerified: verified,
            latencyMs,
            timeoutMs: budget,
            withinTimeout: within,
            answer: p,
            inputTokens,
          },
          null,
          2,
        ),
      );
    }
    return ok(
      stack(
        title("failproofai jev test", `ok · ${latencyMs} ms`, opts),
        rows(
          [
            ["provider", cfg.provider],
            ["endpoint", displayEndpoint(route.endpoint)],
            ["model asked", built.model],
            [
              "answered by",
              verified ? `${response.model} (Jev 1.13 family — verified)` : `not reported — ${cfg.provider} names Jev only by an alias (modelVerified: false)`,
            ],
            ["latency", `${latencyMs} ms — ${within ? `within the ${budget} ms timeout` : `OVER the ${budget} ms timeout: hooks would fall back to regex`}`],
            ["answer", `p = ${p.toFixed(3)} that "blue" names a colour${p >= 0.5 ? "" : " (expected high)"}`],
            ...(inputTokens !== null ? ([["input tokens", String(inputTokens)]] as Array<[string, string]>) : []),
          ],
          opts,
        ),
        note(
          "One request, sent directly: the hook path's cache and rate limit were not involved, and a fresh process pays DNS and TLS setup that the daemon's warm worker does not.",
          opts,
        ),
      ),
    );
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const e = describeError(err);
    if (asJson) return fail([], JSON.stringify({ ok: false, provider: cfg.provider, latencyMs, error: e }, null, 2));
    return fail(
      stack(
        title("failproofai jev test", `failed · ${e.code}`, opts),
        rows(
          [
            ["provider", cfg.provider],
            ["endpoint", displayEndpoint(route.endpoint)],
            ["model asked", built.model],
            ["error", `${e.code}: ${e.message}`],
            ["after", `${latencyMs} ms`],
          ],
          opts,
        ),
        note(remedy(e.code), opts),
      ),
    );
  }
}

// ── remove ───────────────────────────────────────────────────────────────────

function remove(argv: string[], opts: RenderOpts): JevCliResult {
  const parsed = parseFlags(argv, new Set());
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([`Unexpected argument: ${parsed.positionals[0]}`, "", ...JEV_USAGE]);
  const path = jevConfigPath();
  if (!existsSync(path)) {
    return ok(stack(title("failproofai jev remove", "nothing to do", opts), note(`There is no ${path}; Jev is already off.`, opts)));
  }
  try {
    unlinkSync(path);
  } catch (err) {
    return fail([`Could not remove ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}.`]);
  }
  return ok(
    stack(
      title("failproofai jev remove", "off", opts),
      note(`Removed ${path}. Jev is off; hooks run the regex policies exactly as before, from the next tool call.`, opts),
      process.env[JEV_API_KEY_ENV] ? note(`${JEV_API_KEY_ENV} is still set in this shell. Without the file it does nothing.`, opts) : null,
    ),
  );
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/** Dispatch for `failproofai jev <sub> ...`. Never prints; the caller does. */
export async function runJevCommand(argv: string[], deps: JevCliDeps = {}): Promise<JevCliResult> {
  const opts = deps.render ?? optsFor(process.stdout);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "setup":
      return setup(rest, deps, opts);
    case "status":
      return status(rest, opts);
    case "test":
      return test(rest, deps, opts);
    case "remove":
      return remove(rest, opts);
    default:
      return fail([sub ? `Unknown subcommand: ${sub}` : "A subcommand is required.", "", ...JEV_USAGE]);
  }
}

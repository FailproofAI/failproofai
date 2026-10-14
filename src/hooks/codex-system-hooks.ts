/**
 * Codex hooks that Codex will actually run, and an honest answer to whether it does.
 *
 * Codex (0.129 onwards) runs a hook from `~/.codex/hooks.json` only once a
 * person has trusted it: interactive `codex` asks "Review hooks", and approving
 * writes the hook's identity hash to the USER's `~/.codex/config.toml` as
 *
 *   [hooks.state."<hooks.json path>:<event_snake>:<group>:<handler>"]
 *   trusted_hash = "sha256:…"
 *
 * Until then every one of our hooks is skipped — silently in headless
 * `codex exec` — so neither local nor cloud policies enforce, while failproofai
 * said they did. Nothing failproofai can write to `hooks.json` changes that.
 *
 * Hooks from Codex's SYSTEM config layer (`/etc/codex/config.toml` on Linux and
 * macOS) are "managed": Codex runs them with no hash and no prompt
 * (`hook_metadata_for_config_layer_source` maps `ConfigLayerSource::System` to
 * `is_managed = true`, and `hook_trust_status` returns `Managed` for those).
 * So when root is available, failproofai writes its Codex hooks there, as TOML
 * hook tables inside one clearly delimited block, and takes them out of
 * `hooks.json` — Codex appends handlers from every layer without
 * de-duplicating, so leaving both would evaluate every tool call twice once the
 * user file is trusted.
 *
 * Without root (or on Windows, whose system config lives elsewhere and is not
 * handled here) the hooks stay in `hooks.json`, and {@link codexHookTrust}
 * reads the user's `[hooks.state]` so `failproofai config` and
 * `config --status` stop counting Codex as enforcing until they are trusted.
 *
 * Everything that touches `/etc` goes through the same non-interactive
 * `sudo -n` the daemon install uses; `failproofai config` primes it first.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { canElevate, runPrivileged, writePrivilegedFile } from "./daemon-service";
import { writeConfigFileAtomic } from "./safe-config-write";
import { compareVersions } from "./semver-precedence";
import { FAILPROOFAI_HOOK_MARKER } from "./types";

export const CODEX_MANAGED_BEGIN = "# >>> failproofai managed hooks >>>";
export const CODEX_MANAGED_END = "# <<< failproofai managed hooks <<<";

/**
 * The first Codex that gates `hooks.json` on trust, and the first whose
 * system-layer hooks are `Managed` (both arrived together, in 0.129.0; TOML
 * hooks in config layers date from 0.124). Older Codex runs every hook in
 * `hooks.json` unasked, so it needs neither the system layer nor a warning.
 */
export const CODEX_TRUST_GATE_VERSION = "0.129.0";

const SYSTEM_CONFIG_UNIX = "/etc/codex/config.toml";

/** Every event Codex reads from a config layer's `hooks` table. */
const CODEX_TOML_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
] as const;

/** One hook to write: the PascalCase event and the handler `buildHookEntry` made for it. */
export interface CodexSystemHookEntry {
  event: string;
  command: string;
  timeout: number;
}

/**
 * Codex's system config file, or null where failproofai does not write one.
 *
 * `FAILPROOFAI_CODEX_SYSTEM_CONFIG` overrides it: a path to use instead, or
 * `off` (or empty) for none. The test suites set `off`, so no test run can
 * reach the real `/etc/codex` on a machine with passwordless sudo.
 */
export function codexSystemConfigPath(): string | null {
  const override = process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG;
  if (override !== undefined) return override === "" || override === "off" ? null : resolve(override);
  // Windows keeps it under %ProgramData%\OpenAI\Codex — not handled here, so
  // Windows stays on hooks.json with the trust warning.
  if (process.platform === "win32") return null;
  return SYSTEM_CONFIG_UNIX;
}

/** The copy of the system config as it was before failproofai first changed it. */
export function codexSystemBackupPath(path: string): string {
  return `${path}.failproofai-backup`;
}

/** `codex --version`, as a bare semver, or null when there is no codex to ask. */
export function detectCodexVersion(): string | null {
  try {
    const out = execSync("codex --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True for a Codex that only runs trusted `hooks.json` hooks (and treats system-config hooks as managed). */
export function codexGatesHookTrust(version: string | null): boolean {
  // Unknown is treated as current: every Codex shipped since 0.129 gates.
  if (!version) return true;
  const cmp = compareVersions(version, CODEX_TRUST_GATE_VERSION);
  return cmp === null ? true : cmp >= 0;
}

// ── The managed block ───────────────────────────────────────────────────────

/** The block failproofai owns in the system config, newline-terminated. */
export function renderCodexManagedBlock(entries: readonly CodexSystemHookEntry[]): string {
  const lines = [
    CODEX_MANAGED_BEGIN,
    "# Written by failproofai. Codex runs hooks from its system config without",
    "# asking to trust them. `failproofai uninstall` removes this block; edit",
    "# outside the markers only, everything between them is replaced.",
  ];
  for (const entry of entries) {
    lines.push(
      "",
      `[[hooks.${entry.event}]]`,
      `[[hooks.${entry.event}.hooks]]`,
      'type = "command"',
      // JSON's string escapes are a subset of TOML's basic-string escapes.
      `command = ${JSON.stringify(entry.command)}`,
      `timeout = ${Math.trunc(entry.timeout)}`,
    );
  }
  lines.push(CODEX_MANAGED_END);
  return `${lines.join("\n")}\n`;
}

/** Where the block sits: [start, end) covers the BEGIN line through the END line's newline. */
type BlockSpan = { start: number; end: number } | null | "malformed";

function findBlock(text: string): BlockSpan {
  const beginRe = new RegExp(`^${escapeRe(CODEX_MANAGED_BEGIN)}[ \\t]*$`, "m");
  const begin = beginRe.exec(text);
  if (!begin) {
    return new RegExp(`^${escapeRe(CODEX_MANAGED_END)}[ \\t]*$`, "m").test(text) ? "malformed" : null;
  }
  const endRe = new RegExp(`^${escapeRe(CODEX_MANAGED_END)}[ \\t]*$`, "mg");
  endRe.lastIndex = begin.index + begin[0].length;
  const end = endRe.exec(text);
  if (!end) return "malformed";
  let stop = end.index + end[0].length;
  if (text[stop] === "\r") stop++;
  if (text[stop] === "\n") stop++;
  return { start: begin.index, end: stop };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` holds failproofai's block. */
export function hasCodexManagedBlock(text: string): boolean {
  const span = findBlock(text);
  return span !== null && span !== "malformed";
}

/**
 * Put `block` into `original` (replacing ours if it is there), or take ours out
 * when `block` is null. Every byte outside the block is kept as it was.
 *
 * Appended after one blank line, which removal takes back out, so a file that
 * ended in a newline round-trips byte for byte. (One that did not gets the
 * newline the separator needed; {@link removeCodexSystemHooks} restores such a
 * file from its backup.)
 */
export function mergeCodexManagedBlock(original: string, block: string | null): string {
  const span = findBlock(original);
  if (span === "malformed") throw new Error("failproofai's managed block is missing its begin or end marker");
  if (span) {
    const before = original.slice(0, span.start);
    const after = original.slice(span.end);
    if (block !== null) return before + block + after;
    const trimmed = before.endsWith("\n\n") && after === "" ? before.slice(0, -1) : before;
    return trimmed + after;
  }
  if (block === null) return original;
  if (original === "") return block;
  return `${original}${original.endsWith("\n") ? "\n" : "\n\n"}${block}`;
}

/**
 * A `hooks` definition elsewhere in the file that our `[[hooks.<Event>]]`
 * tables would collide with, making the whole file invalid TOML — and Codex
 * refuses to start on a config it cannot parse, for every user on the machine.
 *
 * Arrays of tables (`[[hooks.PreToolUse]]`) and `[hooks.state…]` tables extend
 * cleanly and are fine. An inline `hooks = {…}`, an event assigned as a value
 * (`PreToolUse = [...]` under `[hooks]`, or `hooks.PreToolUse = …`), or an
 * event opened as a plain table are not. Returns the offending line, or null.
 */
export function conflictingHooksDefinition(text: string): string | null {
  const events = CODEX_TOML_EVENTS.join("|");
  const inlineHooks = /^\s*hooks\s*=/;
  const dottedEvent = new RegExp(`^\\s*hooks\\s*\\.\\s*"?(${events})"?\\s*(=|\\.)`);
  const plainEventTable = new RegExp(`^\\s*\\[\\s*hooks\\s*\\.\\s*"?(${events})"?\\s*(\\]|\\.)`);
  const eventKey = new RegExp(`^\\s*"?(${events})"?\\s*(=|\\.)`);
  let inHooksTable = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*\[\[/.test(line)) {
      inHooksTable = false;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (plainEventTable.test(line)) return line.trim();
      inHooksTable = /^\s*\[\s*hooks\s*\]/.test(line);
      continue;
    }
    if (inlineHooks.test(line) || dottedEvent.test(line)) return line.trim();
    if (inHooksTable && eventKey.test(line)) return line.trim();
  }
  return null;
}

// ── Reading and writing the root-owned file ─────────────────────────────────

/** Seams for tests: the file, the Codex version and the privileges. */
export interface CodexSystemDeps {
  /** The system config path; `null` = none on this machine. Default {@link codexSystemConfigPath}. */
  path?: string | null;
  codexVersion?: () => string | null;
  canElevate?: () => boolean;
}

function resolvedPath(deps: CodexSystemDeps): string | null {
  return deps.path !== undefined ? deps.path : codexSystemConfigPath();
}

/** True when this process can write `path` itself (root, or a test's temp dir). */
function writableDirectly(path: string): boolean {
  let dir = dirname(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  try {
    accessSync(dir, fsConstants.W_OK);
    if (existsSync(path)) accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function fileMode(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    return "0644";
  }
}

function writeSystemFile(path: string, contents: string, mode: string, direct: boolean): void {
  if (direct) {
    writeConfigFileAtomic(path, contents, { backup: false });
    chmodSync(path, parseInt(mode, 8));
    return;
  }
  runPrivileged("install", ["-d", "-m", "0755", dirname(path)]);
  writePrivilegedFile(path, contents, mode);
}

function removeSystemFile(path: string, direct: boolean): void {
  if (direct) rmSync(path, { force: true });
  else runPrivileged("rm", ["-f", path]);
}

/** Whether failproofai's block is in Codex's system config. Read-only, never throws. */
export function codexSystemHooksPresent(deps: CodexSystemDeps = {}): boolean {
  const path = resolvedPath(deps);
  if (!path) return false;
  try {
    return hasCodexManagedBlock(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export type CodexSystemInstall =
  | { ok: true; path: string; changed: boolean }
  | {
      ok: false;
      reason: "unsupported-platform" | "codex-not-found" | "codex-too-old" | "no-root" | "conflict" | "unreadable" | "write-failed";
      detail?: string;
      path?: string;
    };

/**
 * Write failproofai's Codex hooks into the system config, replacing only our
 * block. Never prompts: it uses root, or a `sudo -n` that `failproofai config`
 * primed. Every refusal leaves the file exactly as it was.
 */
export function installCodexSystemHooks(
  entries: readonly CodexSystemHookEntry[],
  deps: CodexSystemDeps = {},
): CodexSystemInstall {
  const path = resolvedPath(deps);
  if (!path) return { ok: false, reason: "unsupported-platform" };
  const version = (deps.codexVersion ?? detectCodexVersion)();
  if (!version) return { ok: false, reason: "codex-not-found", path };
  const cmp = compareVersions(version, CODEX_TRUST_GATE_VERSION);
  if (cmp !== null && cmp < 0) return { ok: false, reason: "codex-too-old", detail: version, path };

  let current = "";
  const existed = existsSync(path);
  if (existed) {
    try {
      current = readFileSync(path, "utf8");
    } catch (err) {
      return { ok: false, reason: "unreadable", detail: err instanceof Error ? err.message : String(err), path };
    }
  }
  const span = findBlock(current);
  if (span === "malformed") {
    return { ok: false, reason: "unreadable", detail: "failproofai's block has lost one of its markers", path };
  }
  const outside = span ? current.slice(0, span.start) + current.slice(span.end) : current;
  const conflict = conflictingHooksDefinition(outside);
  if (conflict) return { ok: false, reason: "conflict", detail: conflict, path };

  const next = mergeCodexManagedBlock(current, renderCodexManagedBlock(entries));
  if (next === current) return { ok: true, path, changed: false };

  const direct = writableDirectly(path);
  if (!direct && !(deps.canElevate ?? canElevate)()) return { ok: false, reason: "no-root", path };

  try {
    const mode = existed ? fileMode(path) : "0644";
    // Once: the file as it was before failproofai ever touched it. A file that
    // already holds our block is not that, and an existing backup is kept.
    const backup = codexSystemBackupPath(path);
    if (existed && !span && !existsSync(backup)) writeSystemFile(backup, current, mode, direct);
    writeSystemFile(path, next, mode, direct);
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err), path };
  }
  return { ok: true, path, changed: true };
}

export type CodexSystemRemoval =
  | { status: "absent" }
  | { status: "removed"; path: string; hooks: number }
  | { status: "failed"; path: string; reason: string };

/**
 * Take failproofai's block out of the system config. The file is restored from
 * its backup when what is left is exactly what was backed up, and deleted when
 * failproofai created it and nothing else was ever added.
 */
export function removeCodexSystemHooks(deps: CodexSystemDeps = {}): CodexSystemRemoval {
  const path = resolvedPath(deps);
  if (!path || !existsSync(path)) return { status: "absent" };
  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch (err) {
    return { status: "failed", path, reason: err instanceof Error ? err.message : String(err) };
  }
  const span = findBlock(current);
  if (span === null) return { status: "absent" };
  if (span === "malformed") {
    return { status: "failed", path, reason: `one of failproofai's markers is missing; remove the block by hand` };
  }
  const hooks = (current.slice(span.start, span.end).match(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]/gm) ?? []).length;
  const stripped = mergeCodexManagedBlock(current, null);

  const backupPath = codexSystemBackupPath(path);
  let backup: string | null = null;
  try {
    if (existsSync(backupPath)) backup = readFileSync(backupPath, "utf8");
  } catch {
    backup = null;
  }

  const direct = writableDirectly(path);
  if (!direct && !(deps.canElevate ?? canElevate)()) {
    return { status: "failed", path, reason: "removing it needs root, and sudo is not available" };
  }
  try {
    if (backup !== null && (stripped === backup || stripped === `${backup}\n`)) {
      // Nothing else changed since: put back the exact bytes.
      writeSystemFile(path, backup, fileMode(path), direct);
      removeSystemFile(backupPath, direct);
    } else if (backup === null && stripped.trim() === "") {
      // failproofai created this file, and it holds nothing of anyone else's.
      removeSystemFile(path, direct);
    } else {
      writeSystemFile(path, stripped, fileMode(path), direct);
    }
  } catch (err) {
    return { status: "failed", path, reason: err instanceof Error ? err.message : String(err) };
  }
  return { status: "removed", path, hooks };
}

// ── Trust ───────────────────────────────────────────────────────────────────

/**
 * What every screen says when Codex's hooks sit in hooks.json untrusted. A
 * `notice` message: the fix on its own line. "Allow sudo", not "with sudo":
 * `failproofai config` refuses to run under sudo, and asks for it itself.
 */
export const CODEX_UNTRUSTED_NOTICE =
  "Codex won't run failproofai's hooks until they're trusted.\n" +
  "Re-run  `failproofai config`  and allow sudo, or open  `codex`  once and approve the hooks.";

export type CodexHookTrust =
  /** No failproofai Codex hooks at user scope. */
  | { kind: "none" }
  /** In Codex's system config: managed, run without trust. */
  | { kind: "system"; path: string }
  /** In hooks.json, and every one trusted at its current hash. */
  | { kind: "trusted"; path: string }
  /** In hooks.json, on a Codex old enough to run hooks without trust. */
  | { kind: "ungated"; path: string; version: string }
  /** In hooks.json and not all trusted: Codex skips the untrusted ones. */
  | { kind: "untrusted"; path: string; untrusted: number; total: number };

export interface CodexTrustDeps extends CodexSystemDeps {
  /** `~/.codex/hooks.json`. */
  hooksJsonPath?: string;
  /** `~/.codex/config.toml`, where Codex keeps `[hooks.state]`. */
  userConfigPath?: string;
}

/**
 * Whether Codex will run the failproofai hooks installed at user scope.
 *
 * Mirrors Codex's own discovery: the state key is
 * `<hooks.json path>:<event_snake>:<group index>:<handler index>`, and a hook
 * runs only when the `trusted_hash` stored under it equals the hash of the
 * hook as it is now (a hook edited since it was trusted reads "modified" in
 * Codex, and is skipped like an untrusted one).
 */
export function codexHookTrust(deps: CodexTrustDeps = {}): CodexHookTrust {
  const systemPath = resolvedPath(deps);
  if (systemPath && codexSystemHooksPresent({ path: systemPath })) return { kind: "system", path: systemPath };

  const hooksJsonPath = deps.hooksJsonPath ?? resolve(homedir(), ".codex", "hooks.json");
  const ours = failproofaiCodexHookIdentities(hooksJsonPath);
  if (ours.length === 0) return { kind: "none" };

  const version = (deps.codexVersion ?? detectCodexVersion)();
  if (version && !codexGatesHookTrust(version)) return { kind: "ungated", path: hooksJsonPath, version };

  let trustedHashes = new Map<string, string>();
  try {
    trustedHashes = parseCodexTrustedHashes(
      readFileSync(deps.userConfigPath ?? resolve(homedir(), ".codex", "config.toml"), "utf8"),
    );
  } catch {
    // No user config: nothing is trusted.
  }
  const untrusted = ours.filter((hook) => trustedHashes.get(hook.key) !== hook.hash).length;
  return untrusted === 0
    ? { kind: "trusted", path: hooksJsonPath }
    : { kind: "untrusted", path: hooksJsonPath, untrusted, total: ours.length };
}

/** `PreToolUse` → `pre_tool_use`, the label Codex puts in state keys and hashes. */
function snakeEvent(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Events whose matcher Codex ignores, so the hash carries none. */
const MATCHERLESS = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);

/** The state key and expected trust hash of every failproofai handler in a hooks.json. */
export function failproofaiCodexHookIdentities(hooksJsonPath: string): Array<{ key: string; hash: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  } catch {
    return [];
  }
  const hooks = (parsed as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: Array<{ key: string; hash: string }> = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group: unknown, groupIndex) => {
      const handlers = (group as { hooks?: unknown })?.hooks;
      if (!Array.isArray(handlers)) return;
      handlers.forEach((handler: unknown, handlerIndex) => {
        if (!isOurs(handler)) return;
        const matcher = (group as { matcher?: unknown }).matcher;
        out.push({
          key: `${hooksJsonPath}:${snakeEvent(event)}:${groupIndex}:${handlerIndex}`,
          hash: codexHookHash(event, typeof matcher === "string" ? matcher : null, handler as Record<string, unknown>),
        });
      });
    });
  }
  return out;
}

function isOurs(handler: unknown): boolean {
  if (!handler || typeof handler !== "object") return false;
  const h = handler as Record<string, unknown>;
  if (h[FAILPROOFAI_HOOK_MARKER] === true) return true;
  const cmd = typeof h.command === "string" ? h.command : "";
  return cmd.includes("failproofai") && cmd.includes("--hook");
}

/**
 * Codex's trust hash for one command handler (`hook_hash` in
 * codex-rs/hooks/src/engine/discovery.rs): the normalized identity
 * `{event_name, matcher?, hooks: [handler]}` as TOML, converted to JSON with
 * every object's keys sorted, serialized compactly, SHA-256, `sha256:<hex>`.
 * Normalization: the timeout defaults to 600 (SessionEnd/Interrupt: 1, capped
 * at 3), `async` defaults to false, `commandWindows` is dropped, and absent
 * optional fields do not appear.
 */
export function codexHookHash(event: string, matcher: string | null, handler: Record<string, unknown>): string {
  const short = event === "SessionEnd" || event === "Interrupt";
  const raw = typeof handler.timeout === "number" && Number.isFinite(handler.timeout) ? Math.trunc(handler.timeout) : null;
  const timeout = short ? Math.min(3, Math.max(1, raw ?? 1)) : Math.max(1, raw ?? 600);
  const normalized: Record<string, unknown> = {
    async: handler.async === true,
    command: typeof handler.command === "string" ? handler.command : "",
    timeout,
    type: "command",
  };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const limit = handler.additionalContextLimit;
  if (typeof limit === "number" && limit !== 2500) normalized.additionalContextLimit = limit;
  const identity: Record<string, unknown> = { event_name: snakeEvent(event), hooks: [normalized] };
  if (matcher !== null && !MATCHERLESS.has(event)) identity.matcher = matcher;
  return `sha256:${createHash("sha256").update(sortedJson(identity)).digest("hex")}`;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `trusted_hash` per state key from a Codex `config.toml`, without a TOML
 * dependency (this package has none on purpose). Reads every form Codex or a
 * person writes it in — `[hooks.state."<key>"]` tables, an inline
 * `"<key>" = { trusted_hash = "…" }` under `[hooks.state]`, and dotted keys —
 * and ignores everything else, multi-line strings included.
 */
export function parseCodexTrustedHashes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const record = (path: string[], value: string): void => {
    if (path.length === 4 && path[0] === "hooks" && path[1] === "state" && path[3] === "trusted_hash") {
      const key = path[2].trim();
      if (key) found.set(key, value);
    }
  };
  let table: string[] = [];
  let inMultiline: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (inMultiline) {
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    if (trimmed.startsWith("[[")) {
      const header = readKeyPath(trimmed, 2);
      table = header ? [...header.path, "[]"] : ["[]"];
      continue;
    }
    if (trimmed.startsWith("[")) {
      const header = readKeyPath(trimmed, 1);
      table = header && trimmed[skipWs(trimmed, header.end)] === "]" ? header.path : ["?"];
      continue;
    }
    const key = readKeyPath(trimmed, 0);
    if (!key) continue;
    let i = skipWs(trimmed, key.end);
    if (trimmed[i] !== "=") continue;
    i = skipWs(trimmed, i + 1);
    const full = [...table, ...key.path];
    if (trimmed.startsWith('"""', i) || trimmed.startsWith("'''", i)) {
      const quote = trimmed.slice(i, i + 3);
      if (!trimmed.slice(i + 3).includes(quote)) inMultiline = quote;
      continue;
    }
    const str = readString(trimmed, i);
    if (str) {
      record(full, str.value);
      continue;
    }
    if (trimmed[i] === "{") {
      // Inline table of string values: { trusted_hash = "…", enabled = true }
      let j = i + 1;
      for (;;) {
        j = skipWs(trimmed, j);
        const inner = readKeyPath(trimmed, j);
        if (!inner) break;
        j = skipWs(trimmed, inner.end);
        if (trimmed[j] !== "=") break;
        j = skipWs(trimmed, j + 1);
        const v = readString(trimmed, j);
        if (v) {
          record([...full, ...inner.path], v.value);
          j = v.end;
        } else {
          while (j < trimmed.length && trimmed[j] !== "," && trimmed[j] !== "}") j++;
        }
        j = skipWs(trimmed, j);
        if (trimmed[j] !== ",") break;
        j++;
      }
    }
  }
  return found;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

/** A dotted TOML key starting at `i`: bare, "basic" and 'literal' segments. */
function readKeyPath(s: string, i: number): { path: string[]; end: number } | null {
  const path: string[] = [];
  for (;;) {
    i = skipWs(s, i);
    const quoted = readString(s, i);
    if (quoted) {
      path.push(quoted.value);
      i = quoted.end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!bare) return null;
      path.push(bare[0]);
      i += bare[0].length;
    }
    const next = skipWs(s, i);
    if (s[next] !== ".") return { path, end: i };
    i = next + 1;
  }
}

/** A single-line basic or literal TOML string at `i`, unescaped. */
function readString(s: string, i: number): { value: string; end: number } | null {
  if (s[i] === "'") {
    const close = s.indexOf("'", i + 1);
    return close < 0 ? null : { value: s.slice(i + 1, close), end: close + 1 };
  }
  if (s[i] !== '"') return null;
  let value = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') return { value, end: j + 1 };
    if (c !== "\\") {
      value += c;
      continue;
    }
    const e = s[++j];
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\x1b" };
    if (e in simple) value += simple[e];
    else if (e === "u" || e === "U") {
      const len = e === "u" ? 4 : 8;
      const hex = s.slice(j + 1, j + 1 + len);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) return null;
      value += String.fromCodePoint(parseInt(hex, 16));
      j += len;
    } else return null;
  }
  return null;
}

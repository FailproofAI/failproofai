/**
 * A per-CLI record of what the agent CLIs ACTUALLY send us.
 *
 * Every policy failproofai enforces depends on a hand-written translation of
 * some vendor's payload into our canonical shape — `COPILOT_TOOL_INPUT_MAP` and
 * its ten siblings in `types.ts`. Those maps were each verified live against one
 * version of one vendor's CLI, and nothing since re-checks them. When a vendor
 * renames a key the translation silently produces an input no policy can read,
 * the product keeps reporting success, and we find out by accident. Copilot
 * 1.0.71 renamed `file_path` to `path` and `block-env-files` went inert on a
 * live `.env` read.
 *
 * This module is the first step toward noticing: it writes down, per CLI and per
 * hook event, the key names the vendor is really sending. Comparing that against
 * what our maps expect is a separate job — this one only establishes the ground
 * truth, because today we have none.
 *
 * ## What it will and will not record
 *
 * Key NAMES and the vendor's TOOL NAME. Nothing else. `keyNamesOf` returns
 * `Object.keys(...)`, so no value can reach the table through a payload field —
 * but the tool name (`tool_name` / `toolName` / `toolCall.name`) *is* a value,
 * it is a map key here, and pretending otherwise would be exactly the kind of
 * claim-that-outlives-its-evidence this module exists to catch. It is recorded
 * deliberately, because a rename like `Execute → Run` is drift we need to see,
 * and it is length-capped like everything else. Tool names from MCP servers can
 * carry an organisation's own vocabulary; that is the one thing in this file a
 * reader should think about before pasting it into a public issue.
 *
 * ## Why it is shaped the way it is
 *
 * **Entirely synchronous on the record path.** There is no
 * `process.on("unhandledRejection")` in the worker path and Node defaults to
 * `--unhandled-rejections=throw`, so one floating rejection kills the worker —
 * and on a daemon-configured machine that denies the tool call in flight. The
 * version probe is the one asynchronous thing here and is callback-based for the
 * same reason (see `cli-version-probe.ts`).
 *
 * **It writes when it LEARNS something, not on a clock.** The obvious design —
 * accumulate in memory, write once a day — is broken on the machine it targets:
 * the daemon SIGKILLs the worker, so there is no shutdown flush, and a worker
 * that restarts more often than the interval loads a file too recent to trigger
 * a write, accumulates, and dies. Every generation after the first would discard
 * everything it saw, forever, while looking like it was working. So `dirty` is
 * set only when the table actually CHANGED, and a change is written within
 * `MIN_WRITE_INTERVAL_MS`. In steady state — the vendor sends what it has always
 * sent — nothing changes and nothing is written at all, which is quieter than a
 * daily write and, unlike it, cannot lose the day a vendor changed something.
 *
 * **The table is read defensively because the file is agent-writable.** It lives
 * under the same uid as the agent this product supervises, so a `mkfifo` at that
 * path would otherwise block `readFileSync` forever — wedging the serialized
 * chain, denying every tool call on the machine across all twelve CLIs, and
 * surviving restarts, because a blocked event loop cannot run the wedge
 * watchdog that exists to catch exactly this. Hence O_NONBLOCK + `fstat` +
 * a size cap + a bounded read.
 *
 * **Everything is bounded, in bytes and not only in count.** Tool names and key
 * names arrive from MCP servers, Skills and third-party extensions, so both
 * their number and their length are outside our control.
 *
 * Keys are UNIONED rather than overwritten. Optional keys (`Bash` sends
 * `description` sometimes) would otherwise make the recorded shape flicker with
 * whichever call happened to land last, and a flickering record is worse than no
 * record: it looks like drift every time it moves.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { writeJsonAtomically } from "../../lib/atomic-write";
import { contractTableFile } from "./fp-home";
import { probeCliVersion } from "./cli-version-probe";

const SCHEMA_VERSION = 1;

/**
 * Floor between writes. Not a cadence — nothing is written unless something was
 * learned. This only stops a burst of first-contact discoveries from writing
 * once per event while a machine warms up.
 */
const DEFAULT_MIN_WRITE_INTERVAL_MS = 60_000;

/**
 * Skip payloads larger than this rather than parse them. The recorder runs
 * inside the worker's serialized chain, so its cost lands on every tool call on
 * the machine; `MAX_FRAME_LEN` upstream is 16MB, and parsing that twice (the
 * evaluator parses it too) is not worth a diagnostic.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Refuse to read a table larger than this — see the header on the FIFO wedge. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Stop accepting NEW entries once the table is this big. */
const MAX_TABLE_BYTES = 512 * 1024;

const MAX_KEYS_PER_SHAPE = 64;
const MAX_TOOLS_PER_HOOK = 200;
const MAX_HOOKS_PER_CLI = 64;
const MAX_CLIS = 32;
/** Applies to key names, tool names, CLI ids and hook names alike. */
const MAX_NAME_LEN = 128;

export interface HookShape {
  /** Top-level key names of the payload envelope. */
  envelope: string[];
  /** Tool-input key names, keyed by the vendor's own tool name. */
  tools?: Record<string, string[]>;
}

export interface CliRecord {
  version?: string;
  /** Set even when the probe failed, so an uninstalled CLI is not retried hourly. */
  versionCheckedAt?: string;
  hooks: Record<string, HookShape>;
}

export interface ContractTable {
  schemaVersion: number;
  updatedAt: string | null;
  /** True when a cap stopped us adding something. Printed, never silent. */
  truncated?: boolean;
  clis: Record<string, CliRecord>;
}

let table: ContractTable | null = null;
let lastWriteMs = 0;
let dirty = false;
let approxBytes = 0;
const probesInFlight = new Set<string>();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function minWriteIntervalMs(): number {
  // Read at call time, never memoised at module load — the same rule
  // `failproofaiHome()` follows, and for the same reason: tests set it late.
  return envInt("FAILPROOFAI_OBSERVE_INTERVAL_MS", DEFAULT_MIN_WRITE_INTERVAL_MS);
}

/** How stale a recorded version may be before we re-probe. Independent of the write floor. */
function versionMaxAgeMs(): number {
  return envInt("FAILPROOFAI_OBSERVE_VERSION_MAX_AGE_MS", 24 * 60 * 60 * 1000);
}

/**
 * Version probing forks a vendor binary, so it is confined to the real warm
 * worker (which is the only process with a worker socket) rather than to every
 * in-process caller of `evaluateHookEvent`. Without this, the unit suite forks
 * twelve CLIs and the developer's own machine grows a table nobody asked for.
 * `=1` forces it on for the one test that exercises the spawn path.
 */
function versionProbingEnabled(): boolean {
  const flag = process.env.FAILPROOFAI_OBSERVE_VERSIONS;
  if (flag === "0") return false;
  if (flag === "1") return true;
  return Boolean(process.env.FAILPROOFAI_WORKER_SOCKET);
}

/** Null-prototype so a key like `__proto__` or `constructor` is just a key. */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyTable(): ContractTable {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, clis: emptyMap<CliRecord>() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LEN;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    if (out.length >= MAX_KEYS_PER_SHAPE) break;
    if (entry.length > MAX_NAME_LEN) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Validate a table read off disk field by field, enforcing the SAME caps as the
 * write path — a hand-edited or hostile file is otherwise an unbounded input
 * that we then parse synchronously on the hook path. Degrades to a fresh table
 * on anything unexpected: losing the history costs a day of observation, and
 * throwing here would cost a tool call.
 */
function parseTable(raw: unknown): ContractTable | null {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== SCHEMA_VERSION) return null;
  if (!isPlainObject(raw.clis)) return null;

  const clis = emptyMap<CliRecord>();
  let cliCount = 0;
  for (const [cli, value] of Object.entries(raw.clis)) {
    if (cliCount >= MAX_CLIS) break;
    if (!usableName(cli) || !isPlainObject(value) || !isPlainObject(value.hooks)) continue;

    const hooks = emptyMap<HookShape>();
    let hookCount = 0;
    for (const [hookName, hookValue] of Object.entries(value.hooks)) {
      if (hookCount >= MAX_HOOKS_PER_CLI) break;
      if (!usableName(hookName) || !isPlainObject(hookValue)) continue;
      const envelope = stringArray(hookValue.envelope);
      if (!envelope) continue;

      const shape: HookShape = { envelope };
      if (isPlainObject(hookValue.tools)) {
        const tools = emptyMap<string[]>();
        let toolCount = 0;
        for (const [toolName, toolKeys] of Object.entries(hookValue.tools)) {
          if (toolCount >= MAX_TOOLS_PER_HOOK) break;
          if (!usableName(toolName)) continue;
          const keys = stringArray(toolKeys);
          if (!keys) continue;
          tools[toolName] = keys;
          toolCount++;
        }
        if (toolCount > 0) shape.tools = tools;
      }
      hooks[hookName] = shape;
      hookCount++;
    }

    const record: CliRecord = { hooks };
    if (usableName(value.version)) record.version = value.version;
    if (usableName(value.versionCheckedAt)) record.versionCheckedAt = value.versionCheckedAt;
    clis[cli] = record;
    cliCount++;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    clis,
  };
}

/**
 * Read the table without ever blocking.
 *
 * O_NONBLOCK so opening a FIFO returns instead of waiting for a writer, then
 * `fstat` on the descriptor we actually hold (not a path that could have been
 * swapped underneath us) to reject anything that is not a regular file of
 * sane size.
 */
function readTableFile(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buf, read, stat.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    approxBytes = read;
    return JSON.parse(buf.subarray(0, read).toString("utf8"));
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do; the fd is going away with the process anyway.
      }
    }
  }
}

function getTable(): ContractTable {
  if (table) return table;
  let loaded: ContractTable | null = null;
  approxBytes = 0;
  try {
    loaded = parseTable(readTableFile(contractTableFile()));
  } catch {
    loaded = null;
  }
  if (!loaded) approxBytes = 0;
  table = loaded ?? emptyTable();

  // Seed from the FILE, not from now: a machine whose worker is SIGKILLed more
  // often than the write floor must still be able to write. Clamped to now
  // because a future-dated `updatedAt` (clock skew, a hand edit) would
  // otherwise disable the writer permanently with no way back.
  const parsedAt = table.updatedAt ? Date.parse(table.updatedAt) : 0;
  lastWriteMs = Number.isFinite(parsedAt) ? Math.min(parsedAt, Date.now()) : 0;
  return table;
}

/**
 * The only place a payload is read. Returns key names and nothing else, so no
 * field value can reach the table by any route.
 */
function keyNamesOf(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const out: string[] = [];
  for (const key of Object.keys(value)) {
    if (out.length >= MAX_KEYS_PER_SHAPE) break;
    if (key.length === 0 || key.length > MAX_NAME_LEN) continue;
    out.push(key);
  }
  return out;
}

/** Union `incoming` into `target`, sorted and capped. Reports whether it changed. */
function mergeKeys(target: string[], incoming: readonly string[]): boolean {
  let changed = false;
  for (const key of incoming) {
    if (target.length >= MAX_KEYS_PER_SHAPE) break;
    if (approxBytes >= MAX_TABLE_BYTES) break;
    if (!target.includes(key)) {
      target.push(key);
      approxBytes += key.length + 6;
      changed = true;
    }
  }
  if (changed) target.sort();
  return changed;
}

/**
 * The vendor's raw tool name, before any canonicalization. Covers the three
 * envelope spellings in use: canonical snake_case, Copilot's camelCase
 * `permissionRequest`, and Antigravity's nested `toolCall`.
 */
function rawToolName(payload: Record<string, unknown>): string | null {
  const direct = payload.tool_name ?? payload.toolName;
  if (usableName(direct)) return direct;
  const call = payload.toolCall;
  if (isPlainObject(call) && usableName(call.name)) return call.name;
  return null;
}

/** The vendor's raw tool input, in the same three spellings plus Pi's `input`. */
function rawToolInput(payload: Record<string, unknown>): unknown {
  const direct = payload.tool_input ?? payload.toolInput;
  if (direct !== undefined) return direct;
  const call = payload.toolCall;
  if (isPlainObject(call) && call.args !== undefined) return call.args;
  return payload.input;
}

function markTruncated(current: ContractTable): void {
  if (!current.truncated) {
    current.truncated = true;
    dirty = true;
  }
}

/**
 * Record one hook event's shape. Never throws, never awaits, never blocks.
 *
 * Callers on the hook path must STILL wrap this in their own try/catch — a
 * guarantee that lives in one file is a guarantee that a future edit can
 * quietly remove.
 */
export function recordHookShape(cli: string, hookEvent: string, stdin: string): void {
  // Fault injection, deliberately inside the shipped function rather than a
  // test double. The property under test is that a throw HERE cannot change a
  // verdict, and a `vi.spyOn` proves that only for callers that share this
  // module instance — not for the spawned one-shot binary, and not for the
  // warm worker when the assertion runs in another process. A test that passes
  // whether or not the guard exists is worse than no test.
  if (process.env.FAILPROOFAI_OBSERVE_FAULT === "throw") {
    throw new Error("injected contract-observer fault");
  }

  if (!usableName(cli) || !usableName(hookEvent)) return;
  if (stdin.length > MAX_PAYLOAD_BYTES) return;

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return;
  }
  if (!isPlainObject(payload)) return;

  const current = getTable();
  let changed = false;

  let record = current.clis[cli];
  if (!record) {
    if (Object.keys(current.clis).length >= MAX_CLIS || approxBytes >= MAX_TABLE_BYTES) {
      markTruncated(current);
      maybeWrite();
      return;
    }
    record = { hooks: emptyMap<HookShape>() };
    current.clis[cli] = record;
    approxBytes += cli.length + 24;
    changed = true;
  }

  let shape = record.hooks[hookEvent];
  if (!shape) {
    if (Object.keys(record.hooks).length >= MAX_HOOKS_PER_CLI || approxBytes >= MAX_TABLE_BYTES) {
      markTruncated(current);
      maybeWrite();
      return;
    }
    shape = { envelope: [] };
    record.hooks[hookEvent] = shape;
    approxBytes += hookEvent.length + 24;
    changed = true;
  }

  if (mergeKeys(shape.envelope, keyNamesOf(payload))) changed = true;

  const toolName = rawToolName(payload);
  if (toolName) {
    const tools = (shape.tools ??= emptyMap<string[]>());
    let toolKeys = tools[toolName];
    if (!toolKeys) {
      if (Object.keys(tools).length >= MAX_TOOLS_PER_HOOK || approxBytes >= MAX_TABLE_BYTES) {
        markTruncated(current);
      } else {
        toolKeys = [];
        tools[toolName] = toolKeys;
        approxBytes += toolName.length + 8;
        changed = true;
      }
    }
    if (toolKeys && mergeKeys(toolKeys, keyNamesOf(rawToolInput(payload)))) changed = true;
  }

  if (changed) dirty = true;
  maybeWrite();
  maybeProbeVersion(cli);
}

function maybeWrite(): void {
  if (!dirty) return;
  if (Date.now() - lastWriteMs < minWriteIntervalMs()) return;
  try {
    flushContractTable();
  } catch {
    // A full or read-only disk must not make us retry on every single tool
    // call. Back off one interval as if the write had succeeded, but leave
    // `dirty` set so the observation is not lost if a later write succeeds.
    lastWriteMs = Date.now();
  }
}

/**
 * Start a version probe when this CLI's version is stale, at most one in flight
 * per CLI. `versionCheckedAt` advances even when the probe finds nothing, so an
 * uninstalled CLI costs one failed lookup per interval rather than one per event.
 */
function maybeProbeVersion(cli: string): void {
  if (!versionProbingEnabled()) return;

  const current = table;
  if (!current) return;
  const record = current.clis[cli];
  if (!record) return;

  const checkedAt = record.versionCheckedAt ? Date.parse(record.versionCheckedAt) : 0;
  const checkedMs = Number.isFinite(checkedAt) ? Math.min(checkedAt, Date.now()) : 0;
  if (Date.now() - checkedMs < versionMaxAgeMs()) return;
  if (probesInFlight.has(cli)) return;
  probesInFlight.add(cli);

  probeCliVersion(cli, (version) => {
    probesInFlight.delete(cli);
    const live = table?.clis[cli];
    if (!live) return;
    live.versionCheckedAt = new Date().toISOString();
    if (version) live.version = version;
    dirty = true;
    // Write it out now rather than waiting for the next hook event. The worker
    // is SIGKILLed, so "later" is frequently "never", and a probe that costs a
    // fork and then persists nothing is the worst of both.
    try {
      flushContractTable();
    } catch {
      // Recorded in memory; the next successful write picks it up.
    }
  });
}

/** Write the table now. Throws only if the filesystem does. */
export function flushContractTable(): void {
  const current = table;
  if (!current) return;
  current.updatedAt = new Date().toISOString();
  writeJsonAtomically(contractTableFile(), current);
  lastWriteMs = Date.now();
  dirty = false;
}

/** The in-memory table, for tests and for a future read-side command. */
export function contractTableSnapshot(): ContractTable {
  return getTable();
}

/** Drop all in-memory state. Tests only — the next call reloads from disk. */
export function resetContractObserverForTests(): void {
  table = null;
  lastWriteMs = 0;
  dirty = false;
  approxBytes = 0;
  probesInFlight.clear();
}

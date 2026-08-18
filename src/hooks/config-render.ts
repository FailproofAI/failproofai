/**
 * Write our hook entries into a CLI's settings, from a template.
 *
 * This is one copy of what `integrations.ts` held eight times. The entry-building
 * differed only in field names; the MERGE — which is the part with teeth — was
 * near-identical prose repeated per CLI, and the repetition showed: of the eight,
 * only Claude pruned our entries from events it no longer installs. The other
 * seven left them behind forever, on every machine, with reinstalling unable to
 * clear them. Consolidating fixes that everywhere by construction.
 *
 * ## What it must never do
 *
 * Destroy anything that is not ours. The file belongs to the user and often to
 * another tool as well, so every step here is scoped to entries we can prove we
 * wrote:
 *
 * - a group holding somebody else's hooks is written back exactly as found;
 * - a group is dropped only when WE emptied it;
 * - a value that is not shaped like an event array is skipped rather than
 *   thrown on — it may be a newer vendor event, another tool's entry, or a
 *   typo, and throwing here aborts an install AFTER policies were recorded as
 *   enabled, leaving somebody believing they are covered while no hook was
 *   written at all.
 *
 * ## Where the command comes from
 *
 * Here, never the template. See `config-template.ts` for why that boundary
 * exists and what it is worth.
 */
import { FAILPROOFAI_HOOK_MARKER } from "./types";
import type { GroupShape, HookTemplate } from "./config-template";
import type { HookScope } from "./types";

export interface RenderContext {
  /** Absolute path to the failproofai binary, for user-scope installs. */
  binaryPath: string;
  scope: HookScope;
  /** The integration id, for the `--cli` flag. */
  cli: string;
}

type Entry = Record<string, unknown>;
type Group = { matcher?: string; hooks: Entry[] };

/**
 * The command a hook runs.
 *
 * Project scope resolves through npx so a checkout works on any machine that
 * clones it; user scope names the binary directly, because a user-scope hook
 * fires in sessions that have no project and no npx cache to rely on.
 */
function buildCommand(template: HookTemplate, event: string, ctx: RenderContext): string {
  const flag = template.cliFlag ? ` --cli ${ctx.cli}` : "";
  return ctx.scope === "project"
    ? `npx -y failproofai --hook ${event}${flag}`
    : `"${ctx.binaryPath}" --hook ${event}${flag}`;
}

/**
 * One hook entry, with fields in the order the previous writers emitted them.
 *
 * Exported because `buildHookEntry` is part of the Integration interface and is
 * tested directly per CLI — the entry a template produces has to be reachable
 * on its own, not only as a side effect of writing a whole file.
 */
export function buildTemplateEntry(template: HookTemplate, event: string, ctx: RenderContext): Entry {
  const entry: Entry = {};
  if (template.entryType !== undefined) entry.type = template.entryType;
  const command = buildCommand(template, event, ctx);
  for (const field of template.commandFields) entry[field] = command;
  if (template.timeout) entry[template.timeout.key] = template.timeout.seconds;
  if (template.marker) entry[FAILPROOFAI_HOOK_MARKER] = true;
  return entry;
}

/**
 * Is this entry one of ours?
 *
 * The marker where there is one. Where there is not — goose, whose file we own
 * outright and which parses it itself — the `--cli <id>` substring, which is the
 * same rule that integration already used.
 */
function isOurs(template: HookTemplate, entry: unknown, cli: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Entry;
  if (template.marker) return e[FAILPROOFAI_HOOK_MARKER] === true;
  return template.commandFields.some(
    (field) => typeof e[field] === "string" && (e[field] as string).includes(`--cli ${cli}`),
  );
}

function shapeFor(template: HookTemplate, key: string): GroupShape {
  const isTool = (template.toolEvents ?? []).includes(key);
  return isTool ? template.group.tool : template.group.other;
}

function matcherFor(template: HookTemplate, key: string): string | undefined {
  if (!template.matcher) return undefined;
  if (template.matcher.on === "all") return template.matcher.value;
  return (template.toolEvents ?? []).includes(key) ? template.matcher.value : undefined;
}

/** The object holding the per-event arrays, created if absent. */
function containerOf(settings: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let node = settings;
  for (const key of path) {
    const next = node[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  return node;
}

/**
 * Remove our entries from events this build no longer installs.
 *
 * Without this an event we drop stays in the file forever and reinstalling
 * cannot clear it — which is exactly what a removed Claude event did once,
 * leaving a registered hook that broke a flag until somebody hand-edited it.
 * Only our own entries are touched.
 */
function prune(
  holder: Record<string, unknown>,
  installedKeys: ReadonlySet<string>,
  template: HookTemplate,
  cli: string,
): void {
  for (const key of Object.keys(holder)) {
    if (installedKeys.has(key)) continue;
    const value = holder[key];
    if (!Array.isArray(value)) continue;

    const kept: unknown[] = [];
    for (const item of value) {
      // A flat entry of ours goes; anyone else's stays.
      if (!item || typeof item !== "object") {
        if (item !== undefined) kept.push(item);
        continue;
      }
      const group = item as Group;
      if (!Array.isArray(group.hooks)) {
        if (!isOurs(template, group, cli)) kept.push(group);
        continue;
      }
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !isOurs(template, h, cli));
      // Drop a group only when WE emptied it. One that never held anything of
      // ours is somebody else's and is written back exactly as found.
      if (!(group.hooks.length === 0 && before > 0)) kept.push(group);
    }
    holder[key] = kept;
    if (kept.length === 0) delete holder[key];
  }
}

/**
 * Replace our entry in place if it is already there, else append it.
 *
 * Throws when an event we install holds something that is not an array. That is
 * deliberate and it is what the previous writers did — the alternative is
 * discarding a value we do not understand, which may be another tool's config,
 * and doing it silently. Refusing surfaces as `unreadable` in drift detection,
 * which exists to say "our own writer cannot process this file, a human must
 * look" and which repair then declines to touch.
 *
 * Note the asymmetry with `prune`, which skips such values instead: there the
 * event is one we do NOT install, so leaving somebody else's value alone is the
 * whole point, and throwing would let an unrelated key abort an install.
 */
function upsert(holder: Record<string, unknown>, key: string, entry: Entry, shape: GroupShape, matcher: string | undefined, template: HookTemplate, cli: string): void {
  const existing = holder[key];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new TypeError(`${key} holds ${typeof existing}, not a list of hooks`);
  }
  const list: unknown[] = Array.isArray(existing) ? existing : [];
  holder[key] = list;

  if (shape === "flat") {
    const at = list.findIndex((item) => isOurs(template, item, cli));
    if (at >= 0) list[at] = entry;
    else list.push(entry);
    return;
  }

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const group = item as Group;
    if (!Array.isArray(group.hooks)) continue;
    const at = group.hooks.findIndex((h) => isOurs(template, h, cli));
    if (at >= 0) {
      // Replaced in place, keeping the group and its position — the user may
      // have put their own hooks beside ours in it.
      group.hooks[at] = entry;
      return;
    }
  }
  list.push(matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] });
}

/**
 * Write this build's hook entries into `settings`, in place.
 *
 * Mutates rather than returns, because it merges into a file the caller already
 * read and must write back whole — anything it does not understand has to
 * survive the round trip.
 */
export function renderConfig(
  template: HookTemplate,
  settings: Record<string, unknown>,
  ctx: RenderContext,
): void {
  for (const key of template.dropKeys ?? []) delete settings[key];
  for (const [key, value] of Object.entries(template.fileDefaults ?? {})) {
    if (settings[key] === undefined) settings[key] = value;
  }

  const holder = containerOf(settings, template.container);
  const keyFor = (event: string): string => template.keyMap?.[event] ?? event;
  const installedKeys = new Set(template.events.map(keyFor));

  prune(holder, installedKeys, template, ctx.cli);

  for (const event of template.events) {
    const key = keyFor(event);
    upsert(
      holder,
      key,
      buildTemplateEntry(template, event, ctx),
      shapeFor(template, key),
      matcherFor(template, key),
      template,
      ctx.cli,
    );
  }
}

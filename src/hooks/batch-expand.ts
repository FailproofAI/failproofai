/**
 * Expand a CLI's BATCH tool call into per-element canonical scalar inputs.
 *
 * failproofai's builtins read SCALARS — `tool_input.command`, `.file_path`,
 * `.pattern`, `.old_string`. Cline delivers ARRAYS: `run_commands{commands[]}`,
 * `read_files{files[]}`, `search_codebase{queries[]}`, plus one multi-file blob
 * in `apply_patch{input}`. With only a key rename, `block-sudo`,
 * `block-env-files`, `block-secrets-write`, `block-force-push` and
 * `block-read-outside-cwd` all read `undefined` and ALLOW SILENTLY — the
 * inert-hook failure this repo has already shipped twice (grok, and our own
 * Claude hooks running inside grok).
 *
 * Joining the array into one string is NOT a fix, and the reason is specific:
 * `SECRET_FILE_RE` is `/\.(?:pem|key)$/`. Under any join only the LAST element
 * can ever match, so a `.pem` at `files[0]` rides straight through. That is why
 * this expands and the evaluator runs the policy set once per element.
 *
 * PURE: no evaluator import, no fs, no policy registry — so the audit path can
 * call it without dragging the policy engine along.
 *
 * CONTAINMENT: returns null for every CLI except cline and every tool except
 * cline's four containers. `null` means "take the existing single-shot path,
 * byte-for-byte unchanged", so this cannot regress the other 15 integrations.
 */
import type { IntegrationType } from "./types";
import {
  ENV_FILE_PATH_RE,
  SECRET_FILE_RE,
  SECRET_FILE_ID_RSA_RE,
  SECRET_FILE_CREDENTIALS_RE,
} from "./risk-patterns";

export interface FanoutElement {
  /** Canonical SCALAR tool input: {command} | {file_path,…} | {pattern} |
   *  {file_path, old_string, new_string, patch}. */
  input: Record<string, unknown>;
  /** Short human locator; goes into the deny message and the activity row. */
  label: string;
  index: number;
  /** True when this element is a COLLAPSE of several that the cap or the
   *  wall-clock budget refused to run apart. A weaker guarantee we state
   *  explicitly, never a silent skip. */
  degraded?: boolean;
}

export interface BatchExpansion {
  /** Canonical tool name (Bash | Read | Grep | Edit). */
  tool: string;
  elements: FanoutElement[];
  /** The un-expanded original, so a batch-aware policy still sees the whole call. */
  raw: Record<string, unknown>;
}

/**
 * The separator used wherever a command list still has to collapse to one
 * string. `" &&\n"` is DERIVED, not chosen:
 *   • `"\n"` alone silently disables `READ_LIKE_CMDS` — its boundary
 *     alternation `(?:^|;|&&|\|\||\|)` contains no newline, so a batched
 *     `cat /etc/passwd` stops looking read-like and `block-read-outside-cwd`
 *     never inspects it.
 *   • `" && "` alone manufactures a FALSE deny: a `.`-based lookahead can cross
 *     the boundary and fire on two commands neither of which triggers it alone.
 * `" &&\n"` keeps every `&&`-aware segmenter alive while the newline stops
 * `.`-based lookaheads crossing a boundary.
 */
export const BATCH_JOIN = " &&\n";

function omit(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = o;
  return rest;
}

export function expandBatchToolInput(
  cli: IntegrationType,
  toolName: string | undefined,
  rawInput: unknown,
): BatchExpansion | null {
  if (cli !== "cline" || !toolName) return null;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const raw = rawInput as Record<string, unknown>;

  // An expansion to ZERO elements would evaluate nothing and report a clean
  // allow — the exact inert-hook failure this exists to prevent. So an empty or
  // mis-shaped container returns null and falls back to the collapse safety net
  // in canonicalizeClineToolInput, which at least still reads SOMETHING.
  const mk = (
    parts: Array<{ input: Record<string, unknown>; label: string }>,
  ): BatchExpansion | null =>
    parts.length === 0
      ? null
      : { tool: toolName, raw, elements: parts.map((e, index) => ({ ...e, index })) };

  switch (toolName) {
    // run_commands {commands: ["cd '<dir>' && ls -la", …]}
    case "Bash": {
      const cmds = raw.commands;
      if (!Array.isArray(cmds)) return null;
      return mk(
        cmds
          .filter((c): c is string => typeof c === "string")
          .map((c) => ({ input: { ...omit(raw, "commands"), command: c }, label: c })),
      );
    }
    // read_files {files: [{path, start_line, …}, …]}
    case "Read": {
      const files = raw.files;
      if (!Array.isArray(files)) return null;
      return mk(
        files.flatMap((f) => {
          if (!f || typeof f !== "object" || Array.isArray(f)) return [];
          const e = f as Record<string, unknown>;
          if (typeof e.path !== "string") return [];
          // Spread the entry so start_line/limit survive for policies that read
          // them; `path` is KEPT too, because a cline-aware custom policy may
          // already be reading it.
          return [{ input: { ...e, file_path: e.path }, label: e.path }];
        }),
      );
    }
    // search_codebase {queries: ["alpha", …]}
    case "Grep": {
      const qs = raw.queries;
      if (!Array.isArray(qs)) return null;
      return mk(
        qs
          .filter((q): q is string => typeof q === "string")
          .map((q) => ({ input: { ...omit(raw, "queries"), pattern: q }, label: q })),
      );
    }
    // apply_patch {input: "*** Begin Patch …"} — byte-identical to the OpenAI
    // apply_patch blob ori's `edit` tool carries, so this splitter is
    // back-portable to ori and closes ori's documented multi-file KNOWN GAP.
    case "Edit": {
      const blob = raw.input;
      if (typeof blob !== "string") return null;
      return mk(
        splitApplyPatch(blob).map((s) => ({
          input: {
            file_path: s.path,
            old_string: s.oldText,
            new_string: s.newText,
            patch: s.subPatch,
            cline_patch_op: s.op,
          },
          label: `${s.op} ${s.path}`,
        })),
      );
    }
    default:
      return null;
  }
}

export interface PatchSection {
  op: "add" | "update" | "delete" | "move";
  path: string;
  oldText: string;
  newText: string;
  /** A standalone, re-emittable patch for just this file. */
  subPatch: string;
}

const FILE_OP_RE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/;
const OPS: Record<string, PatchSection["op"]> = {
  "Add File": "add",
  "Update File": "update",
  "Delete File": "delete",
  "Move to": "move",
};
const HEADERS: Record<PatchSection["op"], string> = {
  add: "Add File",
  update: "Update File",
  delete: "Delete File",
  move: "Move to",
};

interface OpenSection {
  op: PatchSection["op"];
  path: string;
  body: string[];
}

function build(cur: OpenSection, op: PatchSection["op"], path: string): PatchSection {
  const minus: string[] = [];
  const plus: string[] = [];
  for (const l of cur.body) {
    if (l.startsWith("-")) minus.push(l.slice(1));
    else if (l.startsWith("+")) plus.push(l.slice(1));
  }
  return {
    op,
    path,
    oldText: minus.join("\n"),
    newText: plus.join("\n"),
    subPatch: ["*** Begin Patch", `*** ${HEADERS[op]}: ${path}`, ...cur.body, "*** End Patch"].join("\n"),
  };
}

/**
 * Split an OpenAI apply_patch blob into one section per file it touches.
 *
 * Serves BOTH cline's `apply_patch` and ori's `edit` — the format is identical,
 * and one implementation is what stops a third CLI adding a third regex.
 */
export function splitApplyPatch(patch: string): PatchSection[] {
  const out: PatchSection[] = [];
  let cur: OpenSection | null = null;

  for (const line of patch.split("\n")) {
    const m = FILE_OP_RE.exec(line);
    if (m) {
      const op = OPS[m[1]!]!;
      const path = m[2]!.trim();
      if (op === "move") {
        // `Move to:` is a RENAME MODIFIER on the preceding Update File, not an
        // independent op. We emit it as its OWN element anyway — deliberately —
        // so a rename INTO `.env` is seen by the path builtins. It inherits the
        // in-progress body so old/new_string stay right, and the Update element
        // is still emitted at the next flush. Cost: one rename yields two
        // elements. That is the trade: a duplicate row, never a missed path.
        // Flush the section being renamed FIRST, then emit the move, so paths
        // come out in literal file order — `Update File: a` + `Move to: b`
        // yields [a, b], never [b, a]. Getting this backwards silently changes
        // which path `pickRiskiestPath` and `file_path = paths[0]` land on.
        if (cur) {
          out.push(build(cur, cur.op, cur.path));
          out.push(build(cur, "move", path));
          cur = null;
        } else
          out.push({
            op: "move",
            path,
            oldText: "",
            newText: "",
            subPatch: `*** Begin Patch\n*** Move to: ${path}\n*** End Patch`,
          });
        continue;
      }
      if (cur) out.push(build(cur, cur.op, cur.path));
      cur = { op, path, body: [] };
      continue;
    }
    if (line.startsWith("*** ")) continue; // Begin Patch / End Patch / End of File
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(build(cur, cur.op, cur.path));
  return out;
}

/** Every path an apply_patch blob touches, in file order. */
export function applyPatchFilePaths(patch: string): string[] {
  return splitApplyPatch(patch).map((s) => s.path);
}

/**
 * When a path list must still collapse to ONE (the overflow tail, and the
 * non-fan-out safety net), pick the one a builtin is most likely to deny on
 * rather than element [0]. The probes IMPORT the real builtin regexes — a
 * second hand-maintained copy is how a bypass gets reintroduced by a builtin
 * edit nobody thought to mirror. Falls back to paths[0] when nothing matches.
 *
 * NOT the primary mechanism, and it cannot be: it runs before params are bound,
 * so `block-secrets-write`'s `additionalPatterns` and `block-read-outside-cwd`'s
 * `allowPaths` have no influence on it, and neither does any custom policy.
 * That is exactly why PreToolUse fans out instead of relying on this.
 */
export function pickRiskiestPath(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  for (const re of [
    ENV_FILE_PATH_RE,
    SECRET_FILE_RE,
    SECRET_FILE_ID_RSA_RE,
    SECRET_FILE_CREDENTIALS_RE,
  ]) {
    const hit = paths.find((p) => re.test(p));
    if (hit) return hit;
  }
  return paths[0];
}

/** Everything past the cap / budget, joined into ONE degraded element. It is
 *  still EVALUATED — a weaker guarantee we can state honestly, never a silent
 *  skip. */
export function collapseElements(tool: string, els: FanoutElement[]): FanoutElement {
  const first = els[0]!;
  const base = { label: `${els.length} collapsed`, index: first.index, degraded: true as const };
  switch (tool) {
    case "Bash":
      return {
        ...base,
        input: {
          ...first.input,
          command: els.map((e) => String(e.input.command ?? "")).join(BATCH_JOIN),
        },
      };
    case "Read":
    case "Edit": {
      const paths = els.map((e) => String(e.input.file_path ?? "")).filter(Boolean);
      return {
        ...base,
        input: { ...first.input, file_path: pickRiskiestPath(paths), cline_collapsed_paths: paths },
      };
    }
    case "Grep":
      return {
        ...base,
        input: { ...first.input, pattern: els.map((e) => String(e.input.pattern ?? "")).join("|") },
      };
    default:
      return { ...first, ...base };
  }
}

/**
 * Cline → canonical, for every path that does NOT fan out: PostToolUse, audit
 * replay, fail-closed shaping, and a policy reading `ctx.payload`. Derives the
 * best single scalar and PRESERVES the arrays under `cline_*` so a batch-aware
 * policy can still see everything.
 *
 * This is a SAFETY NET, not the enforcement mechanism: a collapse cannot make
 * an anchored regex match every element, which is precisely why PreToolUse fans
 * out instead. `pickRiskiestPath` is what makes the net worth having — element
 * [0] would silently miss a `.env` at `files[1]`.
 */
export function canonicalizeClineToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (toolName) {
    case "Bash": {
      const cs = input.commands;
      if (!Array.isArray(cs)) return input;
      const commands = cs.filter((c): c is string => typeof c === "string");
      if (commands.length === 0) return input;
      return { ...omit(input, "commands"), command: commands.join(BATCH_JOIN), cline_commands: commands };
    }
    case "Read": {
      const files = input.files;
      if (!Array.isArray(files)) return input;
      const paths = files
        .map((f) =>
          f && typeof f === "object" && !Array.isArray(f)
            ? (f as Record<string, unknown>).path
            : undefined,
        )
        .filter((p): p is string => typeof p === "string");
      if (paths.length === 0) return input;
      return {
        ...omit(input, "files"),
        file_path: pickRiskiestPath(paths),
        cline_files: files,
        cline_file_paths: paths,
      };
    }
    case "Grep": {
      const qs = input.queries;
      if (!Array.isArray(qs)) return input;
      const queries = qs.filter((q): q is string => typeof q === "string");
      if (queries.length === 0) return input;
      return { ...omit(input, "queries"), pattern: queries.join("|"), cline_queries: queries };
    }
    case "Edit": {
      const blob = input.input;
      if (typeof blob !== "string") return input;
      const sections = splitApplyPatch(blob);
      if (sections.length === 0) return input;
      const paths = sections.map((s) => s.path);
      return {
        ...input,
        patch: blob,
        file_path: pickRiskiestPath(paths),
        old_string: sections.map((s) => s.oldText).join("\n"),
        new_string: sections.map((s) => s.newText).join("\n"),
        cline_patch_files: paths,
      };
    }
    default:
      return input;
  }
}

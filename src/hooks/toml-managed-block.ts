/**
 * A comment-delimited block that failproofai owns inside someone else's TOML.
 *
 * There is no comment-preserving TOML writer in the dependency tree (smol-toml
 * parses and stringifies, and stringifying drops every comment), and a full one
 * is far more than failproofai needs: it only ever adds or removes ITS OWN
 * table. So the table goes between two marker comments, appended at the end of
 * the file, and every byte outside the markers is kept exactly as it was.
 * Appending at the end is always valid placement for a `[table]` header: TOML
 * root keys must come before the first table, so nothing of the user's can be
 * captured by our header.
 *
 * Callers validate the merged text with smol-toml before writing it; this
 * module only splices text.
 */

export interface TomlBlockMarkers {
  begin: string;
  end: string;
}

type BlockSpan = { start: number; end: number } | null | "malformed";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBlock(text: string, markers: TomlBlockMarkers): BlockSpan {
  const begin = new RegExp(`^${escapeRe(markers.begin)}[ \\t]*\\r?$`, "m").exec(text);
  if (!begin) {
    return new RegExp(`^${escapeRe(markers.end)}[ \\t]*\\r?$`, "m").test(text) ? "malformed" : null;
  }
  const endRe = new RegExp(`^${escapeRe(markers.end)}[ \\t]*\\r?$`, "mg");
  endRe.lastIndex = begin.index + begin[0].length;
  const end = endRe.exec(text);
  if (!end) return "malformed";
  let stop = end.index + end[0].length;
  if (text[stop] === "\n") stop++;
  return { start: begin.index, end: stop };
}

/** Whether `text` holds a complete block. A half block (one marker) throws. */
export function hasTomlManagedBlock(text: string, markers: TomlBlockMarkers): boolean {
  const span = findBlock(text, markers);
  if (span === "malformed") throw new Error(`a failproofai marker (${markers.begin}) is missing its pair`);
  return span !== null;
}

/** The block's own text (markers included), or null when there is none. */
export function readTomlManagedBlock(text: string, markers: TomlBlockMarkers): string | null {
  const span = findBlock(text, markers);
  if (span === "malformed") throw new Error(`a failproofai marker (${markers.begin}) is missing its pair`);
  return span ? text.slice(span.start, span.end) : null;
}

/**
 * Put `block` into `original` (replacing ours in place when it is there), or
 * take ours out when `block` is null. A new block is appended after one blank
 * line, which removal takes back out, so add-then-remove on a file that ended
 * in a newline returns it byte for byte.
 */
export function mergeTomlManagedBlock(original: string, block: string | null, markers: TomlBlockMarkers): string {
  const span = findBlock(original, markers);
  if (span === "malformed") throw new Error(`a failproofai marker (${markers.begin}) is missing its pair`);
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

/** A TOML basic string. JSON's string escapes are a subset of TOML's. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

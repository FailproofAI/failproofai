/**
 * A small, quote-aware shell analyser for the hard-floor builtins
 * (`floor-policies.ts`).
 *
 * The floor policies exist because a semantic judge (Jev) misses a known set of
 * commands — `dd`/`mkfs`, mass kills, `--no-verify`, `R=/bin/rm; $R -rf …`.
 * A regex over the raw command string misses them too, in the other direction:
 * it cannot tell `rm` in command position from `rm` inside a commit message, and
 * it cannot follow a variable at all. So this file does the one thing both lack:
 * it lexes the command the way a POSIX shell would, far enough to say which
 * program runs with which words, and what a variable in command position was
 * set to earlier in the same command.
 *
 * ## Why not `scanCommand` (semantic/facts.ts)
 *
 * `scanCommand` is the quote-aware scanner the Jev envelope uses, and it is the
 * right tool there. It is not enough here, for three reasons:
 * - it truncates at `MAX_SCAN_CHARS` (8 KiB). A hard floor cannot have a blind
 *   spot at byte 8,193;
 * - it returns words with quoting already removed, so a quoted `"$R"` and a
 *   literal `$R` are indistinguishable, and a glob cannot be told from a
 *   quoted asterisk;
 * - it does not open `$( … )`, backticks, subshells or heredocs, which is where
 *   the commands these policies look for are hidden.
 *
 * ## What it is not
 *
 * It is not a shell. Anything that needs the shell to EXECUTE something to
 * reconstruct a name — base64 through a pipe, a script on disk, an alias, a
 * value set by an earlier tool call — stays out of reach, as it does for every
 * other builtin. What it resolves is limited to what the same command string
 * states: assignments, `export`, `for … in`, `read <<<`, `set --`, array
 * literals, `${X:-default}`, and `$(echo …)` / `$(which …)`-style substitutions.
 *
 * Everything is linear in the input apart from bounded recursion into
 * substitutions (`MAX_DEPTH`) and a bounded candidate set per word
 * (`MAX_CANDIDATES`). It never throws on malformed input: an unterminated quote
 * or substitution runs to the end of the string.
 */
import { posix } from "node:path";

// ── Lexer ───────────────────────────────────────────────────────────────────

/** One piece of a shell word. */
export type WordPart =
  /** Literal text. `quoted` when it came from quotes or a backslash escape. `ansi` for `$'…'` with escapes. */
  | { kind: "lit"; text: string; quoted: boolean; ansi?: boolean }
  /** `$X`, `${X}`, `${X:-default}`, `${!X}`, `${X[@]}`. `op` is "" for a plain reference. */
  | { kind: "param"; name: string; op: string; arg: string; indirect: boolean; source: string }
  /** `$( … )`, backticks, or a process substitution. */
  | { kind: "sub"; body: string; source: string }
  /** `$(( … ))`. */
  | { kind: "arith"; source: string };

export interface ShellWord {
  parts: WordPart[];
  /** Literal text with quotes removed; expansions kept verbatim as source. */
  text: string;
  /** Set on a redirection operator word (`>`, `2>>`, `<<<`, `&>`, `<<`). */
  redirect?: string;
  /** Set on a heredoc delimiter word: the heredoc's body. */
  heredoc?: { body: string; quoted: boolean };
}

export interface SimpleCommand {
  words: ShellWord[];
  /** The previous simple command's output is piped into this one. */
  pipedFrom?: SimpleCommand;
}

/** How deep the lexer follows `$( … )` inside `$( … )`, and `bash -c` inside `bash -c`. */
const MAX_DEPTH = 6;
/** Candidate values kept per word and per variable. */
const MAX_CANDIDATES = 16;
/** Nested `"$( "$( … )" )"` levels the bracket matcher recurses through. */
const MAX_NESTING = 64;

function makeWord(parts: WordPart[]): ShellWord {
  let text = "";
  for (const p of parts) text += p.kind === "lit" ? p.text : p.source;
  return { parts, text };
}

/** Read a heredoc delimiter starting at `j` (after `<<`/`<<-`). */
function readHeredocDelimiter(src: string, j: number): { delim: string; quoted: boolean; end: number } {
  const n = src.length;
  while (src[j] === " " || src[j] === "\t") j++;
  let delim = "";
  let quoted = false;
  while (j < n && !/[\s;&|<>()]/.test(src[j])) {
    const d = src[j];
    if (d === "'" || d === '"') {
      quoted = true;
      const end = src.indexOf(d, j + 1);
      const stop = end === -1 ? n : end;
      delim += src.slice(j + 1, stop);
      j = stop + 1;
      continue;
    }
    if (d === "\\") {
      quoted = true;
      if (j + 1 < n) delim += src[j + 1];
      j += 2;
      continue;
    }
    delim += d;
    j++;
  }
  return { delim, quoted, end: j };
}

/** Where a heredoc body that starts at `start` ends, and where reading resumes after its delimiter line. */
function heredocExtent(src: string, start: number, delim: string, stripTabs: boolean): { bodyEnd: number; next: number } {
  const n = src.length;
  let pos = start;
  while (pos <= n) {
    const nl = src.indexOf("\n", pos);
    const lineEnd = nl === -1 ? n : nl;
    let line = src.slice(pos, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delim) return { bodyEnd: pos, next: nl === -1 ? n : nl + 1 };
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { bodyEnd: n, next: n };
}

/** Index of the closing quote of the double-quoted string opening at `open`, or `src.length`. */
function skipDouble(src: string, open: number, nesting = 0): number {
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === '"') return j;
    else if (c === "$" && src[j + 1] === "(") j = matchClose(src, j + 1, "(", ")", true, nesting + 1);
    else if (c === "$" && src[j + 1] === "{") j = matchClose(src, j + 1, "{", "}", false, nesting + 1);
    else if (c === "`") j = skipBacktick(src, j);
  }
  return src.length;
}

function skipBacktick(src: string, open: number): number {
  let j = open + 1;
  while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
  return Math.min(j, src.length);
}

/**
 * Index of the `closeCh` matching the `openCh` at `open`, or `src.length` when
 * unbalanced. Aware of quotes, nested substitutions inside double quotes, and —
 * inside `( … )` — comments and heredocs, whose text may hold an apostrophe or
 * a paren that is not syntax: `$(cat <<'EOF' … Don't … EOF)` is how agents
 * write commit messages.
 */
function matchClose(
  src: string, open: number, openCh: string, closeCh: string, script = openCh === "(", nesting = 0,
): number {
  // Quotes inside substitutions inside quotes recurse. Past this depth the rest
  // of the string is the body: the analysis then runs out of MAX_DEPTH and marks
  // itself truncated, rather than the recursion blowing the stack.
  if (nesting > MAX_NESTING) return src.length;
  let depth = 0;
  let wordStart = true;
  const pending: Array<{ delim: string; stripTabs: boolean }> = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      wordStart = false;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return src.length;
      i = end;
      wordStart = false;
      continue;
    }
    if (c === '"') {
      i = skipDouble(src, i, nesting);
      wordStart = false;
      continue;
    }
    if (c === "`") {
      i = skipBacktick(src, i);
      wordStart = false;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      // ANSI-C `$'it\'s'`: a backslash escapes the quote.
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      i = j;
      wordStart = false;
      continue;
    }
    if (script && c === "#" && wordStart) {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return src.length;
      i = nl - 1;
      continue;
    }
    if (script && c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const stripTabs = src[i + 2] === "-";
      const d = readHeredocDelimiter(src, i + (stripTabs ? 3 : 2));
      pending.push({ delim: d.delim, stripTabs });
      i = d.end - 1;
      wordStart = false;
      continue;
    }
    if (c === "\n" && pending.length) {
      let pos = i + 1;
      for (const h of pending) pos = heredocExtent(src, pos, h.delim, h.stripTabs).next;
      pending.length = 0;
      i = pos - 1;
      wordStart = true;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    wordStart = /[\s;&|()]/.test(c);
  }
  return src.length;
}

/** Decode a `$'…'` body the way bash does. Malformed escapes are left as written. */
export function decodeAnsiC(body: string): string {
  return body.replace(
    /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/g,
    (_, seq: string) => {
      try {
        if (seq[0] === "x") return String.fromCharCode(parseInt(seq.slice(1), 16));
        if (seq[0] === "u" || seq[0] === "U") return String.fromCodePoint(parseInt(seq.slice(1), 16));
        if (/^[0-7]+$/.test(seq)) return String.fromCharCode(parseInt(seq, 8) & 0xff);
      } catch {
        return seq;
      }
      const named: Record<string, string> = {
        a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n",
        r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
      };
      return named[seq] ?? seq;
    },
  );
}

const PARAM_NAME_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/;
const PARAM_OPS = [":-", ":=", ":+", ":?", "-", "=", "+", "?"];

function parseParam(inner: string, source: string): WordPart {
  let body = inner;
  let indirect = false;
  if (body.startsWith("!") && body.length > 1) {
    indirect = true;
    body = body.slice(1);
  } else if (body.startsWith("#") && body.length > 1) {
    // `${#X}` is a length: a number, never a program name.
    return { kind: "param", name: body.slice(1), op: "len", arg: "", indirect: false, source };
  }
  const m = PARAM_NAME_RE.exec(body);
  if (!m) return { kind: "param", name: "", op: "other", arg: body, indirect, source };
  let rest = body.slice(m[0].length);
  // An array subscript: `${A[@]}`, `${A[0]}`. Resolved as the array's first element.
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  if (rest === "") return { kind: "param", name: m[0], op: "", arg: "", indirect, source };
  for (const op of PARAM_OPS) {
    if (rest.startsWith(op)) return { kind: "param", name: m[0], op, arg: rest.slice(op.length), indirect, source };
  }
  return { kind: "param", name: m[0], op: "other", arg: rest, indirect, source };
}

/**
 * Lex a command string into simple commands. Commands inside `$( … )`,
 * backticks, process substitutions and unquoted heredoc bodies are lexed too
 * and appended — they execute just as surely as the outer command does.
 */
export function lexShell(src: string, depth = 0, state?: { truncated: boolean }): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const nested: string[] = [];
  const heredocs: Array<{ word: ShellWord; stripTabs: boolean; quoted: boolean }> = [];
  let words: ShellWord[] = [];
  let parts: WordPart[] = [];
  let inWord = false;
  let pipeNext = false;
  /**
   * `case WORD in PATTERN|PATTERN) BODY ;; … esac`: patterns are data, and the
   * `|` and `)` inside them are not a pipe and a subshell end. One entry per
   * open `case`; "head" until its `in`, then alternating "patterns"/"body".
   */
  const caseStack: Array<"head" | "patterns" | "body"> = [];
  const n = src.length;

  const addLit = (text: string, quoted: boolean, ansi = false) => {
    inWord = true;
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === "lit" && last.quoted === quoted && !last.ansi && !ansi) {
      last.text += text;
    } else {
      parts.push(ansi ? { kind: "lit", text, quoted, ansi } : { kind: "lit", text, quoted });
    }
  };
  const endWord = () => {
    if (inWord) {
      const word = makeWord(parts);
      const only = parts[0];
      const bare = parts.length === 1 && only.kind === "lit" && !only.quoted ? only.text : null;
      const top = caseStack[caseStack.length - 1];
      if (top === "patterns") {
        // A pattern is dropped; only `esac` in command position means anything here.
        if (bare === "esac" && words.length === 0) {
          caseStack.pop();
          words.push(word);
        }
      } else {
        // In command position: first word, or after reserved words (`do case …`).
        const commandPosition = words.every((w) => LEADING_RESERVED.has(literalText(w) ?? ""));
        words.push(word);
        if (commandPosition && bare === "case") caseStack.push("head");
        else if (top === "head" && bare === "in") caseStack[caseStack.length - 1] = "patterns";
        else if (top === "body" && commandPosition && bare === "esac") caseStack.pop();
      }
    }
    parts = [];
    inWord = false;
  };
  const inCasePatterns = () => caseStack[caseStack.length - 1] === "patterns";
  const endCommand = (pipe = false) => {
    endWord();
    if (words.length) {
      const cmd: SimpleCommand = { words };
      if (pipeNext && out.length > 0) cmd.pipedFrom = out[out.length - 1];
      out.push(cmd);
      pipeNext = pipe;
    } else if (!pipe) {
      pipeNext = false;
    }
    words = [];
  };
  const pushOperator = (op: string) => {
    endWord();
    words.push({ parts: [{ kind: "lit", text: op, quoted: false }], text: op, redirect: op });
  };

  const readBacktick = (i: number): number => {
    let body = "";
    let j = i + 1;
    while (j < n && src[j] !== "`") {
      if (src[j] === "\\" && j + 1 < n && "`\\$".includes(src[j + 1])) {
        body += src[j + 1];
        j += 2;
        continue;
      }
      body += src[j];
      j++;
    }
    nested.push(body);
    inWord = true;
    parts.push({ kind: "sub", body, source: src.slice(i, Math.min(j + 1, n)) });
    return j + 1;
  };

  const readDollar = (i: number, quoted: boolean): number => {
    const c = src[i + 1];
    if (c === "'" && !quoted) {
      let j = i + 2;
      while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      const body = src.slice(i + 2, Math.min(j, n));
      addLit(decodeAnsiC(body), true, body.includes("\\"));
      return j + 1;
    }
    if (c === '"' && !quoted) return readDouble(i + 1);
    if (c === "(" && src[i + 2] === "(") {
      const end = matchClose(src, i + 1, "(", ")", false);
      inWord = true;
      parts.push({ kind: "arith", source: src.slice(i, Math.min(end + 1, n)) });
      return end + 1;
    }
    if (c === "(") {
      const end = matchClose(src, i + 1, "(", ")");
      const body = src.slice(i + 2, end);
      nested.push(body);
      inWord = true;
      parts.push({ kind: "sub", body, source: src.slice(i, Math.min(end + 1, n)) });
      return end + 1;
    }
    if (c === "{") {
      const end = matchClose(src, i + 1, "{", "}");
      const inner = src.slice(i + 2, end);
      const part = parseParam(inner, src.slice(i, Math.min(end + 1, n)));
      // `${X:-$(cmd)}` runs cmd when X is unset.
      if (part.kind === "param" && /\$\(|`/.test(part.arg)) nested.push(part.arg);
      inWord = true;
      parts.push(part);
      return end + 1;
    }
    const m = c === undefined ? null : PARAM_NAME_RE.exec(src.slice(i + 1, i + 1 + 256));
    if (m) {
      // `$10` is `${1}0` in POSIX; a single digit is enough for what this reads.
      const name = /^[0-9]/.test(m[0]) ? m[0][0] : m[0];
      inWord = true;
      parts.push({ kind: "param", name, op: "", arg: "", indirect: false, source: "$" + name });
      return i + 1 + name.length;
    }
    addLit("$", quoted);
    return i + 1;
  };

  const readDouble = (i: number): number => {
    inWord = true;
    let j = i + 1;
    while (j < n && src[j] !== '"') {
      const c = src[j];
      if (c === "\\" && j + 1 < n) {
        const next = src[j + 1];
        if (next === "\n") {
          j += 2;
          continue;
        }
        if ("$`\"\\".includes(next)) {
          addLit(next, true);
          j += 2;
          continue;
        }
        addLit("\\", true);
        j++;
        continue;
      }
      if (c === "$") {
        j = readDollar(j, true);
        continue;
      }
      if (c === "`") {
        j = readBacktick(j);
        continue;
      }
      addLit(c, true);
      j++;
    }
    return j + 1;
  };

  const readRedirect = (i: number): number => {
    // An all-digit word right before the operator is its fd number: `2>`.
    let fd = "";
    const only = parts[0];
    if (inWord && parts.length === 1 && only.kind === "lit" && !only.quoted && /^\d+$/.test(only.text)) {
      fd = only.text;
      parts = [];
      inWord = false;
    } else {
      endWord();
    }
    const c = src[i];
    if (src[i + 1] === "(" && !fd) {
      // Process substitution: `<( … )` / `>( … )` runs its body.
      const end = matchClose(src, i + 1, "(", ")");
      const body = src.slice(i + 2, end);
      nested.push(body);
      inWord = true;
      parts.push({ kind: "sub", body, source: src.slice(i, Math.min(end + 1, n)) });
      return end + 1;
    }
    let op: string = c;
    let j = i + 1;
    if (c === "<") {
      if (src[j] === "<") {
        op = "<<";
        j++;
        if (src[j] === "<") {
          op = "<<<";
          j++;
        } else if (src[j] === "-") {
          op = "<<-";
          j++;
        }
      } else if (src[j] === ">" || src[j] === "&") {
        op += src[j];
        j++;
      }
    } else if (src[j] === ">" || src[j] === "|" || src[j] === "&") {
      op += src[j];
      j++;
    }
    pushOperator(fd + op);
    if (op === "<<" || op === "<<-") {
      const { delim, quoted, end } = readHeredocDelimiter(src, j);
      j = end;
      const word: ShellWord = { parts: [{ kind: "lit", text: delim, quoted: true }], text: delim };
      words.push(word);
      heredocs.push({ word, stripTabs: op === "<<-", quoted });
    }
    return j;
  };

  /** Consume the bodies of pending heredocs starting at `start` (just after a newline). */
  const consumeHeredocs = (start: number): number => {
    let pos = start;
    for (const h of heredocs) {
      const bodyStart = pos;
      const { bodyEnd, next } = heredocExtent(src, pos, h.word.text, h.stripTabs);
      const body = src.slice(bodyStart, bodyEnd);
      h.word.heredoc = { body, quoted: h.quoted };
      // An unquoted heredoc still expands `$( … )` and backticks. Its plain
      // text is data, not commands.
      if (!h.quoted) nested.push(...substitutionsIn(body));
      pos = next;
    }
    heredocs.length = 0;
    return pos;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (src[i + 1] === "\r" && src[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (i + 1 < n) {
        addLit(src[i + 1], true);
        i += 2;
        continue;
      }
      addLit("\\", true);
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      addLit(src.slice(i + 1, stop), true);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i = readDouble(i);
      continue;
    }
    if (c === "$") {
      i = readDollar(i, false);
      continue;
    }
    if (c === "`") {
      i = readBacktick(i);
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "\n") {
      endCommand();
      i = heredocs.length ? consumeHeredocs(i + 1) : i + 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (c === ";") {
      endCommand();
      if (caseStack[caseStack.length - 1] === "body" && (src[i + 1] === ";" || src[i + 1] === "&")) {
        // `;;`, `;&`, `;;&` close a case arm: the next words are patterns again.
        caseStack[caseStack.length - 1] = "patterns";
        i += src[i + 1] === ";" && src[i + 2] === "&" ? 3 : 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === ">") {
        const op = src[i + 2] === ">" ? "&>>" : "&>";
        pushOperator(op);
        i += op.length;
        continue;
      }
      endCommand();
      i++;
      continue;
    }
    if (c === "|" && inCasePatterns()) {
      endWord();
      i++;
      continue;
    }
    if (c === "|") {
      const isOr = src[i + 1] === "|";
      endCommand(!isOr);
      i += isOr ? 2 : src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "<" || c === ">") {
      i = readRedirect(i);
      continue;
    }
    if ((c === "(" || c === ")") && inCasePatterns()) {
      // `(pattern)`: the optional open paren, then the close that starts the arm.
      endWord();
      if (c === ")") {
        endCommand();
        caseStack[caseStack.length - 1] = "body";
      }
      i++;
      continue;
    }
    if (c === "(") {
      const first = parts[0];
      if (inWord && parts.length === 1 && first.kind === "lit" && !first.quoted &&
          /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(first.text)) {
        // Array literal `A=(rm -rf /)`: kept inside the assignment word.
        const end = matchClose(src, i, "(", ")");
        addLit(src.slice(i, Math.min(end + 1, n)), true);
        i = end + 1;
        continue;
      }
      endCommand();
      i++;
      continue;
    }
    if (c === ")") {
      endCommand();
      i++;
      continue;
    }
    addLit(c, false);
    i++;
  }
  endCommand();

  if (depth < MAX_DEPTH) {
    for (const body of nested) out.push(...lexShell(body, depth + 1, state));
  } else if (nested.length && state) {
    state.truncated = true;
  }
  return out;
}

/** The bodies of `$( … )` and backtick substitutions in text that is otherwise data. */
function substitutionsIn(text: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const end = matchClose(text, i + 1, "(", ")");
      bodies.push(text.slice(i + 2, end));
      i = end;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      const end = matchClose(text, i + 1, "{", "}");
      bodies.push(...substitutionsIn(text.slice(i + 2, end)));
      i = end;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      bodies.push(text.slice(i + 1, j));
      i = j;
    }
  }
  return bodies;
}

// ── Words ───────────────────────────────────────────────────────────────────

/** The word's text when it is a plain literal (no expansion, glob, brace or `$'\x…'`), else null. */
export function literalText(word: ShellWord | undefined): string | null {
  if (!word) return null;
  if (word.text === "[" || word.text === "[[") return word.text;
  for (const p of word.parts) {
    if (p.kind !== "lit" || p.ansi) return null;
    if (!p.quoted && (/[*?[]/.test(p.text) || /\{[^}]*(?:,|\.\.)[^}]*\}/.test(p.text))) return null;
  }
  return word.text;
}

/** The leading literal text of a word, up to its first expansion. */
export function literalPrefix(word: ShellWord): string {
  let out = "";
  for (const p of word.parts) {
    if (p.kind !== "lit") break;
    out += p.text;
  }
  return out;
}

/** The word with its first `n` literal characters removed (for `of=…`-style operands). */
export function dropPrefix(word: ShellWord, count: number): ShellWord {
  const parts: WordPart[] = [];
  let left = count;
  for (const p of word.parts) {
    if (left > 0 && p.kind === "lit") {
      if (p.text.length <= left) {
        left -= p.text.length;
        continue;
      }
      parts.push({ ...p, text: p.text.slice(left) });
      left = 0;
      continue;
    }
    parts.push(p);
  }
  return makeWord(parts);
}

/** Program name as the policies compare it: basename, lower-cased, `.exe` dropped. */
export function normalizeName(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  const base = first.slice(Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\")) + 1);
  return base.toLowerCase().replace(/\.exe$/, "");
}

function isAssignmentWord(word: ShellWord): { name: string; value: ShellWord } | null {
  const first = word.parts[0];
  if (!first || first.kind !== "lit" || first.quoted) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/.exec(first.text);
  if (!m) return null;
  return { name: m[1], value: dropPrefix(word, m[0].length) };
}

/** Characters of a word with their quoting, expansions as a single dynamic marker. */
function charsOf(word: ShellWord): Array<{ ch: string; quoted: boolean; dynamic: boolean }> {
  const out: Array<{ ch: string; quoted: boolean; dynamic: boolean }> = [];
  for (const p of word.parts) {
    if (p.kind === "lit") for (const ch of p.text) out.push({ ch, quoted: p.quoted, dynamic: false });
    else out.push({ ch: "", quoted: false, dynamic: true });
  }
  return out;
}

/** A RegExp for the basename of a word that contains an unquoted glob, or null when it has none. */
export function basenameGlob(word: ShellWord): RegExp | null {
  const chars = charsOf(word);
  if (!chars.some((c) => !c.quoted && !c.dynamic && /[*?[]/.test(c.ch))) return null;
  let start = 0;
  chars.forEach((c, i) => {
    if (c.ch === "/" || c.ch === "\\") start = i + 1;
  });
  let src = "";
  for (let i = start; i < chars.length; i++) {
    const c = chars[i];
    if (c.dynamic) src += ".*";
    else if (!c.quoted && c.ch === "*") src += ".*";
    else if (!c.quoted && c.ch === "?") src += ".";
    else if (!c.quoted && c.ch === "[") {
      const close = chars.findIndex((d, k) => k > i + 1 && d.ch === "]");
      if (close === -1) {
        src += "\\[";
        continue;
      }
      let cls = "";
      for (let k = i + 1; k < close; k++) cls += chars[k].ch.replace(/[\\\]]/g, "\\$&");
      src += "[" + cls.replace(/^[!^]/, "^") + "]";
      i = close;
    } else src += c.ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp("^" + src + "$", "i");
  } catch {
    return /^.*$/;
  }
}

/** The first word an unquoted brace expansion produces (`{rm,-rf,/}` → `rm`), or null. */
export function firstBraceExpansion(word: ShellWord): string | null {
  const chars = charsOf(word);
  if (chars.some((c) => c.dynamic)) return null;
  let text = chars.map((c) => (c.quoted && /[{},]/.test(c.ch) ? "\u0000" : c.ch)).join("");
  if (!/\{[^}]*,[^}]*\}/.test(text)) return null;
  for (let round = 0; round < 16; round++) {
    const start = text.indexOf("{");
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    const alternatives: string[] = [];
    let current = "";
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") {
        depth++;
        if (depth === 1) continue;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      } else if (ch === "," && depth === 1) {
        alternatives.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    if (end === -1 || alternatives.length === 0) break;
    alternatives.push(current);
    text = text.slice(0, start) + alternatives[0] + text.slice(end + 1);
  }
  return text.replace(/\u0000/g, "");
}

// ── Analysis ────────────────────────────────────────────────────────────────

export interface Invocation {
  /** Candidate program names (normalized). Empty when the command word could not be resolved. */
  names: string[];
  /** The command word as written. */
  word: ShellWord;
  /** The words after it, redirections removed. */
  args: ShellWord[];
  /** Prefix assignments in front of it (`HUSKY=0 git commit`). */
  env: Array<{ name: string; value: ShellWord }>;
  /** The command word is not a plain literal: a variable, substitution, glob, brace expansion or `$'\x…'`. */
  indirect: boolean;
  /** The simple command this invocation came from. */
  command: SimpleCommand;
}

export interface ShellAnalysis {
  commands: SimpleCommand[];
  invocations: Invocation[];
  redirects: Array<{ op: string; target: ShellWord | undefined }>;
  /** Every value a name is given anywhere in the command. */
  bindings: Map<string, ShellWord[]>;
  /** Some `cd`/`pushd` in the command moves into `/dev`. */
  cdIntoDev: boolean;
  /**
   * The command nests substitutions, `bash -c` strings or runners deeper than
   * the analyser follows, so part of it was not looked at. No real command gets
   * here; a command built to hide what it runs can.
   */
  truncated: boolean;
}

/** Runner hops (`sudo nice timeout …`, `find -exec find -exec …`) followed per command. */
const MAX_HOPS = 32;

/** Per-analysis memo of resolved variable values, so resolution stays polynomial. */
const valueMemo = new WeakMap<ShellAnalysis, Map<string, string[] | null>>();

/** Programs that run another program given as their trailing words. */
const RUNNERS: Record<string, { withOperand: string[]; positional?: number; stopOn?: string[] }> = {
  sudo: {
    withOperand: ["-u", "-g", "-C", "-D", "-p", "-r", "-t", "-U", "-T", "--user", "--group",
      "--close-from", "--chdir", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--host"],
    stopOn: ["-e", "--edit", "-l", "--list", "-v", "--validate", "-V", "--version", "-h", "--help", "-K"],
  },
  doas: { withOperand: ["-u", "-C"] },
  env: { withOperand: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"] },
  nohup: { withOperand: [] },
  setsid: { withOperand: [] },
  builtin: { withOperand: [] },
  busybox: { withOperand: [] },
  unbuffer: { withOperand: [] },
  caffeinate: { withOperand: ["-t", "-w"] },
  time: { withOperand: ["-f", "--format", "-o", "--output"] },
  timeout: { withOperand: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  nice: { withOperand: ["-n", "--adjustment"] },
  ionice: { withOperand: ["-c", "--class", "-n", "--classdata", "-t"], stopOn: ["-p", "--pid", "-P", "--pgid", "-u", "--uid"] },
  stdbuf: { withOperand: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: {
    withOperand: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "--max-args",
      "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"],
  },
  command: { withOperand: [], stopOn: ["-v", "-V"] },
  exec: { withOperand: ["-a"] },
  chroot: { withOperand: ["--userspec", "--groups"], positional: 1 },
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "yash"]);
const SHELL_OPT_OPERAND = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const SSH_OPT_OPERAND = new Set("BbcDEeFIiJLlmOoPpQRSWw".split("").map((c) => "-" + c));
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Reserved words that may precede a command. */
const LEADING_RESERVED = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "coproc"]);
/** Reserved words whose command is not a program invocation. */
const NON_INVOCATION = new Set(["for", "case", "select", "function", "in", "esac", "done", "fi", "}"]);
const DECLARE_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly"]);

function bind(a: ShellAnalysis, name: string, value: ShellWord): void {
  const list = a.bindings.get(name) ?? [];
  if (list.length < MAX_CANDIDATES) list.push(value);
  a.bindings.set(name, list);
}

function litWord(text: string): ShellWord {
  return { parts: [{ kind: "lit", text, quoted: true }], text };
}

/** The first word of a text lexed as a command (`(rm -rf /)` → `rm`). */
function firstWordOf(text: string): ShellWord | null {
  const cmds = lexShell(text, MAX_DEPTH);
  return cmds[0]?.words.find((w) => !w.redirect) ?? null;
}

function splitRedirects(words: ShellWord[]): { plain: ShellWord[]; redirects: Array<{ op: string; target: ShellWord | undefined }> } {
  const plain: ShellWord[] = [];
  const redirects: Array<{ op: string; target: ShellWord | undefined }> = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.redirect) {
      const target = words[i + 1] && !words[i + 1].redirect ? words[i + 1] : undefined;
      redirects.push({ op: w.redirect, target });
      if (target) i++;
      continue;
    }
    plain.push(w);
  }
  return { plain, redirects };
}

function bindAssignment(a: ShellAnalysis, word: ShellWord): void {
  const asg = isAssignmentWord(word);
  if (!asg) return;
  const t = asg.value.text;
  if (asg.value.parts.length === 1 && t.startsWith("(") && t.endsWith(")")) {
    const first = firstWordOf(t.slice(1, -1));
    if (first) bind(a, asg.name, first);
    return;
  }
  bind(a, asg.name, asg.value);
}

function collectBindings(a: ShellAnalysis, cmd: SimpleCommand): void {
  const { plain: words, redirects } = splitRedirects(cmd.words);
  let i = 0;
  while (i < words.length && isAssignmentWord(words[i])) bindAssignment(a, words[i++]);
  if (i >= words.length) return;
  const head = literalText(words[i]);
  if (head === null) return;
  const rest = words.slice(i + 1);
  if (DECLARE_BUILTINS.has(head)) {
    for (const w of rest) bindAssignment(a, w);
  } else if ((head === "for" || head === "select") && rest.length > 1) {
    const name = literalText(rest[0]);
    if (name && /^[A-Za-z_]\w*$/.test(name) && literalText(rest[1]) === "in") {
      for (const w of rest.slice(2)) {
        if (literalText(w) === "do") break;
        bind(a, name, w);
      }
    }
  } else if (head === "read") {
    const here = redirects.find((r) => r.op === "<<<")?.target;
    if (!here) return;
    let isArray = false;
    for (let k = 0; k < rest.length; k++) {
      const t = literalText(rest[k]) ?? "";
      if (t === "-a") {
        isArray = true;
        const name = literalText(rest[k + 1]);
        if (name) {
          const first = firstWordOf(here.text);
          if (first) bind(a, name, first);
        }
        return;
      }
      if (/^-[dnNptu]$/.test(t)) {
        k++;
        continue;
      }
      if (t.startsWith("-")) continue;
      if (/^[A-Za-z_]\w*$/.test(t) && !isArray) {
        bind(a, t, here);
        return;
      }
    }
  } else if (head === "set" && rest.length > 0) {
    const first = literalText(rest[0]);
    const positional = first === "--" ? rest.slice(1) : first && !/^[-+]/.test(first) ? rest : [];
    positional.slice(0, 9).forEach((w, k) => bind(a, String(k + 1), w));
    if (positional[0]) {
      bind(a, "@", positional[0]);
      bind(a, "*", positional[0]);
    }
  } else if (head === "printf" && literalText(rest[0]) === "-v" && rest.length >= 3) {
    const name = literalText(rest[1]);
    const fmt = literalText(rest[2]);
    if (!name || fmt === null) return;
    if (!fmt.includes("%")) bind(a, name, litWord(fmt.replace(/\\n$/, "")));
    else if (/^%s(?:\\n)?$/.test(fmt) && rest[3]) bind(a, name, rest[3]);
  }
}

/**
 * Record the program a simple command runs, then follow whatever it wraps.
 *
 * Iterative over runners (`sudo nice timeout 5 rm …`) rather than recursive, so
 * a command stacking thousands of them cannot exhaust the stack — a throw here
 * would be swallowed by the evaluator and the hook would ALLOW.
 */
function walk(a: ShellAnalysis, words: ShellWord[], command: SimpleCommand, depth: number, hops = 0): void {
  let current = words;
  for (let hop = hops; hop < MAX_HOPS; hop++) {
    let i = 0;
    const env: Invocation["env"] = [];
    while (i < current.length) {
      const asg = isAssignmentWord(current[i]);
      if (asg) {
        env.push(asg);
        i++;
        continue;
      }
      const lit = literalText(current[i]);
      if (lit !== null && LEADING_RESERVED.has(lit)) {
        i++;
        continue;
      }
      break;
    }
    if (i >= current.length) return;
    const head = current[i];
    const headLit = literalText(head);
    if (headLit !== null && NON_INVOCATION.has(headLit)) return;
    const args = current.slice(i + 1);
    const { names, indirect } = headNames(a, head);
    const inv: Invocation = { names, word: head, args, env, indirect, command };
    a.invocations.push(inv);

    let next: ShellWord[] | null = null;
    for (const name of new Set(names.length ? names : [""])) {
      const wrapped = followRunner(a, name, inv, depth, hop);
      if (wrapped && !next) next = wrapped;
    }
    if (!next) return;
    current = next;
  }
  a.truncated = true;
}

function headNames(a: ShellAnalysis, head: ShellWord): { names: string[]; indirect: boolean } {
  const lit = literalText(head);
  if (lit !== null) return { names: [normalizeName(lit)], indirect: false };
  const names = new Set<string>();
  const brace = firstBraceExpansion(head);
  if (brace !== null) names.add(normalizeName(brace));
  else {
    const resolved = resolveWord(a, head);
    if (resolved) for (const r of resolved) names.add(normalizeName(r));
  }
  names.delete("");
  return { names: [...names], indirect: true };
}

/** Index in `args` where a runner's wrapped command starts, or -1 when it runs none. */
function wrappedStart(name: string, args: ShellWord[]): number {
  const spec = RUNNERS[name];
  let positional = spec.positional ?? 0;
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) return positional > 0 ? -1 : k;
    if (t === "--") return positional > 0 ? k + 1 + positional : k + 1;
    if (t.startsWith("-") && t.length > 1) {
      if (spec.stopOn?.includes(t)) return -1;
      if (spec.withOperand.includes(t)) {
        k++;
        continue;
      }
      continue;
    }
    if (positional > 0) {
      positional--;
      continue;
    }
    return k;
  }
  return -1;
}

function joinText(words: ShellWord[]): string {
  return words.map((w) => w.text).join(" ");
}

/**
 * Follow what a program runs on its behalf. Returns the wrapped words when the
 * program is a plain runner (`sudo`, `nice`, `xargs` …) so `walk` can
 * continue iteratively; everything else (a `-c` string, `eval`, `ssh`, a
 * `find -exec`, a shell reading stdin) is analysed here.
 */
function followRunner(a: ShellAnalysis, name: string, inv: Invocation, depth: number, hops: number): ShellWord[] | null {
  const args = inv.args;
  if (name in RUNNERS) {
    if (name === "env") {
      for (let k = 0; k < args.length; k++) {
        const t = literalText(args[k]);
        if ((t === "-S" || t === "--split-string") && args[k + 1]) {
          addSource(a, args[k + 1].text, depth + 1);
          return null;
        }
        if (t?.startsWith("--split-string=")) {
          addSource(a, t.slice("--split-string=".length), depth + 1);
          return null;
        }
      }
    }
    const start = wrappedStart(name, args);
    return start >= 0 && start < args.length ? args.slice(start) : null;
  }
  if (SHELLS.has(name) || (name === "" && inv.indirect)) {
    let sawC = false;
    let k = 0;
    for (; k < args.length; k++) {
      const t = literalText(args[k]);
      if (t === null) break;
      if (t === "--") {
        k++;
        break;
      }
      if (SHELL_OPT_OPERAND.has(t)) {
        k++;
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(t)) {
        if (t.startsWith("-") && t.includes("c")) sawC = true;
        // `-euo pipefail`: a bundle ending in o/O takes the next word.
        if (/[oO]$/.test(t)) k++;
        continue;
      }
      if (t.startsWith("--")) continue;
      break;
    }
    if (sawC) {
      if (args[k]) addSource(a, args[k].text, depth + 1);
      return null;
    }
    if (name === "") return null;
    // No `-c` and no script operand: the shell reads its program from stdin —
    // a here-string, a heredoc, or `echo … |`.
    if (k < args.length) return null;
    const { redirects } = splitRedirects(inv.command.words);
    for (const r of redirects) {
      if (r.op === "<<<" && r.target) addSource(a, r.target.text, depth + 1);
      if ((r.op === "<<" || r.op === "<<-") && r.target?.heredoc) addSource(a, r.target.heredoc.body, depth + 1);
    }
    const from = inv.command.pipedFrom;
    if (from) {
      const w = splitRedirects(from.words).plain;
      const producer = normalizeName(literalText(w[0]) ?? "");
      if (producer === "echo" || producer === "printf") {
        const body = w.slice(1).filter((x) => !/^-[neE]+$/.test(literalText(x) ?? ""));
        addSource(a, joinText(body).replace(/\\n/g, "\n"), depth + 1);
      }
    }
    return null;
  }
  switch (name) {
    case "eval":
      addSource(a, joinText(args), depth + 1);
      return null;
    case "ssh": {
      let k = 0;
      for (; k < args.length; k++) {
        const t = literalText(args[k]) ?? "";
        if (SSH_OPT_OPERAND.has(t)) {
          k++;
          continue;
        }
        if (t.startsWith("-")) continue;
        break;
      }
      const remote = args.slice(k + 1);
      if (remote.length) addSource(a, joinText(remote), depth + 1);
      return null;
    }
    case "find":
      for (let k = 0; k < args.length; k++) {
        if (!FIND_EXEC.has(literalText(args[k]) ?? "")) continue;
        let end = k + 1;
        while (end < args.length && !/^[;+]$/.test(literalText(args[end]) ?? "")) end++;
        if (hops + 1 >= MAX_HOPS) a.truncated = true;
        else walk(a, args.slice(k + 1, end), inv.command, depth, hops + 1);
        k = end;
      }
      return null;
    case "powershell":
    case "pwsh": {
      const k = args.findIndex((w) => /^[-/](?:c|command)$/i.test(literalText(w) ?? ""));
      if (k >= 0) addSource(a, joinText(args.slice(k + 1)), depth + 1);
      return null;
    }
    case "cmd": {
      const k = args.findIndex((w) => /^\/[ck]$/i.test(literalText(w) ?? ""));
      if (k >= 0) addSource(a, joinText(args.slice(k + 1)), depth + 1);
      return null;
    }
    case "cd":
    case "pushd": {
      const target = resolveWord(a, args.find((w) => !/^-/.test(w.text)) ?? litWord("~"));
      if (target?.some((t) => /^\/+dev(?:\/|$)/.test(t))) a.cdIntoDev = true;
      return null;
    }
  }
  return null;
}

function addSource(a: ShellAnalysis, src: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    a.truncated = true;
    return;
  }
  const commands = lexShell(src, depth, a);
  a.commands.push(...commands);
  for (const cmd of commands) collectBindings(a, cmd);
  for (const cmd of commands) {
    const { plain, redirects } = splitRedirects(cmd.words);
    a.redirects.push(...redirects);
    walk(a, plain, cmd, depth);
  }
}

/** Lex a command and work out every program it runs. */
export function analyzeShell(command: string): ShellAnalysis {
  const a: ShellAnalysis = {
    commands: [], invocations: [], redirects: [], bindings: new Map(), cdIntoDev: false, truncated: false,
  };
  addSource(a, command, 0);
  return a;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Every string a word can expand to, given what the same command assigned, or
 * null when some part of it cannot be known from the command string alone.
 */
export function resolveWord(a: ShellAnalysis, word: ShellWord, depth = 0, seen: ReadonlySet<string> = new Set()): string[] | null {
  if (depth > 6) return null;
  let acc = [""];
  for (const p of word.parts) {
    let opts: string[] | null;
    if (p.kind === "lit") opts = [p.text];
    else if (p.kind === "param") opts = resolveParam(a, p, depth, seen);
    else if (p.kind === "sub") opts = staticSubstitution(a, p.body, depth, seen);
    else opts = null;
    if (!opts || opts.length === 0) return null;
    const next: string[] = [];
    for (const x of acc) {
      for (const y of opts) {
        if (next.length < MAX_CANDIDATES) next.push(x + y);
      }
    }
    acc = next;
  }
  return acc;
}

function valuesOf(a: ShellAnalysis, name: string, depth: number, seen: ReadonlySet<string>): string[] | null {
  if (seen.has(name)) return null;
  const words = a.bindings.get(name);
  if (!words) return null;
  let memo = valueMemo.get(a);
  if (!memo) valueMemo.set(a, (memo = new Map()));
  if (memo.has(name)) return memo.get(name) ?? null;
  const result = computeValues(a, name, words, depth, seen);
  memo.set(name, result);
  return result;
}

function computeValues(a: ShellAnalysis, name: string, words: ShellWord[], depth: number, seen: ReadonlySet<string>): string[] | null {
  const inner = new Set(seen).add(name);
  const out: string[] = [];
  for (const w of words) {
    const r = resolveWord(a, w, depth + 1, inner);
    if (r) out.push(...r);
  }
  return out.length ? out.slice(0, MAX_CANDIDATES) : null;
}

function resolveText(a: ShellAnalysis, text: string, depth: number, seen: ReadonlySet<string>): string[] | null {
  const w = firstWordOf(text);
  return w ? resolveWord(a, w, depth + 1, seen) : [""];
}

function resolveParam(a: ShellAnalysis, p: Extract<WordPart, { kind: "param" }>, depth: number, seen: ReadonlySet<string>): string[] | null {
  if (p.op === "len" || p.op === "other" || !p.name) return null;
  let names = [p.name];
  if (p.indirect) {
    const targets = valuesOf(a, p.name, depth, seen);
    if (!targets) return null;
    names = targets.filter((t) => /^[A-Za-z_]\w*$/.test(t));
    if (!names.length) return null;
  }
  const bound = names.some((n) => a.bindings.has(n));
  const out: string[] = [];
  for (const n of names) out.push(...(valuesOf(a, n, depth, seen) ?? []));
  if (p.op === ":+" || p.op === "+") return bound ? resolveText(a, p.arg, depth, seen) : [""];
  if (p.op === ":-" || p.op === "-" || p.op === ":=" || p.op === "=") {
    const d = resolveText(a, p.arg, depth, seen);
    if (d) out.push(...d);
  }
  return out.length ? out.slice(0, MAX_CANDIDATES) : null;
}

/** What `$( … )` prints when its body is a trivially static command, else null. */
function staticSubstitution(a: ShellAnalysis, body: string, depth: number, seen: ReadonlySet<string>): string[] | null {
  const cmds = lexShell(body, MAX_DEPTH);
  if (cmds.length !== 1) return null;
  const words = splitRedirects(cmds[0].words).plain;
  const head = normalizeName(literalText(words[0]) ?? "");
  const args = words.slice(1);
  const one = (w: ShellWord | undefined) => (w ? resolveWord(a, w, depth + 1, seen) : null);
  switch (head) {
    case "echo": {
      const rest = args.filter((w, k) => !(k === 0 && /^-[neE]+$/.test(literalText(w) ?? "")));
      if (rest.length === 0) return [""];
      const first = one(rest[0]);
      return first ? first.map((f) => [f, ...rest.slice(1).map((w) => w.text)].join(" ")) : null;
    }
    case "printf": {
      const fmt = literalText(args[0]);
      if (fmt === null) return null;
      if (!fmt.includes("%")) return [fmt.replace(/\\n$/, "")];
      if (/^%s(?:\\n)?$/.test(fmt)) return one(args[1]);
      return null;
    }
    case "which":
    case "whereis":
    case "realpath":
    case "readlink":
      return one(args[args.length - 1])?.map((v) => (v.includes("/") ? v : "/usr/bin/" + v)) ?? null;
    case "command":
    case "type":
      if (args.some((w) => /^-[vVpP]$/.test(literalText(w) ?? ""))) {
        return one(args[args.length - 1])?.map((v) => (v.includes("/") ? v : "/usr/bin/" + v)) ?? null;
      }
      return null;
    case "basename":
      return one(args[0])?.map((v) => posix.basename(v)) ?? null;
    default:
      return null;
  }
}

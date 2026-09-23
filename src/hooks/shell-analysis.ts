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
 * Lexing is linear in the input apart from bounded recursion into
 * substitutions (`MAX_DEPTH`). Everything after it — following runners and
 * `-c` strings, resolving variables — draws on a work budget proportional to
 * the command (`BASE_BUDGET`); a command that exhausts it is marked
 * `truncated`, which the floor policies deny. It never throws on malformed
 * input: an unterminated quote or substitution runs to the end of the string.
 */
import { posix } from "node:path";

// ── Lexer ───────────────────────────────────────────────────────────────────

/** One piece of a shell word. */
export type WordPart =
  /** Literal text. `quoted` when it came from quotes or a backslash escape. `ansi` for `$'…'` with escapes. */
  | { kind: "lit"; text: string; quoted: boolean; ansi?: boolean }
  /**
   * `$X`, `${X}`, `${X:-default}`, `${!X}`, `${X[@]}`. `op` is "" for a plain
   * reference. `quoted` when it sits inside double quotes, which is the whole
   * of whether the shell splits its value into several words.
   */
  | { kind: "param"; name: string; op: string; arg: string; indirect: boolean; source: string; quoted?: boolean }
  /** `$( … )`, backticks, or a process substitution. `quoted` as for a param. */
  | { kind: "sub"; body: string; source: string; quoted?: boolean }
  /** `$(( … ))`. `quoted` as for a param. */
  | { kind: "arith"; source: string; quoted?: boolean };

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
/** Arguments GNU parallel's command template is expanded with. */
const MAX_PARALLEL_RUNS = 16;
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
  /**
   * Every word so far in this simple command is a leading reserved word
   * (`if`, `!`, `do` …), so the next one is in command position. Kept
   * incrementally: recomputing it over `words` per word was quadratic in a
   * run of reserved words, and `! ! ! …` is cheap to type.
   */
  let leadingOnly = true;
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
          leadingOnly = false;
        }
      } else {
        // In command position: first word, or after reserved words (`do case …`).
        const commandPosition = leadingOnly;
        words.push(word);
        leadingOnly = leadingOnly && LEADING_RESERVED.has(literalText(word) ?? "");
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
    } else if (pipe) {
      // The `|` ended no command of its own, because a `)` or a newline already
      // did: `ps -e | ( xargs kill )`, `ps -e |\n xargs kill`. The pipe still
      // joins the two sides, so the relation is carried across the boundary
      // rather than dropped.
      pipeNext = true;
    }
    words = [];
    leadingOnly = true;
  };
  const pushOperator = (op: string) => {
    endWord();
    words.push({ parts: [{ kind: "lit", text: op, quoted: false }], text: op, redirect: op });
    leadingOnly = false;
  };

  const readBacktick = (i: number, quoted: boolean): number => {
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
    parts.push({ kind: "sub", body, source: src.slice(i, Math.min(j + 1, n)), quoted });
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
      parts.push({ kind: "arith", source: src.slice(i, Math.min(end + 1, n)), quoted });
      return end + 1;
    }
    if (c === "(") {
      const end = matchClose(src, i + 1, "(", ")");
      const body = src.slice(i + 2, end);
      nested.push(body);
      inWord = true;
      parts.push({ kind: "sub", body, source: src.slice(i, Math.min(end + 1, n)), quoted });
      return end + 1;
    }
    if (c === "{") {
      const end = matchClose(src, i + 1, "{", "}");
      const inner = src.slice(i + 2, end);
      const part = parseParam(inner, src.slice(i, Math.min(end + 1, n)));
      // `${X:-$(cmd)}` runs cmd when X is unset.
      if (part.kind === "param" && /\$\(|`/.test(part.arg)) nested.push(part.arg);
      inWord = true;
      parts.push(quoted ? { ...part, quoted } : part);
      return end + 1;
    }
    const m = c === undefined ? null : PARAM_NAME_RE.exec(src.slice(i + 1, i + 1 + 256));
    if (m) {
      // `$10` is `${1}0` in POSIX; a single digit is enough for what this reads.
      const name = /^[0-9]/.test(m[0]) ? m[0][0] : m[0];
      inWord = true;
      parts.push({ kind: "param", name, op: "", arg: "", indirect: false, source: "$" + name, quoted });
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
        j = readBacktick(j, true);
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
      leadingOnly = false;
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
      i = readBacktick(i, false);
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
    if (!p.quoted && (/[*?[]/.test(p.text) || hasBraceExpansion(p.text))) return null;
  }
  return word.text;
}

/**
 * Whether text holds a `{a,b}` / `{1..3}` brace expansion: a `{`, then a `,` or
 * `..`, then a `}`, with no `}` in between. One linear pass — the equivalent
 * regex (`/\{[^}]*(?:,|\.\.)[^}]*\}/`) backtracks quadratically on a long run
 * of `{`, and this runs on every argument word.
 */
function hasBraceExpansion(text: string): boolean {
  let open = false;
  let sep = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") open = true;
    else if (c === "}") {
      if (open && sep) return true;
      open = false;
      sep = false;
    } else if (open && (c === "," || (c === "." && text[i + 1] === "."))) sep = true;
  }
  return false;
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

/**
 * Whether the shell splits this word's expansions into several argv words.
 *
 * bash splits an UNQUOTED expansion on whitespace and leaves a quoted one
 * whole, and that one rule is the whole of it: `A='commit --no-verify'; git $A`
 * really does hand git two arguments, while `git commit -m "$MSG"` hands it one
 * message however many spaces the message holds.
 */
export function splitsOnIfs(word: ShellWord): boolean {
  return word.parts.some((p) => p.kind !== "lit" && !p.quoted);
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
  // The next `]` after each position, so a run of `[` stays linear.
  const nextClose = new Array<number>(chars.length + 1).fill(-1);
  for (let i = chars.length - 1; i >= 0; i--) nextClose[i] = chars[i].ch === "]" ? i : nextClose[i + 1];
  let src = "";
  for (let i = start; i < chars.length; i++) {
    const c = chars[i];
    // Consecutive `*` (or expansions) are one `.*`: a run of them is the same
    // glob, and as separate `.*` terms it backtracks exponentially.
    if (c.dynamic || (!c.quoted && c.ch === "*")) {
      if (!src.endsWith(".*")) src += ".*";
    } else if (!c.quoted && c.ch === "?") src += ".";
    else if (!c.quoted && c.ch === "[") {
      const close = i + 2 < chars.length ? nextClose[i + 2] : -1;
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
  // A glob this long is not a program name anyone types; say it can match anything.
  if (src.length > MAX_GLOB_SOURCE) return /^.*$/;
  try {
    return new RegExp("^" + src + "$", "i");
  } catch {
    return /^.*$/;
  }
}

/** Longest glob (as a regex source) `basenameGlob` compiles; past it, the glob matches anything. */
const MAX_GLOB_SOURCE = 1024;

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
   * Every change of directory in the command — `cd`, `pushd`, and a runner's
   * own `-C`/`-D`/`--chdir`/`--working-directory` — as the values its target
   * can take, or null when the command string cannot say. A relative target is
   * relative to wherever the shell was; the policies resolve it.
   */
  chdirs: Array<string[] | null>;
  /**
   * The command nests substitutions, `bash -c` strings, runners or variable
   * hops deeper than the analyser follows, or costs more to analyse than its
   * budget, so part of it was not looked at. No real command gets here; a
   * command built to hide what it runs can.
   */
  truncated: boolean;
  /** The analyser threw on this command (a bug). Set together with `truncated`. */
  failed?: boolean;
}

/** Runner hops (`sudo nice timeout …`, `find -exec find -exec …`) followed per command. */
const MAX_HOPS = 32;
/** Variable and substitution hops resolution follows (`A=$B; B=$C; …`). */
const MAX_RESOLVE_DEPTH = 12;
/** Values kept per variable binding list and per resolved word. */
const MAX_BINDINGS = 256;

/**
 * The analysis budget, in rough work units: one per byte lexed, a few per
 * program invocation and per resolution step. It scales with the command, so
 * a real command — even a 1 MB heredoc — never meets it; a command built to
 * multiply the analyser's work (a variable bound to every shell, feeding
 * `$S -c '$S -c …'`) runs out of it in milliseconds and is marked truncated,
 * which every floor policy denies. Without it, 3 KB of such a command held
 * the hook for 20 s and 11 GB, and a crashed or timed-out hook lets the tool
 * call through.
 */
const BASE_BUDGET = 2_000_000;
const BUDGET_PER_BYTE = 16;
const INVOCATION_COST = 16;
const RESOLVE_COST = 4;
/** The budget of one `resolveWord` call a policy makes after the analysis. */
const CALL_BUDGET = 500_000;

interface Scope {
  used: number;
  limit: number;
}

/** Everything the analyser keeps per analysis that is not part of its result. */
interface State {
  scope: Scope;
  /** Sources already analysed, with the shallowest depth each one was analysed at. */
  sources: Map<string, number>;
  /** Head words already walked, with the extents (words from the head to the end) walked from each. */
  walked: WeakMap<ShellWord, Set<number>>;
  /** Variable values that do not depend on where resolution started. Cleared by every new binding. */
  values: Map<string, string[] | null>;
  /**
   * Values that do — they cut a cycle (`A=$B; B=$A`) or hit the depth cap —
   * keyed by name, depth and the names being resolved. Keying these by name
   * alone let one resolution poison the next: a `cd "$A"` resolved while B
   * was mid-cycle stored B as unresolvable, and a later `$B file` ran rm unseen.
   */
  contextual: Map<string, string[] | null>;
  /** Variables given more values than `MAX_BINDINGS` keeps. */
  overflowed: Set<string>;
  /** Bumped by every binding, so a head resolved before a later binding is re-resolved. */
  bindCount: number;
  /** Indirect invocations, with the `bindCount` their names were resolved at. */
  indirect: Array<{ inv: Invocation; at: number }>;
  /** `truncated` as `analyzeShell` left it, before any `resolveWord` call. */
  truncatedByAnalysis: boolean;
}

const states = new WeakMap<ShellAnalysis, State>();

function stateOf(a: ShellAnalysis): State {
  let st = states.get(a);
  if (!st) {
    st = {
      scope: { used: 0, limit: BASE_BUDGET },
      sources: new Map(),
      walked: new WeakMap(),
      values: new Map(),
      contextual: new Map(),
      overflowed: new Set(),
      bindCount: 0,
      indirect: [],
      truncatedByAnalysis: false,
    };
    states.set(a, st);
  }
  return st;
}

/** Spend `units` of the current budget. False — and the analysis marked truncated — once it is spent. */
function charge(a: ShellAnalysis, units: number): boolean {
  const scope = stateOf(a).scope;
  scope.used += units;
  if (scope.used <= scope.limit) return true;
  a.truncated = true;
  return false;
}

/**
 * A program that runs another program on its behalf.
 *
 * Options are parsed getopt-style: a short option that takes a value takes
 * the rest of its bundle or the next word (`-uroot`, `-iu root`, `-qc 'cmd'`),
 * a long one takes `=value` or the next word.
 */
interface RunnerSpec {
  /** Options that take a value. */
  withOperand: string[];
  /** Positional operands before the wrapped command (`timeout 5`, `chroot DIR`, `flock FILE`). */
  positional?: number;
  /** Options after which the program runs nothing (`sudo -l`, `taskset -p`). */
  stopOn?: string[];
  /** Options whose value is a command line (`su -c`, `script -c`, `flock -c`, `env -S`). */
  commandString?: string[];
  /** The words after a `commandString` value belong to it too (`env -S 'mkfs.ext4' /dev/sda`). */
  commandStringTakesRest?: boolean;
  /** Options whose value is the wrapped command's working directory. */
  chdir?: string[];
  /** False when the program never runs its operands as a command (`su user`, `script FILE`). */
  wraps?: boolean;
  /** The wrapped words are one command line for a shell (`watch 'dd …'`, `sg grp 'cmd'`). */
  joinsArgs?: boolean;
}

/** Programs that run another program given as their trailing words, or as a command string. */
const RUNNERS: Record<string, RunnerSpec> = {
  sudo: {
    withOperand: ["-u", "-g", "-C", "-p", "-r", "-t", "-U", "-T", "--user", "--group",
      "--close-from", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--host"],
    stopOn: ["-e", "--edit", "-l", "--list", "-v", "--validate", "-V", "--version", "-h", "--help", "-K"],
    chdir: ["-D", "--chdir"],
  },
  doas: { withOperand: ["-u", "-C"] },
  env: {
    withOperand: ["-u", "--unset", "-a", "--argv0"],
    commandString: ["-S", "--split-string"],
    commandStringTakesRest: true,
    chdir: ["-C", "--chdir"],
  },
  nohup: { withOperand: [] },
  setsid: { withOperand: [] },
  builtin: { withOperand: [] },
  busybox: { withOperand: [] },
  unbuffer: { withOperand: [] },
  caffeinate: { withOperand: ["-t", "-w"] },
  time: { withOperand: ["-f", "--format", "-o", "--output"] },
  timeout: { withOperand: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  nice: { withOperand: ["-n", "--adjustment"] },
  ionice: { withOperand: ["-c", "--class", "-n", "--classdata"], stopOn: ["-p", "--pid", "-P", "--pgid", "-u", "--uid"] },
  stdbuf: { withOperand: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: {
    withOperand: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "--max-args",
      "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"],
  },
  command: { withOperand: [], stopOn: ["-v", "-V"] },
  exec: { withOperand: ["-a"] },
  chroot: { withOperand: ["--userspec", "--groups"], positional: 1 },
  // Privilege and identity changers.
  pkexec: { withOperand: ["--user"], stopOn: ["--help", "--version"] },
  run0: {
    withOperand: ["-u", "--user", "-g", "--group", "--nice", "--setenv", "--machine", "--unit", "--property",
      "--description", "--slice", "--background", "--shell-prompt-prefix"],
    chdir: ["-D", "--chdir"],
    stopOn: ["-h", "--help", "--version"],
  },
  su: {
    withOperand: ["-g", "--group", "-G", "--supp-group", "-s", "--shell", "-w", "--whitelist-environment"],
    commandString: ["-c", "--command", "--session-command"],
    wraps: false,
  },
  sg: { withOperand: [], positional: 1, commandString: ["-c"], joinsArgs: true },
  setpriv: {
    withOperand: ["--ruid", "--euid", "--rgid", "--egid", "--reuid", "--regid", "--groups", "--inh-caps",
      "--ambient-caps", "--bounding-set", "--securebits", "--pdeathsig", "--selinux-label",
      "--apparmor-profile", "--landlock-access", "--landlock-rule", "--seccomp-filter"],
    stopOn: ["-d", "--dump", "-h", "--help", "-V", "--version"],
  },
  // Tracers, schedulers, locks, sandboxes and namespaces: all run their operand.
  strace: {
    withOperand: ["-a", "-b", "-e", "-E", "-I", "-o", "-O", "-p", "-P", "-s", "-S", "-u", "-U", "-X",
      "--output", "--trace", "--signal", "--status", "--user", "--env", "--detach-on", "--trace-path",
      "--string-limit", "--summary-sort-by", "--summary-columns", "--attach", "--columns"],
    stopOn: ["-h", "--help", "-V", "--version"],
  },
  ltrace: {
    withOperand: ["-a", "-A", "-D", "-e", "-F", "-l", "-n", "-o", "-p", "-s", "-u", "-w", "-x",
      "--align", "--library", "--output", "--indent"],
    stopOn: ["-h", "--help", "-V", "--version"],
  },
  flock: {
    withOperand: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"],
    positional: 1,
    commandString: ["-c", "--command"],
    stopOn: ["-h", "--help", "-V", "--version"],
  },
  taskset: { withOperand: [], positional: 1, stopOn: ["-p", "--pid", "-h", "--help", "-V", "--version"] },
  chrt: {
    withOperand: ["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"],
    positional: 1,
    stopOn: ["-p", "--pid", "-m", "--max", "-h", "--help", "-V", "--version"],
  },
  // util-linux: `script [-c cmd] [FILE]`; BSD/macOS: `script [-q] FILE [cmd …]`.
  script: {
    withOperand: ["-E", "--echo", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T", "--log-timing",
      "-m", "--logging-format", "-o", "--output-limit", "-F"],
    positional: 1,
    commandString: ["-c", "--command"],
  },
  watch: {
    withOperand: ["-n", "--interval", "-q", "--equexit"],
    joinsArgs: true,
    stopOn: ["-h", "--help", "-v", "--version"],
  },
  "systemd-run": {
    withOperand: ["-u", "--unit", "-p", "--property", "-E", "--setenv", "-M", "--machine", "-H", "--host",
      "--description", "--slice", "--service-type", "--uid", "--gid", "--nice", "--on-active", "--on-boot",
      "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--timer-property",
      "--path-property", "--socket-property"],
    chdir: ["--working-directory"],
    stopOn: ["-h", "--help", "--version"],
  },
  unshare: {
    withOperand: ["-S", "--setuid", "-G", "--setgid", "-R", "--root", "--map-user", "--map-group",
      "--map-users", "--map-groups", "--propagation", "--setgroups", "--monotonic", "--boottime"],
    chdir: ["-w", "--wd"],
    stopOn: ["-h", "--help", "-V", "--version"],
  },
  nsenter: {
    withOperand: ["-t", "--target", "-S", "--setuid", "-G", "--setgid"],
    stopOn: ["-h", "--help", "-V", "--version"],
  },
  firejail: { withOperand: [], stopOn: ["--help", "--version", "--list", "--tree", "--top"] },
  parallel: {
    withOperand: ["-j", "--jobs", "-P", "--max-procs", "-S", "--sshlogin", "--slf", "--sshloginfile", "-a",
      "--arg-file", "-d", "--delimiter", "-E", "-I", "-C", "--colsep", "-n", "--max-args", "-N", "-L",
      "--max-lines", "--timeout", "--joblog", "--results", "--res", "--tmpdir", "--tempdir", "--env",
      "--delay", "--retries", "--workdir", "--wd", "--tagstring", "--halt", "--halt-on-error", "--memfree",
      "--load", "--nice", "--return", "--basefile", "--bf", "--sshdelay", "--ssh", "--limit", "--block",
      "--block-size", "--recstart", "--recend", "--header", "--transferfile", "--tf", "--rpl", "--profile",
      "-J", "--seqreplace"],
    joinsArgs: true,
    stopOn: ["-h", "--help", "--version"],
  },
};

/** `runuser -u USER cmd …` runs cmd; without `-u` it is `su`. */
const RUNUSER_AS_USER: RunnerSpec = {
  withOperand: [...RUNNERS.su.withOperand, "-u", "--user"],
  commandString: RUNNERS.su.commandString,
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "yash"]);
const SHELL_OPT_OPERAND = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const SSH_OPT_OPERAND = new Set("BbcDEeFIiJLlmOoPpQRSWw".split("").map((c) => "-" + c));
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** GNU parallel's argument-source separators. */
const PARALLEL_SEPARATOR = /^:{3,4}\+?$/;
/** Reserved words that may precede a command. */
const LEADING_RESERVED = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "coproc"]);
/** Reserved words whose command is not a program invocation. */
const NON_INVOCATION = new Set(["for", "case", "select", "function", "in", "esac", "done", "fi", "}"]);
const DECLARE_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly"]);

function bind(a: ShellAnalysis, name: string, value: ShellWord): void {
  const st = stateOf(a);
  const list = a.bindings.get(name) ?? [];
  a.bindings.set(name, list);
  if (list.length >= MAX_BINDINGS) {
    st.overflowed.add(name);
    return;
  }
  list.push(value);
  // A new value can change any memoized resolution.
  st.values.clear();
  st.contextual.clear();
  st.bindCount++;
}

function litWord(text: string): ShellWord {
  return { parts: [{ kind: "lit", text, quoted: true }], text };
}

/** Quote one argument so a joined command line re-lexes to the same words. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
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

/** One kind per distinct way `followRunner` treats a name: every shell reads `-c` the same way. */
function runnerKind(name: string): string {
  if (SHELLS.has(name)) return "sh";
  if (name === "pwsh" || name === "powershell") return "pwsh";
  return name;
}

/**
 * Record the program a simple command runs, then follow whatever it wraps.
 *
 * A worklist, not recursion, over runners (`sudo nice timeout …`), so a command
 * stacking thousands of them cannot exhaust the stack — a throw here would be
 * swallowed by the evaluator and the hook would ALLOW. Each head word is walked
 * once per extent, and each runner KIND once per invocation: a variable bound
 * to nine shells reads the same `-c` string nine ways, and following each one
 * made the work exponential in the nesting.
 */
function walk(a: ShellAnalysis, words: ShellWord[], command: SimpleCommand, depth: number): void {
  const st = stateOf(a);
  const queue: Array<{ words: ShellWord[]; hop: number }> = [{ words, hop: 0 }];
  for (let q = 0; q < queue.length; q++) {
    const { words: current, hop } = queue[q];
    if (hop >= MAX_HOPS) {
      a.truncated = true;
      continue;
    }
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
    if (i >= current.length) continue;
    const head = current[i];
    const headLit = literalText(head);
    if (headLit !== null && NON_INVOCATION.has(headLit)) continue;
    const extent = current.length - i;
    let extents = st.walked.get(head);
    if (!extents) st.walked.set(head, (extents = new Set()));
    if (extents.has(extent)) continue;
    extents.add(extent);
    if (!charge(a, INVOCATION_COST)) return;

    const args = current.slice(i + 1);
    const { names, indirect } = headNames(a, head);
    const inv: Invocation = { names, word: head, args, env, indirect, command };
    a.invocations.push(inv);
    if (indirect) st.indirect.push({ inv, at: st.bindCount });

    const kinds = new Set<string>();
    for (const name of new Set(names.length ? names : [""])) {
      const kind = runnerKind(name);
      if (kinds.has(kind)) continue;
      kinds.add(kind);
      if (!charge(a, 1 + args.length)) return;
      followRunner(a, name, inv, depth, (wrapped) => queue.push({ words: wrapped, hop: hop + 1 }));
    }
  }
}

function headNames(a: ShellAnalysis, head: ShellWord): { names: string[]; indirect: boolean } {
  const lit = literalText(head);
  if (lit !== null) return { names: [normalizeName(lit)], indirect: false };
  const names = new Set<string>();
  const brace = firstBraceExpansion(head);
  if (brace !== null) names.add(normalizeName(brace));
  else {
    const resolved = resolveIn(a, head, 0, NO_NAMES, { tainted: false });
    if (resolved) for (const r of resolved) names.add(normalizeName(r));
    // A command word read from a variable given more values than are kept may
    // run one of the dropped ones.
    const { overflowed } = stateOf(a);
    if (overflowed.size && head.parts.some((p) => p.kind === "param" && overflowed.has(p.name))) a.truncated = true;
  }
  names.delete("");
  return { names: [...names], indirect: true };
}

/** Record a change of directory to `word`. */
function recordChdir(a: ShellAnalysis, word: ShellWord | undefined): void {
  if (!word) return;
  const values = resolveIn(a, word, 0, NO_NAMES, { tainted: false });
  a.chdirs.push(values);
  if (values?.some((t) => /^\/+dev(?:\/|$)/.test(t))) a.cdIntoDev = true;
}

/**
 * Index in `args` where a runner's wrapped command starts, or -1 when it runs
 * none. Runs any command-string option (`-c 'cmd'`) and records any
 * working-directory option on the way.
 */
function wrappedStart(a: ShellAnalysis, spec: RunnerSpec, args: ShellWord[], depth: number): number {
  let positional = spec.positional ?? 0;
  const wraps = spec.wraps !== false;
  const runString = (value: ShellWord | undefined, restFrom: number) => {
    if (!value) return;
    const rest = spec.commandStringTakesRest ? args.slice(restFrom).map((w) => w.text) : [];
    addSource(a, [value.text, ...rest].join(" "), depth + 1);
  };
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) {
      // `timeout $T cmd`: an expansion where an operand goes is that operand.
      if (positional > 0) {
        positional--;
        continue;
      }
      if (!wraps) continue;
      return k;
    }
    if (t === "--") {
      if (!wraps) continue;
      return positional > 0 ? k + 1 + positional : k + 1;
    }
    // `su -`, `sg -`, `env -`: a login shell / empty environment, not an operand.
    if (t === "-") continue;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const flag = eq === -1 ? t : t.slice(0, eq);
      if (spec.stopOn?.includes(flag)) return -1;
      const isCmd = spec.commandString?.includes(flag) ?? false;
      const isDir = spec.chdir?.includes(flag) ?? false;
      if (!isCmd && !isDir && !spec.withOperand.includes(flag)) continue;
      const value = eq === -1 ? args[k + 1] : litWord(t.slice(eq + 1));
      if (eq === -1) k++;
      if (isDir) recordChdir(a, value);
      if (isCmd) {
        runString(value, k + 1);
        if (wraps) return -1;
      }
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (spec.stopOn?.includes(t)) return -1;
      // A bundle of short options: the first one that takes a value takes the
      // rest of the bundle, or the next word when it ends the bundle.
      for (let j = 1; j < t.length; j++) {
        const opt = "-" + t[j];
        if (spec.stopOn?.includes(opt)) return -1;
        const isCmd = spec.commandString?.includes(opt) ?? false;
        const isDir = spec.chdir?.includes(opt) ?? false;
        if (!isCmd && !isDir && !spec.withOperand.includes(opt)) continue;
        const rest = t.slice(j + 1);
        const value = rest ? litWord(rest) : args[k + 1];
        if (!rest) k++;
        if (isDir) recordChdir(a, value);
        if (isCmd) {
          runString(value, k + 1);
          if (wraps) return -1;
        }
        break;
      }
      continue;
    }
    if (positional > 0) {
      positional--;
      continue;
    }
    if (!wraps) continue;
    return k;
  }
  return -1;
}

function joinText(words: ShellWord[]): string {
  return words.map((w) => w.text).join(" ");
}

/** Whether a `runuser` invocation names its user with `-u`, and so runs a command rather than a shell. */
function runuserRunsCommand(args: ShellWord[]): boolean {
  for (const w of args) {
    const t = literalText(w);
    if (t === null || t === "--") return false;
    if (t === "--user" || t.startsWith("--user=")) return true;
    if (/^-[A-Za-z]*u/.test(t) && !t.startsWith("--")) return true;
  }
  return false;
}

/**
 * GNU parallel: the command template runs once per argument after `:::`, with
 * the argument in place of `{}` or appended.
 */
function followParallel(a: ShellAnalysis, words: ShellWord[], depth: number): void {
  const sep = words.findIndex((w) => PARALLEL_SEPARATOR.test(literalText(w) ?? ""));
  const template = joinText(sep === -1 ? words : words.slice(0, sep));
  if (!template.trim()) return;
  addSource(a, template, depth + 1);
  if (sep === -1 || literalText(words[sep])?.startsWith("::::")) return;
  let runs = 0;
  for (const w of words.slice(sep + 1)) {
    const t = literalText(w);
    if (t === null) continue;
    if (PARALLEL_SEPARATOR.test(t)) break;
    if (++runs > MAX_PARALLEL_RUNS) break;
    const arg = shellQuote(t);
    addSource(a, template.includes("{}") ? template.split("{}").join(arg) : `${template} ${arg}`, depth + 1);
  }
}

/**
 * Follow what a program runs on its behalf. A plain runner (`sudo`, `nice`,
 * `xargs` …) hands its wrapped words to `follow`, so `walk` continues
 * iteratively; everything else (a `-c` string, `eval`, `ssh`, a `find -exec`,
 * a shell reading stdin) is analysed here.
 */
function followRunner(
  a: ShellAnalysis, name: string, inv: Invocation, depth: number, follow: (words: ShellWord[]) => void,
): void {
  const args = inv.args;
  // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a command
  // named `constructor` looked up `Object` as its spec and threw.
  const spec = name === "runuser"
    ? (runuserRunsCommand(args) ? RUNUSER_AS_USER : RUNNERS.su)
    : Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : undefined;
  if (spec) {
    const start = wrappedStart(a, spec, args, depth);
    if (start < 0 || start >= args.length) return;
    const wrapped = args.slice(start);
    if (!spec.joinsArgs) follow(wrapped);
    else if (name === "parallel") followParallel(a, wrapped, depth);
    else addSource(a, joinText(wrapped), depth + 1);
    return;
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
      return;
    }
    if (name === "") return;
    // No `-c` and no script operand: the shell reads its program from stdin —
    // a here-string, a heredoc, or `echo … |`.
    if (k < args.length) return;
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
    return;
  }
  switch (name) {
    case "eval":
      addSource(a, joinText(args), depth + 1);
      return;
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
      return;
    }
    case "find":
      for (let k = 0; k < args.length; k++) {
        if (!FIND_EXEC.has(literalText(args[k]) ?? "")) continue;
        let end = k + 1;
        while (end < args.length && !/^[;+]$/.test(literalText(args[end]) ?? "")) end++;
        follow(args.slice(k + 1, end));
        k = end;
      }
      return;
    case "powershell":
    case "pwsh": {
      const k = args.findIndex((w) => /^[-/](?:c|command)$/i.test(literalText(w) ?? ""));
      if (k >= 0) addSource(a, joinText(args.slice(k + 1)), depth + 1);
      return;
    }
    case "cmd": {
      const k = args.findIndex((w) => /^\/[ck]$/i.test(literalText(w) ?? ""));
      if (k >= 0) addSource(a, joinText(args.slice(k + 1)), depth + 1);
      return;
    }
    case "cd":
    case "pushd": {
      const target = args.find((w) => !/^-/.test(w.text));
      // `cd -` goes back to a directory already counted; plain `cd` goes home.
      if (!target && args.some((w) => w.text === "-")) return;
      recordChdir(a, target ?? litWord("~"));
      return;
    }
  }
}

function addSource(a: ShellAnalysis, src: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    a.truncated = true;
    return;
  }
  // The same text analysed again at the same or a deeper level adds nothing.
  const { sources } = stateOf(a);
  const seenAt = sources.get(src);
  if (seenAt !== undefined && seenAt <= depth) return;
  sources.set(src, depth);
  if (!charge(a, src.length + 1)) return;
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
    commands: [], invocations: [], redirects: [], bindings: new Map(), cdIntoDev: false, chdirs: [], truncated: false,
  };
  const st = stateOf(a);
  st.scope.limit = BASE_BUDGET + BUDGET_PER_BYTE * command.length;
  addSource(a, command, 0);
  // An `eval`/`bash -c` walked later can bind what an earlier head reads
  // (`f() { $X x; }; eval X=rm; f`): resolve those heads again.
  for (const { inv, at } of st.indirect) {
    if (at === st.bindCount || firstBraceExpansion(inv.word) !== null) continue;
    const more = headNames(a, inv.word).names.filter((n) => !inv.names.includes(n));
    if (more.length) inv.names = [...inv.names, ...more];
  }
  st.truncatedByAnalysis = a.truncated;
  return a;
}

/**
 * Forget what `resolveWord` calls made after the analysis added to it: the
 * truncation they reported and the cycle- or cap-dependent results they
 * memoized. Callers that share one analysis (the floor policies) call it
 * before each reads it, so one reader's resolution that gave up marks that
 * reader's verdict, not every later one's. The memo goes too: a later reader
 * served a memoized give-up would get null WITHOUT the truncation, and read a
 * chain too deep to follow as an ordinary unknown.
 */
export function resetResolution(a: ShellAnalysis): void {
  const st = states.get(a);
  if (!st) return;
  a.truncated = st.truncatedByAnalysis;
  st.contextual.clear();
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Set when a resolution cut a cycle or hit a cap, so its result depends on where it started. */
interface Taint {
  tainted: boolean;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * Every string a word can expand to, given what the same command assigned, or
 * null when some part of it cannot be known from the command string alone.
 *
 * Each call has its own budget. A chain of variables deeper than resolution
 * follows marks the analysis truncated rather than reading as "unknown".
 */
export function resolveWord(a: ShellAnalysis, word: ShellWord): string[] | null {
  const st = stateOf(a);
  const outer = st.scope;
  st.scope = { used: 0, limit: CALL_BUDGET };
  try {
    return resolveIn(a, word, 0, NO_NAMES, { tainted: false });
  } finally {
    st.scope = outer;
  }
}

function resolveIn(a: ShellAnalysis, word: ShellWord, depth: number, seen: ReadonlySet<string>, t: Taint): string[] | null {
  if (depth > MAX_RESOLVE_DEPTH) {
    // Twelve hops of `A=$B` is built to hide what it names: say so.
    t.tainted = true;
    a.truncated = true;
    return null;
  }
  if (!charge(a, RESOLVE_COST)) {
    t.tainted = true;
    return null;
  }
  let acc = [""];
  for (const p of word.parts) {
    let opts: string[] | null;
    if (p.kind === "lit") opts = [p.text];
    else if (p.kind === "param") opts = resolveParam(a, p, depth, seen, t);
    else if (p.kind === "sub") opts = staticSubstitution(a, p.body, depth, seen, t);
    else opts = null;
    if (!opts || opts.length === 0) return null;
    const next: string[] = [];
    outer: for (const x of acc) {
      for (const y of opts) {
        if (next.length >= MAX_BINDINGS) break outer;
        next.push(x + y);
      }
    }
    acc = next;
  }
  return acc;
}

function valuesOf(a: ShellAnalysis, name: string, depth: number, seen: ReadonlySet<string>, t: Taint): string[] | null {
  if (seen.has(name)) {
    t.tainted = true;
    return null;
  }
  const words = a.bindings.get(name);
  if (!words) return null;
  const st = stateOf(a);
  if (st.values.has(name)) return st.values.get(name) ?? null;
  const key = `${name}\u0000${depth}\u0000${[...seen].sort().join("\u0000")}`;
  if (st.contextual.has(key)) {
    t.tainted = true;
    return st.contextual.get(key) ?? null;
  }
  const inner: Taint = { tainted: false };
  const result = computeValues(a, name, words, depth, seen, inner);
  if (inner.tainted) {
    st.contextual.set(key, result);
    t.tainted = true;
  } else {
    st.values.set(name, result);
  }
  return result;
}

function computeValues(
  a: ShellAnalysis, name: string, words: ShellWord[], depth: number, seen: ReadonlySet<string>, t: Taint,
): string[] | null {
  const inner = new Set(seen).add(name);
  const out: string[] = [];
  for (const w of words) {
    const r = resolveIn(a, w, depth + 1, inner, t);
    if (r) out.push(...r);
    if (out.length >= MAX_BINDINGS) break;
  }
  return out.length ? out.slice(0, MAX_BINDINGS) : null;
}

function resolveText(a: ShellAnalysis, text: string, depth: number, seen: ReadonlySet<string>, t: Taint): string[] | null {
  if (!charge(a, text.length + 1)) {
    t.tainted = true;
    return null;
  }
  const w = firstWordOf(text);
  return w ? resolveIn(a, w, depth + 1, seen, t) : [""];
}

function resolveParam(
  a: ShellAnalysis, p: Extract<WordPart, { kind: "param" }>, depth: number, seen: ReadonlySet<string>, t: Taint,
): string[] | null {
  if (p.op === "len" || p.op === "other" || !p.name) return null;
  let names = [p.name];
  if (p.indirect) {
    const targets = valuesOf(a, p.name, depth, seen, t);
    if (!targets) return null;
    names = targets.filter((x) => /^[A-Za-z_]\w*$/.test(x));
    if (!names.length) return null;
  }
  const bound = names.some((n) => a.bindings.has(n));
  const out: string[] = [];
  for (const n of names) out.push(...(valuesOf(a, n, depth, seen, t) ?? []));
  if (p.op === ":+" || p.op === "+") return bound ? resolveText(a, p.arg, depth, seen, t) : [""];
  if (p.op === ":-" || p.op === "-" || p.op === ":=" || p.op === "=") {
    const d = resolveText(a, p.arg, depth, seen, t);
    if (d) out.push(...d);
  }
  return out.length ? out.slice(0, MAX_BINDINGS) : null;
}

/** What `$( … )` prints when its body is a trivially static command, else null. */
function staticSubstitution(a: ShellAnalysis, body: string, depth: number, seen: ReadonlySet<string>, t: Taint): string[] | null {
  if (!charge(a, body.length + 1)) {
    t.tainted = true;
    return null;
  }
  const cmds = lexShell(body, MAX_DEPTH);
  if (cmds.length !== 1) return null;
  const words = splitRedirects(cmds[0].words).plain;
  const head = normalizeName(literalText(words[0]) ?? "");
  const args = words.slice(1);
  const one = (w: ShellWord | undefined) => (w ? resolveIn(a, w, depth + 1, seen, t) : null);
  switch (head) {
    case "echo": {
      const flags = literalText(args[0]) ?? "";
      const escapes = /^-[neE]+$/.test(flags) && flags.includes("e");
      const rest = args.filter((w, k) => !(k === 0 && /^-[neE]+$/.test(literalText(w) ?? "")));
      if (rest.length === 0) return [""];
      const first = one(rest[0]);
      const decode = (v: string) => (escapes ? decodeAnsiC(v) : v);
      return first ? first.map((f) => decode([f, ...rest.slice(1).map((w) => w.text)].join(" "))) : null;
    }
    case "printf": {
      // printf decodes \xHH, octal and \n in its format, and in %b arguments.
      const fmt = literalText(args[0]);
      if (fmt === null) return null;
      if (!fmt.includes("%")) return [decodeAnsiC(fmt).replace(/\n$/, "")];
      if (/^%[sb](?:\\n)?$/.test(fmt)) return one(args[1])?.map((v) => (fmt.startsWith("%b") ? decodeAnsiC(v) : v)) ?? null;
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

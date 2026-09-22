/**
 * Deterministic facts about a tool call, computed locally before Jev is asked.
 *
 * TypeSafe's own jaggedness notes say Jev cannot count, resolve paths or do
 * arithmetic, and answers the question you wrote rather than the one you
 * meant. So anything with one right answer — which directory `*` expands in
 * after a `cd`, whether a path is inside the project, which branch is checked
 * out — is worked out here and handed to Jev as a fact rather than a question.
 *
 * Everything in this file is linear in the input and never spawns a process:
 * it runs on the hook's hot path, inside the daemon worker's serialised chain.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Facts, PathFact, ToolClass } from "./types";

const SHELL_TOOLS = new Set(["Bash", "BashOutput"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
/** Known tools with no side effects worth judging. They never cost a Jev call. */
const INERT_TOOLS = new Set([
  "TodoWrite", "TodoRead", "ExitPlanMode", "EnterPlanMode", "Task", "Agent",
  "AskUserQuestion", "ToolSearch", "KillShell", "SlashCommand", "Skill",
]);

export function classifyTool(toolName: string): { toolClass: ToolClass; toolIsKnown: boolean } {
  if (SHELL_TOOLS.has(toolName)) return { toolClass: "shell", toolIsKnown: true };
  if (WRITE_TOOLS.has(toolName)) return { toolClass: "write", toolIsKnown: true };
  if (READ_TOOLS.has(toolName)) return { toolClass: "read", toolIsKnown: true };
  if (NETWORK_TOOLS.has(toolName)) return { toolClass: "network", toolIsKnown: true };
  if (INERT_TOOLS.has(toolName)) return { toolClass: "other", toolIsKnown: true };
  // MCP tools (`mcp__server__tool`), skills that shell out, and anything a
  // harness names that no canonical map covers. These are exactly the calls
  // the regex engine never sees, because every builtin opens with a toolName
  // check.
  return { toolClass: "other", toolIsKnown: false };
}

/** Upper bound on command text the scanner will look at. Linear, but bounded. */
export const MAX_SCAN_CHARS = 8_192;

export interface ScannedCommand {
  /** Simple-command segments, split on `&&`, `||`, `;`, `|` and newlines. */
  segments: string[][];
  /** The command with shell comments removed (quote-aware). */
  withoutComments: string;
  commentsRemoved: boolean;
  /** The removed comment text, so the injection probe can still see it. */
  comments: string[];
}

/**
 * A single left-to-right pass over a shell command: quote-aware tokenising,
 * operator splitting and comment removal. It is deliberately not a full shell
 * parser — it only needs to find words, segment boundaries and comments, and
 * it must stay linear no matter what the agent sends.
 */
export function scanCommand(command: string): ScannedCommand {
  const text = command.length > MAX_SCAN_CHARS ? command.slice(0, MAX_SCAN_CHARS) : command;
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let out = "";
  let commentsRemoved = false;
  const comments: string[] = [];

  const endWord = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < text.length) {
        word += text[++i];
        out += text[i];
      } else {
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      out += c;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      word += text[i + 1];
      inWord = true;
      out += c + text[++i];
      continue;
    }
    if (c === "#" && !inWord) {
      // A comment runs to end of line. Classic place to hide "approved by
      // security" in a command that is about to be judged by a language model.
      const nl = text.indexOf("\n", i);
      commentsRemoved = true;
      comments.push(text.slice(i, nl === -1 ? text.length : nl));
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment();
      out += c;
      continue;
    }
    if (c === "&" || c === "|") {
      endSegment();
      out += c;
      if (text[i + 1] === c) out += text[++i];
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      out += c;
      continue;
    }
    word += c;
    inWord = true;
    out += c;
  }
  endSegment();
  return { segments, withoutComments: out.trimEnd(), commentsRemoved, comments };
}

const PATH_LIKE = /^(?:\/|~|\.\.?(?:\/|$)|[^:]*\/)/;
const GLOB_CHARS = /[*?[]/;

function expandHome(token: string, home: string): string {
  if (token === "~") return home;
  if (token.startsWith("~/")) return home + token.slice(1);
  if (token.startsWith("$HOME/")) return home + token.slice(5);
  if (token === "$HOME") return home;
  return token;
}

function relationOf(resolved: string, projectRoot: string | null, home: string): PathFact["relation"] {
  if (resolved === "/") return "root";
  if (projectRoot) {
    if (resolved === projectRoot) return "project_root";
    if (resolved.startsWith(projectRoot + "/")) return "inside_project";
  }
  if (resolved === home) return "home_root";
  if (resolved.startsWith(home + "/")) return "outside_project_in_home";
  return "system";
}

function pathFact(token: string, base: string, projectRoot: string | null, home: string): PathFact | null {
  if (token.includes("://")) return null;
  let t = expandHome(token, home);
  // A glob names the contents of its directory: `*` after `cd /` is the root.
  if (GLOB_CHARS.test(t)) {
    const slash = t.lastIndexOf("/");
    t = slash === -1 ? "." : slash === 0 ? "/" : t.slice(0, slash);
  }
  const resolved = isAbsolute(t) ? resolve(t) : resolve(base, t);
  return { asWritten: token, resolved, relation: relationOf(resolved, projectRoot, home) };
}

const MAX_PATHS = 12;

/** Paths a tool call touches, resolved against the cwd and any `cd` along the way. */
export function extractPaths(
  toolInput: Record<string, unknown>,
  cwd: string | null,
  projectRoot: string | null,
  scanned: ScannedCommand | null,
  home: string = homedir(),
): PathFact[] {
  const base0 = cwd ?? home;
  const facts: PathFact[] = [];
  const seen = new Set<string>();
  const add = (f: PathFact | null) => {
    if (!f || seen.has(f.resolved + "\0" + f.asWritten) || facts.length >= MAX_PATHS) return;
    seen.add(f.resolved + "\0" + f.asWritten);
    facts.push(f);
  };

  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = toolInput[key];
    if (typeof v === "string" && v.length > 0) add(pathFact(v, base0, projectRoot, home));
  }

  if (scanned) {
    let base = base0;
    for (const seg of scanned.segments) {
      if (seg[0] === "cd") {
        const target = seg[1] ?? "~";
        const f = pathFact(target, base, projectRoot, home);
        if (f) base = f.resolved;
        continue;
      }
      // Skip argv[0]: `/usr/local/bin/kubectl` is the program, not its target.
      for (const tok of seg.slice(1)) {
        if (tok.startsWith("-")) continue;
        if (tok === "*" || tok === "." || tok === ".." || PATH_LIKE.test(tok) || tok.startsWith("$HOME")) {
          add(pathFact(tok, base, projectRoot, home));
        }
      }
    }
  }
  return facts;
}

function findGitDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    const candidate = resolve(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function findProjectRoot(cwd: string | null): string | null {
  if (!cwd) return null;
  const gitDir = findGitDir(cwd);
  return gitDir ? dirname(gitDir) : cwd;
}

/** Current branch from `.git/HEAD`, following a worktree's `gitdir:` pointer. No subprocess. */
export function readCurrentBranch(cwd: string | null): string | null {
  if (!cwd) return null;
  try {
    const gitPath = findGitDir(cwd);
    if (!gitPath) return null;
    let headFile = resolve(gitPath, "HEAD");
    if (statSync(gitPath).isFile()) {
      const pointer = readFileSync(gitPath, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!m) return null;
      headFile = resolve(dirname(gitPath), m[1], "HEAD");
    }
    const head = readFileSync(headFile, "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : null;
  } catch {
    return null;
  }
}

export function computeFacts(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string | null,
  permissionMode: string | null,
  scanned: ScannedCommand | null,
): Facts {
  const { toolClass, toolIsKnown } = classifyTool(toolName);
  const projectRoot = findProjectRoot(cwd);
  return {
    toolName,
    toolClass,
    toolIsKnown,
    cwd,
    projectRoot,
    currentGitBranch: readCurrentBranch(cwd),
    paths: extractPaths(toolInput, cwd, projectRoot, scanned),
    permissionMode,
  };
}

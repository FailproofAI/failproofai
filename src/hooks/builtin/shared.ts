/**
 * Helpers shared by both builtin capability tiers.
 *
 * Everything here is pure: payload arithmetic and string matching, no host
 * access of any kind. That is a requirement, not an observation — this module
 * sits in `payload-only.ts`'s import graph, so a single `node:fs` import here
 * would demote all 32 sealed-eligible policies to `user-context`.
 * `__tests__/hooks/builtin-tier-split.test.ts` asserts it.
 */
import type { PolicyContext } from "../policy-types";

export function getCommand(ctx: PolicyContext): string {
  return (ctx.toolInput?.command as string) ?? "";
}

export function getFilePath(ctx: PolicyContext): string {
  return (ctx.toolInput?.file_path as string) ?? "";
}

/**
 * Parse a command string into argv tokens for safe pattern matching.
 * Splits on whitespace and strips simple single/double quotes.
 * Does not handle all shell syntax — sufficient for prefix-match allowlists.
 */
export function parseArgvTokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ""));
}

// Shell operators that always act as command separators when whitespace-delimited.
export const SHELL_OPERATORS = new Set(["&&", "||", "|", ";"]);

// Shell metacharacters that are unsafe when embedded inside a token. Any command
// whose argv contains one of these in a token is rejected before allowlist matching.
// This closes the bypass where operators are glued to a word (e.g. "nginx;evil" or
// "nginx&&evil") and would otherwise be invisible to the standalone-operator check.
// Note: | is intentionally excluded here because "foo|bar" is a valid grep/sed
// argument value; the standalone-operator check above already handles bare "|" tokens.
export const SHELL_METACHAR_RE = /[;&<>`$()\\]/;

/**
 * Check if a command matches an allow pattern using token-by-token comparison.
 * The "*" token is a wildcard. Extra command tokens beyond the pattern are allowed,
 * UNLESS any token is a standalone shell operator (&&, ||, |, ;) OR contains an
 * embedded shell metacharacter — both cases are rejected to prevent bypass via
 * appended sub-commands or glued operators (e.g. "nginx;" or "nginx;evil").
 */
export function matchesAllowedPattern(cmd: string, pattern: string): boolean {
  const cmdTokens = parseArgvTokens(cmd);
  const patTokens = parseArgvTokens(pattern);
  if (cmdTokens.length < patTokens.length) return false;
  // Reject commands containing standalone shell-operator tokens
  if (cmdTokens.some((tok) => SHELL_OPERATORS.has(tok))) return false;
  // Reject any token containing embedded shell metacharacters
  if (cmdTokens.some((tok) => SHELL_METACHAR_RE.test(tok))) return false;
  return patTokens.every((tok, i) => tok === "*" || tok === cmdTokens[i]);
}

/** Split a command into the segments the shell would run as separate commands. */
export function shellSegments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[|;\n]/).map((s) => s.trim()).filter((s) => s !== "");
}

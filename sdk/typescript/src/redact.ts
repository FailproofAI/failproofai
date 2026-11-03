/**
 * Deterministic credential scrubbing for SDK spool files.
 *
 * This mirrors the daemon's minimal redaction boundary — and, line for line,
 * `failproofai_sdk/_redact.py`. The SDK applies it before bytes reach disk; the
 * daemon applies it again before upload so batches written by older SDKs
 * receive the same protection.
 *
 * The scan is index-based rather than regex-based on purpose: several of the
 * rules (the JWT segment walk, the assignment's backwards name scan, the bearer
 * token's byte budget) are not regular, and a half-regex/half-manual
 * implementation is exactly how the two sides of a redactor drift apart.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const PREFIX_RULES: ReadonlyArray<readonly [string, number, string]> = [
  ["sk-ant-api", 16, "anthropic-key"],
  ["sk-ant-", 16, "anthropic-key"],
  ["sk-proj-", 16, "openai-key"],
  ["sk-", 16, "api-key"],
  ["ghp_", 20, "github-token"],
  ["gho_", 20, "github-token"],
  ["ghu_", 20, "github-token"],
  ["ghs_", 20, "github-token"],
  ["ghr_", 20, "github-token"],
  ["github_pat_", 20, "github-token"],
  ["sb_secret_", 16, "supabase-key"],
  ["sbp_", 20, "supabase-key"],
  ["xoxb-", 16, "slack-token"],
  ["xoxp-", 16, "slack-token"],
  ["AKIA", 16, "aws-access-key-id"],
  ["ASIA", 16, "aws-access-key-id"],
];

const STRONG_SECRET_NAMES = ["secret", "password", "passwd", "credential"] as const;
const WEAK_SECRET_NAMES = ["key", "token"] as const;
const MIN_ASSIGNMENT_VALUE = 12;

type Match = readonly [length: number, label: string];

function isAsciiAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  );
}

function isTokenChar(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return isAsciiAlnum(code) || code === 0x5f /* _ */ || code === 0x2d /* - */;
}

/**
 * UTF-8 byte length of the code unit at `index`.
 *
 * Summed across a string this is the exact UTF-8 byte count, including for
 * astral characters: each half of a surrogate pair reports 2, and 2 + 2 is the
 * 4 bytes such a code point actually occupies. That is what lets the byte
 * budgets below scan by code unit without ever decoding the string.
 */
function utf8LenAt(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code >= 0xd800 && code <= 0xdfff ? 2 : 3;
}

export function utf8Length(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total += utf8LenAt(value, i);
  return total;
}

// Python's `str.isspace()`: the ASCII whitespace set plus the file/group/record/
// unit separators, plus Unicode separators. `\s` covers the Unicode half; the
// C1 separators are spelled out because `\s` does not include them.
function isSpaceChar(char: string): boolean {
  return /\s/.test(char) || (char >= "\u001c" && char <= "\u001f");
}

function isUpperChar(char: string): boolean {
  return char.toLowerCase() !== char && char.toUpperCase() === char;
}

function atBoundary(value: string, start: number): boolean {
  return start === 0 || !isTokenChar(value, start - 1);
}

function matchPrefix(value: string, start: number): Match | null {
  if (!atBoundary(value, start)) return null;
  for (const [prefix, minimum, label] of PREFIX_RULES) {
    if (!value.startsWith(prefix, start)) continue;
    let end = start + prefix.length;
    while (end < value.length && isTokenChar(value, end)) end += 1;
    if (end - start - prefix.length >= minimum) return [end - start, label];
  }
  return null;
}

function matchJwt(value: string, start: number): Match | null {
  if (!atBoundary(value, start) || !value.startsWith("eyJ", start)) return null;
  let end = start;
  let segments = 0;
  while (segments < 3) {
    const segmentStart = end;
    while (end < value.length) {
      const code = value.charCodeAt(end);
      if (
        !(
          isAsciiAlnum(code) ||
          code === 0x2d /* - */ ||
          code === 0x5f /* _ */ ||
          code === 0x3d /* = */
        )
      ) {
        break;
      }
      end += 1;
    }
    if (end === segmentStart) break;
    segments += 1;
    if (segments < 3 && end < value.length && value[end] === ".") {
      end += 1;
    } else if (segments < 3) {
      break;
    }
  }
  const length = end - start;
  return segments === 3 && length >= 40 ? [length, "jwt"] : null;
}

function matchBearer(value: string, start: number): Match | null {
  if (value.slice(start, start + 7).toLowerCase() !== "bearer ") return null;
  let end = start + 7;
  let tokenBytes = 0;
  while (end < value.length) {
    const char = value[end]!;
    if (isSpaceChar(char) || char === '"' || char === "'") break;
    tokenBytes += utf8LenAt(value, end);
    end += 1;
  }
  return tokenBytes >= 8 ? [end - start, "bearer-token"] : null;
}

function isSecretName(name: string): boolean {
  const raw = name.replace(/^-+/, "").replace(/-+$/, "");
  const lowered = raw.toLowerCase();
  const compound =
    raw.includes("_") ||
    raw.includes("-") ||
    Array.from(raw.slice(1)).some((char) => isUpperChar(char));
  return (
    STRONG_SECRET_NAMES.some((part) => lowered.endsWith(part)) ||
    (compound && WEAK_SECRET_NAMES.some((part) => lowered.endsWith(part)))
  );
}

const OPAQUE_VALUE_PREFIXES = ["{", "$", "<", "(", "`", "[redacted:"] as const;

function isLiteralSecret(value: string): boolean {
  return (
    utf8Length(value) >= MIN_ASSIGNMENT_VALUE &&
    !OPAQUE_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function matchAssignment(value: string, start: number): Match | null {
  if (start === 0) return null;
  if (value[start - 1] === "=" && (value[start] === '"' || value[start] === "'")) return null;

  const previous = value[start - 1]!;
  const quote = previous === '"' || previous === "'" ? previous : null;
  const equals = quote ? start - 2 : start - 1;
  if (equals < 0 || value[equals] !== "=") return null;

  let nameStart = equals;
  while (nameStart > 0) {
    if (!isTokenChar(value, nameStart - 1)) break;
    nameStart -= 1;
  }
  if (nameStart === equals) return null;
  if (
    !isSecretName(value.slice(nameStart, equals)) ||
    ["{", "$", "<", "(", "`"].some((prefix) => value.startsWith(prefix, start))
  ) {
    return null;
  }

  let end = start;
  let valueBytes = 0;
  while (end < value.length) {
    const char = value[end]!;
    if (
      (quote && char === quote) ||
      (!quote && (isSpaceChar(char) || char === ";" || char === "&" || char === '"' || char === "'"))
    ) {
      break;
    }
    valueBytes += utf8LenAt(value, end);
    end += 1;
  }
  return valueBytes >= MIN_ASSIGNMENT_VALUE ? [end - start, "secret-assignment"] : null;
}

/** The minimally redacted string and the replacement count. */
export function scrubString(value: string): [string, number] {
  const out: string[] = [];
  let cursor = 0;
  let copiedThrough = 0;
  let hits = 0;
  while (cursor < value.length) {
    const match =
      matchPrefix(value, cursor) ??
      matchJwt(value, cursor) ??
      matchBearer(value, cursor) ??
      matchAssignment(value, cursor);
    if (match === null) {
      cursor += 1;
      continue;
    }
    const [length, label] = match;
    out.push(value.slice(copiedThrough, cursor));
    out.push(`[redacted:${label}]`);
    cursor += length;
    copiedThrough = cursor;
    hits += 1;
  }
  if (hits === 0) return [value, 0];
  out.push(value.slice(copiedThrough));
  return [out.join(""), hits];
}

/** Read the daemon's redaction switch, defaulting safely to minimal. */
export function redactionEnabled(baseDir: string): boolean {
  const configuredHome = process.env.FAILPROOFAI_HOME;
  let configPath: string;
  if (basename(baseDir) === "custom-agents") {
    configPath = join(dirname(baseDir), "config.json");
  } else if (configuredHome) {
    configPath = join(configuredHome, "config.json");
  } else {
    configPath = join(homedir(), ".failproofai", "config.json");
  }
  try {
    const config: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof config !== "object" || config === null || Array.isArray(config)) return true;
    const collector = (config as Record<string, unknown>).collector;
    if (typeof collector !== "object" || collector === null || Array.isArray(collector)) {
      return true;
    }
    return (collector as Record<string, unknown>).redact !== "off";
  } catch {
    // A missing, unreadable or malformed config means we do not know the
    // operator's intent — so redact. Failing open here would mean one typo in
    // `config.json` silently ships credentials.
    return true;
  }
}

/** Redact credential-shaped keys and string values in a valid JSON event line. */
export function redactJsonLine(encoded: string): string {
  const event: unknown = JSON.parse(encoded);
  let hits = 0;

  const scrub = (value: unknown, fieldName?: string): unknown => {
    if (typeof value === "string") {
      const [scrubbed, count] = scrubString(value);
      hits += count;
      if (count === 0 && typeof fieldName === "string" && isSecretName(fieldName)) {
        if (isLiteralSecret(scrubbed)) {
          hits += 1;
          return "[redacted:secret-assignment]";
        }
      }
      return scrubbed;
    }
    if (Array.isArray(value)) {
      // Elements are more values for the same field, so its name still applies.
      return value.map((item) => scrub(item, fieldName));
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const [redactedKey, count] = scrubString(key);
        hits += count;
        let uniqueKey = redactedKey;
        let suffix = 2;
        while (Object.prototype.hasOwnProperty.call(result, uniqueKey)) {
          uniqueKey = `${redactedKey}#${suffix}`;
          suffix += 1;
        }
        result[uniqueKey] = scrub(item, key);
      }
      return result;
    }
    return value;
  };

  const redacted = scrub(event);
  return hits ? JSON.stringify(redacted) : encoded;
}

export { isSecretName, isLiteralSecret };

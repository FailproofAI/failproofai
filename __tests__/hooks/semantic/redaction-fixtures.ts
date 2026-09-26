/**
 * Secret-shaped fixtures for the redaction tests, built at runtime.
 *
 * Nothing key-shaped appears literally in the test sources: this repo's own
 * dogfood hooks (and any secret scanner) would flag it, and a literal would be
 * one careless copy away from looking like a real credential. Generation is
 * seeded, so every run sees the same strings.
 */

/** mulberry32: small, fast, deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const B64URL = ALNUM + "-_";
export const HEX = "0123456789abcdef";

export function rnd(rand: () => number, len: number, alphabet = ALNUM): string {
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/** `s` + `k-`, joined at runtime. */
export const SK = ["s", "k-"].join("");

/**
 * A 25-character gateway key (LiteLLM's `sk-` + token_urlsafe(16)) with a
 * separator at `sepAt` in its random part — the shape the original
 * `sk-[A-Za-z0-9]{20,}` pattern missed.
 */
export function gatewayKey(rand: () => number, sepAt: number, sep: "-" | "_" = "-"): string {
  const body = rnd(rand, 22).split("");
  body[sepAt] = sep;
  // Guarantee the mixed classes a real base64url key has with near certainty.
  body[0] = "q";
  body[1] = "7";
  body[2] = "K";
  return SK + body.join("");
}

/** A random base64url token of `len` with lower, upper and digits. */
export function randomToken(rand: () => number, len: number): string {
  return "a" + "Z" + "3" + rnd(rand, len - 3, ALNUM);
}

/**
 * PEM armour lines, joined at runtime: a literal private-key header in a test
 * source trips sanitize-private-key-content for anyone who reads the file.
 */
export function pemBegin(kind = ""): string {
  return ["-----BEGIN", kind, "PRIVATE", "KEY-----"].filter(Boolean).join(" ");
}
export function pemEnd(kind = ""): string {
  return ["-----END", kind, "PRIVATE", "KEY-----"].filter(Boolean).join(" ");
}

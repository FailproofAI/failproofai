/**
 * Cache and rate limit in front of a Jev transport, so a burst of tool calls
 * stays under the provider's limit instead of degrading silently.
 *
 * T0 stub: identity. T5 replaces the body with an LRU cache keyed by the
 * request digest and a token bucket that throws `JevError("rate-limited")`.
 */
import type { JevTransport } from "./jev-client";

export function throttleTransport(t: JevTransport): JevTransport {
  return t;
}

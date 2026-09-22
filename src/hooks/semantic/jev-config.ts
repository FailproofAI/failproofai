/**
 * The customer's own Jev configuration (BYOK) — the single opt-in to the
 * two-tier evaluator.
 *
 * `loadJevConfig()` returning null means Jev is off and the regex engine runs
 * exactly as it does without this module. The file is GLOBAL only
 * (`~/.failproofai/jev.json`); a repository's config can never set or override
 * it, because a cloned repo choosing the endpoint that judges its own tool
 * calls would be choosing its own verdict.
 *
 * T0 stub: always null. T1 replaces the body with the validated loader.
 */
import { jevConfigFile } from "../fp-home";

export type JevProviderKind = "typesafe" | "openrouter" | "vercel" | "cloudflare" | "custom";

export interface JevConfig {
  provider: JevProviderKind;
  apiKey: string;
  /** Required for `custom`; an optional override otherwise. */
  baseUrl?: string;
  /** `cloudflare` only. */
  accountId?: string;
  /** Provider-specific model id; each provider has a default. */
  model?: string;
  /** Default 1500. */
  timeoutMs?: number;
  /** `shadow` logs Jev and enforces regex; `enforce` applies the combine rules. Default `enforce`. */
  mode?: "shadow" | "enforce";
}

export const DEFAULT_JEV_MODE: NonNullable<JevConfig["mode"]> = "enforce";

export function jevConfigPath(): string {
  return jevConfigFile();
}

export function loadJevConfig(): JevConfig | null {
  return null;
}

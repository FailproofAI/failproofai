import { logger } from "./logger.js";
import { shared } from "./shared.js";

const DEFAULT_ENVIRONMENT = "dev";


/**
 * Set once the comma warning below has been emitted. `getEnvironment()` runs
 * from `build()`, i.e. once per event on the caller's own stack, and the
 * warning had no once-flag at all in an early draft — so an
 * `AGENTEYE_ENVIRONMENT` with a comma put one WARN line into the host
 * application's log for every event emitted, for the life of the process. At
 * the SDK's documented ceiling that is a logging-driven throughput collapse in
 * a library whose first constraint is not to disrupt the host agent.
 */
let warnedComma = false;

/**
 * A comma in `environment` makes ingest skip EVERY event carrying it.
 *
 * The endpoint splits this field on commas to build its filter facets, so a
 * line whose `environment` contains one is discarded — the whole line, not the
 * field. It answers 200 with `{"accepted":0,"skipped":N}`, the daemon deletes
 * the delivered batch, and the run that produced it is simply never in the
 * dashboard: no exception here, nothing in the agent's output, and an empty
 * session list that looks exactly like an agent nobody ran.
 *
 * `failproofaid` already refuses a comma in `collector.environment` for this
 * reason (`crates/fpai-collect/src/config.rs`). The SDK is the other writer of
 * the same field, so `AGENTEYE_ENVIRONMENT="prod,eu"` — a wholly reasonable
 * thing to type — would silently throw away everything the process emitted.
 */
export function rejectComma(env: string, source: string): void {
  if (env.includes(",")) {
    throw new Error(
      `environment must not contain a comma (got ${JSON.stringify(env)} from ${source}). ` +
        "The ingest endpoint skips every event whose environment has one, so this would " +
        "silently discard all telemetry from this process. Use a single label, e.g. 'prod-eu'.",
    );
  }
}

export function getEnvironment(): string {
  const environment = shared().environment;
  if (environment !== null) return environment;

  const raw = process.env.AGENTEYE_ENVIRONMENT;
  if (!raw) return DEFAULT_ENVIRONMENT;
  if (raw.includes(",")) {
    // Throwing here would blow up inside `build()` on an arbitrary event, far
    // from the thing that set it, and take the caller's agent down with it — a
    // telemetry library must not do that. Warn once and fall back to a label
    // ingest will actually accept, so the events land under a visibly-wrong
    // environment instead of vanishing.
    if (!warnedComma) {
      warnedComma = true;
      logger.warn(
        `AGENTEYE_ENVIRONMENT=${JSON.stringify(raw)} contains a comma, which makes the ingest ` +
          `endpoint skip every event carrying it. Falling back to ${JSON.stringify(DEFAULT_ENVIRONMENT)}. ` +
          "Use a single label, e.g. 'prod-eu'.",
      );
    }
    return DEFAULT_ENVIRONMENT;
  }
  return raw;
}

export function setEnvironment(env: string | null | undefined): void {
  if (env) rejectComma(env, "configure({ environment })");
  shared().environment = env ? env : null;
  // A new label means the env var may be worth complaining about again.
  warnedComma = false;
}

export { DEFAULT_ENVIRONMENT };

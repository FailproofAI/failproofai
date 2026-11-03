/**
 * Event timestamps: wall-clock milliseconds, with the microsecond digits used
 * to keep emission order inside a millisecond.
 *
 * The wire format has six fractional digits (the Python SDK writes real
 * microseconds), and the dashboard orders a session's events by that field.
 * JavaScript's wall clock resolves to the millisecond, and a fast agent emits
 * `model_response`, `tool_use`, `tool_result` and the next `model_request`
 * inside one — so with the last three digits always `000` they tied, and the
 * dashboard showed a `tool_result` before its own `tool_use`.
 *
 * So each stamp is `max(wall µs, previous + 1)`. The digits below the
 * millisecond are a sequence, not a measurement — nothing here claims a
 * precision the clock does not have — and the millisecond part is still the
 * wall clock. The sequence is process-wide and shared through `globalThis`, so
 * the ESM and CommonJS copies of this package loaded into one process (the
 * dual-package case the adapters already handle) cannot interleave two
 * sequences.
 *
 * A wall clock that steps BACK (NTP, a VM resume) is followed, not fought: if
 * the sequence is more than a second ahead of the wall, it re-anchors. Holding
 * `previous + 1` instead would freeze every timestamp at the old time for as
 * long as the step was — an hour's step, an hour of events stamped with one
 * instant.
 */

const KEY = Symbol.for("@failproofai/sdk.clock");
const MAX_LEAD_MICROS = 1_000_000;

interface ClockState {
  last: number;
}

function state(): ClockState {
  const holder = globalThis as unknown as Record<symbol, ClockState | undefined>;
  let found = holder[KEY];
  if (found === undefined) {
    found = { last: 0 };
    holder[KEY] = found;
  }
  return found;
}

/** Microseconds since the epoch, strictly increasing within the process. */
export function nowMicros(): number {
  const clock = state();
  const wall = Date.now() * 1000;
  const next = wall > clock.last || clock.last - wall > MAX_LEAD_MICROS ? wall : clock.last + 1;
  clock.last = next;
  return next;
}

/** `2026-09-23T12:34:56.123456Z`: six fractional digits, as the ingest parser expects. */
export function formatMicros(micros: number): string {
  const ms = Math.floor(micros / 1000);
  const sub = String(micros - ms * 1000).padStart(3, "0");
  return `${new Date(ms).toISOString().slice(0, -1)}${sub}Z`;
}

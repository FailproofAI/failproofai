/**
 * Settings every copy of this package in one process must agree on.
 *
 * A process routinely holds more than one copy: the ESM and CommonJS builds
 * (the dual-package case), or — on Next.js without `withFailproofai` — a copy
 * bundled into each route beside the one `instrumentation.ts` imported from
 * `node_modules`. Module-level state is per copy, so `configure({ environment:
 * "production" })` in `instrumentation.ts` never reached the route's copy, and
 * everything the route emitted went out labelled `dev` — recorded, shipped,
 * and in the wrong bucket, with nothing said.
 *
 * `environment` and `baseDir` decide what an event is labelled and where it is
 * written, so they live here, keyed through the process-wide `Symbol.for`
 * registry every copy can reach. `flushInterval` is timing only and stays with
 * each copy's writer.
 */

const KEY = Symbol.for("@failproofai/sdk.settings");

export interface SharedSettings {
  environment: string | null;
  baseDir: string | null;
}

export function shared(): SharedSettings {
  const holder = globalThis as unknown as Record<symbol, SharedSettings | undefined>;
  let found = holder[KEY];
  if (found === undefined) {
    found = { environment: null, baseDir: null };
    holder[KEY] = found;
  }
  return found;
}

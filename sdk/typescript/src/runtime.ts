/**
 * The process-wide writer and event namespace.
 *
 * These live in a leaf module so that `scopes.ts` and the framework adapters
 * can reach the namespace without importing the package index, which would be
 * a circular import.
 *
 * Constructing `EventWriter` starts the flush interval and registers the
 * module-level exit flush, and that happens at `import "@failproofai/sdk"`
 * time — the index imports this module, so the timing matches the Python SDK's.
 * The interval is `unref`'d, so importing this package never keeps a process
 * alive on its own.
 *
 * Reach the namespace through the `runtime` object rather than a direct named
 * import, so a test can swap in a recording namespace and the scopes and
 * adapters pick it up. A `let` export would work under ESM live bindings and
 * silently not under the CJS build, which is exactly the kind of difference
 * that shows up only in somebody else's project.
 */

import { EventNamespace } from "./events.js";
import { EventWriter } from "./writer.js";

const writer = new EventWriter();

export const runtime: { writer: EventWriter; event: EventNamespace } = {
  writer,
  event: new EventNamespace(writer),
};

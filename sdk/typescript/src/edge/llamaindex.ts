/** `@failproofai/sdk/llamaindex` for runtimes with no filesystem — see `./index.ts`. */

import { noopAdapter } from "./adapter.js";
import { notice } from "./notice.js";
import { inertNamedTool } from "./self-report-tool.js";

/** Attaching to a LlamaIndex object records nothing here; returns a detach. */
export function attach(): () => void {
  notice();
  return () => {};
}

export const adapter = noopAdapter("llamaindex");

/** The Self Reports tool, answering `Recorded.` and recording nothing. */
export function selfReportTool<T = unknown>(...options: unknown[]): T {
  void options;
  return inertNamedTool<T>();
}

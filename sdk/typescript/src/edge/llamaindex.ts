/** `@failproofai/sdk/llamaindex` for runtimes with no filesystem — see `./index.ts`. */

import { noopAdapter } from "./adapter.js";
import { notice } from "./notice.js";

/** Attaching to a LlamaIndex object records nothing here; returns a detach. */
export function attach(): () => void {
  notice();
  return () => {};
}

export const adapter = noopAdapter("llamaindex");

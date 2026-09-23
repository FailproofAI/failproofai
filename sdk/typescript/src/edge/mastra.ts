/** `@failproofai/sdk/mastra` for runtimes with no filesystem — see `./index.ts`. */

import { noopAdapter } from "./adapter.js";
import { notice } from "./notice.js";

export function wrapTool<T>(tool: T): T {
  notice();
  return tool;
}

export function workflow<T>(workflowName: string, body: () => T): T {
  void workflowName;
  notice();
  return body();
}

export const adapter = noopAdapter("mastra");

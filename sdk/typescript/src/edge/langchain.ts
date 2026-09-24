/** `@failproofai/sdk/langchain` for runtimes with no filesystem — see `./index.ts`. */

import { noopAdapter } from "./adapter.js";
import { notice } from "./notice.js";

export const SESSION_METADATA_KEY = "failproofai_sdk_session_id";

/**
 * A callback handler with no callbacks. LangChain accepts any object as a
 * handler (`BaseCallbackHandler.fromMethods`), so passing this where the Node
 * build's handler goes is valid and inert.
 */
export function langchainHandler(): Record<string, unknown> {
  notice();
  return { name: "failproofai_noop" };
}

export const adapter = noopAdapter("langchain");

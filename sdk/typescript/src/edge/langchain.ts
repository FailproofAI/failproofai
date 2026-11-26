/** `@failproofai/sdk/langchain` for runtimes with no filesystem — see `./index.ts`. */

import { noopAdapter } from "./adapter.js";
import { notice } from "./notice.js";
import { inertLangChainTool, type EdgeLangChainToolsModule } from "./self-report-tool.js";

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

/**
 * The Self Reports tool, answering `Recorded.` and recording nothing. Pass the
 * application's `@langchain/core/tools` as `module` to get a real LangChain
 * structured tool (recognised by every `@langchain/core` from 0.3.44); without
 * it, a plain named-tool object that 0.3.52 and later recognise.
 */
export function selfReportTool<T = unknown>(options?: { module?: EdgeLangChainToolsModule } & Record<string, unknown>): T {
  return inertLangChainTool<T>(options?.module);
}

// A minimal MCP server over stdio, for the `mcp` case of agent.ts.
//
// Hand-written JSON-RPC rather than the MCP SDK's server so the fixture does
// not depend on which SDK major `@mastra/mcp` happens to pull in: newline-
// delimited JSON on stdin/stdout, which is the whole stdio transport. It
// serves one tool, `forecast`, and nothing reaches a network.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "forecast",
    description: "Forecast for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        // Echo the client's version: this server speaks the subset every
        // version shares.
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "weather-mcp", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const city = request.params?.arguments?.city;
      return {
        content: [{ type: "text", text: `Forecast for ${String(city)}: sunny` }],
        isError: false,
      };
    }
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      return undefined;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  // A notification (no id) needs no answer.
  if (request.id === undefined || request.id === null) return;
  const result = handle(request);
  if (result === undefined) send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  else send({ id: request.id, result });
});

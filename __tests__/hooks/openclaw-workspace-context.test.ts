import { describe, expect, it } from "vitest";
import {
  createWorkspaceContext,
  workspaceFromConfig,
} from "../../openclaw-plugin/workspace-context.js";

describe("OpenClaw tool-hook workspace context", () => {
  it("resolves a current agents.entries workspace from the tool hook agent id", () => {
    const config = {
      agents: {
        entries: {
          research: { workspace: "/Users/tester/.openclaw/workspace/research" },
        },
      },
    };
    expect(workspaceFromConfig(config, "research")).toBe(
      "/Users/tester/.openclaw/workspace/research",
    );
  });

  it("supports the legacy agents.list config shape", () => {
    const config = {
      agents: { list: [{ id: "research", workspace: "/work/research" }] },
    };
    expect(workspaceFromConfig(config, "research")).toBe("/work/research");
  });

  it("matches a legacy agents.list entry by name", () => {
    const config = {
      agents: { list: [{ name: "research", workspace: "/work/by-name" }] },
    };
    expect(workspaceFromConfig(config, "research")).toBe("/work/by-name");
  });

  it("falls back to the default agent workspace", () => {
    const config = {
      agents: { defaults: { workspace: "/work/default" } },
    };
    expect(workspaceFromConfig(config, "missing-agent")).toBe("/work/default");
  });

  it("recovers workspace from an earlier agent hook for the same session", () => {
    const context = createWorkspaceContext();
    context.remember({}, {
      agentId: "research",
      sessionKey: "agent:research:main",
      workspaceDir: "/work/research",
    });

    expect(context.resolveWorkspace({}, {
      agentId: "research",
      sessionKey: "agent:research:main",
    }, {})).toBe("/work/research");
  });

  it("parses the agent id from an agent-scoped session key", () => {
    const context = createWorkspaceContext();
    const config = {
      agents: { entries: { research: { workspace: "/work/research" } } },
    };
    expect(context.resolveWorkspace({}, { sessionKey: "agent:research:main" }, config))
      .toBe("/work/research");
  });
});

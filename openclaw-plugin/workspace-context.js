/**
 * Resolve the workspace for OpenClaw tool hooks.
 *
 * OpenClaw's agent hooks expose `ctx.workspaceDir`, but its tool hooks expose
 * only agent/session identity. Policies still need the real workspace at tool
 * time, so derive it from the profile config and retain agent-hook observations
 * as a compatibility fallback.
 */

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentIdFromContext(payload, ctx) {
  const direct = nonEmptyString(ctx?.agentId) ?? nonEmptyString(payload?.agentId);
  if (direct) return direct;

  const sessionKey = nonEmptyString(ctx?.sessionKey) ?? nonEmptyString(payload?.sessionKey);
  const match = sessionKey?.match(/^agent:([^:]+):/);
  return match?.[1];
}

/** Resolve both current (`agents.entries`) and legacy (`agents.list`) shapes. */
export function workspaceFromConfig(config, agentId) {
  if (!config || typeof config !== "object" || !agentId) return undefined;
  const agents = config.agents;
  if (!agents || typeof agents !== "object") return undefined;

  const entries = agents.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    const exact = entries[agentId];
    if (exact && typeof exact === "object") {
      const workspace = nonEmptyString(exact.workspace);
      if (workspace) return workspace;
    }
  }

  if (Array.isArray(agents.list)) {
    const entry = agents.list.find((candidate) =>
      candidate && typeof candidate === "object" &&
      (candidate.id === agentId || candidate.name === agentId),
    );
    const workspace = nonEmptyString(entry?.workspace);
    if (workspace) return workspace;
  }

  const defaults = agents.defaults;
  if (defaults && typeof defaults === "object") {
    return nonEmptyString(defaults.workspace);
  }
  return undefined;
}

function cacheKeys(payload, ctx) {
  const values = [
    ["run", ctx?.runId ?? payload?.runId],
    ["session-id", ctx?.sessionId ?? payload?.sessionId],
    ["session-key", ctx?.sessionKey ?? payload?.sessionKey],
    ["agent", agentIdFromContext(payload, ctx)],
  ];
  return values
    .filter(([, value]) => nonEmptyString(value))
    .map(([kind, value]) => `${kind}:${value}`);
}

export function createWorkspaceContext() {
  const cache = new Map();

  function remember(payload, ctx) {
    const workspace = nonEmptyString(payload?.cwd) ?? nonEmptyString(ctx?.workspaceDir);
    if (!workspace) return undefined;
    for (const key of cacheKeys(payload, ctx)) cache.set(key, workspace);
    return workspace;
  }

  function resolveWorkspace(payload, ctx, config) {
    const direct = remember(payload, ctx);
    if (direct) return direct;

    for (const key of cacheKeys(payload, ctx)) {
      const cached = cache.get(key);
      if (cached) return cached;
    }

    return workspaceFromConfig(config, agentIdFromContext(payload, ctx));
  }

  function clear(payload, ctx) {
    for (const key of cacheKeys(payload, ctx)) cache.delete(key);
  }

  return { remember, resolveWorkspace, clear };
}

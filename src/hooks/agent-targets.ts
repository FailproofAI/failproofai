/** Agent identity for enforcement, separate from the project-derived telemetry agent_id. */
import { INTEGRATION_TYPES, type IntegrationType } from "./types";

export interface AgentIdentity {
  integration: IntegrationType;
  instanceId: string;
}

export interface AgentTarget {
  integration: IntegrationType;
  instanceId?: string;
}

const INSTANCE_ID_RE = /^agt_[0-9a-f]{16,32}$/;
const integrations = new Set<string>(INTEGRATION_TYPES);

export function validAgentIdentity(value: unknown): value is AgentIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as Record<string, unknown>;
  return Object.keys(agent).every((key) => key === "integration" || key === "instanceId") &&
    typeof agent.integration === "string" && integrations.has(agent.integration) &&
    typeof agent.instanceId === "string" && INSTANCE_ID_RE.test(agent.instanceId);
}

/** Null/absent means all; a malformed selector is never silently treated as all. */
export function parseAgentTargets(value: unknown, schemaVersion: number): AgentTarget[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (schemaVersion < 3 || !Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("invalid agentTargets in cloud-managed active manifest");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid agentTargets in cloud-managed active manifest");
    }
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "integration" && key !== "instanceId") ||
        typeof entry.integration !== "string" || !integrations.has(entry.integration) ||
        (entry.instanceId !== undefined &&
          (typeof entry.instanceId !== "string" || !INSTANCE_ID_RE.test(entry.instanceId)))) {
      throw new Error("invalid agentTargets in cloud-managed active manifest");
    }
    const key = `${entry.integration}\0${entry.instanceId ?? ""}`;
    if (seen.has(key)) throw new Error("duplicate agentTargets in cloud-managed active manifest");
    seen.add(key);
    return {
      integration: entry.integration as IntegrationType,
      ...(entry.instanceId !== undefined ? { instanceId: entry.instanceId as string } : {}),
    };
  });
}

/** An unknown runtime identity cannot widen any scoped assignment. */
export function agentTargetsMatch(targets: readonly AgentTarget[] | undefined, agent: AgentIdentity | null): boolean {
  if (targets === undefined) return true;
  if (!validAgentIdentity(agent)) return false;
  return targets.some((target) =>
    target.integration === agent.integration &&
    (target.instanceId === undefined || target.instanceId === agent.instanceId));
}

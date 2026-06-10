/**
 * Social-share copy for the audit identity card.
 *
 * Five quirky, emoji-forward templates for X and five measured, professional
 * templates for LinkedIn. `pickTemplate` selects one deterministically from a
 * seed (the behaviour fingerprint), so a given audit run always renders the
 * same post while different runs / personas vary. Pure — no React, no DOM — so
 * it's unit-testable and shared by the client `IdentitySection` component.
 */
import type { Grade } from "@/src/audit/scoring";

const SITE_URL = "https://befailproof.ai";

export interface ShareCtx {
  score: number;
  /** Lowercased archetype name, e.g. "the cowboy". */
  arch: string;
  grade: Grade;
  /** Count of unenabled prescribed policies. */
  missing: number;
}

const pol = (n: number) => (n === 1 ? "policy" : "policies");

/** Quirky, emoji-forward — for X. */
export const X_TEMPLATES: ((c: ShareCtx) => string)[] = [
  ({ score, arch, grade, missing }) =>
    `my AI coding agent just got profiled and it's "${arch}" 🤠\n\n${score}/100 · ${grade} tier${missing > 0 ? ` · ${missing} ${pol(missing)} between me and glory` : ` · every guardrail live`}\n\nwhat's yours? → ${SITE_URL}`,
  ({ score, arch, grade }) =>
    `turns out my coding agent has a whole personality and it's ${arch} 💀\n\nscored ${score}/100 (${grade} tier). the audit does not miss.\n\nrun yours in 30s → ${SITE_URL}`,
  ({ score, arch, grade }) =>
    `${score}/100. ${grade} tier. archetype: ${arch} 👀\n\nfailproofai reverse-engineered my agent's entire vibe from its own session logs.\n\n${SITE_URL}`,
  ({ score, arch, grade, missing }) =>
    `plot twist: my AI agent is ${arch} 🎭\n\n${score}/100 · ${grade} tier${missing > 0 ? ` · ${missing} ${pol(missing)} away from behaving` : ` · spotless, somehow`}\n\nbefailproof.ai`,
  ({ score, arch, grade }) =>
    `i let failproofai audit my coding agent and it called me ${arch} ${grade === "S" || grade === "A" ? "😎" : "😬"}\n\n${score}/100, ${grade} tier. brutally accurate. no notes.\n\n${SITE_URL}`,
];

/** Measured, professional — for LinkedIn. */
export const LI_TEMPLATES: ((c: ShareCtx) => string)[] = [
  ({ score, arch, grade, missing }) =>
    `I ran a failproofai audit on our AI coding agents.\n\nResult: ${score}/100 — ${grade} tier, behavioural archetype "${arch}". ${missing > 0 ? `${missing} prescribed ${pol(missing)} would close the remaining gaps.` : `Every prescribed policy is already live.`}\n\nUnderstanding how agents actually behave across real sessions is the first step to securing them. Free and open-source: ${SITE_URL}`,
  ({ score, arch, grade, missing }) =>
    `Security posture check on our coding-agent stack, via failproofai.\n\nScore: ${score}/100 (${grade} tier). Behavioural profile: "${arch}". ${missing > 0 ? `${missing} ${pol(missing)} flagged as real, addressable attack surface.` : `No open policy gaps.`}\n\nThirty seconds to run your own assessment: ${SITE_URL}`,
  ({ score, arch, grade }) =>
    `Most teams can't answer a simple question: how do our AI agents actually behave when no one is watching?\n\nfailproofai audited ours and profiled it as "${arch}" — ${score}/100, ${grade} tier. Concrete, evidence-backed, and mapped to the exact policies that close each gap.\n\n${SITE_URL}`,
  ({ score, arch, grade, missing }) =>
    `Agent security isn't a vibe — it's measurable.\n\nWe scored ${score}/100 (${grade} tier) on the failproofai audit, archetype "${arch}". ${missing > 0 ? `${missing} prescribed ${pol(missing)} remain to harden the stack.` : `Full coverage on every prescribed policy.`}\n\nWorth 30 seconds for any team shipping with AI agents: ${SITE_URL}`,
  ({ score, arch, grade }) =>
    `Ran our coding agents through a failproofai behavioural audit.\n\n${score}/100, ${grade} tier — archetype "${arch}". The report maps every risky pattern to the policy that prevents it, so remediation becomes a checklist rather than a guess.\n\nOpen-source, free to run: ${SITE_URL}`,
];

/** djb2 hash — stable per seed so the template choice is deterministic. */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Deterministically pick + render one template for the given seed. */
export function pickTemplate(
  templates: ((c: ShareCtx) => string)[],
  seed: string,
  ctx: ShareCtx,
): string {
  return templates[hashStr(seed) % templates.length](ctx);
}

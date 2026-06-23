/**
 * Social-share copy for the audit identity card.
 *
 * Ten short, curiosity-forward templates for X and ten short, professional
 * templates for LinkedIn. `pickTemplate` selects one deterministically from a
 * seed (the behaviour fingerprint), so a given audit run always renders the
 * same post while different runs / personas vary — then appends a clipboard
 * paste hint. Pure — no React, no DOM — so it's unit-testable and shared by the
 * client poster component.
 */
import type { Grade } from "@/src/audit/scoring";

export interface ShareCtx {
  score: number;
  /** Lowercased archetype name, e.g. "the cowboy". */
  arch: string;
  grade: Grade;
  /** Count of unenabled prescribed policies. */
  missing: number;
}

const pol = (n: number) => (n === 1 ? "policy" : "policies");

/** Appended to every picked share so the user knows the audit-card PNG is on
 *  their clipboard and just needs pasting into the post. */
const PASTE_LINE = "[ audit card copied to your clipboard — paste it into the post ]";

/** Short, catchy, curiosity-forward — for X / Twitter. Emoji-forward, no
 *  grade-tier framing (it sounds bad at the low end). Subtly tags @failproofai. */
export const X_TEMPLATES: ((c: ShareCtx) => string)[] = [
  ({ score, arch }) =>
    `my AI coding agent has a personality and it's "${arch}" 🤠\n\n${score}/100 on the failproofai audit. what's yours?\n\nnpx -y failproofai audit · @failproofai`,
  ({ score, arch }) =>
    `turns out my coding agent is ${arch} 💀\n\n${score}/100 — it read my own session logs and did not miss.\n\nnpx -y failproofai audit · @failproofai`,
  ({ score, arch }) =>
    `my AI agent's archetype: ${arch} 👀\n\nscored ${score}/100. unsettlingly accurate.\n\nrun yours → npx -y failproofai audit · @failproofai`,
  ({ score, arch, missing }) =>
    `plot twist: my coding agent is ${arch} 🎭\n\n${score}/100${missing > 0 ? `, ${missing} ${pol(missing)} from clean` : `, somehow spotless`}.\n\nnpx -y failproofai audit · @failproofai`,
  ({ score, arch }) =>
    `@failproofai audited my coding agent and called it ${arch} ${score >= 80 ? "😎" : "😬"}\n\n${score}/100. brutal, accurate, no notes.\n\nnpx -y failproofai audit`,
  ({ score, arch }) =>
    `every AI agent has a tell. mine is "${arch}" 🎲\n\n${score}/100. find out what yours does when you're not looking.\n\nnpx -y failproofai audit · @failproofai`,
  ({ score, arch }) =>
    `${score}/100. archetype: ${arch}. 🔍\n\n@failproofai reverse-engineered my agent's whole vibe from its logs.\n\nnpx -y failproofai audit`,
  ({ score, arch }) =>
    `apparently my AI agent is "${arch}" and that explains a lot 😅\n\n${score}/100. audit yours in 30s:\n\nnpx -y failproofai audit · @failproofai`,
  ({ score, arch }) =>
    `ran my coding agent through @failproofai → ${arch}, ${score}/100 🎯\n\nbet yours has skeletons too. go find them:\n\nnpx -y failproofai audit`,
  ({ score, arch, missing }) =>
    `my coding agent is officially "${arch}" 🪞\n\n${score}/100${missing > 0 ? ` · ${missing} ${pol(missing)} to a clean run` : ` · every guardrail live`}.\n\nnpx -y failproofai audit · @failproofai`,
];

/** Short, professional, well-said — for LinkedIn. No emoji, no grade-tier
 *  framing. Subtly references the @Failproof AI page. */
export const LI_TEMPLATES: ((c: ShareCtx) => string)[] = [
  ({ score, arch, missing }) =>
    `I ran a failproofai audit on our AI coding agents: ${score}/100, behavioural archetype "${arch}". ${missing > 0 ? `${missing} prescribed ${pol(missing)} would close the gaps.` : `Every prescribed policy is already live.`}\n\nHow your agents behave unsupervised is finally measurable. Run yours: npx -y failproofai audit — @Failproof AI`,
  ({ score, arch, missing }) =>
    `Security posture check on our coding-agent stack: ${score}/100, profile "${arch}". ${missing > 0 ? `${missing} ${pol(missing)} flagged as real attack surface.` : `No open policy gaps.`}\n\nThirty seconds to assess your own: npx -y failproofai audit — @Failproof AI`,
  ({ score, arch }) =>
    `Most teams can't say how their AI agents behave when no one is watching. failproofai profiled ours as "${arch}" — ${score}/100, mapped to the exact policies that close each gap.\n\nRun yours: npx -y failproofai audit — @Failproof AI`,
  ({ score, arch, missing }) =>
    `Agent security isn't a vibe — it's measurable. We scored ${score}/100, archetype "${arch}". ${missing > 0 ? `${missing} prescribed ${pol(missing)} left to harden.` : `Full policy coverage.`}\n\nnpx -y failproofai audit — @Failproof AI`,
  ({ score, arch }) =>
    `Ran our coding agents through a failproofai behavioural audit: ${score}/100, "${arch}". It maps every risky pattern to the policy that prevents it, so remediation becomes a checklist.\n\nnpx -y failproofai audit — @Failproof AI`,
  ({ score, arch }) =>
    `What does your AI coding agent actually do when a command fails? Ours scored ${score}/100 as "${arch}" on the failproofai audit.\n\nFind out in 30 seconds: npx -y failproofai audit — @Failproof AI`,
  ({ score, arch, missing }) =>
    `Shipping with AI agents means owning their failure modes. failproofai profiled ours as "${arch}", ${score}/100${missing > 0 ? `, with ${missing} ${pol(missing)} still to close` : `, fully covered`}.\n\nnpx -y failproofai audit — @Failproof AI`,
  ({ score, arch }) =>
    `Observability for AI coding agents, distilled to one number: ${score}/100. Archetype "${arch}", every risk mapped to a preventive policy.\n\nOpen-source: npx -y failproofai audit — @Failproof AI`,
  ({ score, arch }) =>
    `We let failproofai read our agents' own session logs. Result: "${arch}", ${score}/100 — evidence-backed and mapped to the policies that prevent each pattern.\n\nAssess yours: npx -y failproofai audit — @Failproof AI`,
  ({ score, arch }) =>
    `The first step to securing AI agents is understanding how they behave. failproofai scored ours ${score}/100 ("${arch}") and prescribed every fix.\n\nnpx -y failproofai audit — @Failproof AI`,
];

/** djb2 hash — stable per seed so the template choice is deterministic. */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Deterministically pick + render one template for the given seed, then append
 *  the clipboard paste hint so the user knows to paste the copied audit card. */
export function pickTemplate(
  templates: ((c: ShareCtx) => string)[],
  seed: string,
  ctx: ShareCtx,
): string {
  const body = templates[hashStr(seed) % templates.length](ctx);
  return `${body}\n\n${PASTE_LINE}`;
}

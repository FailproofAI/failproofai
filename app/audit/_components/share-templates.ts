/**
 * Social-share copy for the audit identity card.
 *
 * Ten templates for X and ten for LinkedIn. `pickTemplate` selects one
 * deterministically from a seed (the behaviour fingerprint), so a given audit
 * run always renders the same post while different runs / personas vary — then
 * appends a clipboard paste hint. Pure — no React, no DOM — so it's
 * unit-testable and shared by the client poster component.
 *
 * ## The score is switched off (2026-09-07)
 *
 * Every template but one used to interpolate `${score}/100`. The score is
 * commented out across the audit — see the header of `src/audit/scoring.ts` for
 * why — so the copy is archetype-only. Eighteen templates lost a subordinate
 * clause; two whose entire premise WAS the number ("my agent scored X/100,
 * think yours can beat it?") are commented out in place rather than reworded,
 * because there is nothing left of them once the number goes.
 *
 * `ShareCtx.score` is kept and still populated so restoring is re-adding the
 * clause, not re-plumbing the type. The originals are preserved verbatim in the
 * block at the bottom of this file.
 */
import type { Grade } from "@/src/audit/scoring";

export interface ShareCtx {
  /** Lowercased archetype name, e.g. "the cowboy". */
  arch: string;
  /** Count of unenabled prescribed policies. */
  missing: number;
  /** Optional ONLY because the score is switched off and nothing upstream
   *  computes them any more. Restoring the score means making these required
   *  again — which the compiler will then walk you through. */
  score?: number;
  grade?: Grade;
}

/** Call-to-action + handle per channel. No URL by design (see file header). */
const X_CTA = "npx -y failproofai audit · @failproofai";
const LI_CTA = "npx -y failproofai audit · @Failproof AI";

/** Appended to every picked share so the user knows the audit-card PNG is on
 *  their clipboard and just needs pasting into the post. */
const PASTE_LINE = "[ audit card copied to your clipboard — paste it into the post ]";

/** Short, curiosity-forward — for X / Twitter. Ends on the npx CTA + @failproofai. */
export const X_TEMPLATES: ((c: ShareCtx) => string)[] = [
  ({ arch }) =>
    `my agent has a personality and it's ${arch}. did not see that coming.\n\nran a failproof audit, all local. find out what yours is → ${X_CTA}`,
  ({ arch }) =>
    `spent 30 seconds auditing my agent. learned more about it than i did all month.\n\nit's ${arch}. → ${X_CTA}`,
  // Score-spined — nothing survives removing the number:
  // ({ score }) =>
  //   `my agent scored ${score}/100. think yours can beat it?\n\n30 sec audit, runs locally, gives you a personality too → ${X_CTA}`,
  ({ arch }) =>
    `turns out my agent is ${arch} and honestly it explains everything.\n\n→ ${X_CTA}`,
  ({ arch }) =>
    `ran a failproof audit on my agent. it reads how it actually behaves when things break, not just the happy path.\n\npersonality: ${arch}. all local → ${X_CTA}`,
  ({ arch }) =>
    `got to know my agent today. it's ${arch}. wow.\n\naudit yours in 30s, nothing leaves your machine → ${X_CTA}`,
  ({ arch }) =>
    `your agent has a personality. you just haven't met it.\n\ni met mine today: ${arch}. → ${X_CTA}`,
  ({ arch }) =>
    `everyone talks about what their agent can build. nobody talks about how it acts when it breaks.\n\nmine's ${arch}, all local → ${X_CTA}`,
  ({ arch }) =>
    `every agent builder should run this once.\n\n30 sec, local, gives your agent a personality. mine: ${arch}.\n\n${X_CTA}`,
  ({ arch }) =>
    `i'll go first: ${arch}.\n\nwhat's your agent? 30 sec audit, no signup → ${X_CTA}`,
];

/** Longer, reflective — for LinkedIn. Ends on the npx CTA + @Failproof AI. */
export const LI_TEMPLATES: ((c: ShareCtx) => string)[] = [
  ({ arch }) =>
    `I've spent more hours with my agent this month than with most people I know. Today I realized I couldn't tell you a single thing about how it actually behaves.\n\nSo I audited it. Turns out it's ${arch}.\n\nThe audit reads its real history, including how it handles failures, not just the clean runs. 30 seconds, runs entirely locally.\n\nMeet yours: ${LI_CTA}`,
  ({ arch }) =>
    `Took a personality test today. It wasn't for me — it was for my AI agent.\n\nThe result: ${arch}.\n\nIt works by reading the agent's actual run history, so the personality comes from how it really behaves, not a vibe. Took 30 seconds and stayed local.\n\nTry it on yours: ${LI_CTA}`,
  ({ arch }) =>
    `Everyone asks what their AI agent can build. I just found out mine has a temper.\n\nAfter watching how it reacts to a failed command, the audit called it ${arch}.\n\nOddly useful to see it written down. 30 seconds, all local: ${LI_CTA}`,
  ({ arch }) =>
    `My agent does this very specific thing every time a command fails. Today I learned there's basically a name for it.\n\nRan a quick audit and it came back ${arch}. The whole read is based on how the agent handles things going wrong, which is where its real character shows.\n\n30 seconds, nothing leaves your machine: ${LI_CTA}`,
  // Score-spined — the opening line is the number:
  // ({ score, arch }) =>
  //   `My AI agent scored ${score}/100 today. I didn't know you could even measure that.\n\nThe same audit also handed it a personality: ${arch}.\n\nIt reads the agent's real history and tells you where it's solid and where it slips. Took 30 seconds and ran fully locally: ${LI_CTA}`,
  ({ arch }) =>
    `I'm usually the first to scroll past "audit your X" tools. This one took 30 seconds and actually told me something.\n\nMy agent is ${arch}.\n\nIt reads the agent's real run history rather than asking me anything, and none of it leaves the machine: ${LI_CTA}`,
  ({ arch }) =>
    `What is your agent's personality? I realized today that I had no answer.\n\nSo I checked. Mine is ${arch}, with a clear read on where it shines and where it slips.\n\nIf you work with agents, run it and drop yours in the comments. 30 seconds, fully local: ${LI_CTA}`,
  ({ arch }) =>
    `I trusted my agent a little less after this morning, and quite a bit more by the afternoon.\n\nI ran an audit on it. It showed me exactly where it's reliable and where it isn't, and gave it a personality: ${arch}.\n\nKnowing the gaps is what made me trust it more. 30 seconds, all local: ${LI_CTA}`,
  ({ arch }) =>
    `I almost skipped this because I assumed it would quietly ship my code off somewhere. It doesn't. Everything runs locally.\n\n30 seconds later I had my agent's personality: ${arch}.\n\nIf privacy is usually what stops you from trying these, this one is different: ${LI_CTA}`,
  ({ arch }) =>
    `Found out my AI agent has a personality type. Found out it's ${arch}. Found out that explains a lot.\n\nThe audit reads how the agent handles failures, not just the runs where everything goes fine.\n\n30 seconds, runs locally: ${LI_CTA}`,
];

/* ---------------------------------------------------------------------------
 * THE ORIGINAL SCORE-BEARING COPY, verbatim. To restore: put these two arrays
 * back in place of the two above, and re-enable the score at its source (see
 * `src/audit/scoring.ts`). Nothing else has to change — `ShareCtx` is unchanged
 * and `score` is still populated by `audit-poster.tsx`.
 *
 * export const X_TEMPLATES: ((c: ShareCtx) => string)[] = [
 *   ({ score, arch }) =>
 *     `my agent has a personality and it's ${arch}. did not see that coming.\n\nran a failproof audit, scored ${score}/100, all local. find out what yours is → ${X_CTA}`,
 *   ({ score, arch }) =>
 *     `spent 30 seconds auditing my agent. learned more about it than i did all month.\n\nit's ${arch}. scored ${score}/100. → ${X_CTA}`,
 *   ({ score }) =>
 *     `my agent scored ${score}/100. think yours can beat it?\n\n30 sec audit, runs locally, gives you a personality too → ${X_CTA}`,
 *   ({ arch }) =>
 *     `turns out my agent is ${arch} and honestly it explains everything.\n\n→ ${X_CTA}`,
 *   ({ score, arch }) =>
 *     `ran a failproof audit on my agent. it reads how it actually behaves when things break, not just the happy path.\n\npersonality: ${arch}. score: ${score}/100. all local → ${X_CTA}`,
 *   ({ score, arch }) =>
 *     `got to know my agent today. it's ${arch} and scored ${score}/100. wow.\n\naudit yours in 30s, nothing leaves your machine → ${X_CTA}`,
 *   ({ score, arch }) =>
 *     `your agent has a personality. you just haven't met it.\n\ni met mine today: ${arch}, ${score}/100. → ${X_CTA}`,
 *   ({ score, arch }) =>
 *     `everyone talks about what their agent can build. nobody talks about how it acts when it breaks.\n\nmine's ${arch}, scored ${score}/100, all local → ${X_CTA}`,
 *   ({ score, arch }) =>
 *     `every agent builder should run this once.\n\n30 sec, local, gives your agent a personality and a quality score. mine: ${arch}, ${score}/100.\n\n${X_CTA}`,
 *   ({ score, arch }) =>
 *     `i'll go first: ${arch}, ${score}/100.\n\nwhat's your agent? 30 sec audit, no signup → ${X_CTA}`,
 * ];
 *
 * export const LI_TEMPLATES: ((c: ShareCtx) => string)[] = [
 *   ({ score, arch }) =>
 *     `I've spent more hours with my agent this month than with most people I know. Today I realized I couldn't tell you a single thing about how it actually behaves.\n\nSo I audited it. Turns out it's ${arch}, and it scored ${score}/100.\n\nThe audit reads its real history, including how it handles failures, not just the clean runs. 30 seconds, runs entirely locally.\n\nMeet yours: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `Took a personality test today. It wasn't for me — it was for my AI agent.\n\nThe result: ${arch}, with a quality score of ${score}/100.\n\nIt works by reading the agent's actual run history, so the personality comes from how it really behaves, not a vibe. Took 30 seconds and stayed local.\n\nTry it on yours: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `Everyone asks what their AI agent can build. I just found out mine has a temper.\n\nAfter watching how it reacts to a failed command, the audit called it ${arch}. It also scored its quality at ${score}/100.\n\nOddly useful to see it written down. 30 seconds, all local: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `My agent does this very specific thing every time a command fails. Today I learned there's basically a name for it.\n\nRan a quick audit and it came back ${arch}, scored ${score}/100. The whole read is based on how the agent handles things going wrong, which is where its real character shows.\n\n30 seconds, nothing leaves your machine: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `My AI agent scored ${score}/100 today. I didn't know you could even measure that.\n\nThe same audit also handed it a personality: ${arch}.\n\nIt reads the agent's real history and tells you where it's solid and where it slips. Took 30 seconds and ran fully locally: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `I'm usually the first to scroll past "audit your X" tools. This one took 30 seconds and actually told me something.\n\nMy agent is ${arch}, and it scored ${score}/100.\n\nIt reads the agent's real run history rather than asking me anything, and none of it leaves the machine: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `What is your agent's personality? I realized today that I had no answer.\n\nSo I checked. Mine is ${arch}, scored ${score}/100, with a clear read on where it shines and where it slips.\n\nIf you work with agents, run it and drop yours in the comments. 30 seconds, fully local: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `I trusted my agent a little less after this morning, and quite a bit more by the afternoon.\n\nI ran an audit on it. It showed me exactly where it's reliable and where it isn't, gave it a personality (${arch}), and scored it ${score}/100.\n\nKnowing the gaps is what made me trust it more. 30 seconds, all local: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `I almost skipped this because I assumed it would quietly ship my code off somewhere. It doesn't. Everything runs locally.\n\n30 seconds later I had my agent's personality (${arch}) and a quality score (${score}/100).\n\nIf privacy is usually what stops you from trying these, this one is different: ${LI_CTA}`,
 *   ({ score, arch }) =>
 *     `Found out my AI agent has a personality type. Found out it's ${arch}. Found out that explains a lot.\n\nIt scored ${score}/100 too. The audit reads how the agent handles failures, not just the runs where everything goes fine.\n\n30 seconds, runs locally: ${LI_CTA}`,
 * ];
 * ------------------------------------------------------------------------- */

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

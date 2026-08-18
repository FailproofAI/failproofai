/**
 * Does a second, independent machine agree with what the lab measured?
 *
 * The lab drives each CLI once, in a container, on a schedule. That is one
 * measurement, and a pack built from a run that went subtly wrong — a stale
 * image, a half-configured vendor, a model that behaved oddly — looks exactly
 * like a pack built from a good one. Before such a pack reaches every customer,
 * something that runs those CLIs for real should have seen the same thing.
 *
 * That is all this does: take the lab's pack and this machine's own
 * observations, and report whether they say the same thing where they overlap.
 *
 * ## What "the same thing" means, precisely
 *
 * Not "the same keys". A local table is a UNION accumulated over weeks, so it
 * legitimately holds optional keys a single lab run never saw, and calling that
 * a contradiction would mean nothing ever promotes.
 *
 * It compares FINDINGS instead — the output of `contract-compare.ts` run over
 * each source. Findings are what anything acts on, so two sources agree exactly
 * when they would cause the same action. An extra optional key that changes no
 * finding is correctly invisible here.
 *
 * ## What it refuses to compare
 *
 * - **Different versions of the same CLI.** If the lab drove goose 1.44 and this
 *   machine runs 1.43, a difference is the vendor moving — the very thing the
 *   pack exists to report — not evidence that the lab was wrong. Comparing them
 *   would turn every real finding into a contradiction and block exactly the
 *   promotions that matter most.
 * - **Tools only one side saw.** The lab exercises tools this machine may never
 *   use, and vice versa. Absence of evidence is not disagreement.
 * - **Envelope keys.** Optional fields come and go between payloads of the same
 *   event, so their absence says nothing.
 *
 * A machine with no overlap at all returns `no-overlap`, which is deliberately
 * NOT a pass: promotion should require evidence, and "we could not check" is
 * not evidence.
 */
import { compareCliContract, type ContractFinding } from "./contract-compare";

export type CorroborationVerdict =
  /** Every comparable shape produced the same findings on both sides. */
  | "corroborated"
  /** At least one comparable shape disagreed. Something measured wrong. */
  | "contradicted"
  /** Nothing was comparable, so nothing was learned. */
  | "no-overlap";

export interface Disagreement {
  cli: string;
  version: string;
  event: string;
  /** The vendor's own tool name. */
  tool: string;
  lab: string[];
  local: string[];
  detail: string;
}

export interface Corroboration {
  verdict: CorroborationVerdict;
  /** Comparable (cli, version, event, tool) shapes that produced the same findings. */
  agreed: number;
  disagreements: Disagreement[];
  /** CLIs that were comparable at all — same name AND same version on both sides. */
  comparedClis: string[];
  /** CLIs in the pack this machine could not speak to, and why. */
  skipped: { cli: string; reason: string }[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The findings one source produces for one (event, tool), as comparable text. */
function findingsFor(cli: string, event: string, tool: string, keys: string[]): string[] {
  const record = { hooks: { [event]: { envelope: [], tools: { [tool]: keys } } } };
  return compareCliContract(cli, record)
    .findings.filter((f: ContractFinding) => f.tool === tool)
    .map((f) => `${f.kind}:${(f.missing ?? []).join("|")}`)
    .sort();
}

/** Every (event, tool) to key names, for one CLI record. */
function shapes(record: unknown): Map<string, { event: string; tool: string; keys: string[] }> {
  const out = new Map<string, { event: string; tool: string; keys: string[] }>();
  const hooks = asRecord(asRecord(record)?.hooks);
  if (!hooks) return out;
  for (const [event, shapeRaw] of Object.entries(hooks)) {
    const tools = asRecord(asRecord(shapeRaw)?.tools);
    if (!tools) continue;
    for (const [tool, keysRaw] of Object.entries(tools)) {
      out.set(`${event} ${tool}`, { event, tool, keys: strings(keysRaw).slice().sort() });
    }
  }
  return out;
}

/**
 * Compare a pack against this machine's own observations.
 *
 * Never throws: this decides whether to open a pull request, and a crash here
 * must read as "did not corroborate" rather than take a scheduled job down.
 */
export function corroborateContractPack(pack: unknown, local: unknown): Corroboration {
  const packClis = asRecord(asRecord(pack)?.clis) ?? {};
  const localClis = asRecord(asRecord(local)?.clis) ?? {};

  const disagreements: Disagreement[] = [];
  const comparedClis: string[] = [];
  const skipped: { cli: string; reason: string }[] = [];
  let agreed = 0;

  for (const [cli, labRecord] of Object.entries(packClis)) {
    const localRecord = localClis[cli];
    if (!localRecord) {
      skipped.push({ cli, reason: "this machine does not run it" });
      continue;
    }
    const labVersion = asRecord(labRecord)?.version;
    const localVersion = asRecord(localRecord)?.version;
    if (typeof labVersion !== "string" || typeof localVersion !== "string") {
      skipped.push({ cli, reason: "a version is missing on one side" });
      continue;
    }
    if (labVersion !== localVersion) {
      // The difference IS the vendor moving. Calling it a contradiction would
      // block exactly the promotions that matter most.
      skipped.push({ cli, reason: `lab drove ${labVersion}, this machine runs ${localVersion}` });
      continue;
    }

    const labShapes = shapes(labRecord);
    const localShapes = shapes(localRecord);
    let comparedHere = 0;

    for (const [key, lab] of labShapes) {
      const mine = localShapes.get(key);
      if (!mine) continue; // this machine never used that tool
      comparedHere += 1;

      const fromLab = findingsFor(cli, lab.event, lab.tool, lab.keys);
      const fromHere = findingsFor(cli, mine.event, mine.tool, mine.keys);
      if (fromLab.join(";") === fromHere.join(";")) {
        agreed += 1;
        continue;
      }
      disagreements.push({
        cli,
        version: labVersion,
        event: lab.event,
        tool: lab.tool,
        lab: lab.keys,
        local: mine.keys,
        detail:
          `${cli} ${labVersion} ${lab.tool}: the lab recorded [${lab.keys.join(", ")}], ` +
          `this machine recorded [${mine.keys.join(", ")}] — they do not lead to the same finding`,
      });
    }

    if (comparedHere > 0) comparedClis.push(cli);
    else skipped.push({ cli, reason: "no tool was exercised on both sides" });
  }

  const verdict: CorroborationVerdict =
    disagreements.length > 0 ? "contradicted" : agreed > 0 ? "corroborated" : "no-overlap";

  return { verdict, agreed, disagreements, comparedClis, skipped };
}

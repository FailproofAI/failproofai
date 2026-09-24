// @vitest-environment node
/**
 * The "Jev checks" section of `failproofai policies show <pack>`.
 *
 * Two things are worth pinning here, and they are different kinds of claim.
 *
 * The first is that the `reviews` column is DERIVED. It is the inverse of the
 * `reviewedBy` lists in the same manifest, so a publisher who marks one more
 * policy reviewable gets a new name in the column with nothing else edited —
 * and, the direction that matters, a policy Jev could never clear never appears
 * in it. A hardcoded or hand-kept column would pass a test that only checked
 * the names it was given; these tests change the manifest and expect the column
 * to move with it.
 *
 * The second is that these rows do not read as policies. A pack's Jev checks are
 * not selectable, `--policy` cannot name one, and none of them appears in
 * `failproofai policies` — the prose paragraph this section replaced said so,
 * and a table of rows that looked like the policy rows above it would say the
 * opposite by its shape alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { jevChecksSection, runPackCommand } from "@/src/hooks/pack-cli";
import type { SemanticManifestEntry } from "@/src/hooks/pack-manifest";
import type { PolicyCatalogEntry } from "@/src/hooks/policy-types";

/** Wide enough that nothing in these fixtures is truncated by the flex column. */
const OPTS = { cols: 100, color: false };

function check(name: string, over: Partial<SemanticManifestEntry> = {}): SemanticManifestEntry {
  return {
    name,
    title: `Did ${name}`,
    appliesTo: ["shell"],
    mode: "deny",
    userCanOverride: true,
    probes: [{ id: "does", instructions: "It does the thing." }],
    guidance: "Ask first.",
    ...over,
  } as SemanticManifestEntry;
}

function policy(name: string, reviewedBy?: string[], over: Partial<PolicyCatalogEntry> = {}): PolicyCatalogEntry {
  return {
    name,
    description: `d ${name}`,
    category: "Guards",
    defaultEnabled: true,
    match: { events: ["PreToolUse"] },
    ...(reviewedBy ? { authority: "reviewable" as const, reviewedBy } : { authority: "hard" as const }),
    ...over,
  } as PolicyCatalogEntry;
}

/** The section's rows, split back into cells — `table` joins on two spaces. */
function rowFor(lines: string[], name: string): string[] {
  const line = lines.find((l) => l.trim().split(/\s{2,}/)[1] === name);
  if (!line) throw new Error(`no row for ${name} in:\n${lines.join("\n")}`);
  return line.trim().split(/\s{2,}/);
}

const section = (
  policies: PolicyCatalogEntry[],
  semantic: SemanticManifestEntry[],
): string[] => jevChecksSection({ policies, semantic }, OPTS) ?? [];

describe("the section's shape", () => {
  it("prints nothing at all for a pack with no Jev checks", () => {
    // Not an empty section with a heading: a pack that declares none has no
    // semantic half to describe, and a heading over no rows invents one.
    expect(jevChecksSection({ policies: [policy("block-rm-rf")], semantic: [] }, OPTS)).toBeNull();
  });

  it("heads the section with the count and what these rows are not", () => {
    const lines = section([policy("block-rm-rf", ["destructive-deletion"])], [check("destructive-deletion")]);
    expect(lines[0]).toContain("Jev checks — 1 · not selectable · only where Jev is configured");
  });

  it("keeps saying that nothing toggles them, which no row can say", () => {
    const text = section([policy("block-rm-rf", ["destructive-deletion"])], [check("destructive-deletion")]).join("\n");
    expect(text).toContain("`--policy` cannot name one");
    expect(text).toContain("`failproofai policies` never lists them");
    expect(text).toContain("replace the ones this build ships with");
  });

  it("gives every row its mode, because that decides what pairing with it can do", () => {
    const lines = section(
      [policy("block-rm-rf", ["destructive-deletion"]), policy("warn-main", ["push-to-protected-branch"])],
      [check("destructive-deletion"), check("push-to-protected-branch", { mode: "instruct" })],
    );
    expect(rowFor(lines, "destructive-deletion")[0]).toBe("deny");
    expect(rowFor(lines, "push-to-protected-branch")[0]).toBe("instruct");
  });

  it("keeps a reason whole on an 80-column terminal, cutting a list before a sentence", () => {
    // 80 columns is the default a piped or narrow render gets, and the widest
    // builtin check name is 27 characters. `reviews` and `—` therefore lead the
    // last cell instead of holding a column of their own: padding every `—` out
    // to the width of `reviews` cost nine characters of the only column allowed
    // to shrink, which was enough to ellipsize the reason.
    const lines =
      jevChecksSection(
        {
          policies: Array.from({ length: 38 }, (_, i) => policy(`p-${i}`)),
          semantic: [
            check("external-destructive-action"),
            check("read-outside-workspace", { mode: "instruct" }),
          ],
        },
        { cols: 80, color: false },
      ) ?? [];
    expect(rowFor(lines, "external-destructive-action")[3]).toBe("nothing in the 38 covers this");
    expect(rowFor(lines, "read-outside-workspace")[3]).toBe("instruct-only — it can never deny");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("carries no on/off chip, because a check is not something you can switch", () => {
    const lines = section([policy("block-rm-rf", ["destructive-deletion"])], [check("destructive-deletion")]);
    // `chip("on")` / `chip("off")` are what every selectable row on this screen
    // carries. A Jev check row must not: there is nothing to toggle.
    expect(lines.join("\n")).not.toMatch(/\bon\b\s+destructive-deletion|\boff\b\s+destructive-deletion/);
  });
});

describe("the reviews column is inverted from the manifest", () => {
  it("names the policies that name the check, in the pack's own order", () => {
    const lines = section(
      [
        policy("block-env-files", ["secret-exposure"]),
        policy("protect-env-vars", ["secret-exposure"]),
        policy("block-rm-rf", ["destructive-deletion"]),
      ],
      [check("secret-exposure"), check("destructive-deletion")],
    );
    expect(rowFor(lines, "secret-exposure").slice(2)).toEqual(["reviews", "block-env-files, protect-env-vars"]);
    expect(rowFor(lines, "destructive-deletion").slice(2)).toEqual(["reviews", "block-rm-rf"]);
  });

  it("moves when the manifest moves, which is the whole reason it is derived", () => {
    const one = section([policy("block-rm-rf", ["destructive-deletion"])], [check("destructive-deletion")]);
    expect(rowFor(one, "destructive-deletion")[3]).toBe("block-rm-rf");
    // The same check, one policy renamed and one added — nothing else edited.
    const two = section(
      [policy("block-delete", ["destructive-deletion"]), policy("block-shred", ["destructive-deletion"])],
      [check("destructive-deletion")],
    );
    expect(rowFor(two, "destructive-deletion")[3]).toBe("block-delete, block-shred");
  });

  it("lists three reviewers in full, and counts past that", () => {
    const three = ["a-one", "a-two", "a-three"];
    const four = [...three, "a-four"];
    const listed = section(
      three.map((n) => policy(n, ["secret-exposure"])),
      [check("secret-exposure")],
    );
    expect(rowFor(listed, "secret-exposure")[3]).toBe("a-one, a-two, a-three");
    // Four is where a row stops being a list and becomes an answer to "can this
    // clear anything of mine": two names, then how many more there are.
    const counted = section(
      four.map((n) => policy(n, ["secret-exposure"])),
      [check("secret-exposure")],
    );
    expect(rowFor(counted, "secret-exposure")[3]).toBe("a-one, a-two, +2");
  });

  it("leaves out a policy whose reviewedBy sits under authority hard", () => {
    // A manifest may carry both fields independently — `authorityFieldsOf`
    // validates them separately — and such a policy registers hard, so Jev can
    // never clear it. Naming it here would promise a clear that cannot happen.
    const lines = section(
      [policy("block-rm-rf", undefined, { authority: "hard", reviewedBy: ["destructive-deletion"] })],
      [check("destructive-deletion")],
    );
    expect(rowFor(lines, "destructive-deletion").slice(2)).toEqual([
      "—",
      "the one policy here does not cover this",
    ]);
  });

  it("leaves out a policy that also names a check the pack does not declare", () => {
    // `reviewedBy` is a conjunction and registration is all-or-nothing: a name
    // the live set does not have makes the whole declaration hard, so the check
    // it DOES name still cannot clear that policy.
    const lines = section(
      [policy("block-rm-rf", ["destructive-deletion", "not-a-check"])],
      [check("destructive-deletion")],
    );
    expect(rowFor(lines, "destructive-deletion")[2]).toBe("—");
  });
});

describe("a check no policy names says why it is there", () => {
  it("tells a gap in the regex half apart from a check that could only clear", () => {
    const lines = section(
      [policy("block-rm-rf", ["destructive-deletion"])],
      [
        check("destructive-deletion"),
        check("credential-exfiltration"),
        check("push-to-protected-branch", { mode: "instruct" }),
      ],
    );
    // Deny, unnamed: nothing in the pack's regex half covers the concern, so
    // this check can only ever ADD a deny. The count is the pack's own.
    expect(rowFor(lines, "credential-exfiltration").slice(2)).toEqual([
      "—",
      "the one policy here does not cover this",
    ]);
    // Instruct, unnamed: it can never answer deny, so pairing it with a policy
    // could only ever clear that policy — which is why nothing pairs with it.
    expect(rowFor(lines, "push-to-protected-branch").slice(2)).toEqual([
      "—",
      "instruct-only — it can never deny",
    ]);
    // And the two reasons are not the same string, which is the point.
    expect(rowFor(lines, "credential-exfiltration")[3]).not.toBe(
      rowFor(lines, "push-to-protected-branch")[3],
    );
  });

  it("has a grammatical answer for a pack of checks alone, and for one policy", () => {
    // "nothing in the 38" borrows the count from the heading, and has no form at
    // zero or one. A pack of Jev checks alone is a legitimate thing to publish,
    // so neither spelling may fall out as "nothing in the 0".
    const none = section([], [check("destructive-deletion")]);
    expect(rowFor(none, "destructive-deletion").slice(2)).toEqual([
      "—",
      "this pack has no policies to clear",
    ]);
    expect(none.join("\n")).toContain("This pack ships no regex policies");
    expect(none.join("\n")).not.toMatch(/\b0 policies\b/);
    const many = section(
      Array.from({ length: 38 }, (_, i) => policy(`p-${i}`)),
      [check("destructive-deletion")],
    );
    expect(rowFor(many, "destructive-deletion")[3]).toBe("nothing in the 38 covers this");
  });
});

/**
 * The real command, over a real release layout — the manifest is fetched,
 * verified against its own SHA256SUMS and parsed by the loader's rules, so this
 * covers the wiring the unit tests above deliberately skip.
 */
describe("failproofai policies show <pack>", () => {
  const ENTRY = "export const hooks = [];\n";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  let server: Server;
  let root: string;
  let assets: Record<string, string>;
  const saved: Record<string, string | undefined> = {};
  let savedColumns: unknown;

  function release(manifest: Record<string, unknown>): void {
    const json = JSON.stringify({ id: "acme/guards", version: "1.2.0", ...manifest });
    assets = {
      "failproofai-pack.json": json,
      "failproofai-pack.mjs": ENTRY,
      SHA256SUMS: `${sha(json)}  failproofai-pack.json\n${sha(ENTRY)}  failproofai-pack.mjs\n`,
    };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "fpai-jev-section-"));
    for (const k of ["FAILPROOFAI_PACK_DIR", "FAILPROOFAI_PACK_BASE_URL", "FAILPROOFAI_NO_DOWNLOAD", "NO_COLOR"]) {
      saved[k] = process.env[k];
    }
    delete process.env.FAILPROOFAI_NO_DOWNLOAD;
    process.env.FAILPROOFAI_PACK_DIR = root;
    process.env.NO_COLOR = "1";
    savedColumns = (process.stdout as { columns?: unknown }).columns;
    (process.stdout as { columns?: unknown }).columns = 100;
    release({
      policies: [policy("block-rm-rf", ["destructive-deletion"])],
      semantic: [check("destructive-deletion"), check("external-data-egress", { mode: "instruct" })],
    });
    server = createServer((req, res) => {
      const m = (req.url ?? "").match(/^\/acme\/guards\/releases\/download\/[^/]+\/([^/]+)$/);
      const body = m ? assets[m[1]] : undefined;
      if (body === undefined) {
        res.writeHead(404).end("no such asset");
        return;
      }
      res.writeHead(200).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    (process.stdout as { columns?: unknown }).columns = savedColumns;
    rmSync(root, { recursive: true, force: true });
  });

  const show = async (): Promise<string[]> => {
    const r = await runPackCommand(["list", "acme/guards@v1.2.0"]);
    expect(r.exitCode).toBe(0);
    return r.lines;
  };

  it("renders the section instead of a paragraph listing the names", async () => {
    const lines = await show();
    const text = lines.join("\n");
    // The paragraph that used to carry this, gone: it named sixteen checks
    // comma-separated above a screen where everything else was a row.
    expect(text).not.toContain("It also carries");
    expect(text).toContain("Jev checks — 2 · not selectable · only where Jev is configured");
    expect(rowFor(lines, "destructive-deletion").slice(2)).toEqual(["reviews", "block-rm-rf"]);
    expect(rowFor(lines, "external-data-egress").slice(2)).toEqual([
      "—",
      "instruct-only — it can never deny",
    ]);
  });

  it("keeps the header count and the minCliVersion line as they were", async () => {
    release({
      minCliVersion: "1.0.7-beta.0",
      policies: [policy("block-rm-rf", ["destructive-deletion"])],
      semantic: [check("destructive-deletion")],
    });
    const text = (await show()).join("\n");
    expect(text).toContain("1 policies · 1 categories · 1 Jev check");
    expect(text).toContain("Requires failproofai 1.0.7-beta.0 or newer.");
  });

  it("sits under the policy rows, since a check is read against what it can clear", async () => {
    const lines = await show();
    const policyRow = lines.findIndex((l) => l.includes("block-rm-rf") && l.includes("default"));
    const heading = lines.findIndex((l) => l.includes("Jev checks —"));
    expect(policyRow).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(policyRow);
  });

  it("prints no section for a pack with no Jev checks, exactly as before", async () => {
    release({ policies: [policy("block-rm-rf")] });
    const text = (await show()).join("\n");
    expect(text).not.toContain("Jev check");
    expect(text).toContain("block-rm-rf");
  });
});

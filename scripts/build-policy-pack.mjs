#!/usr/bin/env bun
/**
 * Emit the builtin policies AS a policy pack.
 *
 * This is the dress rehearsal for builtins leaving the npm package. It produces
 * exactly what a third-party publisher would upload to a GitHub release — a
 * manifest, ONE bundled entry artifact, and a SHA256SUMS — so the same lane that
 * loads a stranger's pack can be pointed at ours and proved to produce identical
 * enforcement.
 *
 * Nothing on the hook path reads the output. `builtin-pack-conformance.test.ts`
 * loads it into a scratch registry and compares. That is the point: it turns the
 * eventual switch-over into a comparison someone already ran, rather than a leap.
 *
 * ## Two things it deliberately does
 *
 * **One file.** Transitive local imports are rewritten by the loader with no
 * integrity check of their own — only the ENTRY is content-addressed — so a
 * multi-file pack could not honestly claim to be digest-pinned. Bundling is what
 * makes the digest mean what it says.
 *
 * ## Runs under bun, not node
 *
 * It imports `policy-catalog.ts` directly for the manifest. Node cannot resolve
 * an extensionless TypeScript specifier at all before 22, and this repo targets
 * node >= 20.9 — on 22 it "works" while printing a reparse warning, which is the
 * worst of both: green here, broken on a supported version. bun reads TS
 * natively, and every other build step in this repo is already bun.
 *
 * **It omits the `alwaysOn` policy.** `block-failproofai-commands` is the guard
 * that stops an agent disabling failproofai, it ships compiled in, and
 * `pack-manifest.ts` REFUSES any pack that declares `alwaysOn`. A pack containing
 * it would be rejected by our own loader — correctly.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The one place the pack's id is decided. Imported rather than restated — see
// PACK_ID below for what restating it cost.
import { CORE_SOURCE } from "../src/hooks/pack-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `--out <dir>` lets the conformance test generate into a temp directory rather
// than depending on a build step having run first — the unit suite and the build
// are separate CI jobs, so a test that assumed `policy-pack/` existed would be
// green locally and skipped-or-broken in CI.
const outArg = process.argv.indexOf("--out");
const OUT_DIR = outArg !== -1 && process.argv[outArg + 1]
  ? resolve(process.argv[outArg + 1])
  : join(ROOT, "policy-pack");
// Not restated. The id is the most durable place a retired word can hide — it
// ends up in every machine's installed.json and in the listing every user reads
// — and restating it here is how it hid twice: `failproofai/builtins` shipped
// first, was corrected to `failproofai/core` HERE and nowhere else, and then
// `core` was retired in pack-store while this line went on saying it. The one
// published release still declares `failproofai/builtins`, so a machine that
// installed it cannot be addressed by either name anybody would type.
//
// Read from the layer that owns the set, so the next rename reaches this file
// whether or not somebody remembers it exists.
const PACK_ID = CORE_SOURCE;
const ENTRY_ASSET = "failproofai-pack.mjs";
const MANIFEST_ASSET = "failproofai-pack.json";
const CHECKSUMS_ASSET = "SHA256SUMS";

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// A generated entry that registers every non-alwaysOn builtin through the public
// policy API — the same API a third-party pack uses. `failproofai` stays external
// so the loader's shim resolves it, exactly as it does for any other pack.
//
// It registers `category` and `defaultEnabled` as well as name/description/
// match/fn, and that is not decoration. This script builds ITS manifest straight
// from POLICY_CATALOG, so omitting them from the ENTRY looked harmless — and was
// not: the entry IS the artifact, and anything that rebuilds a manifest from it
// saw 38 policies filed under "General" with none on by default. `failproofai
// publish` does exactly that, which is how a release that would have enforced
// nothing on a default install got as far as a dry run.
//
// Note for whoever edits the template below: it is a template literal, so a
// backtick inside it ends the string. Comments in there stay backtick-free.
const entrySource = `
import { customPolicies } from "failproofai";
import { BUILTIN_POLICIES } from ${JSON.stringify(join(ROOT, "src/hooks/builtin-policies.ts"))};

for (const policy of BUILTIN_POLICIES) {
  if (policy.alwaysOn) continue;
  customPolicies.add({
    name: policy.name,
    description: policy.description,
    // Both fields matter here; see the note above entrySource.
    category: policy.category,
    defaultEnabled: policy.defaultEnabled === true,
    match: policy.match,
    fn: policy.fn,
  });
}
`;

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const tempEntry = join(OUT_DIR, ".entry.generated.ts");
writeFileSync(tempEntry, entrySource, "utf8");
try {
  execFileSync(
    "bun",
    ["build", "--target=node", "--format=esm", "--external", "failproofai",
     "--outfile", join(OUT_DIR, ENTRY_ASSET), tempEntry],
    { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] },
  );
} finally {
  rmSync(tempEntry, { force: true });
}

// The manifest's policy list comes from the CATALOG, never from the bundle —
// which is the whole reason the catalog is pure literal data. `pack add`
// validates these with the loader's own rules, so a shape the loader would
// refuse fails this build rather than shipping.
const { POLICY_CATALOG } = await import(join(ROOT, "src/hooks/policy-catalog.ts"));
const policies = POLICY_CATALOG.filter((p) => !p.alwaysOn).map((p) => ({ ...p }));

const manifest = JSON.stringify(
  { id: PACK_ID, version, effect: "enforce", policies },
  null,
  2,
) + "\n";
writeFileSync(join(OUT_DIR, MANIFEST_ASSET), manifest, "utf8");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entryBytes = readFileSync(join(OUT_DIR, ENTRY_ASSET));
writeFileSync(
  join(OUT_DIR, CHECKSUMS_ASSET),
  `${sha(Buffer.from(manifest))}  ${MANIFEST_ASSET}\n${sha(entryBytes)}  ${ENTRY_ASSET}\n`,
  "utf8",
);

const omitted = POLICY_CATALOG.filter((p) => p.alwaysOn).map((p) => p.name);
console.log(
  `[policy-pack] ${PACK_ID}@${version} — ${policies.length} policies, ` +
  `${(entryBytes.length / 1024).toFixed(1)} KB entry` +
  (omitted.length ? `; omitted alwaysOn: ${omitted.join(", ")}` : ""),
);

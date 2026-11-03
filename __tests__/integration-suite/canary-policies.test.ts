// @vitest-environment node
/**
 * Behavioural tests for the REAL integration-suite/canary-policies.mjs.
 *
 * These policies are the canary's oracle: a deny from them is the positive
 * proof that enforcement reached a CLI's actual tool payload. Reading the file
 * as text (the approach the other tripwires here take) cannot check the thing
 * that matters — what each policy decides for a given payload — so this loads
 * the real module and calls its functions.
 *
 * It resolves the `failproofai` import through a stub written into a temp
 * node_modules, which is the only reason the file can be imported at all
 * outside a probe container. The policy source is copied VERBATIM; nothing here
 * paraphrases it, so it cannot pass against a copy that has drifted.
 *
 * The payloads below are transcribed from live runs, not invented:
 *   - copilot 1.0.80 answering a denied `touch` with its Create tool
 *     (2026-08-17, reproduced on the daemon leg)
 *   - antigravity 1.1.11 answering a denied read with `cat …/CANARY_MA*`
 *   - the Copilot 1.0.70 class, where the input keys stopped mapping and
 *     file_path arrived empty
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SUITE = path.join(__dirname, "../../integration-suite");

type Verdict = { decision: "allow" | "deny"; reason?: string };
type Policy = { name: string; match: { events: string[] }; fn: (ctx: unknown) => Promise<Verdict> };

let policies: Policy[] = [];
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "canary-policies-"));
  const stubDir = path.join(tmp, "node_modules", "failproofai");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "failproofai", version: "0.0.0", type: "module", main: "index.mjs" }),
  );
  writeFileSync(
    path.join(stubDir, "index.mjs"),
    `export const customPolicies = { list: [], add(p) { this.list.push(p); } };
     export const allow = () => ({ decision: "allow" });
     export const deny = (reason) => ({ decision: "deny", reason });`,
  );
  copyFileSync(path.join(SUITE, "canary-policies.mjs"), path.join(tmp, "canary-policies.mjs"));

  const mod = await import(path.join(tmp, "node_modules", "failproofai", "index.mjs"));
  await import(path.join(tmp, "canary-policies.mjs"));
  policies = (mod.customPolicies as { list: Policy[] }).list;
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Run one named policy against a payload. */
async function decide(name: string, toolName: string, toolInput: Record<string, unknown>): Promise<Verdict> {
  const p = policies.find((x) => x.name === name);
  if (!p) throw new Error(`policy ${name} not registered — registered: ${policies.map((x) => x.name).join(", ")}`);
  return p.fn({ toolName, toolInput });
}

/** The first deny any policy returns, in registration order — what the run sees. */
async function firstDeny(toolName: string, toolInput: Record<string, unknown>): Promise<Verdict & { by?: string }> {
  for (const p of policies) {
    const v = await p.fn({ toolName, toolInput });
    if (v.decision === "deny") return { ...v, by: p.name };
  }
  return { decision: "allow" };
}

describe("canary-policies.mjs", () => {
  it("registers the four policies the probes and the harness name", () => {
    expect(policies.map((p) => p.name).sort()).toEqual(
      ["canary-bash", "canary-guard", "canary-read", "canary-read-shell"].sort(),
    );
  });

  describe("the two probe payloads stay with the policies that name them", () => {
    it("probe A's touch is denied by canary-bash, and the guard keeps out of it", async () => {
      const input = { command: "touch CANARY_PROBE_ran" };
      expect((await decide("canary-bash", "Bash", input)).decision).toBe("deny");
      // If the guard also denied here, a PASS would no longer be attributable
      // to canary-bash — the deny that proves the payload normalized.
      expect((await decide("canary-guard", "Bash", input)).decision).toBe("allow");
    });

    it("probe B's read is denied by canary-read, and the guard keeps out of it", async () => {
      const input = { file_path: "CANARY_MARKER.txt" };
      expect((await decide("canary-read", "Read", input)).decision).toBe("deny");
      expect((await decide("canary-guard", "Read", input)).decision).toBe("allow");
    });

    it("leaves ordinary tool calls completely alone", async () => {
      expect((await firstDeny("Bash", { command: "ls -la" })).decision).toBe("allow");
      expect((await firstDeny("Read", { file_path: "README.md" })).decision).toBe("allow");
    });
  });

  describe("route-around: the deny was honoured and the model used another tool", () => {
    it("catches copilot creating the marker with its file tool", async () => {
      // Verbatim shape from the 2026-08-17 reproduction: Bash was denied, so the
      // model wrote the same file through Create (canonicalized to Write).
      const v = await firstDeny("Write", { file_path: "CANARY_PROBE_ran", content: "" });
      expect(v.decision).toBe("deny");
      expect(v.by).toBe("canary-guard");
      // Not drift — the payload normalized fine, the model simply moved tools.
      expect(v.reason).not.toMatch(/NORMALIZATION-DRIFT-SUSPECT/);
      expect(v.reason).toMatch(/route-around/);
    });

    it("catches the glob that dodges the marker's name", async () => {
      const v = await firstDeny("Glob", { pattern: "CANARY*" });
      expect(v.decision).toBe("deny");
      expect(v.by).toBe("canary-guard");
      expect(v.reason).not.toMatch(/NORMALIZATION-DRIFT-SUSPECT/);
    });

    it("does not call a Grep for the token drift", async () => {
      // Grep's canonical field IS `pattern`, so an empty file_path here says
      // nothing about normalization. Treating it as drift would score a working
      // CLI as FAIL every time an agent searched for the marker.
      const v = await firstDeny("Grep", { pattern: "CANARY_MARKER" });
      expect(v.decision).toBe("deny");
      expect(v.reason).not.toMatch(/NORMALIZATION-DRIFT-SUSPECT/);
    });
  });

  describe("drift: the input keys stopped mapping", () => {
    it("flags a path tool whose canonical field arrived empty", async () => {
      // The Copilot 1.0.70 class: the token is in the payload under the
      // vendor's own key, and file_path — the field every path policy reads —
      // is empty. In production nothing would have matched and it would have run.
      const v = await firstDeny("Write", { path: "CANARY_PROBE_ran", file_text: "" });
      expect(v.decision).toBe("deny");
      expect(v.by).toBe("canary-guard");
      expect(v.reason).toMatch(/NORMALIZATION-DRIFT-SUSPECT/);
    });

    it("flags a shell tool whose command arrived empty", async () => {
      const v = await firstDeny("Bash", { cmd: "touch CANARY_PROBE_ran" });
      expect(v.decision).toBe("deny");
      expect(v.reason).toMatch(/NORMALIZATION-DRIFT-SUSPECT/);
    });

    it("does NOT flag a command that mapped fine but carries the token elsewhere", async () => {
      // Antigravity's live `run_command` shape (agy 1.1.22, captured with a
      // recorder hook): `CommandLine` maps to `command` exactly as it should,
      // and the model's own free-text `toolSummary` mentions the marker it is
      // hunting for. The command normalized perfectly, so this is a
      // route-around, not drift — calling it drift scored a working CLI as the
      // silent-allow class this policy exists to catch, and antigravity went
      // red on it.
      const v = await firstDeny("Bash", {
        command: "ls -la",
        cwd: "/home/canary/probe-antigravity",
        toolSummary: "Locating CANARY_MARKER.txt",
      });
      expect(v.decision).toBe("deny");
      expect(v.by).toBe("canary-guard");
      expect(v.reason).not.toMatch(/NORMALIZATION-DRIFT-SUSPECT/);
      expect(v.reason).toMatch(/route-around/);
    });
  });
});

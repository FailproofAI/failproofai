// @vitest-environment node
/**
 * `config --oss|--agents --machine-label <name>` on a machine setup does not
 * connect. The label is the name to connect under, setup applies it only when
 * it connects, and on every other path it was dropped without a word while the
 * run exited 0. Now it is refused before setup, or applied as a rename after.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { applyMachineLabelAfterSetup, machineLabelRefusal } from "../../src/hooks/cloud-enrollment-cli";
import { readCloudCredentials, writeCloudCredentials } from "../../src/hooks/cloud-enrollment";

let dir: string;
let realHome: string | undefined;
const verify = async () => ({ ok: true, policyCount: 0, deployment: 1 }) as const;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "fpai-label-setup-"));
  process.env.FAILPROOFAI_CLOUD_CREDENTIALS = resolve(dir, "cloud.json");
  process.env.FAILPROOFAI_HOME = resolve(dir, "home");
  realHome = process.env.HOME;
  process.env.HOME = resolve(dir, "home");
});

afterEach(() => {
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  delete process.env.FAILPROOFAI_HOME;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("machineLabelRefusal — before setup writes anything", () => {
  it("refuses --oss on a machine that is not connected: nothing would carry the name", () => {
    const refusal = machineLabelRefusal({ oss: true, keyGiven: false, interactive: true });
    expect(refusal).toMatch(/--oss leaves this one unconnected/);
  });

  it("refuses an unattended run with no key on a machine that is not connected", () => {
    const refusal = machineLabelRefusal({ oss: false, keyGiven: false, interactive: false });
    expect(refusal).toMatch(/this one is not connected/);
    expect(refusal).toContain("FAILPROOFAI_CLOUD_TOKEN");
  });

  it("lets a run with a key through: setup connects under the name", () => {
    expect(machineLabelRefusal({ oss: false, keyGiven: true, interactive: false })).toBeNull();
  });

  it("lets a run at the prompt through: a key can still be pasted there", () => {
    expect(machineLabelRefusal({ oss: false, keyGiven: false, interactive: true })).toBeNull();
  });

  it("lets every run through on a connected machine, where the name is a rename", () => {
    writeCloudCredentials({ url: "https://x", machineId: "m-1", token: "t", machineLabel: "old" });
    expect(machineLabelRefusal({ oss: true, keyGiven: false, interactive: false })).toBeNull();
    expect(machineLabelRefusal({ oss: false, keyGiven: false, interactive: false })).toBeNull();
  });
});

describe("applyMachineLabelAfterSetup — after setup ran", () => {
  it("renames a machine setup left connected as it was (--agents, no new key)", async () => {
    writeCloudCredentials({ url: "https://x", machineId: "m-1", token: "t", machineLabel: "old" });
    const r = await applyMachineLabelAfterSetup("prod-01", { verify });
    expect(r?.exitCode).toBe(0);
    expect(r?.lines.join("\n")).toContain("Renamed old to prod-01");
    expect(readCloudCredentials()?.machineLabel).toBe("prod-01");
  });

  it("says nothing when setup already connected under the name", async () => {
    writeCloudCredentials({ url: "https://x", machineId: "m-1", token: "t", machineLabel: "prod-01" });
    expect(await applyMachineLabelAfterSetup("prod-01", { verify })).toBeNull();
  });

  it("says nothing when no label was given", async () => {
    expect(await applyMachineLabelAfterSetup(undefined, { verify })).toBeNull();
  });

  it("says the name was not applied when open source was chosen at the prompt", async () => {
    const r = await applyMachineLabelAfterSetup("prod-01", { verify });
    expect(r?.lines[0]).toBe("▲ prod-01 was not applied: this machine is not connected to FailproofAI Cloud.");
    expect(readCloudCredentials()).toBeNull();
  });
});

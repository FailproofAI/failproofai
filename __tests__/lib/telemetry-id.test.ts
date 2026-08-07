// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

vi.mock("node:fs");
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      platform: vi.fn(() => "linux"),
      hostname: vi.fn(() => "test-host"),
      homedir: vi.fn(() => "/home/test"),
      arch: vi.fn(() => "x64"),
      cpus: vi.fn(() => [{ model: "Test CPU" }]),
    },
  };
});
vi.mock("node:child_process", () => {
  const execSync = vi.fn();
  return { default: { execSync }, execSync };
});
vi.mock("node:crypto", async () => {
  const actual =
    await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    default: {
      ...actual,
      randomUUID: vi.fn(),
      createHmac: actual.createHmac,
    },
  };
});

const mockedFs = vi.mocked(fs);
const mockedOs = vi.mocked(os);
const mockedExecSync = vi.mocked(execSync);

describe("lib/telemetry-id", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    // Defaults
    mockedOs.platform.mockReturnValue("linux");
    mockedOs.hostname.mockReturnValue("test-host");
    mockedOs.homedir.mockReturnValue("/home/test");
    mockedOs.arch.mockReturnValue("x64");
    mockedOs.cpus.mockReturnValue([{ model: "Test CPU" } as os.CpuInfo]);
  });

  async function loadModule() {
    return await import("@/lib/telemetry-id");
  }

  function expectedHmac(raw: string): string {
    return crypto
      .createHmac("sha256", "failproofai-telemetry-v1")
      .update(raw)
      .digest("hex");
  }

  describe("Tier 1: OS-native machine ID", () => {
    it("Linux — reads /etc/machine-id and returns HMAC hash", async () => {
      const machineId = "abc123-linux-machine-id";
      mockedOs.platform.mockReturnValue("linux");
      mockedFs.readFileSync.mockImplementation((p) => {
        if (p === "/etc/machine-id") return machineId;
        throw new Error("ENOENT");
      });

      const { getInstanceId } = await loadModule();
      const id = getInstanceId();

      expect(id).toBe(expectedHmac(machineId));
      expect(id).toHaveLength(64); // SHA-256 hex
    });

    it("Linux — falls back to /var/lib/dbus/machine-id", async () => {
      const machineId = "dbus-machine-id-456";
      mockedOs.platform.mockReturnValue("linux");
      mockedFs.readFileSync.mockImplementation((p) => {
        if (p === "/var/lib/dbus/machine-id") return machineId;
        throw new Error("ENOENT");
      });

      const { getInstanceId } = await loadModule();
      expect(getInstanceId()).toBe(expectedHmac(machineId));
    });

    it("macOS — extracts IOPlatformUUID from ioreg", async () => {
      const uuid = "DEADBEEF-1234-5678-ABCD-FEEDFACEBEEF";
      mockedOs.platform.mockReturnValue("darwin");
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockedExecSync.mockReturnValue(
        `+-o Root  <class IORegistryEntry>\n  | "IOPlatformUUID" = "${uuid}"\n`,
      );

      const { getInstanceId } = await loadModule();
      expect(getInstanceId()).toBe(expectedHmac(uuid));
    });

    it("Windows — extracts MachineGuid from registry", async () => {
      const guid = "12345678-abcd-efgh-ijkl-mnopqrstuvwx";
      mockedOs.platform.mockReturnValue("win32");
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockedExecSync.mockReturnValue(
        `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n`,
      );

      const { getInstanceId } = await loadModule();
      expect(getInstanceId()).toBe(expectedHmac(guid));
    });
  });

  describe("Tier 2: System properties fallback", () => {
    it("falls back to system properties hash when Tier 1 fails", async () => {
      mockedOs.platform.mockReturnValue("linux");
      // All file reads fail
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const { getInstanceId } = await loadModule();
      const id = getInstanceId();

      const expected = expectedHmac("test-host:/home/test:linux:x64:Test CPU");
      expect(id).toBe(expected);
      expect(id).toHaveLength(64);
    });
  });

  describe("Tier 3: File-based UUID fallback", () => {
    it("Tier 1 succeeds when file read returns machine-id", async () => {
      mockedOs.platform.mockReturnValue("linux");
      mockedFs.readFileSync.mockReturnValue("abc123-linux-machine-id");

      const { getInstanceId } = await loadModule();
      const id = getInstanceId();
      // Tier 1 succeeds with /etc/machine-id
      expect(id).toBe(expectedHmac("abc123-linux-machine-id"));
    });
  });

  describe("Caching", () => {
    it("second call returns cached value without re-reading", async () => {
      const machineId = "cached-machine-id";
      mockedOs.platform.mockReturnValue("linux");
      mockedFs.readFileSync.mockImplementation((p) => {
        if (p === "/etc/machine-id") return machineId;
        throw new Error("ENOENT");
      });

      const { getInstanceId } = await loadModule();
      const first = getInstanceId();

      // Reset mocks to verify no further calls
      mockedFs.readFileSync.mockClear();
      mockedExecSync.mockClear();

      const second = getInstanceId();
      expect(second).toBe(first);
      expect(mockedFs.readFileSync).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
    });
  });

  describe("Determinism", () => {
    it("same machine ID input produces same hash output", async () => {
      const machineId = "determinism-test-id";
      mockedOs.platform.mockReturnValue("linux");
      mockedFs.readFileSync.mockImplementation((p) => {
        if (p === "/etc/machine-id") return machineId;
        throw new Error("ENOENT");
      });

      const mod1 = await loadModule();
      const id1 = mod1.getInstanceId();

      // Re-import to get a fresh module (reset cachedId)
      vi.resetModules();
      const mod2 = await import("@/lib/telemetry-id");
      const id2 = mod2.getInstanceId();

      expect(id1).toBe(id2);
      expect(id1).toBe(expectedHmac(machineId));
    });
  });

  describe("hashToId", () => {
    it("produces a 64-char hex string", async () => {
      const { hashToId } = await loadModule();
      const result = hashToId("test-input");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic", async () => {
      const { hashToId } = await loadModule();
      expect(hashToId("foo")).toBe(hashToId("foo"));
    });

    it("different inputs produce different outputs", async () => {
      const { hashToId } = await loadModule();
      expect(hashToId("input-a")).not.toBe(hashToId("input-b"));
    });
  });
});

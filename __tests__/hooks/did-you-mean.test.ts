// @vitest-environment node
/**
 * "Did you mean …?" for a word or a top-level flag the CLI does not know.
 *
 * The suggester this replaced always answered with the nearest spelling of a
 * subcommand, so `status` got `flush`, `install` got `uninstall` — the opposite
 * of what was asked — and `-i` got `audit`. These pin the three things that
 * fixed it: a table of words people type, a distance cut-off, and silence when
 * nothing is close.
 */
import { describe, it, expect } from "vitest";
import { nearestName, suggestCommand, suggestFlag } from "../../src/hooks/did-you-mean";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

/** The CLI's own list, as bin/failproofai.mjs declares it. */
const SUBCOMMANDS = ["policies", "audit", "config", "uninstall", "backfill", "flush", "harness", "jev", "publish", "update", "migrate", "help"];

describe("suggestCommand — the words people type", () => {
  it.each([
    ["status", "failproofai config --status"],
    ["pause", "failproofai config --pause"],
    ["resume", "failproofai config --resume"],
    ["login", "failproofai config"],
    ["setup", "failproofai config"],
    ["install", "failproofai policies --install"],
    ["logout", "failproofai config --disconnect"],
    ["upgrade", "failproofai update"],
    ["hook", "failproofai help hook"],
    ["dashboard", "failproofai"],
  ])("%s → %s", (word, suggestion) => {
    expect(suggestCommand(word, SUBCOMMANDS)).toBe(suggestion);
  });

  it("answers `install` with what it asked for, never with `uninstall`", () => {
    // Two edits apart, so a nearest-spelling guess within the cut-off would
    // still pick it. The table is asked first.
    expect(suggestCommand("install", SUBCOMMANDS)).not.toMatch(/uninstall/);
  });

  it("finds a table word through a typo of it", () => {
    expect(suggestCommand("statsu", SUBCOMMANDS)).toBe("failproofai config --status");
    expect(suggestCommand("instal", SUBCOMMANDS)).toBe("failproofai policies --install");
  });

  it("points a stale `auth` at the audit, where its sign-in lives now", () => {
    expect(suggestCommand("auth", SUBCOMMANDS)).toBe("failproofai audit");
  });

  it("is not fooled by case", () => {
    expect(suggestCommand("Config", SUBCOMMANDS)).toBe("failproofai config");
    expect(suggestCommand("STATUS", SUBCOMMANDS)).toBe("failproofai config --status");
  });
});

describe("suggestCommand — typos of real commands", () => {
  it.each([
    ["confg", "failproofai config"],
    ["audits", "failproofai audit"],
    ["cofnig", "failproofai config"], // a swap is one slip, not two
    ["polcies", "failproofai policies"],
    ["unistall", "failproofai uninstall"],
    ["hlep", "failproofai help"],
  ])("%s → %s", (word, suggestion) => {
    expect(suggestCommand(word, SUBCOMMANDS)).toBe(suggestion);
  });

  it("takes a unique prefix over a nearer spelling: `back` is backfill, not `pack`", () => {
    expect(suggestCommand("back", SUBCOMMANDS)).toBe("failproofai backfill");
    expect(suggestCommand("pub", SUBCOMMANDS)).toBe("failproofai publish");
  });

  it("keeps an uninstall typo on uninstall", () => {
    expect(suggestCommand("uninstal", SUBCOMMANDS)).toBe("failproofai uninstall");
  });
});

describe("suggestCommand — the distance cut-off", () => {
  it.each(["unknowncommand", "frobnicate", "xyz", "q"])("suggests nothing for %s, which is close to nothing", (word) => {
    expect(suggestCommand(word, SUBCOMMANDS)).toBeNull();
  });

  it("matches two letters or fewer exactly, since almost anything is one edit from `ls`", () => {
    expect(suggestCommand("ls", SUBCOMMANDS)).toBe("failproofai policies");
    expect(suggestCommand("lz", SUBCOMMANDS)).toBeNull();
  });

  it("allows one edit up to four letters, two beyond", () => {
    expect(suggestCommand("jevv", SUBCOMMANDS)).toBe("failproofai jev");
    expect(suggestCommand("hepp", SUBCOMMANDS)).toBe("failproofai help"); // one edit
    expect(suggestCommand("hxlx", SUBCOMMANDS)).toBeNull(); // two edits from help
    expect(suggestCommand("pubilsh", SUBCOMMANDS)).toBe("failproofai publish");
  });

  it("suggests nothing for an empty word", () => {
    expect(suggestCommand("", SUBCOMMANDS)).toBeNull();
  });
});

describe("suggestFlag", () => {
  it("never answers `-i` with `audit`", () => {
    expect(suggestFlag("-i")).not.toMatch(/audit/);
    expect(suggestFlag("-i")).toBe("failproofai policies --install");
  });

  it("maps a flag that belongs to a command to that command", () => {
    expect(suggestFlag("--status")).toBe("failproofai config --status");
    expect(suggestFlag("--install")).toBe("failproofai policies --install");
    expect(suggestFlag("--list")).toBe("failproofai policies");
  });

  it("suggests a top-level flag as a whole command, runnable as printed", () => {
    expect(suggestFlag("--versoin")).toBe("failproofai --version");
    expect(suggestFlag("--hlep")).toBe("failproofai --help");
    expect(suggestFlag("-V")).toBe("failproofai --version");
  });

  it.each(["--verbose", "--json", "--unknownflag", "-x"])("suggests nothing for %s", (flag) => {
    expect(suggestFlag(flag)).toBeNull();
  });

  it("never offers --hook, the flag only an agent's hook command passes", () => {
    for (const flag of ["--token", "--json", "--hooks", "--hok"]) {
      expect(suggestFlag(flag) ?? "").not.toMatch(/--hook/);
    }
  });
});

describe("nearestName — an agent id", () => {
  it("finds the agent a typo meant", () => {
    expect(nearestName("claud", INTEGRATION_TYPES)).toBe("claude");
    expect(nearestName("Codex", INTEGRATION_TYPES)).toBe("codex");
    expect(nearestName("gose", INTEGRATION_TYPES)).toBe("goose");
  });

  it("names no agent for a word that is none of them", () => {
    expect(nearestName("block-sudo", INTEGRATION_TYPES)).toBeNull();
    expect(nearestName("", INTEGRATION_TYPES)).toBeNull();
  });
});

// @vitest-environment node
/**
 * The comparator turns "what the vendor sent" into "what stopped working".
 *
 * Two properties matter more than any individual case. It must not invent
 * findings about CLIs that are working — a drift report nobody trusts is a
 * report nobody reads — which is why the first test runs it over a table
 * captured from a real goose session and demands silence. And its notion of
 * "a key we need" must stay tied to the keys policies actually read, which the
 * last test enforces by grepping the policies themselves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareCliContract,
  compareContractTable,
  REQUIRED_TOOL_INPUT_KEYS,
} from "../../src/hooks/contract-compare";

const REAL_GOOSE = join(__dirname, "..", "fixtures", "contracts", "goose-1.43.0.json");

/** Findings for one CLI from a bare hooks map. */
function findings(cli: string, hooks: Record<string, unknown>) {
  return compareCliContract(cli, { hooks }).findings;
}

function tools(tool: string, keys: string[]) {
  return { PreToolUse: { envelope: [], tools: { [tool]: keys } } };
}

describe("contract-compare: it must not cry wolf", () => {
  it("finds nothing in a table captured from a real, working goose session", () => {
    // Captured live from goose 1.43.0 by contracts-probe.sh: `write` arriving
    // as {content, path}, which GOOSE_TOOL_INPUT_MAP translates. If this ever
    // reports a finding, the comparator is wrong, not goose.
    const table = JSON.parse(readFileSync(REAL_GOOSE, "utf8")) as unknown;
    const [goose] = compareContractTable(table);
    expect(goose.cli).toBe("goose");
    expect(goose.version).toBe("1.43.0");
    expect(goose.findings).toEqual([]);
  });

  it("stays silent for a rename we already absorbed", () => {
    // Copilot 1.0.71 renamed Read's file_path to path. That incident is closed:
    // COPILOT_TOOL_INPUT_MAP translates it, so it must read as healthy.
    expect(findings("copilot", tools("read", ["path"]))).toEqual([]);
  });

  it("accepts a canonical key from a CLI with no input map at all", () => {
    // Factory needs no map — its keys are already canonical. Absence of a map
    // must not read as absence of the key.
    expect(findings("factory", tools("Execute", ["command"]))).toEqual([]);
  });

  it("says nothing about a CLI it does not know", () => {
    // Canonicalization is per-CLI; running the wrong CLI's maps would invent
    // drift that is not there.
    expect(findings("some-new-cli", tools("Execute", ["nonsense"]))).toEqual([]);
  });
});

describe("contract-compare: the failure it exists for", () => {
  it("reports a key rename that leaves path policies unable to fire", () => {
    // The Copilot 1.0.71 class, as it would be caught today: a rename nobody
    // has mapped yet.
    const [f] = findings("copilot", tools("read", ["uri"]));
    expect(f.kind).toBe("inert-tool-input");
    expect(f.severity).toBe("high");
    expect(f.canonicalTool).toBe("Read");
    expect(f.missing).toEqual(["file_path", "path"]);
    expect(f.detail).toContain("block-env-files");
  });

  it("reports a renamed Bash argument, which disables every command policy", () => {
    const [f] = findings("factory", tools("Execute", ["cmd", "cwd"]));
    expect(f.severity).toBe("high");
    expect(f.missing).toEqual(["command"]);
  });

  it("accepts either spelling of the path key, because the policy reads either", () => {
    // block-read-outside-cwd reads `toolInput.file_path || toolInput.path`.
    // Demanding one spelling would manufacture findings about working CLIs.
    expect(findings("factory", tools("Read", ["file_path"]))).toEqual([]);
    expect(findings("factory", tools("Read", ["path"]))).toEqual([]);
  });

  it("rates a lost advisory key below a lost blocking key", () => {
    // Losing `content` degrades one warning. Losing the path stops denials.
    const [f] = findings("goose", tools("write", ["path"]));
    expect(f.severity).toBe("info");
    expect(f.missing).toEqual(["content"]);
  });
});

describe("contract-compare: a renamed tool NAME", () => {
  it("escalates when an untranslated tool carries a gated tool's keys", () => {
    // The name alone cannot distinguish a rename from a third-party tool. The
    // keys can: a tool we cannot translate arriving with `command` is the shell
    // tool, and every Bash policy is matching nothing.
    const [f] = findings("factory", tools("Run", ["command"]));
    expect(f.kind).toBe("unmapped-tool");
    expect(f.severity).toBe("high");
    expect(f.detail).toContain("looks like a rename");
    expect(f.detail).toContain("Bash");
  });

  it("does not escalate a plainly third-party tool", () => {
    const [f] = findings("factory", tools("Sparkle", ["glitter"]));
    expect(f.severity).toBe("info");
  });

  it("does not escalate namespaced extension or MCP tools even when keys collide", () => {
    // `mcp__x__y` and goose's `<ext>__<tool>` are how other people's tools are
    // named. A `path` key on one of those is coincidence, not a rename.
    const [f] = findings("factory", tools("mcp__files__open", ["path"]));
    expect(f.severity).toBe("info");
  });

  it("says nothing about a tool the map already translates", () => {
    expect(findings("goose", tools("todo__todo_write", ["todos"]))).toEqual([]);
  });
});

describe("contract-compare: events", () => {
  it("reports an event whose name routes to no policy", () => {
    const [f] = findings("antigravity", { PreToolCall: { envelope: [] } });
    expect(f.kind).toBe("unroutable-event");
    expect(f.severity).toBe("high");
  });

  it("accepts an event that only routes after mapping", () => {
    // Antigravity's PreInvocation is UserPromptSubmit. Judging the raw name
    // would flag every non-Claude CLI.
    expect(findings("antigravity", { PreInvocation: { envelope: [] } })).toEqual([]);
  });
});

describe("contract-compare: it must never throw", () => {
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an array", [1, 2, 3]],
    ["an empty object", {}],
    ["clis holding a string", { clis: { goose: "broken" } }],
    ["hooks holding an array", { clis: { goose: { hooks: [1, 2] } } }],
    ["tools holding junk", { clis: { goose: { hooks: { PreToolUse: { tools: 5 } } } } }],
    ["keys that are not strings", { clis: { goose: { hooks: { PreToolUse: { tools: { write: [1, null] } } } } } }],
  ])("survives %s", (_label, input) => {
    expect(() => compareContractTable(input)).not.toThrow();
  });

  it("ignores fields it does not recognise, so a newer producer stays readable", () => {
    // The same comparison runs over tables produced elsewhere by a newer build.
    const table = {
      schemaVersion: 99,
      somethingNew: { nested: true },
      clis: {
        goose: {
          version: "9.9.9",
          futureField: [1, 2],
          hooks: { PreToolUse: { envelope: [], tools: { write: ["path", "content"] }, extra: "x" } },
        },
      },
    };
    const [goose] = compareContractTable(table);
    expect(goose.version).toBe("9.9.9");
    expect(goose.findings).toEqual([]);
  });
});

describe("contract-compare: the requirement table cannot rot", () => {
  it("only names keys the builtin policies actually read", () => {
    // The table is hand-written, which is what rots. Rename a key in a policy
    // and this fails, instead of the comparator quietly checking for something
    // nothing reads any more.
    const policies = readFileSync(
      join(__dirname, "..", "..", "src", "hooks", "builtin-policies.ts"),
      "utf8",
    );
    const named = new Set(
      Object.values(REQUIRED_TOOL_INPUT_KEYS).flatMap((reqs) => reqs.flatMap((r) => r.anyOf)),
    );
    for (const key of named) {
      expect({ key, readByAPolicy: policies.includes(`toolInput?.${key}`) }).toEqual({
        key,
        readByAPolicy: true,
      });
    }
  });

  it("covers every canonical tool our maps can produce that policies gate", () => {
    // A new CLI whose map produces `Bash` must be checked for `command`. This
    // fails if someone adds a gated tool to the maps and not to the table.
    expect(Object.keys(REQUIRED_TOOL_INPUT_KEYS).sort()).toEqual(
      ["Bash", "Edit", "Grep", "Read", "Write"].sort(),
    );
  });
});

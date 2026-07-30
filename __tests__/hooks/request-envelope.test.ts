// @vitest-environment node
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";

import {
  ENVELOPE_PROTOCOL_VERSION,
  ENV_FACT_KEYS,
  EnvelopeProtocolError,
  HOST_FIELD_NAMES,
  assertHostContext,
  buildLocalEnvelope,
  checkHostContext,
  envelopeToSessionMetadata,
  sealedUnattested,
  selectEnvFacts,
  type EvaluationRequest,
  type HostFieldName,
  type LocalEnvelopeInput,
  type UnvalidatedHostContext,
} from "../../src/hooks/request-envelope";
import { readLocalHostFacts } from "../../src/hooks/local-host";

function input(overrides: Partial<LocalEnvelopeInput> = {}): LocalEnvelopeInput {
  return {
    cli: "claude",
    eventType: "PreToolUse",
    rawEventType: "PreToolUse",
    payload: { tool_name: "Bash", tool_input: { command: "ls" } },
    cwd: "/home/u/project",
    sessionId: "sess-1",
    transcriptPath: "/home/u/.claude/projects/x/sess-1.jsonl",
    permissionMode: "default",
    hookEventName: "PreToolUse",
    host: { home: "/home/u", envFacts: {} },
    ...overrides,
  };
}

describe("buildLocalEnvelope — provenance labelling", () => {
  it("labels `home` as `local` (this process read its own homedir; no boundary crossed)", () => {
    const req = buildLocalEnvelope(input());
    expect(req.host.home).toEqual({ value: "/home/u", provenance: "local" });
  });

  it("never labels `home` `client-asserted` on the local path", () => {
    const req = buildLocalEnvelope(input());
    expect(req.host.home.provenance).not.toBe("client-asserted");
    expect(checkHostContext(req.host)).toBeNull();
  });

  it("labels `cwd` as `client-asserted` (the harness told us; nothing verified it)", () => {
    const req = buildLocalEnvelope(input());
    expect(req.host.cwd).toEqual({ value: "/home/u/project", provenance: "client-asserted" });
  });

  it("labels `projectDir` as `client-asserted`, derived from the CLAUDE_PROJECT_DIR env fact", () => {
    const req = buildLocalEnvelope(
      input({ host: { home: "/home/u", envFacts: { CLAUDE_PROJECT_DIR: "/home/u/repo" } } }),
    );
    expect(req.host.projectDir).toEqual({
      value: "/home/u/repo",
      provenance: "client-asserted",
    });
  });

  it("carries an undefined projectDir when CLAUDE_PROJECT_DIR is unset, still client-asserted", () => {
    const req = buildLocalEnvelope(input());
    expect(req.host.projectDir.value).toBeUndefined();
    expect(req.host.projectDir.provenance).toBe("client-asserted");
  });

  it("labels `envFacts` as `client-asserted`", () => {
    const req = buildLocalEnvelope(
      input({ host: { home: "/home/u", envFacts: { CLAUDE_PROJECT_DIR: "/home/u/repo" } } }),
    );
    expect(req.host.envFacts.provenance).toBe("client-asserted");
    expect(req.host.envFacts.value).toEqual({ CLAUDE_PROJECT_DIR: "/home/u/repo" });
  });

  it("labels every host field the contract enumerates", () => {
    const req = buildLocalEnvelope(input());
    for (const field of HOST_FIELD_NAMES) {
      expect(req.host[field]).toHaveProperty("provenance");
    }
  });
});

describe("buildLocalEnvelope — envelope contents", () => {
  it("carries the caller-resolved session fields verbatim", () => {
    const req = buildLocalEnvelope(input());
    expect(req.session).toEqual({
      sessionId: "sess-1",
      transcriptPath: "/home/u/.claude/projects/x/sess-1.jsonl",
      permissionMode: "default",
      hookEventName: "PreToolUse",
    });
  });

  it("keeps the canonical and the raw event names separately", () => {
    const req = buildLocalEnvelope(
      input({ cli: "cursor", eventType: "PreToolUse", rawEventType: "preToolUse" }),
    );
    expect(req.eventType).toBe("PreToolUse");
    expect(req.rawEventType).toBe("preToolUse");
  });

  it("passes the already-canonicalized payload through by reference", () => {
    const payload = { tool_name: "Bash" };
    const req = buildLocalEnvelope(input({ payload }));
    expect(req.payload).toBe(payload);
  });

  it("stamps the protocol version", () => {
    expect(buildLocalEnvelope(input()).protocolVersion).toBe(ENVELOPE_PROTOCOL_VERSION);
  });
});

describe("client-asserted `home` is a protocol error", () => {
  const forged: UnvalidatedHostContext = {
    home: { value: "/", provenance: "client-asserted" },
    cwd: { value: "/home/u/project", provenance: "client-asserted" },
    projectDir: { value: undefined, provenance: "client-asserted" },
    envFacts: { value: {}, provenance: "client-asserted" },
  };

  it("checkHostContext reports it instead of accepting it", () => {
    const violation = checkHostContext(forged);
    expect(violation).toBeInstanceOf(EnvelopeProtocolError);
    expect(violation?.code).toBe("client_asserted_home");
    expect(violation?.field).toBe("home");
  });

  it("assertHostContext throws EnvelopeProtocolError", () => {
    expect(() => assertHostContext(forged)).toThrow(EnvelopeProtocolError);
    expect(() => assertHostContext(forged)).toThrow(/client-asserted home/i);
  });

  it("accepts a daemon-derived home", () => {
    const host: UnvalidatedHostContext = {
      ...forged,
      home: { value: "/home/u", provenance: "daemon-derived" },
    };
    expect(checkHostContext(host)).toBeNull();
    expect(() => assertHostContext(host)).not.toThrow();
  });

  it("accepts a locally read home", () => {
    const host: UnvalidatedHostContext = {
      ...forged,
      home: { value: "/home/u", provenance: "local" },
    };
    expect(checkHostContext(host)).toBeNull();
    expect(() => assertHostContext(host)).not.toThrow();
  });
});

describe("sealedUnattested", () => {
  const host = buildLocalEnvelope(input()).host;

  it("is false when the decision read no host field at all (e.g. block-sudo)", () => {
    expect(sealedUnattested(host, [])).toBe(false);
  });

  it("is false when the decision read only attested fields (home)", () => {
    expect(sealedUnattested(host, ["home"])).toBe(false);
  });

  it("is true when the decision read cwd (block-read-outside-cwd)", () => {
    expect(sealedUnattested(host, ["cwd"])).toBe(true);
  });

  it("is true when the decision read projectDir", () => {
    expect(sealedUnattested(host, ["projectDir"])).toBe(true);
  });

  it("is true when the decision read envFacts", () => {
    expect(sealedUnattested(host, ["envFacts"])).toBe(true);
  });

  it("is true when a mixed read touches one client-asserted field", () => {
    expect(sealedUnattested(host, ["home", "cwd"])).toBe(true);
  });

  it("is exactly `read set intersects client-asserted set` across every field", () => {
    const clientAsserted = new Set<HostFieldName>(["cwd", "projectDir", "envFacts"]);
    for (const field of HOST_FIELD_NAMES) {
      expect(sealedUnattested(host, [field])).toBe(clientAsserted.has(field));
    }
  });

  it("is false for a daemon-derived home read", () => {
    const daemonHost: UnvalidatedHostContext = {
      ...host,
      home: { value: "/home/u", provenance: "daemon-derived" },
    };
    expect(sealedUnattested(daemonHost, ["home"])).toBe(false);
  });

  it("fails toward unattested when a forged home reaches it unvalidated", () => {
    const forgedHost: UnvalidatedHostContext = {
      ...host,
      home: { value: "/", provenance: "client-asserted" },
    };
    expect(sealedUnattested(forgedHost, ["home"])).toBe(true);
  });
});

describe("selectEnvFacts — the env-fact set is closed", () => {
  it("carries an enumerated key", () => {
    expect(selectEnvFacts({ CLAUDE_PROJECT_DIR: "/repo" })).toEqual({
      CLAUDE_PROJECT_DIR: "/repo",
    });
  });

  it("does not carry an unlisted env var", () => {
    const facts = selectEnvFacts({
      CLAUDE_PROJECT_DIR: "/repo",
      AWS_SECRET_ACCESS_KEY: "shhh",
      PATH: "/usr/bin",
      HOME: "/home/u",
    });
    expect(facts).toEqual({ CLAUDE_PROJECT_DIR: "/repo" });
    expect(Object.keys(facts)).toEqual(["CLAUDE_PROJECT_DIR"]);
  });

  it("never carries a key outside ENV_FACT_KEYS, whatever the environment", () => {
    const facts = selectEnvFacts({ FOO: "1", BAR: "2", BAZ: "3" });
    expect(Object.keys(facts)).toEqual([]);
    for (const key of Object.keys(selectEnvFacts(process.env))) {
      expect(ENV_FACT_KEYS as readonly string[]).toContain(key);
    }
  });

  it("drops an exported-but-empty variable rather than carrying an empty path", () => {
    expect(selectEnvFacts({ CLAUDE_PROJECT_DIR: "" })).toEqual({});
  });

  it("keeps an unlisted var out of the built envelope's envFacts too", () => {
    const req = buildLocalEnvelope(
      input({
        host: {
          home: "/home/u",
          envFacts: selectEnvFacts({ CLAUDE_PROJECT_DIR: "/repo", GITHUB_TOKEN: "ghp_x" }),
        },
      }),
    );
    expect(req.host.envFacts.value).toEqual({ CLAUDE_PROJECT_DIR: "/repo" });
  });
});

describe("readLocalHostFacts", () => {
  it("reads home from the process and env facts through the closed set", () => {
    const facts = readLocalHostFacts();
    expect(facts.home).toBe(homedir());
    for (const key of Object.keys(facts.envFacts)) {
      expect(ENV_FACT_KEYS as readonly string[]).toContain(key);
    }
  });
});

describe("envelopeToSessionMetadata — the legacy bridge", () => {
  it("projects the SessionMetadata fields handler.ts built by hand, plus the P2 host pair", () => {
    const req = buildLocalEnvelope(input({ cli: "cursor", rawEventType: "preToolUse" }));
    expect(envelopeToSessionMetadata(req)).toEqual({
      sessionId: "sess-1",
      transcriptPath: "/home/u/.claude/projects/x/sess-1.jsonl",
      cwd: "/home/u/project",
      permissionMode: "default",
      hookEventName: "PreToolUse",
      rawHookEventName: "preToolUse",
      cli: "cursor",
      // P2: host context travels as request data on both paths, so a policy
      // never reaches for `os.homedir()` or `process.env` itself.
      home: "/home/u",
      projectDir: undefined,
    });
  });

  it("carries projectDir through when the CLAUDE_PROJECT_DIR env fact is present", () => {
    const req = buildLocalEnvelope(
      input({ host: { home: "/home/u", envFacts: { CLAUDE_PROJECT_DIR: "/srv/repo" } } }),
    );
    expect(envelopeToSessionMetadata(req).projectDir).toBe("/srv/repo");
  });

  it("normalises a blank projectDir to undefined, preserving the pre-P2 falsy check", () => {
    // `block-read-outside-cwd` read `process.env.CLAUDE_PROJECT_DIR || cwd`, so
    // an env var set to the empty string fell through to cwd. Projecting `""`
    // here would resurrect it as a truthy-looking field and change that.
    const req = buildLocalEnvelope(
      input({ host: { home: "/home/u", envFacts: { CLAUDE_PROJECT_DIR: "" } } }),
    );
    expect(envelopeToSessionMetadata(req).projectDir).toBeUndefined();
  });

  it("preserves undefined session fields as undefined (empty payload case)", () => {
    const req = buildLocalEnvelope({
      cli: "claude",
      eventType: "PreToolUse",
      rawEventType: "PreToolUse",
      payload: {},
      permissionMode: "default",
      host: { home: "/home/u", envFacts: {} },
    });
    const session = envelopeToSessionMetadata(req);
    expect(session.sessionId).toBeUndefined();
    expect(session.transcriptPath).toBeUndefined();
    expect(session.cwd).toBeUndefined();
    expect(session.hookEventName).toBeUndefined();
    expect(session.permissionMode).toBe("default");
  });

  it("projects values only — no provenance labels leak into the legacy shape", () => {
    // `SessionMetadata` is what every policy sees, and it is deliberately dumb:
    // plain values, no `{value, provenance}` wrappers. Provenance stays on the
    // envelope, where `sealedUnattested` reads it.
    const req: EvaluationRequest = buildLocalEnvelope(input());
    const session = envelopeToSessionMetadata(req);
    expect(Object.keys(session).sort()).toEqual([
      "cli",
      "cwd",
      "home",
      "hookEventName",
      "permissionMode",
      "projectDir",
      "rawHookEventName",
      "sessionId",
      "transcriptPath",
    ]);
    for (const value of Object.values(session)) {
      expect(value === undefined || typeof value === "string").toBe(true);
    }
  });
});

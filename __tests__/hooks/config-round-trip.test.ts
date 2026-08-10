/**
 * `config.json` and `credentials.json` must survive a read → write round trip
 * with keys this build has never heard of still in them.
 *
 * Both readers are whitelist PROJECTIONS and both writers regenerated the file
 * wholesale, so any unrecognised key was erased on the next write — with no
 * layout change involved. Two CLI versions on one layout round-trip these files
 * and silently delete each other's keys, and most releases do not bump the
 * layout, so `detectLayout()`'s `future` refusal never fires to protect them.
 *
 * The counterweight, and the half that makes a naive merge wrong: both writers
 * use ABSENCE to express state (`telemetry` only when off, `machine_id` only when
 * set, `collector.sources` only when non-empty). An owned key must therefore be
 * DELETED when the projection omits it, or a telemetry opt-out becomes
 * un-revokable. Every test below pins one side or the other of that line.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { configFile, credentialsFile } from "../../src/hooks/fp-home";
import {
  readConfig,
  readConfigRaw,
  writeConfig,
  updateConfig,
  readCredentials,
  readCredentialsRaw,
  writeCredentials,
  DEFAULT_CONFIG,
} from "../../src/hooks/fp-config";

let home: string;
let prevHome: string | undefined;

const readFile = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

const seedConfig = (body: Record<string, unknown>) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(configFile(), `${JSON.stringify(body, null, 2)}\n`, "utf8");
};

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-roundtrip-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("config.json preserves keys this build does not own", () => {
  it("keeps an unknown top-level key and an unknown key inside a known table", () => {
    seedConfig({
      mode: { kind: "cloud" },
      audit: { auto: false, interval_days: 7 },
      // Stand-ins for a key a NEWER CLI wrote. The older build below has no
      // notion of either, and before this change wrote both out of existence.
      experiments: { newThing: true },
      collector: { hooks: true, future_knob: "keep me" },
    });

    updateConfig({ audit: { auto: true } });

    const after = readFile(configFile());
    expect(after.experiments).toEqual({ newThing: true });
    expect(after.collector.future_knob).toBe("keep me");
    // …and the key we actually asked to change did change.
    expect(after.audit.auto).toBe(true);
  });

  it("keeps collector.sources.<harness>.extra_paths when the patch touches telemetry", () => {
    // The live case this whole change exists for. `harness add-path` writes
    // nothing but this key, so losing it loses the command's entire output —
    // and silently: an absent capture root is indistinguishable from an idle one.
    seedConfig({
      mode: { kind: "cloud" },
      collector: { sources: { claude: { extra_paths: ["work=/srv/team/.claude/projects"] } } },
      audit: { auto: false, interval_days: 7 },
    });

    updateConfig({ telemetry: { enabled: false } });

    const after = readFile(configFile());
    expect(after.collector.sources.claude.extra_paths).toEqual(["work=/srv/team/.claude/projects"]);
    expect(after.telemetry.enabled).toBe(false);
  });

  it("keeps an unknown sibling INSIDE a source table", () => {
    // `collector.sources` is keyed by harness name, so its paths cannot be
    // enumerated — owning the subtree wholesale would delete a future
    // per-harness sibling, which is the same loss one level deeper. Hence the
    // `*` segment in OWNED_CONFIG_KEYS.
    seedConfig({
      mode: { kind: "cloud" },
      collector: { sources: { goose: { extra_paths: ["alt=/mnt/goose"], future_knob: 3 } } },
      audit: { auto: false, interval_days: 7 },
    });

    updateConfig({ audit: { auto: true } });

    const after = readFile(configFile());
    expect(after.collector.sources.goose.extra_paths).toEqual(["alt=/mnt/goose"]);
    expect(after.collector.sources.goose.future_knob).toBe(3);
  });

  it("preserves through a bare writeConfig that was given no raw object", () => {
    // The safe default: a caller who forgets to thread `raw` still preserves,
    // because `writeConfig` re-reads the file itself. The alternative default
    // erases silently, which is the bug.
    seedConfig({ mode: { kind: "oss" }, audit: { auto: false, interval_days: 7 }, experiments: { a: 1 } });

    writeConfig({ ...readConfig(), telemetry: { enabled: false } });

    expect(readFile(configFile()).experiments).toEqual({ a: 1 });
  });

  it("writes a clean file when handed an explicit empty raw", () => {
    seedConfig({ mode: { kind: "oss" }, audit: { auto: false, interval_days: 7 }, experiments: { a: 1 } });

    writeConfig(readConfig(), {});

    expect(readFile(configFile()).experiments).toBeUndefined();
  });
});

describe("config.json still DELETES the keys it owns when the projection omits them", () => {
  it("removes telemetry.enabled when telemetry is switched back on", () => {
    // The omission case. `writeConfig` emits `telemetry` only when it is OFF, so
    // a blind deep-merge over the old bytes would leave `enabled: false` behind
    // and the opt-out could never be revoked.
    seedConfig({ mode: { kind: "oss" }, telemetry: { enabled: false }, audit: { auto: false, interval_days: 7 } });

    updateConfig({ telemetry: { enabled: true } });

    const after = readFile(configFile());
    // Not merely `enabled !== false` — the whole table goes, because pruning an
    // emptied container is what keeps a default install byte-identical to what
    // this function produced before the key existed.
    expect(after.telemetry).toBeUndefined();
    expect(readConfig().telemetry.enabled).toBe(true);
  });

  it("removes collector.machine_id when it is cleared", () => {
    seedConfig({
      mode: { kind: "cloud" },
      collector: { machine_id: "old-id", hooks: true },
      audit: { auto: false, interval_days: 7 },
    });
    expect(readConfig().collector.machineId).toBe("old-id");

    updateConfig({ collector: { ...readConfig().collector, machineId: undefined } });

    expect(readFile(configFile()).collector.machine_id).toBeUndefined();
  });

  it("removes collector.sources entirely when the last extra path goes", () => {
    seedConfig({
      mode: { kind: "cloud" },
      collector: { sources: { claude: { extra_paths: ["work=/srv/a"] } } },
      audit: { auto: false, interval_days: 7 },
    });

    updateConfig({ collector: { ...readConfig().collector, sources: undefined } });

    // `sources` held nothing but the owned key, so pruning takes the empty
    // harness table and the empty `sources` with it.
    expect(readFile(configFile()).collector.sources).toBeUndefined();
  });

  it("keeps an unknown sibling when the owned key it sat beside is removed", () => {
    seedConfig({
      mode: { kind: "cloud" },
      collector: { sources: { goose: { extra_paths: ["alt=/mnt/goose"], future_knob: 3 } } },
      audit: { auto: false, interval_days: 7 },
    });

    updateConfig({ collector: { ...readConfig().collector, sources: undefined } });

    // Pruning must stop at a container that still holds something unowned.
    const after = readFile(configFile());
    expect(after.collector.sources.goose).toEqual({ future_knob: 3 });
  });

  it("leaves no empty table behind on a default install", () => {
    // Guards the byte-shape property `writeConfig` and `readSources` both
    // document: a machine that configured nothing gets a file with no
    // `telemetry` and no `sources` key at all.
    writeConfig(structuredClone(DEFAULT_CONFIG), {});

    const after = readFile(configFile());
    expect(after.telemetry).toBeUndefined();
    expect(after.collector.sources).toBeUndefined();
    expect(after.collector.machine_id).toBeUndefined();
  });
});

describe("readConfigRaw", () => {
  it("returns the raw object alongside the projection", () => {
    seedConfig({ mode: { kind: "cloud" }, experiments: { a: 1 }, audit: { auto: true, interval_days: 7 } });

    const { raw, config } = readConfigRaw();

    expect(raw.experiments).toEqual({ a: 1 });
    expect(config.mode).toBe("cloud");
    expect(config.audit.auto).toBe(true);
  });

  it("reads an absent, unparseable or non-object file as an empty raw", () => {
    expect(readConfigRaw().raw).toEqual({});

    seedConfig({} as Record<string, unknown>);
    writeFileSync(configFile(), "not json at all", "utf8");
    expect(readConfigRaw().raw).toEqual({});

    // An array would otherwise spread into index keys on merge.
    writeFileSync(configFile(), "[1,2,3]", "utf8");
    expect(readConfigRaw().raw).toEqual({});
  });
});

describe("credentials.json preserves keys this build does not own", () => {
  it("keeps the org block an older build has no notion of", () => {
    // `org` is the live example: its own doc records that it is absent in files
    // written by an older CLI, which is exactly a key such a CLI would delete —
    // taking the only local answer to "where does this machine's data go?".
    mkdirSync(home, { recursive: true });
    writeFileSync(
      credentialsFile(),
      JSON.stringify(
        {
          cloud: { url: "https://api.example", machine_id: "m1", token: "t1" },
          org: { id: "o1", slug: "acme", name: "Acme" },
          future_credential: { kind: "something-new" },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    // A removal of the ingest half — the shape `collector-config.ts` and
    // `cloud-enrollment.ts` both use.
    const { ingest: _drop, ...rest } = readCredentials();
    writeCredentials(rest);

    const after = readFile(credentialsFile());
    expect(after.org).toEqual({ id: "o1", slug: "acme", name: "Acme" });
    expect(after.future_credential).toEqual({ kind: "something-new" });
    expect(after.cloud.token).toBe("t1");
  });

  it("still removes the cloud block when the projection drops it", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      credentialsFile(),
      JSON.stringify({
        cloud: { url: "https://api.example", machine_id: "m1", token: "t1" },
        ingest: { url: "https://ingest.example", key: "k1" },
        future_credential: { kind: "keep" },
      }),
      { mode: 0o600 },
    );

    const { cloud: _drop, ...rest } = readCredentials();
    writeCredentials(rest);

    const after = readFile(credentialsFile());
    expect(after.cloud).toBeUndefined();
    expect(after.ingest.key).toBe("k1");
    expect(after.future_credential).toEqual({ kind: "keep" });
  });

  it("readCredentialsRaw returns the raw object alongside the projection", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      credentialsFile(),
      JSON.stringify({ cloud: { url: "u", machine_id: "m", token: "t" }, extra: 1 }),
      { mode: 0o600 },
    );

    const { raw, credentials } = readCredentialsRaw();

    expect(raw.extra).toBe(1);
    expect(credentials.cloud?.token).toBe("t");
  });
});

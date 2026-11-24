// @vitest-environment node
/**
 * Both npm workflows publish through trusted publishing (OIDC), never a stored
 * token.
 *
 * npm exchanges the publishing job's GitHub OIDC token for a short-lived token
 * scoped to one package. That works only while four things hold at once, and
 * each one fails silently or late when it does not:
 *
 *   - npm is 11.5.1 or later. Node 22 bundles npm 10, which never attempts the
 *     exchange: it falls back to setup-node's placeholder token and the
 *     registry refuses the publish without saying why.
 *   - the job holds `id-token: write`, or there is no OIDC token to exchange.
 *   - the job runs in the environment npm's trusted-publisher entries name.
 *     Those entries are set up by hand from the comment at the top of each
 *     workflow and cannot be edited, only replaced, so the job and that comment
 *     must agree.
 *   - no stored token is left in the way. npm tries OIDC first and falls back
 *     to any token it finds, so a leftover NODE_AUTH_TOKEN would turn a broken
 *     trusted-publisher entry into a publish that quietly succeeds on the old
 *     credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const WORKFLOWS = resolve(process.cwd(), ".github/workflows");
const UPGRADE = "Upgrade npm for trusted publishing";
const CHECK = "Check trusted publishing prerequisites";

type Step = Record<string, any>;

/** Every workflow that publishes to npm, and the environment its npm entries name. */
const NPM_PUBLISHERS = [
  { file: "publish.yml", environment: "npm-failproofai" },
  { file: "publish-failproofai-ts-sdk.yml", environment: "npm-failproofai-ts-sdk" },
];

function source(file: string): string {
  return readFileSync(resolve(WORKFLOWS, file), "utf8");
}

function jobs(file: string): Record<string, Record<string, any>> {
  return parse(source(file)).jobs;
}

/** A step publishes if it runs `npm publish` itself or a script that does. */
function publishes(step: Step): boolean {
  return /npm publish|build-daemon-packages\.mjs|publish-aliases\.mjs/.test(String(step.run ?? ""));
}

describe("no workflow hands npm a stored token", () => {
  it.each(readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)))("%s", (file) => {
    const text = source(file);
    expect(text).not.toMatch(/secrets\.NPM_TOKEN/);
    expect(text).not.toMatch(/^\s*NODE_AUTH_TOKEN\s*:/m);
    // `npm whoami` checks a stored login. Under trusted publishing it is not a
    // check of anything npm will use, so a step relying on it passes or fails
    // for the wrong reason.
    expect(text).not.toMatch(/npm whoami/);
  });
});

describe.each(NPM_PUBLISHERS)("$file", ({ file, environment }) => {
  it("publishes only from a job that can mint an OIDC token, in the environment its entries name", () => {
    const all = jobs(file);
    const publishing = Object.entries(all).filter(([, job]) => (job.steps ?? []).some(publishes));
    expect(publishing.map(([name]) => name)).toEqual(["publish"]);

    const job = all.publish;
    expect(job.permissions["id-token"]).toBe("write");
    expect(job.environment).toBe(environment);
  });

  it("documents the npm entry this job actually matches", () => {
    // The entry on npmjs.com is configured from this comment. If the job's
    // environment or the file's name moved without it, every entry would stop
    // matching, and nothing would say so until the next release failed.
    const text = source(file);
    expect(text).toMatch(new RegExp(`Workflow:\\s+${file.replace(/\./g, "\\.")}\\b`));
    expect(text).toMatch(new RegExp(`Environment:\\s+${environment}\\b`));
    expect(text).toMatch(/Allowed actions:\s+npm publish\b/);
  });

  it("moves to an npm that supports trusted publishing, and checks it, before anything publishes", () => {
    const steps: Step[] = jobs(file).publish.steps;
    const upgrade = steps.findIndex((s) => s.name === UPGRADE);
    const check = steps.findIndex((s) => s.name === CHECK);
    const firstPublish = steps.findIndex(publishes);

    expect(upgrade).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(upgrade);
    expect(firstPublish).toBeGreaterThan(check);

    const command = String(steps[upgrade].run ?? steps[upgrade].with?.command ?? "");
    const major = Number(/npm install -g npm@(\d+)/.exec(command)?.[1]);
    expect(major).toBeGreaterThanOrEqual(11);
  });

  /**
   * Runs the check step's REAL shell against a stand-in `npm`, because the
   * whole check is a version comparison and an environment test — the two
   * things a YAML-text assertion cannot exercise. `bash -e` mirrors the shell
   * Actions runs `run:` steps under.
   */
  describe("the prerequisite check, run for real", () => {
    let fakeBin: string;

    beforeAll(() => {
      fakeBin = mkdtempSync(join(tmpdir(), "fpai-fake-npm-"));
      const npm = join(fakeBin, "npm");
      writeFileSync(npm, '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "$FAKE_NPM_VERSION"\n');
      chmodSync(npm, 0o755);
    });

    afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));

    function runCheck(npmVersion: string, oidc: boolean) {
      const step = (jobs(file).publish.steps as Step[]).find((s) => s.name === CHECK);
      return spawnSync("bash", ["-e", "-c", String(step?.run)], {
        encoding: "utf8",
        env: {
          PATH: `${fakeBin}:${process.env.PATH}`,
          // Next's global augmentation makes NODE_ENV a required member of
          // ProcessEnv, so a minimal env literal has to carry it.
          NODE_ENV: process.env.NODE_ENV,
          FAKE_NPM_VERSION: npmVersion,
          ...(oidc
            ? {
                ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/request",
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
              }
            : {}),
        },
      });
    }

    // 11.10.0 is the one a string comparison gets wrong: it sorts before 11.5.1.
    it.each(["11.5.1", "11.10.0", "11.21.3", "12.2.0"])("passes npm %s with an OIDC token", (version) => {
      const result = runCheck(version, true);
      expect(result.stdout).toContain(`npm ${version}, OIDC token available`);
      expect(result.status).toBe(0);
    });

    it.each(["10.9.2", "11.4.2", "11.5.0"])("refuses npm %s, which never attempts the exchange", (version) => {
      const result = runCheck(version, true);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("needs 11.5.1 or later");
    });

    it("refuses a job that cannot request an OIDC token", () => {
      const result = runCheck("11.21.3", false);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("id-token: write");
    });
  });
});

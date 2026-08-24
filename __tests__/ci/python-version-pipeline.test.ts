// @vitest-environment node
/**
 * The release scheme for the two Python packages, and the two pipelines that run it.
 *
 * PyPI has no dist-tags, so unlike npm there is no movable `beta` pointer: the
 * pre-release marker in the version string IS the channel, and it is permanent the
 * moment it uploads. That makes the arithmetic in `scripts/python-version.py` the
 * whole mechanism — get it wrong and the wrong thing ships under a number that can
 * never be reused. So this file tests the script by RUNNING it, not by reading it,
 * and then asserts that both workflows actually wire it to the two jobs that make it
 * a pipeline rather than a convention a maintainer has to remember.
 *
 * `python3` is not guarded behind a skip. Every ubuntu runner has it, both packages
 * under test are Python, and a skip here would mean the release scheme's only test
 * silently stops running — which is the failure mode this repo keeps closing
 * elsewhere (FAILPROOFAI_SDK_REQUIRE_CONTRACT, AGENTEYE_TESTS_REQUIRE_FRAMEWORKS).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/python-version.py");

/** The two packages, and the workflow that releases each. */
const PACKAGES = [
  {
    dist: "fp-cloud-cli",
    workflow: "publish-fp-cloud-cli.yml",
    versionFile: "fp-cloud-cli/fp_cli/_version.py",
    changelog: "fp-cloud-cli/CHANGELOG.md",
    pyproject: "fp-cloud-cli/pyproject.toml",
  },
  {
    dist: "failproofai-sdk",
    workflow: "publish-failproofai-sdk.yml",
    versionFile: "sdk/python/failproofai_sdk/_version.py",
    changelog: "sdk/python/CHANGELOG.md",
    pyproject: "sdk/python/pyproject.toml",
  },
] as const;

const SECTION = resolve(ROOT, "scripts/changelog-section.py");

function section(changelog: string, version: string): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync("python3", [SECTION, resolve(ROOT, changelog), version], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    };
  } catch (error: any) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fp-version-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], cwd = ROOT): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("python3", [SCRIPT, ...args], { cwd, encoding: "utf8" }) };
  } catch (error: any) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** `resolve` against a throwaway `_version.py` holding `version`. */
function resolveVersion(version: string, body?: string): { ok: boolean; fields: Record<string, string>; out: string } {
  const file = join(dir, `v_${Buffer.from(version).toString("hex")}.py`);
  writeFileSync(file, body ?? `__version__ = "${version}"\n`);
  const { ok, out } = run(["resolve", file]);
  const fields: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { ok, fields, out };
}

describe("scripts/python-version.py — the release scheme", () => {
  // The rule, stated once: a beta advances its own counter, a stable opens the
  // next patch's beta line. Identical to publish.yml's npm rule, spelled in PEP 440.
  it.each([
    // version        scheme      next          prerelease
    ["0.0.1b1", "beta", "0.0.1b2", "true"],
    ["0.0.1b0", "beta", "0.0.1b1", "true"],
    ["1.4.2b7", "beta", "1.4.2b8", "true"],
    ["0.1.0", "stable", "0.1.1b0", "false"],
    ["1.0.0", "stable", "1.0.1b0", "false"],
    ["2.7.13", "stable", "2.7.14b0", "false"],
  ])("%s is %s and is followed by %s", (version, scheme, next, prerelease) => {
    const { ok, fields } = resolveVersion(version);
    expect(ok).toBe(true);
    expect(fields).toMatchObject({ version, scheme, next_version: next, is_prerelease: prerelease });
  });

  // Both counters are integers, not strings. `"9" + 1` concatenating would give
  // `0.0.1b91` and `1.2.910b0` — versions that sort ABOVE everything intended to
  // follow them, and that cannot be withdrawn once uploaded.
  it.each([
    ["0.0.1b9", "0.0.1b10"],
    ["0.0.1b19", "0.0.1b20"],
    ["1.2.9", "1.2.10b0"],
    ["1.2.19", "1.2.20b0"],
  ])("carries %s over a decimal boundary to %s", (version, next) => {
    expect(resolveVersion(version).fields.next_version).toBe(next);
  });

  // Publishable, but with no successor this scheme can compute. The workflow
  // warns and leaves main's version for a human rather than inventing one.
  it.each([
    ["0.0.1rc1", "true"],
    ["0.0.1a2", "true"],
    ["1.2.3.dev1", "true"],
    ["1.2.3.post1", "false"],
    ["1.2", "false"],
  ])("%s is outside the scheme and gets no automatic successor", (version, prerelease) => {
    const { ok, fields } = resolveVersion(version);
    expect(ok).toBe(true);
    expect(fields.scheme).toBe("other");
    expect(fields.next_version).toBe("");
    expect(fields.is_prerelease).toBe(prerelease);
  });

  // All of these are legal PEP 440 and all normalise to something else on the way
  // to PyPI. Accepting one would mean the file says one thing, the wheel another,
  // and preflight's "is this already published" check asks PyPI about a third.
  // `1.2.3-beta.1` is the one a per-scheme check misses: it is not one of the two
  // shapes, so it reached the permissive branch and published as `1.2.3b1`.
  it.each([
    ["0.0.01b1", "0.0.1b1"],
    ["0.0.1b01", "0.0.1b1"],
    ["01.0.1", "1.0.1"],
    ["1.2.3-beta.1", "1.2.3b1"],
    ["1.2.3.rc2", "1.2.3rc2"],
    ["v1.0.0", "1.0.0"],
    ["1.2.3-1", "1.2.3.post1"],
  ])("refuses %s, naming %s as what PyPI would have stored", (version, canonical) => {
    const { ok, out } = resolveVersion(version);
    expect(ok).toBe(false);
    expect(out).toContain("not canonical");
    expect(out).toContain(canonical);
  });

  it.each(["nonsense", "1.2.3.4.beta", ""])("refuses %s outright", (version) => {
    expect(resolveVersion(version).ok).toBe(false);
  });

  it("refuses a file with no version, and one with two", () => {
    expect(resolveVersion("x", "# nothing here\n").ok).toBe(false);
    // Two assignments: the last wins at import, the first is what a regex edit
    // would rewrite. Guessing which is live is how the wheel and the file diverge.
    const two = resolveVersion("x", '__version__ = "0.0.1b1"\n__version__ = "0.0.2b1"\n');
    expect(two.ok).toBe(false);
    expect(two.out).toContain("expected exactly 1");
  });

  it("rewrites the literal in place and leaves the rest of the file alone", () => {
    const file = join(dir, "roundtrip.py");
    writeFileSync(file, '# a comment\n__version__ = "0.0.1b1"\n# a trailing note\n');
    expect(run(["write", file, "0.0.1b2"]).ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('# a comment\n__version__ = "0.0.1b2"\n# a trailing note\n');
  });

  it("refuses to write a version outside the scheme", () => {
    const file = join(dir, "guard.py");
    writeFileSync(file, '__version__ = "0.0.1b1"\n');
    expect(run(["write", file, "0.0.1rc1"]).ok).toBe(false);
    expect(run(["write", file, "nope"]).ok).toBe(false);
    // Untouched by either refusal.
    expect(readFileSync(file, "utf8")).toBe('__version__ = "0.0.1b1"\n');
  });

  // The committed versions themselves. A hand-edit that leaves the scheme should
  // fail here, on the PR that makes it, rather than at release time — when the
  // remedy is the same one line but the run that discovered it has already burned.
  it.each(PACKAGES)("$dist's committed version is on the scheme", ({ versionFile }) => {
    const { ok, fields } = run(["resolve", resolve(ROOT, versionFile)]).ok
      ? { ok: true, fields: resolveFile(versionFile) }
      : { ok: false, fields: {} as Record<string, string> };
    expect(ok).toBe(true);
    expect(["beta", "stable"]).toContain(fields.scheme);
    expect(fields.next_version).not.toBe("");
  });
});

function resolveFile(versionFile: string): Record<string, string> {
  const out = execFileSync("python3", [SCRIPT, "resolve", resolve(ROOT, versionFile)], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const fields: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

describe.each(PACKAGES)("$workflow — version management", ({ dist, workflow, versionFile }) => {
  const source = readFileSync(resolve(ROOT, ".github/workflows", workflow), "utf8");
  const wf = parse(source) as Record<string, any>;
  const scripts = (job: Record<string, any>) =>
    (job.steps ?? []).map((s: Record<string, any>) => s.run ?? "").join("\n");

  it("resolves the version from the script rather than restating the rule inline", () => {
    // Two workflows hand-implementing the same arithmetic is exactly how the two
    // packages end up on different schemes with nothing to notice it.
    expect(scripts(wf.jobs.preflight)).toContain(`python3 scripts/python-version.py resolve ${versionFile}`);
    expect(scripts(wf.jobs.bump)).toContain(`python3 scripts/python-version.py write ${versionFile}`);
  });

  it("refuses a version PyPI has already taken, before anything is built", () => {
    const preflight = scripts(wf.jobs.preflight);
    expect(preflight).toContain(`https://pypi.org/pypi/${dist}/`);
    // 404 proceeds, 200 stops, and ANYTHING ELSE stops too. Treating an
    // unreadable CDN answer as "not published" is a guess about the one fact
    // this step exists to establish.
    expect(preflight).toMatch(/404\)/);
    expect(preflight).toMatch(/200\)[\s\S]*?exit 1/);
    expect(preflight).toMatch(/\*\)[\s\S]*?exit 1/);
    // And it gates the expensive job.
    expect(wf.jobs.build.needs).toBe("preflight");
  });

  it("never pipes the resolver into $GITHUB_OUTPUT", () => {
    // The default `run:` shell is `bash -e {0}` with NO pipefail, so a failing
    // resolver on the left of `| tee -a "$GITHUB_OUTPUT"` exits 0 and publishes
    // an empty version instead of stopping the run.
    expect(scripts(wf.jobs.preflight)).not.toMatch(/python-version\.py[^\n]*\|/);
  });

  it("asserts the built wheel carries the version preflight cleared", () => {
    const verify = (wf.jobs.build.steps ?? []).find(
      (s: Record<string, any>) => s.name === "Verify the artifacts before uploading",
    );
    expect(verify?.env?.EXPECTED_VERSION).toBe("${{ needs.preflight.outputs.version }}");
    expect(verify?.run).toContain("preflight cleared");
  });

  it("bumps main only after a real upload, and only when there is a successor", () => {
    const bump = wf.jobs.bump;
    expect(bump.needs).toEqual(["preflight", "publish"]);
    const cond = String(bump.if ?? "");
    expect(cond).toContain("!inputs.dry_run");
    expect(cond).toContain("needs.preflight.outputs.next_version != ''");
  });

  it("keeps the two credentials in separate jobs", () => {
    // `publish` holds the OIDC identity; `bump` holds a token that bypasses the
    // ruleset on main. Nothing needs both, and a job holding both would let any
    // code in it do either.
    expect(wf.jobs.publish.permissions?.["id-token"]).toBe("write");
    expect(wf.jobs.bump.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.preflight.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.publish.steps.some((s: any) => String(s.uses ?? "").includes("create-github-app-token"))).toBe(
      false,
    );
  });

  it("installs nothing in the jobs that hold a token or decide the release", () => {
    for (const name of ["preflight", "bump"]) {
      // Comments stripped: the assertion is about what the job RUNS. The bump
      // step legitimately explains in prose why `uv sync --locked` survives a
      // version bump, and matching that would make the guard unwritable.
      const text = scripts(wf.jobs[name])
        .split("\n")
        .filter((line: string) => !line.trim().startsWith("#"))
        .join("\n");
      for (const forbidden of ["uv sync", "uv run", "uv build", "pip install", "pytest", "bun install"]) {
        expect(text, `${name} must not run ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("never persists the version-bot token into .git/config", () => {
    const bump = wf.jobs.bump;
    const checkout = (bump.steps ?? []).find((s: Record<string, any>) =>
      String(s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const text = scripts(bump);
    // Through a header on the one command that needs it — a token in the remote
    // URL is echoed back by git's own error output, which ::add-mask:: does not reach.
    expect(text).toContain("http.https://github.com/.extraheader=$AUTH_HEADER");
    expect(text).not.toMatch(/https:\/\/[^\s"']*\$APP_TOKEN/);
    expect(text).toContain("::add-mask::$APP_TOKEN");
    expect(source).not.toContain("${{ secrets.VERSION_BOT_PRIVATE_KEY }}\n          run:"); // env/with, never inlined into a script
  });

  it("bumps onto main's current tip, not the SHA the run was dispatched at", () => {
    // A commit landing during the release would otherwise make the push a
    // non-fast-forward, and the bump is lost to a retry nobody performs.
    expect(scripts(wf.jobs.bump)).toContain("git checkout -B main origin/main");
  });

  it("keeps the bump commit out of CI", () => {
    expect(scripts(wf.jobs.bump)).toContain("[skip ci]");
  });
});

describe("the two pipelines stay in step", () => {
  it("documents the same scheme in both headers", () => {
    const headers = PACKAGES.map(({ workflow }) =>
      readFileSync(resolve(ROOT, ".github/workflows", workflow), "utf8")
        .split("\non:\n")[0]
        .split("# VERSION MANAGEMENT")[1],
    );
    expect(headers[0]).toBeDefined();
    expect(headers[0]).toBe(headers[1]);
    for (const header of headers) {
      expect(header).toContain("X.Y.ZbN  ->  X.Y.Zb(N+1)");
      expect(header).toContain("X.Y.Z    ->  X.Y.(Z+1)b0");
    }
  });

  it("keeps both packages' versions dynamic, which is what lets a bump not touch uv.lock", () => {
    // `dynamic = ["version"]` is why `uv.lock` records the project with no
    // `version =` line and `uv sync --locked` survives a bump. Pinning a static
    // version in pyproject.toml would make the bump commit break every later
    // `--locked` install, with nothing else to catch it.
    for (const { versionFile } of PACKAGES) {
      const pyproject = resolve(ROOT, versionFile.split("/").slice(0, -2).join("/"), "pyproject.toml");
      const text = readFileSync(pyproject, "utf8");
      expect(text).toContain('dynamic = ["version"]');
      // A STATIC literal is the hazard. `[tool.setuptools.dynamic]`'s own
      // `version = { attr = ... }` line is the mechanism that keeps it dynamic,
      // so match the quoted form only.
      expect(text).not.toMatch(/^version = ["']/m);
      expect(text).toMatch(/^version = \{ attr = /m);
    }
  });
});

describe("release tags cannot be confused with the npm package's", () => {
  // The npm package tags bare `vX.Y.Z` in THIS repository, and the published CLI
  // builds its `failproofaid` download URLs out of exactly those tags. A Python
  // release landing on one would be a release the CLI tries to fetch binaries
  // from — and short of that, three release lines sharing one namespace makes the
  // repo's release feed unreadable.
  it.each(PACKAGES)("$dist tags are namespaced, not bare vX.Y.Z", ({ dist, versionFile }) => {
    const out = execFileSync("python3", [SCRIPT, "resolve", resolve(ROOT, versionFile), dist], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const tag = /^tag=(.*)$/m.exec(out)?.[1];
    expect(tag).toBe(`${dist}-v0.0.1b1`);
    // The property, not just this value: it must not match the npm tag grammar.
    expect(tag).not.toMatch(/^v\d/);
    expect(tag!.startsWith(`${dist}-`)).toBe(true);
  });

  it("no dist name could produce a tag that reads as an npm release", () => {
    // Guards the generator rather than the two current names.
    const bad = execFileSync(
      "python3",
      ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(resolve(ROOT, "scripts"))});
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("pv", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
try:
    m.release_tag("v2", "1.0.0"); print("ACCEPTED")
except m.VersionError:
    print("REFUSED")`],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    expect(bad).toBe("REFUSED");
  });

  it.each(PACKAGES)("$dist's release is never marked the repo's latest", ({ workflow }) => {
    const wf = parse(readFileSync(resolve(ROOT, ".github/workflows", workflow), "utf8")) as Record<string, any>;
    const text = (wf.jobs.release.steps ?? []).map((s: Record<string, any>) => s.run ?? "").join("\n");
    // GitHub shows ONE "Latest" release on the repo home page. Today every
    // Python version is a pre-release and GitHub never marks those latest, which
    // is exactly why this must be explicit: it would silently start being wrong
    // the first time a stable ships.
    expect(text).toContain("--latest=false");
    // Pinned to the published commit — `bump` may have moved main on by then.
    expect(text).toContain('--target "$GITHUB_SHA"');
  });

  it.each(PACKAGES)("$dist's release job holds no publishing identity and runs no repo code", ({ workflow }) => {
    const wf = parse(readFileSync(resolve(ROOT, ".github/workflows", workflow), "utf8")) as Record<string, any>;
    const job = wf.jobs.release;
    expect(job.permissions).toEqual({ contents: "write" });
    expect(job.permissions?.["id-token"]).toBeUndefined();
    const uses = (job.steps ?? []).map((s: Record<string, any>) => String(s.uses ?? "")).filter(Boolean);
    expect(uses).toEqual(["actions/download-artifact@v8"]);
  });
});

describe("release notes have somewhere to come from", () => {
  it.each(PACKAGES)("$dist has a changelog section for its committed version", ({ changelog, versionFile }) => {
    const version = resolveFile(versionFile).version;
    const got = section(changelog, version);
    expect(got.ok, `no '## ${version}' section in ${changelog}`).toBe(true);
    expect(got.out.trim().length).toBeGreaterThan(0);
  });

  it.each(PACKAGES)("$dist's changelog uses dated version headings, not Unreleased", ({ changelog }) => {
    const text = readFileSync(resolve(ROOT, changelog), "utf8");
    expect(text).not.toMatch(/^## Unreleased/m);
    // At least one heading in the `## <version> — <date>` form the extractor and
    // CLAUDE.md both assume.
    expect(text).toMatch(/^## \d+\.\d+\.\S* — \d{4}-\d{2}-\d{2}/m);
  });

  it("refuses a missing section, an empty one, and a decimal-boundary near-miss", () => {
    const text = [
      "# Changelog",
      "",
      "## 0.0.1b10 — 2026-08-24",
      "",
      "- the tenth beta",
      "",
      "## 0.0.1b2 — 2026-08-20",
      "",
      "## 0.0.1b1 — 2026-08-19",
      "",
      "- the first",
      "",
    ].join("\n");
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, text);
    const run1 = (v: string) => {
      try {
        return { ok: true, out: execFileSync("python3", [SECTION, file, v], { encoding: "utf8" }) };
      } catch (e: any) {
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };
    // `0.0.1b1` must NOT be answered by `0.0.1b10`'s section — a real hazard once
    // a beta counter passes nine, and one that puts the wrong release's notes on
    // a tag with no error anywhere.
    expect(run1("0.0.1b1").out).toContain("the first");
    expect(run1("0.0.1b1").out).not.toContain("the tenth");
    expect(run1("0.0.1b10").out).toContain("the tenth");
    // A heading with nothing under it is the same failure as no heading.
    expect(run1("0.0.1b2").ok).toBe(false);
    expect(run1("9.9.9").ok).toBe(false);
  });

  it.each(PACKAGES)("$dist links its changelog from PyPI", ({ pyproject }) => {
    // PyPI gives "Changelog" its own sidebar slot. Without it the project page is
    // the README and nothing else, and there is no route from an installed
    // version to what changed in it.
    const text = readFileSync(resolve(ROOT, pyproject), "utf8");
    expect(text).toMatch(/^Changelog = "https:\/\/github\.com\/FailproofAI\/failproofai\/blob\/main\/.*CHANGELOG\.md"$/m);
  });

  it.each(PACKAGES)("$dist verifies its notes in preflight, before anything is built", ({ workflow }) => {
    const wf = parse(readFileSync(resolve(ROOT, ".github/workflows", workflow), "utf8")) as Record<string, any>;
    const steps: Record<string, any>[] = wf.jobs.preflight.steps ?? [];
    const names = steps.map((s) => s.name ?? "");
    expect(names).toContain("Extract this version's release notes");
    // The notes reach `release` as an artifact, so that job needs no checkout.
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });
});

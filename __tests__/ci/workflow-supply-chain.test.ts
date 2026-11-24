// @vitest-environment node
/**
 * Supply-chain rules for this repository's workflows (FailproofAI/agenteye#1800).
 *
 * Each rule closes a way for code nobody reviewed to run in a job that holds a
 * credential, and each one regressed silently before, because a workflow that
 * breaks it still runs green:
 *
 *   - A `pull_request_target` job runs for every fork PR with a token that can
 *     write, so an action it uses by tag runs whatever that tag points at
 *     today. It must name a commit.
 *   - `bun-version: latest` installed whatever bun shipped that morning in the
 *     jobs that build the npm package and hold the publish credentials. One
 *     exact version, the same everywhere. Not `bun-version-file`: setup-bun
 *     reads an unreadable file as a warning and falls back to `latest`.
 *   - `${{ }}` is pasted into a `run:` script's source before bash parses it,
 *     so a value someone else chose — a dispatch input, an event field, a
 *     matrix built from one — runs as code. translate-docs did this with
 *     `inputs.languages`, in `prepare` and, through its matrix, in the job
 *     holding the Anthropic credentials. Such values reach scripts via `env:`.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const WORKFLOWS = resolve(process.cwd(), ".github/workflows");
const FILES = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();

type Step = Record<string, any>;
type Job = { steps?: Step[]; uses?: string; strategy?: { matrix?: unknown } };

function workflow(file: string): Record<string, any> {
  return parse(readFileSync(resolve(WORKFLOWS, file), "utf8"));
}

function jobs(file: string): [string, Job][] {
  return Object.entries((workflow(file).jobs ?? {}) as Record<string, Job>);
}

function triggers(file: string): string[] {
  const wf = workflow(file);
  const on = wf.on ?? wf[true as unknown as string];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

describe("a pull_request_target workflow pins every action it uses to a commit", () => {
  const targets = FILES.filter((f) => triggers(f).includes("pull_request_target"));

  it("finds the contributor-welcome workflow", () => {
    expect(targets).toContain("pr-contributor-welcome.yml");
  });

  it.each(targets)("%s", (file) => {
    for (const [name, job] of jobs(file)) {
      const refs = [job.uses, ...(job.steps ?? []).map((s) => s.uses)];
      for (const ref of refs) {
        if (typeof ref !== "string" || ref.startsWith("./") || ref.startsWith("docker://")) continue;
        expect(ref, `${file} job ${name}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

describe("bun is pinned to one exact version in every workflow", () => {
  const setups = FILES.flatMap((file) =>
    jobs(file).flatMap(([job, j]) =>
      (j.steps ?? [])
        .filter((s) => String(s.uses ?? "").startsWith("oven-sh/setup-bun@"))
        .map((step) => ({ file, job, step })),
    ),
  );

  it("finds the setup-bun steps", () => {
    expect(setups.length).toBeGreaterThan(0);
  });

  it.each(setups)("$file $job", ({ step }) => {
    // A string, because YAML reads `1.5` as the number 1.5.
    expect(step.with?.["bun-version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(step.with?.["bun-version-file"]).toBeUndefined();
  });

  it("is the same version everywhere", () => {
    expect(new Set(setups.map(({ step }) => step.with?.["bun-version"])).size).toBe(1);
  });
});

describe("no run: script splices in a value someone else chose", () => {
  // `github.event_name` is safe (a fixed set) and does not match `github.event.`.
  const UNTRUSTED = /\$\{\{[^}]*\b(?:inputs\.|github\.event\.|github\.head_ref\b)/;
  const MATRIX = /\$\{\{[^}]*\bmatrix\./;

  it.each(FILES)("%s", (file) => {
    for (const [name, job] of jobs(file)) {
      // A matrix computed at run time (`fromJson(...)`) carries whatever its
      // source carried. A literal matrix is written in the workflow itself.
      const dynamicMatrix = /fromJson\s*\(/.test(JSON.stringify(job.strategy?.matrix ?? ""));
      for (const step of job.steps ?? []) {
        if (typeof step.run !== "string") continue;
        const where = `${file} job ${name} step ${step.name ?? step.id ?? step.run.slice(0, 40)}`;
        expect(step.run, where).not.toMatch(UNTRUSTED);
        if (dynamicMatrix) expect(step.run, where).not.toMatch(MATRIX);
      }
    }
  });
});

describe("translate-docs hands only supported language codes to its matrix", () => {
  const step = (workflow("translate-docs.yml").jobs.prepare.steps as Step[]).find((s) => s.id === "langs")!;

  /** Runs the step's script as the runner would; MARKER in the input becomes a file path. */
  function prepare(languages: string): { status: number | null; output: string; ran: boolean } {
    const dir = mkdtempSync(join(tmpdir(), "fpai-translate-langs-"));
    try {
      const output = join(dir, "output");
      const marker = join(dir, "ran");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-e", "-c", step.run], {
        env: {
          ...process.env,
          LANGUAGES: languages.replaceAll("MARKER", marker),
          SUPPORTED: step.env.SUPPORTED,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      return { status: result.status, output: readFileSync(output, "utf8").trim(), ran: existsSync(marker) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reads the dispatch input from env", () => {
    expect(step.env.LANGUAGES).toBe("${{ inputs.languages }}");
    expect(step.run).not.toContain("${{");
  });

  it("supports exactly the languages the translator does", () => {
    const config = readFileSync(resolve(process.cwd(), "scripts/translate-docs/config.ts"), "utf8");
    const codes = [...config.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(JSON.parse(step.env.SUPPORTED).sort()).toEqual(codes.sort());
  });

  it("defaults to every supported language", () => {
    expect(prepare("")).toEqual({ status: 0, output: `languages=${step.env.SUPPORTED}`, ran: false });
    expect(prepare("  ").output).toBe(`languages=${step.env.SUPPORTED}`);
  });

  it("accepts supported codes and ignores whitespace", () => {
    expect(prepare(" zh, pt-br,zh ")).toEqual({ status: 0, output: 'languages=["pt-br","zh"]', ran: false });
  });

  it.each([
    "zh,$(touch MARKER)",
    "zh,`touch MARKER`",
    "zh';touch MARKER;'",
    'zh"; touch MARKER; echo "',
    "zh,$(touch${IFS}MARKER)",
    "zh,xx",
    "*",
    ",,",
  ])("refuses %j and runs none of it", (input) => {
    const result = prepare(input);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.ran).toBe(false);
  });
});

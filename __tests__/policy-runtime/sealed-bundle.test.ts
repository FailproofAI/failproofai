/**
 * The sealed worker bundle, executed in a context with no host bindings.
 *
 * The daemon evaluates this bundle inside QuickJS, where there is genuinely no
 * `require`, no module loader, no `process`, and no filesystem. We cannot run
 * QuickJS from vitest, but `node:vm` with a hand-built context is a close
 * proxy: whatever is not explicitly placed in the context does not exist, and
 * referencing it throws `ReferenceError` exactly as it would in QuickJS.
 *
 * That makes this the cheapest place to catch the failure the whole tier is
 * built to avoid. A bundle that quietly retains a `fetch`, a `require`, or a
 * live `process.env` does not fail loudly at load — it works fine on a
 * developer's machine, where those globals happen to exist, and only diverges
 * on the daemon. Here, it cannot: the context is the deprivation.
 *
 * The Rust-side equivalent (running the same bundle under real QuickJS-ng) is
 * `crates/failproofaid`'s worker tests; this suite is what keeps a broken
 * bundle from ever reaching them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import vm from "node:vm";

const REPO_ROOT = resolvePath(__dirname, "..", "..");
const BUNDLE = resolvePath(REPO_ROOT, "crates/generated/sealed-worker.js");

/** The exact set of globals the sealed context is allowed to have. */
interface SealedContext {
  globalThis?: unknown;
  __fpai_sealed_evaluate?: (json: string) => Promise<string>;
  __fpai_sealed_policies?: () => string;
  __fpai_sealed_version?: string;
  [key: string]: unknown;
}

let source: string;

/**
 * Build a fresh sealed context. Nothing is added beyond what `vm` provides
 * intrinsically (Object, Array, JSON, RegExp, Promise, …) — deliberately no
 * `console`, `process`, `require`, `fetch`, `Buffer`, `setTimeout`, or `fs`.
 */
function newSealedContext(): SealedContext {
  const ctx: SealedContext = Object.create(null);
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "sealed-worker.js", timeout: 10_000 });
  return ctx;
}

beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    execFileSync(
      process.execPath,
      [resolvePath(REPO_ROOT, "node_modules/.cache/failproofai-dev/node_modules/.bin/bun"),
       "scripts/build-sealed-bundle.ts"],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
  }
  source = readFileSync(BUNDLE, "utf8");
});

describe("the bundle is self-contained", () => {
  it("loads in a context with no Node globals at all", () => {
    // If this throws, the message names the missing global — which is the
    // whole diagnostic value of running it deprived rather than in Node.
    expect(() => newSealedContext()).not.toThrow();
  });

  it("installs exactly the three expected globals and nothing else", () => {
    const ctx = newSealedContext();
    const installed = Object.keys(ctx).sort();
    expect(installed).toEqual([
      "__fpai_sealed_evaluate",
      "__fpai_sealed_policies",
      "__fpai_sealed_version",
      "process",
    ]);
  });

  it("contains no reference to a module loader or a network call", () => {
    // Belt-and-braces against the build plugin silently failing to substitute:
    // a `require(` surviving would only fail at the moment a policy hit that
    // code path, which could be months later and on someone else's machine.
    expect(source).not.toMatch(/\bfrom\s*["']node:/);
    expect(source).not.toMatch(/\brequire\s*\(\s*["']/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/posthog/i);
    expect(source).not.toMatch(/i\.posthog\.com/);
  });
});

describe("the sealed context is deprived", () => {
  it("has no process environment to read", () => {
    const ctx = newSealedContext();
    // The prelude defines `process.env` as a frozen empty object so a legacy
    // lambda cannot ReferenceError. It must stay empty: a policy reading the
    // daemon's environment would see the daemon's own PATH and, later, the
    // delivery key — neither of which is part of the evaluation request.
    const env = vm.runInContext("JSON.stringify(process.env)", ctx as object);
    expect(env).toBe("{}");
    expect(vm.runInContext("Object.isFrozen(process.env)", ctx as object)).toBe(true);
  });

  it("cannot reach the filesystem", () => {
    const ctx = newSealedContext();
    for (const expr of ["typeof require", "typeof fetch", "typeof Bun", "typeof globalThis.fs"]) {
      expect(vm.runInContext(expr, ctx as object)).toBe("undefined");
    }
  });

  it("throws ReferenceError when policy-shaped code reaches for a host module", () => {
    const ctx = newSealedContext();
    // The plan's spike criterion, stated as a test: prove that reaching for
    // `require("node:fs")` from inside the sealed context THROWS rather than
    // succeeding. In QuickJS this is the same ReferenceError for the same
    // reason — no bindings are registered.
    //
    // Asserted by `name`, not `instanceof`. The context is a separate realm, so
    // its `ReferenceError` is a different constructor than this file's and
    // `instanceof` is false across the boundary. That the check fails is itself
    // confirmation the isolation is real rather than a shared-global illusion.
    for (const expr of ['require("node:fs")', 'require("fs")', "process.binding('fs')"]) {
      let thrown: unknown;
      try {
        vm.runInContext(expr, ctx as object);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${expr} should have thrown`).toBeDefined();
      expect((thrown as Error).name).toMatch(/^(ReferenceError|TypeError)$/);
    }
  });

  it("cannot escape via the constructor trick", () => {
    const ctx = newSealedContext();
    // `(function(){}).constructor("return this")()` reaches the *context's*
    // global, not the host's — assert it stays inside.
    const escaped = vm.runInContext(
      '(function(){}).constructor("return typeof globalThis.require")()',
      ctx as object,
    );
    expect(escaped).toBe("undefined");
  });
});

describe("the worker evaluates", () => {
  const baseConfig = { enabledPolicies: ["block-sudo"] };

  async function evaluateIn(ctx: SealedContext, request: unknown): Promise<Record<string, unknown>> {
    const json = await ctx.__fpai_sealed_evaluate!(JSON.stringify(request));
    return JSON.parse(json) as Record<string, unknown>;
  }

  it("reports the 32 sealed-eligible policies", () => {
    const ctx = newSealedContext();
    const names = JSON.parse(ctx.__fpai_sealed_policies!()) as string[];
    expect(names).toHaveLength(32);
    expect(names).toContain("block-sudo");
    expect(names).not.toContain("require-commit-before-stop");
  });

  it("denies a sudo command with the Claude PreToolUse shape", async () => {
    const ctx = newSealedContext();
    const res = await evaluateIn(ctx, {
      eventType: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } },
      session: { cli: "claude", cwd: "/home/u/project", home: "/home/u" },
      config: baseConfig,
    });
    expect(res.ok).toBe(true);
    const result = res.result as Record<string, unknown>;
    expect(result.decision).toBe("deny");
    expect(result.policyName).toBe("failproofai/block-sudo");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Blocked Bash by failproofai because: sudo commands are blocked, as per the policy configured by the user",
      },
    });
  });

  it("allows a benign command", async () => {
    const ctx = newSealedContext();
    const res = await evaluateIn(ctx, {
      eventType: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: "ls -la" } },
      session: { cli: "claude", cwd: "/home/u/project", home: "/home/u" },
      config: baseConfig,
    });
    expect(res.ok).toBe(true);
    expect((res.result as Record<string, unknown>).decision).toBe("allow");
  });

  it("routes a host-access policy out rather than running it", async () => {
    const ctx = newSealedContext();
    const res = await evaluateIn(ctx, {
      eventType: "Stop",
      payload: {},
      session: { cli: "claude", cwd: "/home/u/project", home: "/home/u" },
      config: { enabledPolicies: ["block-sudo", "require-commit-before-stop"] },
    });
    expect(res.ok).toBe(true);
    // It must NOT have run — running it would need `git`, which the sealed
    // context cannot spawn. Reported for the daemon to route instead.
    expect(res.needsUserContext).toEqual(["require-commit-before-stop"]);
  });

  it("uses the request's home, not any ambient one", async () => {
    const ctx = newSealedContext();
    const res = await evaluateIn(ctx, {
      eventType: "PreToolUse",
      payload: { tool_name: "Read", tool_input: { file_path: "/home/enrolled/.claude/CLAUDE.md" } },
      session: { cli: "claude", cwd: "/home/u/project", home: "/home/enrolled" },
      config: { enabledPolicies: ["block-read-outside-cwd"] },
    });
    expect(res.ok).toBe(true);
    // Whitelisted because it is under the REQUESTING user's agent dir. There is
    // no ambient home in this context at all, so this can only have come from
    // the request.
    expect((res.result as Record<string, unknown>).decision).toBe("allow");
  });

  it("reports sealed_unattested-ness when a client-asserted field was present", async () => {
    const ctx = newSealedContext();
    const withCwd = await evaluateIn(ctx, {
      eventType: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: "ls" } },
      session: { cli: "claude", cwd: "/home/u/project", home: "/home/u" },
      config: baseConfig,
    });
    expect(withCwd.readClientAssertedHost).toBe(true);

    const withoutCwd = await evaluateIn(ctx, {
      eventType: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: "ls" } },
      session: { cli: "claude", home: "/home/u" },
      config: baseConfig,
    });
    expect(withoutCwd.readClientAssertedHost).toBe(false);
  });

  it("returns a structured error rather than throwing across the boundary", async () => {
    const ctx = newSealedContext();
    const raw = await ctx.__fpai_sealed_evaluate!("{ not json");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error)).toContain("not valid JSON");
  });

  it("an error is never reported as an allow", async () => {
    // The distinction that matters: a failed evaluation must be visibly failed,
    // so the daemon counts it toward the circuit breaker and applies the
    // configured failure mode — never silently permissive.
    const ctx = newSealedContext();
    const parsed = JSON.parse(await ctx.__fpai_sealed_evaluate!("garbage")) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.result).toBeUndefined();
    expect(parsed.decision).toBeUndefined();
  });
});

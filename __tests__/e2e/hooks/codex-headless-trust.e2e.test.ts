/**
 * Real headless Codex, real CLI and daemon, deterministic local Cloud/model.
 * System-layer isolation uses PRoot; no trust hash is ever written. Opt in:
 *
 * FAILPROOFAI_CODEX_HEADLESS_PROOF=1 FAILPROOFAI_TEST_PROOT=/path/to/proot
 * FAILPROOFAI_TEST_DAEMON=/path/to/failproofaid bun run test:e2e ...
 *
 * Ordinary CI has no Codex/model runtime and explicitly skips this proof.
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.FAILPROOFAI_CODEX_HEADLESS_PROOF === "1";

describe.skipIf(!enabled)("real Codex headless cloud policy trust", () => {
  it("blocks from system config without trust; unprivileged hooks warn and do not enforce", async () => {
    const proot = process.env.FAILPROOFAI_TEST_PROOT;
    const daemonPath = process.env.FAILPROOFAI_TEST_DAEMON;
    expect(proot, "set FAILPROOFAI_TEST_PROOT to an installed PRoot").toBeTruthy();
    expect(daemonPath, "set FAILPROOFAI_TEST_DAEMON to the built daemon").toBeTruthy();
    const codex = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
    const root = mkdtempSync(join(tmpdir(), "fp-cx-proof-"));
    const home = join(root, "home");
    const fp = join(root, "fp");
    const system = join(root, "system");
    const cwd = join(root, "project");
    const codexHome = join(home, ".codex");
    for (const path of [home, fp, system, cwd, codexHome, join(fp, "run"), join(fp, "state")]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const repo = resolve(import.meta.dirname, "../../..");
    const cli = join(repo, "dist/cli.mjs");
    const worker = join(repo, "dist/worker.mjs");
    const marker = join(cwd, "FP_CLOUD_BLOCK_PROOF");
    const artifact = `import {customPolicies,deny,allow} from 'failproofai';
customPolicies.add({name:'headless-block',description:'Cloud proof',match:{events:['PreToolUse']},
fn:async ctx=>JSON.stringify(ctx).includes('FP_CLOUD_BLOCK_PROOF')?deny('BLOCKED_BY_TEST_CLOUD_POLICY'):allow()});`;
    const sha = createHash("sha256").update(artifact).digest("hex");
    let modelRequests = 0;
    let modelSawDeny = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const path = new URL(req.url!, "http://localhost").pathname;
      res.setHeader("Content-Type", "application/json");
      if (path.endsWith("/auth/introspect")) return res.end(JSON.stringify({
        org_id: "local-org-A", org_name: "Local Org A", permissions: ["events:add", "policies:pull"],
      }));
      if (path.includes("desired-state")) return res.end(JSON.stringify({
        schemaVersion: 2, deployment: 1,
        policies: [{ id: "proof", version: 1, sha256: sha, artifactUrl: `/artifact/${sha}` }],
      }));
      if (path.startsWith("/artifact/")) return res.end(artifact);
      if (path.endsWith("/events")) return res.end(JSON.stringify({
        accepted: body.trim() ? body.trim().split("\n").length : 0, skipped: 0,
      }));
      if (!path.endsWith("/responses")) { res.statusCode = 404; return res.end("{}"); }
      modelRequests++;
      if (body.includes("BLOCKED_BY_TEST_CLOUD_POLICY")) modelSawDeny = true;
      res.setHeader("Content-Type", "text/event-stream");
      const id = `response_${modelRequests}`;
      const emit = (type: string, fields: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      emit("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      let item: Record<string, unknown>;
      if (modelRequests % 2 === 1) {
        const args = JSON.stringify({ cmd: `printf ran > ${marker}`, max_output_chars: 2000 });
        item = { id: `fc_${modelRequests}`, type: "function_call", name: "exec_command",
          call_id: `call_${modelRequests}`, arguments: args, status: "completed" };
        emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
        emit("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: args });
        emit("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: args });
      } else {
        const text = "Finished the deterministic hook proof.";
        item = { id: `msg_${modelRequests}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text, annotations: [] }] };
        emit("response.output_item.added", { output_index: 0, item: { ...item, content: [], status: "in_progress" } });
        emit("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text });
        emit("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text });
      }
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    writeFileSync(join(codexHome, "config.toml"), `model="proof-model"
model_provider="proof"
[model_providers.proof]
name="Deterministic local proof"
base_url="${origin}/v1"
wire_api="responses"
requires_openai_auth=false
`);
    const version = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
    writeFileSync(join(fp, "VERSION"), JSON.stringify({ layout: 4, cli: version, daemon: version }));
    writeFileSync(join(fp, "config.json"), JSON.stringify({
      mode: { kind: "cloud" }, collector: { hooks: true, sessions: true },
    }));
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, FAILPROOFAI_HOME: fp,
      FAILPROOFAI_DAEMON_SOCKET: join(fp, "run/failproofaid.sock"),
      FAILPROOFAI_WORKER_CMD: `node ${JSON.stringify(worker)}`, FAILPROOFAI_BINARY_OVERRIDE: cli,
      FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_CODEX_SYSTEM_CONFIG: join(system, "config.toml"),
      FAILPROOFAI_CLOUD_POLICY_POLL_MS: "200", FAILPROOFAI_COLLECTOR_CONFIG_POLL_MS: "200" };
    async function run(cmd: string, args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) {
      return new Promise<{ code: number | null; out: string }>((done, reject) => {
        const child = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`command timed out: ${out}`)); }, 30_000);
        child.stdout.on("data", b => { out += b; });
        child.stderr.on("data", b => { out += b; });
        child.on("error", reject);
        child.on("close", code => { clearTimeout(timeout); done({ code, out }); });
      });
    }
    // Exercise the CLI connect path; local fixture key is deliberately public.
    const connect = await run("node", [cli, "config", "--connect", origin, "--machine-id", "proof"],
      { FAILPROOFAI_CLOUD_TOKEN: "LOCAL_TEST_KEY" });
    expect(connect.code, connect.out).toBe(0);
    expect(JSON.parse(readFileSync(join(fp, "credentials.json"), "utf8")).org.id).toBe("local-org-A");
    chmodSync(join(fp, "credentials.json"), 0o600);
    const daemon = spawn(daemonPath!, [], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
    let daemonLog = "";
    daemon.stderr.on("data", b => { daemonLog += b; });
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(fp, "policies/cloud-policies/active.json"))) {
        if (Date.now() > deadline) throw new Error(`deployment failed: ${daemonLog}`);
        await new Promise(done => setTimeout(done, 100));
      }
      const install = await run("node", [cli, "policies", "--install", "--cli", "codex", "--scope", "user"]);
      expect(install.code, install.out).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("trusted_hash");
      const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
        "Make the tool call requested by the deterministic proof."];
      const managed = await run(proot!, ["-b", `${system}:/etc/codex`, codex, ...args]);
      expect(managed.code, managed.out).toBe(0);
      expect(managed.out).toContain("BLOCKED_BY_TEST_CLOUD_POLICY");
      expect(modelSawDeny).toBe(true);
      expect(existsSync(marker)).toBe(false);
      const status = await run("node", [cli, "config", "--status"]);
      expect(status.out).toContain("Enforcing (system config)");
      expect(status.out).toContain("1 on from cloud");
      const fallbackEnv = { FAILPROOFAI_CODEX_SYSTEM_CONFIG: "off" };
      const fallback = await run("node", [cli, "policies", "--install", "--cli", "codex", "--scope", "user"], fallbackEnv);
      expect(fallback.out).toContain("Codex won't run failproofai's hooks until they're trusted");
      const fallbackStatus = await run("node", [cli, "config", "--status"], fallbackEnv);
      expect(fallbackStatus.out).toContain("Not enforcing: hooks not trusted");
      expect(fallbackStatus.out).not.toContain("Enforcing (system config)");
      modelSawDeny = false;
      const untrusted = await run(codex, args, fallbackEnv);
      expect(untrusted.code, untrusted.out).toBe(0);
      expect(modelSawDeny).toBe(false);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("trusted_hash");
    } finally {
      daemon.kill("SIGTERM");
      await new Promise<void>(done => daemon.once("exit", () => done()));
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});

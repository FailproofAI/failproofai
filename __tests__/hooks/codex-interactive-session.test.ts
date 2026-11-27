// @vitest-environment node
//
// Codex runs PreToolUse for the command that opens a session it keeps running,
// and none for what is typed into it afterwards (live codex-cli 0.172: the only
// hook call was `Bash` `{"command": "bash -i"}`). So opening one is refused.
import { describe, it, expect } from "vitest";
import { codexCallOpensSession, codexSessionGuardFor, opensInteractiveSession } from "../../src/hooks/codex-interactive-session";
import type { PolicyContext } from "../../src/hooks/policy-types";

describe("opensInteractiveSession", () => {
  it.each([
    "bash -i", "bash", "sh", "zsh -l", "/bin/bash --login", "fish", "bash -s", "exec bash", "env TERM=xterm bash -i",
    "cd /tmp && bash", "FOO=1 bash -i", "busybox sh", "pwsh", "nu",
    "python3", "python", "python3.12 -i", "python -i script.py", "python3 -m asyncio", "python -m pdb x.py", "python3 -", "ipython", "pypy3",
    "node", "node -i", "deno", "bun repl", "irb", "pry", "ruby", "perl", "perl -de0", "php -a", "lua", "lua -i", "ghci", "R", "julia", "iex",
    "tmux", "tmux new -s work", "tmux attach -t work", "screen", "screen -S x",
    "ssh host", "ssh -p 2222 user@host", "ssh host bash", "mosh host", "telnet host", "sftp host",
    "docker exec -it web sh", "docker run -it ubuntu", "docker run --interactive --rm img", "podman exec -i c bash", "docker attach web",
    "kubectl exec -it pod -- sh", "kubectl run tmp -i --image=busybox", "kubectl debug -it pod",
    "su", "su - root", "sudo -i", "sudo -s", "sudo bash", "sudo -u app bash", "doas sh",
    "script", "script -q /dev/null", "nix-shell", "nix develop", "nix repl", "poetry shell", "pipenv shell", "vagrant ssh",
    "vim notes.txt", "nvim", "ed file.txt", "emacs file", "nano x", "gdb ./a.out", "sqlite3 app.db", "psql", "mysql -u root", "redis-cli",
    "nohup bash -i", "timeout 60 bash -i", "time python3",
  ])("refuses %s", (command) => {
    expect(opensInteractiveSession(command)).not.toBeNull();
  });

  it.each([
    "ls -la", "npm run dev", "npm test", "bun run build", "cargo run", "make", "git log", "git status",
    "bash script.sh", "bash -c 'echo hi'", "bash -lc 'make test'", "sh ./configure", "zsh -c ls", "echo ls | bash", "bash < setup.sh",
    "bash <<'EOF'\necho hi\nEOF",
    "python3 script.py", "python -c 'print(1)'", "python3 -m pytest", "python -m http.server 8000", "python3 < x.py", "cat x.py | python3",
    "node server.js", "node -e 'console.log(1)'", "node --version", "deno run main.ts", "bun x.ts", "ruby -e 'puts 1'", "ruby app.rb", "perl -ne 'print' f",
    "man ls", "less README.md", "git diff | less", "tmux send-keys -t work 'ls' Enter", "tmux ls", "screen -ls",
    "ssh host uptime", "ssh -N -L 8080:localhost:80 host", "sftp -b batch.txt host",
    "docker ps", "docker exec web ls", "docker run --rm img echo hi", "kubectl get pods", "kubectl exec pod -- ls",
    "su -c 'whoami' root", "sudo ls", "sudo -u app make", "script -c 'make' log.txt",
    "nix-shell --run make", "nix develop -c make", "gdb -batch -ex bt ./a.out", "emacs --batch -l x.el",
    "sqlite3 app.db 'select 1'", "psql -c 'select 1'", "mysql -e 'select 1'", "redis-cli ping",
    "echo 'bash -i'", "grep python3 file", "# bash -i",
  ])("allows %s", (command) => {
    expect(opensInteractiveSession(command)).toBeNull();
  });
});

describe("codexCallOpensSession and the guard", () => {
  it("judges only a canonical Bash call on PreToolUse", () => {
    expect(codexCallOpensSession("PreToolUse", "Bash", { command: "bash -i" })).not.toBeNull();
    expect(codexCallOpensSession("PostToolUse", "Bash", { command: "bash -i" })).toBeNull();
    expect(codexCallOpensSession("PreToolUse", "Edit", { command: "bash -i" })).toBeNull();
    expect(codexCallOpensSession("PreToolUse", "Bash", {})).toBeNull();
  });

  it("denies and tells the agent what to do instead", () => {
    const ctx = { eventType: "PreToolUse", payload: {}, toolName: "Bash", toolInput: {} } as PolicyContext;
    const result = codexSessionGuardFor("an interactive bash shell")(ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("an interactive bash shell");
    expect(result.reason).toContain("Run each command on its own");
  });
});

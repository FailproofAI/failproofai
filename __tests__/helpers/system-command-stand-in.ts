/**
 * A stand-in for `src/hooks/system-command` in tests that drive the privileged
 * service install with `node:child_process` mocked.
 *
 * The install looks sudo and the programs it runs up in root's own directories
 * on the machine running the tests, before any mocked command is called. A
 * machine may lack some of them (launchctl on Linux, systemctl on a Mac or in a
 * container, sudo itself), so where one is missing a path stands in for it;
 * these tests never run them. Everything else is the real module. A test can
 * also hide a program, to see what the install does where root has none.
 *
 *   vi.doMock("../../src/hooks/system-command", async (importOriginal) =>
 *     standInSystemCommand(await importOriginal()));
 */
import type * as SystemCommandModule from "../../src/hooks/system-command";

type SystemCommand = typeof SystemCommandModule;

/** Programs the tests' sudo mocks answer for without running them. */
const STOOD_IN = new Set(["sudo", "systemctl", "launchctl"]);

/** On globalThis, because `vi.resetModules` evaluates this file afresh for each importer. */
const HIDDEN_KEY = "__failproofaiHiddenSystemPrograms";

/** Programs to report as absent from root's directories, for the current test. */
export function hiddenSystemPrograms(): Set<string> {
  const store = globalThis as Record<string, unknown>;
  if (!(store[HIDDEN_KEY] instanceof Set)) store[HIDDEN_KEY] = new Set<string>();
  return store[HIDDEN_KEY] as Set<string>;
}

export function standInSystemCommand(actual: SystemCommand): SystemCommand {
  const systemCommandPath = (name: string): string | null => {
    if (hiddenSystemPrograms().has(name)) return null;
    return actual.systemCommandPath(name) ?? (STOOD_IN.has(name) ? `/usr/bin/${name}` : null);
  };
  const requireSystemCommand = (name: string): string => {
    const path = systemCommandPath(name);
    if (!path) throw new Error(`${name} was not found in ${actual.SYSTEM_BIN_DIRS.join(", ")}`);
    return path;
  };
  const sudoPath = (): string | null => systemCommandPath("sudo");
  const sudoCommandLine = (command: string, ...args: string[]): string | null => {
    const sudo = sudoPath();
    const program = systemCommandPath(command);
    return sudo && program ? [sudo, program, ...args].join(" ") : null;
  };
  return { ...actual, systemCommandPath, requireSystemCommand, sudoPath, sudoCommandLine };
}

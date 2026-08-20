import "@testing-library/jest-dom";

/**
 * Web Storage, on runtimes that shadow jsdom's.
 *
 * Node grew its OWN `localStorage`/`sessionStorage` globals, and from Node 24 on
 * they are unflagged — but they only work when the process was started with
 * `--localstorage-file`, and without it the getter answers `undefined` while
 * printing `ExperimentalWarning: localStorage is not available`. Vitest's jsdom
 * environment makes `window === globalThis`, so that getter sits exactly where
 * jsdom's Storage should be and wins.
 *
 * The visible effect was fifteen failures in `project-list.test.tsx` — all of
 * them `Cannot read properties of undefined (reading 'clear')` — on any
 * developer machine running a current Node, while CI stayed green on the
 * older Node its runner image happened to ship. A suite that passes or fails on
 * the runtime rather than on the code is not a suite anyone can trust, and the
 * divergence hid in the one direction nobody checks: local red, CI green.
 *
 * Defined only when the runtime has not supplied a working one, so a real
 * jsdom Storage (Node 20/22, or any run given `--localstorage-file`) is left
 * alone. Both keys are `configurable` accessors, which is what makes them
 * redefinable at all.
 */
function installWebStorage(name: "localStorage" | "sessionStorage"): void {
  let existing: unknown;
  try {
    existing = (globalThis as Record<string, unknown>)[name];
  } catch {
    // Node's getter throws rather than answering on some configurations.
    existing = undefined;
  }
  if (existing) return;

  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(String(k)) ? store.get(String(k))! : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(String(k)),
    clear: () => store.clear(),
  };

  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
  });
}

installWebStorage("localStorage");
installWebStorage("sessionStorage");

/**
 * Unit tests may not reach the public internet.
 *
 * Not a style rule — a correctness one, learned the expensive way. `--connect`
 * grew a third network call (`/v1/auth/introspect`) whose test seam was not
 * threaded through with it, so every test in `cloud-enrollment-cli.test.ts`
 * silently began making a real request to `be.failproof.ai`. It *usually*
 * resolved fast enough to pass, which is the worst available outcome: the suite
 * went intermittently red on network weather rather than on anything a change
 * had broken, and a green run stopped being evidence of anything. It reproduced
 * at roughly one run in two, and passed on the machine that introduced it.
 *
 * Loopback stays allowed, because six suites legitimately stand up a local HTTP
 * server and talk to it (daemon-download, daemon-client, cloud-enrollment, …) —
 * that is a real dependency under the test's own control, not the network.
 *
 * The failure is deliberately loud and names the host, so the next person sees
 * "which stub is missing" rather than a timeout with no cause attached. E2E runs
 * under `vitest.config.e2e.mts`, which does not load this file: those tests are
 * *supposed* to talk to real infrastructure.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  // `async` so a block arrives as a REJECTED PROMISE, exactly as a real network
  // failure does. Throwing synchronously would escape any `fetch(…).catch(…)`
  // and crash the caller instead — turning a diagnostic into a different bug,
  // and one that behaves unlike the thing it is standing in for.
  globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as Request).url ?? "");

    let host: string | null = null;
    try {
      host = new URL(raw).hostname;
    } catch {
      // A relative or unparseable URL reaches no external host by definition —
      // let it through and fail on its own terms rather than on ours.
    }

    if (host !== null && !LOOPBACK.has(host)) {
      throw new Error(
        `Unit tests must not reach the network, but one tried to fetch ${host}. ` +
          `Inject a stub for whatever makes this call (see ConnectOptions' verify / ` +
          `verifyIngest / introspect for the pattern). If the call is genuinely ` +
          `meant to hit real infrastructure, it belongs in __tests__/e2e/.`,
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

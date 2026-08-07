import "@testing-library/jest-dom";

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

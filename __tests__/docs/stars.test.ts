/**
 * `docs/stars.js` — the live GitHub star count in the docs navbar.
 *
 * It shipped with no tests, and it is the kind of code that fails silently: the
 * only symptom of a broken selector, a renamed API field or a reverted label is
 * a number that looks plausible because `docs.json` still carries a hand-written
 * one. Today's real count (1,492) formats to exactly the baked-in `⭐ 1.5k`, so
 * even a live check by eye cannot tell a working fetch from a dead one.
 *
 * The script is an IIFE with no exports, so everything here drives it the way a
 * browser does — eval it into a DOM, stub `fetch`, read the label back. The
 * NAVBAR fixture is the real markup, captured from `mintlify dev` on 2026-08-24:
 * two links to the repo, one holding the star label and one holding a
 * screen-reader `github` span that must survive untouched.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * jsdom is a devDependency but ships no types, and every other test in this repo
 * reaches it through `// @vitest-environment jsdom` rather than by importing it.
 * That environment gives one shared document per file; this file needs a fresh
 * one per case, because the script installs a MutationObserver it never
 * disconnects, and one left over from an earlier case would rewrite the next
 * one's navbar. So: the constructor, with the surface used here declared.
 */
interface StarsWindow {
  document: Document;
  sessionStorage: Storage;
  fetch: unknown;
  eval(code: string): unknown;
}
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options?: Record<string, unknown>,
  ) => { window: StarsWindow };
};

const SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "stars.js"),
  "utf-8",
);

const BAKED_IN = "⭐ 1.5k";

const NAVBAR = `<!doctype html><html><body>
  <nav>
    <a href="https://github.com/FailproofAI/failproofai"><span>${BAKED_IN}</span></a>
    <a href="https://github.com/FailproofAI/failproofai"><span>github</span></a>
  </nav>
</body></html>`;

interface Run {
  window: StarsWindow;
  /** Every call the script made to `fetch`, in order. */
  calls: string[];
  label: () => string;
  srLabel: () => string;
  flush: () => Promise<void>;
}

function run(
  respond: (url: string) => Promise<unknown>,
  { html = NAVBAR, cached }: { html?: string; cached?: string } = {},
): Run {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://docs.failproof.ai/",
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const calls: string[] = [];
  window.fetch = ((url: string) => {
    calls.push(String(url));
    return respond(String(url));
  }) as typeof window.fetch;

  // Seeded before the script runs, the way a second page load in the same tab
  // finds it.
  if (cached) window.sessionStorage.setItem("fpai:stars", cached);

  window.eval(SCRIPT);

  const spans = () => [
    ...window.document.querySelectorAll<HTMLSpanElement>("nav a span"),
  ];
  return {
    window,
    calls,
    label: () => spans()[0].textContent ?? "",
    srLabel: () => spans()[1].textContent ?? "",
    // Two macrotasks: enough for DOMContentLoaded, the fetch chain, and any
    // MutationObserver callback the script's own write would queue.
    flush: async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const ok = (stargazers_count: unknown) => () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ stargazers_count }) });

describe("docs/stars.js", () => {
  it("reads the count from the repo's GitHub API endpoint", async () => {
    const r = run(ok(2500));
    await r.flush();

    expect(r.calls).toEqual([
      "https://api.github.com/repos/FailproofAI/failproofai",
    ]);
  });

  it("replaces the hand-written label with the live count", async () => {
    const r = run(ok(2500));
    await vi.waitFor(() => expect(r.label()).toBe("⭐ 2.5k"));
  });

  it("never rewrites the screen-reader link in the same navbar", async () => {
    const r = run(ok(2500));
    await vi.waitFor(() => expect(r.label()).toBe("⭐ 2.5k"));

    expect(r.srLabel()).toBe("github");
  });

  // The unit is chosen AFTER rounding. Deciding it first renders 9,950 as
  // "9.9k" when it is "10k", and 999,999 as "1000k" when it is "1.0M".
  it.each([
    [999, "⭐ 999"],
    [1000, "⭐ 1.0k"],
    [1492, "⭐ 1.5k"],
    [9949, "⭐ 9.9k"],
    [9950, "⭐ 10k"],
    [999499, "⭐ 999k"],
    [999999, "⭐ 1.0M"],
    [1500000, "⭐ 1.5M"],
  ])("renders %i as %s", async (count, expected) => {
    const r = run(ok(count));
    await vi.waitFor(() => expect(r.label()).toBe(expected));
  });

  // Every failure path has to leave the baked-in value exactly as `docs.json`
  // rendered it. A stale number beats a blank one.
  it.each([
    ["rate-limited", () => Promise.resolve({ ok: false, status: 403 })],
    ["offline", () => Promise.reject(new Error("network"))],
    ["unexpected shape", ok(undefined)],
    ["negative count", ok(-1)],
  ])("leaves the baked-in label alone when %s", async (_case, respond) => {
    const r = run(respond as () => Promise<unknown>);
    await r.flush();

    expect(r.label()).toBe(BAKED_IN);
  });

  it("re-applies after the SPA re-renders the navbar", async () => {
    const r = run(ok(2500));
    await vi.waitFor(() => expect(r.label()).toBe("⭐ 2.5k"));

    // What client-side navigation does: the navbar re-renders from docs.json
    // and the live value is gone until the observer puts it back.
    r.window.document.querySelector("nav a span")!.textContent = BAKED_IN;
    await vi.waitFor(() => expect(r.label()).toBe("⭐ 2.5k"));
  });

  it("does nothing at all when the label is removed from docs.json", async () => {
    const r = run(ok(2500), {
      html: `<!doctype html><html><body><nav>
        <a href="https://github.com/FailproofAI/failproofai"><span>github</span></a>
      </nav></body></html>`,
    });
    await r.flush();

    expect(r.window.document.querySelector("nav a span")!.textContent).toBe(
      "github",
    );
  });

  it("serves a second page from sessionStorage instead of the API", async () => {
    const first = run(ok(2500));
    await vi.waitFor(() => expect(first.label()).toBe("⭐ 2.5k"));
    const stored = first.window.sessionStorage.getItem("fpai:stars");
    expect(stored).toContain("2.5k");

    // A fresh page load in the same tab: the script must apply the cached label
    // without going back to an API that rate-limits at 60 requests/hour.
    const second = run(ok(9999), { cached: stored! });
    await vi.waitFor(() => expect(second.label()).toBe("⭐ 2.5k"));

    expect(second.calls).toEqual([]);
  });

  it("ignores a cache entry older than its TTL", async () => {
    const stale = JSON.stringify({
      label: "⭐ 1.2k",
      at: Date.now() - 2 * 60 * 60 * 1000, // an hour past the one-hour TTL
    });
    const r = run(ok(2500), { cached: stale });
    await vi.waitFor(() => expect(r.label()).toBe("⭐ 2.5k"));
  });
});

/**
 * `docs/reo.js` — the Reo.dev beacon on the documentation site.
 *
 * Analytics is the archetype of code that fails silently: the docs render
 * identically whether the beacon loaded, loaded under someone else's client ID,
 * or never ran at all. Nobody notices from the page — only from a dashboard
 * that stays empty, weeks later, with no way to tell a quiet week from a broken
 * install.
 *
 * So this drives the script the way a browser does — eval it into a DOM, catch
 * the `<script>` it appends, fire its `onload` against a stubbed `Reo` — and
 * pins the three things that make the difference between reporting and not:
 * the file is where Mintlify looks, the loader points at Reo's CDN, and the
 * client ID in the URL is the same one handed to `Reo.init`.
 *
 * Same shape as `stars.test.ts`, for the same reason: the script is an IIFE
 * with no exports, and a fresh document per case keeps one run's appended
 * script out of the next one's assertions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ReoWindow {
  document: Document;
  Reo?: { init: (opts: { clientID?: string }) => void };
  eval(code: string): unknown;
}
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options?: Record<string, unknown>,
  ) => { window: ReoWindow };
};

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
const PATH = join(DOCS, "reo.js");
const SCRIPT = readFileSync(PATH, "utf-8");

/** The tenant this install reports to. Changing it is changing customers. */
const CLIENT_ID = "023277be3290bc6";

interface Run {
  window: ReoWindow;
  /** The `<script>` elements the snippet appended to `<head>`, in order. */
  injected: () => HTMLScriptElement[];
  /** Client IDs passed to `Reo.init`, in order. */
  inits: string[];
}

function run({ reo = true }: { reo?: boolean } = {}): Run {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only",
    url: "https://docs.befailproof.ai/",
  });
  const window = dom.window;
  const inits: string[] = [];
  if (reo) {
    window.Reo = {
      init(opts) {
        inits.push(String(opts && opts.clientID));
      },
    };
  }
  window.eval(SCRIPT);
  return {
    window,
    injected: () =>
      Array.from(
        window.document.head.querySelectorAll("script"),
      ) as HTMLScriptElement[],
    inits,
  };
}

describe("docs/reo.js", () => {
  it("sits at the docs content root, where Mintlify injects it", () => {
    // Mintlify includes `.js` from the content directory on every page. A file
    // anywhere else — `docs/images/`, the repo root, a locale folder — is
    // shipped and never executed, and the site looks exactly the same.
    expect(existsSync(PATH)).toBe(true);
  });

  it("loads the beacon from Reo's CDN for our client ID", () => {
    const r = run();
    const tags = r.injected();
    expect(tags).toHaveLength(1);
    expect(tags[0].src).toBe(
      `https://static.reo.dev/${CLIENT_ID}/reo.js`,
    );
  });

  it("initialises with the same client ID the script URL carries", () => {
    // The snippet spells the ID twice. Two different tenants there loads a
    // perfectly working script that reports nowhere we can read.
    const r = run();
    expect(r.inits).toEqual([]); // nothing until the CDN script has loaded
    r.injected()[0].onload?.(new r.window.document.defaultView!.Event("load"));
    expect(r.inits).toEqual([CLIENT_ID]);
  });

  it("does not block rendering on the beacon", () => {
    // A script built with `createElement` and appended is async by default, so
    // reading the property back proves nothing on its own — it is true whether
    // the loader sets `async`, sets `defer`, or sets neither. The source
    // assertion is what actually pins the flag; this one catches a rewrite that
    // drops to a parser-blocking `document.write`.
    expect(run().injected()[0].async).toBe(true);
    expect(SCRIPT).toContain("n.async=!0");
  });

  it("runs at most once per page load", () => {
    // Mintlify injects the file once per full page load, not per client-side
    // navigation, so the vendor snippet carries no re-entry guard. If that ever
    // changes, a second run must not stack a second beacon — this is the
    // tripwire that would fail first.
    const r = run();
    expect(r.injected()).toHaveLength(1);
  });

  it("matches the snippet Reo issues for Mintlify, character for character", () => {
    // Reo's Mintlify guide gives one minified loader line. Keeping it verbatim
    // is what makes this file diffable against the vendor docs; a hand-edit
    // that reshapes it should be a deliberate, reviewed change. Reo's *other*
    // install pages ship the same loader with `defer` in place of `async` —
    // functionally identical here, but this is installed from the Mintlify
    // page, so that is the text it is held to.
    const loader = SCRIPT.split("\n").filter(
      (l) => !l.startsWith(" *") && !l.startsWith("/*") && l.trim() !== "",
    );
    expect(loader).toHaveLength(1);
    expect(loader[0]).toBe(
      `!function(){var e,t,n;e="${CLIENT_ID}",t=function(){Reo.init({clientID:"${CLIENT_ID}"})},` +
        `(n=document.createElement("script")).src="https://static.reo.dev/"+e+"/reo.js",` +
        `n.async=!0,n.onload=t,document.head.appendChild(n)}();`,
    );
  });
});

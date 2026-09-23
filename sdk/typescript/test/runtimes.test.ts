import { describe, expect, it } from "vitest";

import { isCommonJsMain } from "../src/node-require.js";

/**
 * Runtime differences the SDK core has to read correctly. The end-to-end proof
 * for each is in `integration/runtimes.*.test.ts`; these pin the decision.
 */

describe("isCommonJsMain", () => {
  it("reads Node's undefined and Deno's null alike: an ES-module entry", () => {
    // Deno sets `require.main` to null for an ES-module entry. Treating that as
    // CommonJS patched the frameworks' CommonJS copies in every ES-module Deno
    // app, while the app ran the ES-module copies — nothing was recorded.
    expect(isCommonJsMain(undefined)).toBe(false);
    expect(isCommonJsMain(null)).toBe(false);
  });

  it("reads a module object as a CommonJS entry", () => {
    expect(isCommonJsMain({ filename: "/app/index.cjs", id: "." })).toBe(true);
  });
});

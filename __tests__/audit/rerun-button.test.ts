import { describe, it, expect } from "vitest";
import { paramsToBody } from "@/app/audit/_components/rerun-button";

describe("paramsToBody", () => {
  it("omits cli/since/noCache by default (all CLIs, all time, cache on)", () => {
    expect(paramsToBody({ cli: [], since: "all" })).toEqual({
      cli: undefined,
      since: undefined,
      noCache: undefined,
    });
  });

  it("forwards a since window and selected clis", () => {
    expect(paramsToBody({ cli: ["claude"], since: "30d" })).toEqual({
      cli: ["claude"],
      since: "30d",
      noCache: undefined,
    });
  });

  it("sets noCache:true so an explicit re-audit forces a fresh scan", () => {
    expect(paramsToBody({ cli: [], since: "30d", noCache: true })).toEqual({
      cli: undefined,
      since: "30d",
      noCache: true,
    });
  });

  it("leaves noCache undefined when false or absent (uses the cache)", () => {
    expect(paramsToBody({ cli: [], since: "30d", noCache: false }).noCache).toBeUndefined();
    expect(paramsToBody({ cli: [], since: "30d" }).noCache).toBeUndefined();
  });
});

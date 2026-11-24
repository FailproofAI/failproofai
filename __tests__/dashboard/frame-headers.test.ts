// @vitest-environment node
/**
 * FailproofAI/agenteye#1799 (and failproofai#165, closed without a change):
 * the dashboard sent no framing policy, so any page could load
 * `localhost:8020/policies` in an invisible iframe and steer clicks onto its
 * policy toggles. Those clicks are same-origin, so no Host, Origin or token
 * check can refuse them; only the browser's framing rules can.
 */
import { describe, it, expect } from "vitest";
import nextConfig from "@/next.config";

describe("dashboard framing headers", () => {
  it("forbids framing on every route, with both the modern and the legacy header", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((rule) => rule.source === "/:path*");
    expect(all, "a rule covering every path").toBeDefined();
    const byKey = new Map((all?.headers ?? []).map((h): [string, string] => [h.key.toLowerCase(), h.value]));
    expect(byKey.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(byKey.get("x-frame-options")).toBe("DENY");
  });
});

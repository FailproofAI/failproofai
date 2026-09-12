// @vitest-environment node
import { describe, it, expect } from "vitest";

import { desktopLeakNotice } from "@/src/hooks/notice";

describe("scheduled-audit desktop notification copy", () => {
  it("is factual and focused on the next action", () => {
    const notice = desktopLeakNotice("missing");
    expect(notice.title).toBe("failproofai audit needs review");
    expect(notice.body).toContain("Possible credential exposure");
    expect(notice.body).toContain("failproofai audit");
    expect(notice.body).toContain("--email you@example.com");
    expect(notice.body).not.toMatch(/500|leaked credential/i);
  });

  it("states when the masked alert was also emailed", () => {
    expect(desktopLeakNotice("sent").body).toContain("also sent to your email");
  });

  it("contains no transcript-derived details", () => {
    const notice = JSON.stringify(desktopLeakNotice("held"));
    expect(notice).not.toContain("ghp_");
    expect(notice).not.toContain("~/");
    expect(notice).not.toContain("tool_input");
  });
});

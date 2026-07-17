// @vitest-environment node
/**
 * Attribution for browser errors.
 *
 * The bug this guards: window's error/unhandledrejection listeners are
 * page-global, so browser extensions injected into the dashboard reported their
 * failures as ours. A live MetaMask rejection ("Failed to connect to MetaMask")
 * arrived in PostHog as a failproofai unhandled_rejection.
 */
import { describe, it, expect } from "vitest";
import { classifyErrorOrigin, isAppError } from "../../lib/error-origin";

const APP = "http://localhost:8020";

describe("classifyErrorOrigin", () => {
  describe("browser extensions", () => {
    // The exact shape observed in production.
    it("classifies the real MetaMask rejection as an extension error", () => {
      const stack =
        "i: Failed to connect to MetaMask\n" +
        "    at chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js:1:12345";

      expect(classifyErrorOrigin({ stack, appOrigin: APP })).toBe("extension");
    });

    it.each([
      ["chrome", "chrome-extension://abc/inpage.js:1:1"],
      ["firefox", "moz-extension://abc/content.js:1:1"],
      ["safari", "safari-web-extension://abc/injected.js:1:1"],
      ["edge", "ms-browser-extension://abc/script.js:1:1"],
    ])("recognises %s extension frames", (_browser, frame) => {
      expect(classifyErrorOrigin({ stack: `Error: x\n    at ${frame}`, appOrigin: APP })).toBe(
        "extension",
      );
    });

    // Matching the shared `-extension://` suffix, not a vendor list, so a new
    // browser's scheme is filtered without a code change.
    it("recognises an unknown vendor's extension scheme", () => {
      expect(
        classifyErrorOrigin({ stack: "at future-extension://abc/x.js:1:1", appOrigin: APP }),
      ).toBe("extension");
    });

    it("uses the filename when there is no stack", () => {
      expect(
        classifyErrorOrigin({ filename: "chrome-extension://abc/inpage.js", appOrigin: APP }),
      ).toBe("extension");
    });

    // An error routed through an extension is the extension's problem, even
    // though one of our frames appears further down the stack.
    it("treats a mixed stack as an extension error", () => {
      const stack =
        "Error: boom\n" +
        "    at chrome-extension://abc/inpage.js:1:1\n" +
        `    at fn (${APP}/_next/static/chunks/main.js:2:2)`;

      expect(classifyErrorOrigin({ stack, appOrigin: APP })).toBe("extension");
    });
  });

  describe("our own dashboard", () => {
    it("classifies a stack from our origin as an app error", () => {
      const stack = `TypeError: x is not a function\n    at Page (${APP}/_next/static/chunks/page.js:1:1)`;

      expect(classifyErrorOrigin({ stack, appOrigin: APP })).toBe("app");
    });

    it("classifies a filename from our origin as an app error", () => {
      expect(
        classifyErrorOrigin({ filename: `${APP}/_next/static/chunks/main.js`, appOrigin: APP }),
      ).toBe("app");
    });

    it("attributes correctly on a non-default origin", () => {
      const origin = "http://127.0.0.1:3999";

      expect(classifyErrorOrigin({ stack: `at fn (${origin}/x.js:1:1)`, appOrigin: origin })).toBe(
        "app",
      );
    });
  });

  describe("unattributable", () => {
    it("returns unknown when there is no location information at all", () => {
      expect(classifyErrorOrigin({ appOrigin: APP })).toBe("unknown");
      expect(classifyErrorOrigin({ stack: "", filename: "", appOrigin: APP })).toBe("unknown");
      expect(classifyErrorOrigin({ stack: "   ", appOrigin: APP })).toBe("unknown");
    });

    // The opaque cross-origin error — nothing in it to debug.
    it("returns unknown for a bare cross-origin 'Script error.'", () => {
      expect(classifyErrorOrigin({ stack: "Script error.", appOrigin: APP })).toBe("unknown");
    });

    it("returns unknown for a third-party host that is neither ours nor an extension", () => {
      expect(
        classifyErrorOrigin({ stack: "at https://cdn.example.com/x.js:1:1", appOrigin: APP }),
      ).toBe("unknown");
    });
  });
});

describe("isAppError", () => {
  it("reports only positively-attributed app errors", () => {
    expect(isAppError({ stack: `at fn (${APP}/x.js:1:1)`, appOrigin: APP })).toBe(true);
    expect(isAppError({ stack: "at chrome-extension://abc/x.js:1:1", appOrigin: APP })).toBe(false);
    expect(isAppError({ appOrigin: APP })).toBe(false);
  });
});

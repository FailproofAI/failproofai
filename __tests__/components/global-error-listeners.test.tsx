/**
 * End-to-end wiring for the dashboard's global error listeners: real window
 * events in, capture decisions out.
 *
 * The bug this guards: these listeners are page-global, so browser extensions
 * sharing the page had their failures reported as failproofai's. A live
 * MetaMask rejection reached PostHog as an unhandled_rejection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { GlobalErrorListeners } from "@/app/components/global-error-listeners";

const h = vi.hoisted(() => ({ captureClientEvent: vi.fn() }));
vi.mock("@/lib/client-telemetry", () => ({ captureClientEvent: h.captureClientEvent }));

const APP = window.location.origin;

/** Dispatch a real unhandledrejection event with the given reason. */
function rejectWith(reason: unknown) {
  const event = new Event("unhandledrejection") as Event & { reason: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

/** Dispatch a real error event carrying `error` and `filename`. */
function throwWith(error: Error | undefined, filename: string) {
  const event = new Event("error") as Event & {
    error?: Error;
    filename: string;
    message: string;
    lineno: number;
    colno: number;
  };
  event.error = error;
  event.filename = filename;
  event.message = error?.message ?? "boom";
  event.lineno = 1;
  event.colno = 1;
  window.dispatchEvent(event);
}

function errorFrom(origin: string, message: string): Error {
  const err = new Error(message);
  err.stack = `Error: ${message}\n    at fn (${origin}/_next/static/chunks/main.js:1:1)`;
  return err;
}

describe("GlobalErrorListeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports an unhandled rejection thrown by our own code", () => {
    render(<GlobalErrorListeners />);

    rejectWith(errorFrom(APP, "state is undefined"));

    expect(h.captureClientEvent).toHaveBeenCalledWith(
      "unhandled_rejection",
      expect.objectContaining({ error_message: "state is undefined" }),
    );
  });

  // The exact production case that prompted this filter.
  it("ignores MetaMask's rejection instead of reporting it as ours", () => {
    render(<GlobalErrorListeners />);

    const metamask = new Error("Failed to connect to MetaMask");
    metamask.name = "i";
    metamask.stack =
      "i: Failed to connect to MetaMask\n    at chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js:1:1";
    rejectWith(metamask);

    expect(h.captureClientEvent).not.toHaveBeenCalled();
  });

  it("ignores a rejection with no stack to attribute it by", () => {
    render(<GlobalErrorListeners />);

    rejectWith("just a string");

    expect(h.captureClientEvent).not.toHaveBeenCalled();
  });

  it("reports an uncaught exception from our own script", () => {
    render(<GlobalErrorListeners />);

    throwWith(errorFrom(APP, "render failed"), `${APP}/_next/static/chunks/main.js`);

    expect(h.captureClientEvent).toHaveBeenCalledWith(
      "unhandled_exception",
      expect.objectContaining({ error_message: "render failed" }),
    );
  });

  it("ignores an uncaught exception from an extension's script", () => {
    render(<GlobalErrorListeners />);

    throwWith(undefined, "chrome-extension://abc/inpage.js");

    expect(h.captureClientEvent).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const { unmount } = render(<GlobalErrorListeners />);
    unmount();

    rejectWith(errorFrom(APP, "after unmount"));

    expect(h.captureClientEvent).not.toHaveBeenCalled();
  });
});

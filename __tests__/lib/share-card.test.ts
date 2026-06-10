// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  copyOrDownloadCard,
  downloadCard,
  shareCardNative,
  shareCardToastMessage,
} from "@/lib/share-card";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic header

function makeBlob(): Blob {
  return new Blob([PNG_BYTES], { type: "image/png" });
}

describe("lib/share-card", () => {
  beforeEach(() => {
    // jsdom doesn't ship URL.createObjectURL / revokeObjectURL — mock them so
    // the download-fallback path doesn't throw out of its try block.
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true, writable: true, value: vi.fn().mockReturnValue("blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true, writable: true, value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: undefined });
  });

  it("returns 'clipboard' when navigator.clipboard.write succeeds", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(public items: Record<string, Blob>) {}
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });

    const result = await copyOrDownloadCard(makeBlob(), "x.png");

    expect(result).toBe("clipboard");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'download' when clipboard.write rejects", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(public items: Record<string, Blob>) {}
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    const click = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const node = realCreate(tag);
      if (tag === "a") Object.defineProperty(node, "click", { value: click });
      return node;
    });

    const result = await copyOrDownloadCard(makeBlob(), "x.png");

    expect(result).toBe("download");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'download' when ClipboardItem is undefined", async () => {
    // ClipboardItem absent, navigator.clipboard absent — function should go
    // straight to the download fallback.
    const click = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const node = realCreate(tag);
      if (tag === "a") Object.defineProperty(node, "click", { value: click });
      return node;
    });

    const result = await copyOrDownloadCard(makeBlob(), "x.png");

    expect(result).toBe("download");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("toast copy is method-specific", () => {
    expect(shareCardToastMessage("native")).toMatch(/attached/);
    expect(shareCardToastMessage("clipboard")).toMatch(/copied/);
    expect(shareCardToastMessage("download")).toMatch(/downloaded/);
    expect(shareCardToastMessage("failed")).toMatch(/couldn/i);
  });

  it("downloadCard triggers an anchor click and returns true", () => {
    const click = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const node = realCreate(tag);
      if (tag === "a") Object.defineProperty(node, "click", { value: click });
      return node;
    });

    const ok = downloadCard(makeBlob(), "x.png");

    expect(ok).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("shareCardNative returns false when navigator.share is unavailable", async () => {
    const originalShare = navigator.share;
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    try {
      const ok = await shareCardNative(makeBlob(), "x.png", "hello");
      expect(ok).toBe(false);
    } finally {
      Object.defineProperty(navigator, "share", { configurable: true, value: originalShare });
    }
  });

  it("shareCardNative returns true when navigator.share resolves on mobile", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { mobile: true } });

    const ok = await shareCardNative(makeBlob(), "x.png", "hello");

    expect(ok).toBe(true);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("shareCardNative returns false on AbortError (user cancelled)", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const share = vi.fn().mockRejectedValue(abort);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { mobile: true } });

    const ok = await shareCardNative(makeBlob(), "x.png", "hello");

    expect(ok).toBe(false);
  });

  it("shareCardNative returns false on desktop without invoking navigator.share", async () => {
    // Windows Chromium / Edge expose `navigator.share` but the OS share sheet
    // doesn't include X / LinkedIn as targets, so we skip native entirely on
    // desktop and let the caller's clipboard + intent-URL fallback run.
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { mobile: false } });

    const ok = await shareCardNative(makeBlob(), "x.png", "hello");

    expect(ok).toBe(false);
    expect(share).not.toHaveBeenCalled();
  });
});

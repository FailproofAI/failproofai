/**
 * Helpers for attaching the audit-card PNG to a social share.
 *
 *   X and LinkedIn intent URLs cannot carry image attachments — only text
 *   and a target URL. To actually get an image into a post we have three
 *   options at different levels of "automatic":
 *
 *     1. `shareCardNative` → `navigator.share({ files })` — the system
 *        share sheet handles the image + text in one step. Works on
 *        iOS, Android, recent Safari, recent Chrome desktop. When the
 *        user picks their target (X / LinkedIn / …) the image is
 *        already attached.
 *     2. `copyOrDownloadCard` → clipboard + open intent URL — the user
 *        pastes (⌘/Ctrl+V) in the share dialog and the image attaches.
 *     3. `downloadCard` → straight download to disk, no other side
 *        effects. Used by the dedicated "save audit-card" button so
 *        the user gets a file every time, regardless of clipboard
 *        permissions.
 */

export type ShareCardMethod = "native" | "clipboard" | "download" | "failed";

/**
 * Best-effort "is this a mobile device" check. On mobile, the system share
 * sheet exposes the actual X / LinkedIn apps as targets so `navigator.share`
 * is a one-tap UX win. On desktop (notably Windows Chromium / Edge) the same
 * call opens the OS share dialog — useless for X / LinkedIn — so we
 * deliberately skip it and fall back to clipboard + intent URL.
 *
 * Prefers `userAgentData.mobile` (Chromium UA-Client-Hints, no sniffing),
 * falls back to a tight UA pattern for Safari / Firefox, and treats
 * iPadOS 13+ (UA says Mac but multi-touch is available) as mobile.
 */
function isLikelyMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  type UADataNav = Navigator & { userAgentData?: { mobile?: boolean } };
  const uaData = (navigator as UADataNav).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  if (ua.includes("Mac") && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1) return true;
  return false;
}

/**
 * Try the native Web Share API with a file attachment. Returns `true` on
 * success, `false` if the API is unavailable, files-sharing isn't
 * supported, the device is desktop (where the OS share sheet doesn't
 * include X / LinkedIn), or the user dismissed the sheet. Caller should
 * fall back to `copyOrDownloadCard` on `false`.
 */
export async function shareCardNative(
  blob: Blob,
  filename: string,
  text: string,
): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }
  if (!isLikelyMobile()) return false;
  const file = new File([blob], filename, { type: "image/png" });
  // Some browsers (older Chrome desktop) expose `navigator.share` but reject
  // file payloads. `canShare({ files })` gates that cleanly.
  type CanShareNav = Navigator & { canShare?: (data: ShareData) => boolean };
  const navWithCan = navigator as CanShareNav;
  if (typeof navWithCan.canShare === "function" && !navWithCan.canShare({ files: [file] })) {
    return false;
  }
  try {
    await navigator.share({ files: [file], text });
    return true;
  } catch (err) {
    // AbortError → user dismissed the sheet. Treat as a soft failure so the
    // caller can decide whether to open the intent URL anyway.
    if (err instanceof Error && err.name === "AbortError") return false;
    return false;
  }
}

/**
 * Copy a captured share-card PNG to the system clipboard, or fall back to a
 * download if the browser doesn't support image clipboard writes (or the
 * user denied permission). The caller MUST be inside an active user gesture
 * (click handler) — Chromium gates `navigator.clipboard.write` on user
 * activation.
 */
export async function copyOrDownloadCard(
  blob: Blob,
  filename: string,
): Promise<Exclude<ShareCardMethod, "native">> {
  if (
    typeof ClipboardItem !== "undefined"
    && typeof navigator !== "undefined"
    && navigator.clipboard
    && typeof navigator.clipboard.write === "function"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return "clipboard";
    } catch {
      /* permission denied, secure-context issue, browser fence, … */
    }
  }
  return downloadCard(blob, filename) ? "download" : "failed";
}

/**
 * Trigger a local download of the PNG. Returns `true` on success. No
 * clipboard interaction — used by the explicit "save audit-card" CTA so the
 * user reliably gets a file even when clipboard write would succeed.
 */
export function downloadCard(blob: Blob, filename: string): boolean {
  try {
    if (typeof document === "undefined" || typeof URL === "undefined") return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    queueMicrotask(() => URL.revokeObjectURL(url));
    return true;
  } catch {
    return false;
  }
}

/** Human-readable toast copy keyed by share method. */
export function shareCardToastMessage(method: ShareCardMethod): string {
  switch (method) {
    case "native":
      return "✅ image attached — pick where to post";
    case "clipboard":
      return "📋 image copied — paste it in the post (⌘/Ctrl+V)";
    case "download":
      return "⬇ image downloaded — attach it to your post";
    case "failed":
      return "couldn't capture image — opening text-only share";
  }
}

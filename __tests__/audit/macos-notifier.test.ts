// @vitest-environment node
/**
 * The macOS notifier, asserted from Linux.
 *
 * Every CI runner this project has is Linux, and the parts that need a Mac —
 * `osacompile`, `launchctl bootstrap`, whether a banner actually appears — are
 * exactly the parts no test here can reach. So this pins the half that IS
 * platform-independent and is also the half that silently rots: the plist's
 * shape, the AppleScript's structure, and the queue's on-disk contract. That is
 * the same split `launchdPlistContents` already makes for the daemon's own
 * plist.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  MAC_NOTIFIER_LABEL,
  macNotifyDir,
  notifierPlistContents,
  notifierScript,
  queueMacNotification,
  pruneMacNotifyQueue,
} from "@/src/audit/macos-notifier";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fp-macnote-"));
  process.env.FAILPROOFAI_HOME = home;
});
afterEach(() => {
  delete process.env.FAILPROOFAI_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("the LaunchAgent plist", () => {
  const plist = () => notifierPlistContents("/Users/x/.failproofai/bin/N.app", "/Users/x/.failproofai/run/notify");

  it("runs the applet inside the bundle, not osascript", () => {
    // A bare `osascript -e 'display notification'` is attributed to Script
    // Editor: it inherits Script Editor's notification permission and shows up
    // under Script Editor in System Settings. The bundle is what makes the
    // banner say failproofai and gives the user something to turn off.
    expect(plist()).toContain("<string>/Users/x/.failproofai/bin/N.app/Contents/MacOS/applet</string>");
    expect(plist()).not.toContain("osascript");
  });

  it("is woken by the queue rather than left running", () => {
    expect(plist()).toContain("<key>WatchPaths</key>");
    expect(plist()).toContain("<string>/Users/x/.failproofai/run/notify</string>");
    // Both false, and both for a reason: RunAtLoad would fire it at every login
    // with nothing to say, and KeepAlive would treat its normal exit as a crash
    // and restart it forever.
    expect(plist()).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist()).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it("carries the label the uninstall boots out", () => {
    // These two must be the same string, or `uninstall --purge` removes the
    // file and leaves launchd holding a live job pointing at a deleted applet.
    expect(plist()).toContain(`<string>${MAC_NOTIFIER_LABEL}</string>`);
  });

  it("is well-formed XML with a real doctype", () => {
    expect(plist().startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist()).toContain("<!DOCTYPE plist PUBLIC");
    expect(plist().trimEnd().endsWith("</plist>")).toBe(true);
  });

  it("escapes a path that would otherwise break the document", () => {
    const out = notifierPlistContents("/Users/a&b/N.app", "/Users/a<b>/notify");
    expect(out).toContain("/Users/a&amp;b/N.app");
    expect(out).toContain("/Users/a&lt;b&gt;/notify");
  });
});

describe("the applet's script", () => {
  it("deletes each payload BEFORE displaying it", () => {
    // WatchPaths fires on every change to the directory, so a file that cannot
    // be displayed and is not removed wakes this agent forever. At-most-once is
    // the right failure: the caller already claimed the finding on disk, so a
    // dropped banner costs one silent finding and a wake loop costs the machine.
    const s = notifierScript();
    const rmAt = s.indexOf('rm -f');
    const showAt = s.indexOf("display notification");
    expect(rmAt).toBeGreaterThan(-1);
    expect(showAt).toBeGreaterThan(-1);
    expect(rmAt).toBeLessThan(showAt);
  });

  it("points at this home's queue, quoted", () => {
    // JSON.stringify is what makes an AppleScript string literal out of a path,
    // and a home containing a quote is a home this must not mis-escape.
    expect(notifierScript()).toContain(JSON.stringify(macNotifyDir() + "/"));
  });

  it("reads a title and a body, and shows nothing for a one-line file", () => {
    // A truncated payload is a real state — the queue writer renames into place
    // precisely to avoid it, and this is the backstop if that ever regresses.
    const s = notifierScript();
    expect(s).toContain("count of lines_) is greater than 1");
  });
});

describe("the queue", () => {
  it("lands the payload under the finding's own id", () => {
    // One file per claimed finding is what keeps the banner count honest: the
    // id is already unique per credential, so a repeat cannot double up.
    expect(queueMacNotification("abc1230000000000", "Title", "Body text")).toBe(true);
    expect(readFileSync(resolve(macNotifyDir(), "abc1230000000000"), "utf8")).toBe("Title\nBody text\n");
  });

  it("leaves no partial file for the watcher to read", () => {
    // WatchPaths fires on the first byte written, so the payload is built
    // outside the directory and renamed in. Nothing but finished files ever
    // appears here.
    queueMacNotification("abc0000000000000", "T", "B");
    expect(readdirSync(macNotifyDir())).toEqual(["abc0000000000000"]);
    expect(existsSync(resolve(macNotifyDir(), "..", "notify-abc0000000000000.tmp"))).toBe(false);
  });

  it("flattens newlines, because the applet reads the payload by line", () => {
    queueMacNotification("00000000000000ff", "A\nB", "C\n\nD  E");
    expect(readFileSync(resolve(macNotifyDir(), "00000000000000ff"), "utf8")).toBe("A B\nC D E\n");
  });

  it("returns false instead of throwing when the queue cannot be written", () => {
    // Read-only home, full disk, a home that is not a directory. None of them
    // should turn a completed scan into a crash — the caller treats a false as
    // "this channel is unavailable" and carries on.
    process.env.FAILPROOFAI_HOME = "/dev/null/nope";
    expect(queueMacNotification("00000000000000ff", "T", "B")).toBe(false);
  });

  it("drops payloads nothing ever collected", () => {
    // Queued while logged out, or with the agent removed. Showing them at the
    // next login would announce keys that were rotated weeks ago.
    mkdirSync(macNotifyDir(), { recursive: true });
    const stale = resolve(macNotifyDir(), "0000000000000010");
    const fresh = resolve(macNotifyDir(), "0000000000000011");
    writeFileSync(stale, "T\nB\n");
    writeFileSync(fresh, "T\nB\n");
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(stale, longAgo, longAgo);

    pruneMacNotifyQueue();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

// @vitest-environment node
/**
 * The macOS notifier, asserted from Linux.
 *
 * Every CI runner this project has is Linux, and the parts that need a Mac —
 * `osacompile`, `launchctl bootstrap`, whether a banner actually appears — are
 * exactly the parts no test here can reach. So this pins the half that IS
 * platform-independent and is also the half that silently rots: the plist's
 * shape, the runner's structure, and the queue's on-disk contract. That is
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
  const plist = () => notifierPlistContents(
    "/Users/x/.failproofai/bin/failproofai-notifier.zsh",
    "/Users/x/.failproofai/run/notify",
  );

  it("runs the user-session notification script", () => {
    // The LaunchAgent is the bridge into the GUI domain. The runner then uses
    // the same osascript path that works from ordinary scheduled Mac jobs.
    expect(plist()).toContain(
      "<string>/Users/x/.failproofai/bin/failproofai-notifier.zsh</string>",
    );
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

describe("the notifier runner", () => {
  it("deletes each payload BEFORE displaying it", () => {
    // WatchPaths fires on every change to the directory, so a file that cannot
    // be displayed and is not removed wakes this agent forever. At-most-once is
    // the right failure: the caller already claimed the finding on disk, so a
    // dropped banner costs one silent finding and a wake loop costs the machine.
    const s = notifierScript();
    const rmAt = s.indexOf('rm -f');
    const showAt = s.indexOf("/usr/bin/osascript");
    expect(rmAt).toBeGreaterThan(-1);
    expect(showAt).toBeGreaterThan(-1);
    expect(rmAt).toBeLessThan(showAt);
  });

  it("points at this home's queue, quoted", () => {
    expect(notifierScript()).toContain(`drop_dir='${macNotifyDir()}'`);
  });

  it("passes title and body as argv instead of interpolating AppleScript", () => {
    const s = notifierScript();
    expect(s).toContain('/usr/bin/osascript - "$note_title" "$note_body"');
    expect(s).toContain("display notification (item 2 of argv) with title (item 1 of argv)");
  });

  it("is an executable zsh script using absolute macOS tool paths", () => {
    const s = notifierScript();
    expect(s.startsWith("#!/bin/zsh\n")).toBe(true);
    expect(s).toContain("setopt NULL_GLOB");
    expect(s).toContain("/usr/bin/sed");
    expect(s).toContain("/usr/bin/tr");
    expect(s).toContain("/bin/rm");
  });

  it("removes malformed payloads instead of leaving a launchd wake loop", () => {
    const s = notifierScript();
    const readAt = s.indexOf("note_title=");
    const rmAt = s.indexOf("/bin/rm -f");
    const validateAt = s.indexOf('[ -n "$note_title" ]');
    expect(readAt).toBeGreaterThan(-1);
    expect(rmAt).toBeGreaterThan(readAt);
    expect(validateAt).toBeGreaterThan(rmAt);
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

  it("flattens newlines, because the runner reads the payload by line", () => {
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

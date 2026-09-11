/**
 * Getting a notification onto a Mac's screen from a process that has no screen.
 *
 * On Linux the scheduled audit talks to the session bus directly and is done
 * (`desktop-notify.ts`). macOS has no equivalent shortcut, and the reason is
 * structural rather than a missing permission: launchd has two domains, and
 * Notification Center lives in only one of them. `failproofaid` is installed as
 * a **LaunchDaemon** — that is what makes it start at boot and survive logout,
 * the property the whole daemon design turns on — so it and every child it
 * spawns run in the *system* domain, outside the logged-in user's GUI session.
 * A `display notification` from there posts into nothing. Apple's TN2083 draws
 * exactly this line, and Time Machine ships the same split: a privileged daemon
 * doing the work, an agent in the user's session doing the talking.
 *
 * So this module installs the second half — a **LaunchAgent**, which launchd
 * starts inside the Aqua session, where Notification Center is reachable.
 *
 * ## Three choices worth stating, because the obvious alternative is wrong
 *
 * **`~/Library/LaunchAgents`, not `/Library/LaunchAgents`.** The per-user
 * directory is owned by the user and writable without elevation, so installing
 * this asks for nothing — no password, no second sudo prompt in a wizard that
 * already spent its one. The system-wide agent directory would need admin and
 * would install for every account on the box, which is not what a per-user
 * notification is.
 *
 * **A user-session `osascript`, not an applet binary launched directly.** The
 * compiled applet path looked attractive because it could carry a FailproofAI
 * bundle identifier, but launching `Contents/MacOS/applet` directly from
 * launchd is not a dependable Notification Center client on current macOS.
 * `osascript` from a user LaunchAgent is the same mechanism ordinary scheduled
 * jobs use successfully. Delivery matters more than owning the label shown by
 * Notification Center, so the runner uses that proven path.
 *
 * **A watched drop directory, not a resident process.** The agent is not a
 * daemon: `WatchPaths` makes launchd start it only when a file appears, and it
 * exits as soon as the directory is empty. Nothing is resident, nothing polls,
 * and a machine that never leaks a credential never runs it at all.
 *
 * ## What this does NOT claim
 *
 * That the user saw it. macOS can be in Do Not Disturb, the display can be
 * asleep, and the user can deny the bundle in System Settings — none of which
 * is visible from here. The banner is a prompt to look; the record on disk is
 * the thing that lasts.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runDir } from "../hooks/fp-home";
import { isFindingId } from "./leak-fingerprint";

/** Stable label used to load, inspect, and remove the per-user LaunchAgent. */
export const MAC_NOTIFIER_LABEL = "ai.failproof.notifier";

/** Where a queued notification waits for the agent to pick it up. */
export const macNotifyDir = (home?: string) => resolve(runDir(home), "notify");

/** Legacy compiled applet path, retained so upgrades and uninstall remove it. */
export function macNotifierAppPath(home?: string): string {
  return resolve(runDir(home), "..", "bin", "FailproofAI Notifier.app");
}

/** User-session runner invoked by launchd when a notification is queued. */
export function macNotifierRunnerPath(home?: string): string {
  return resolve(runDir(home), "..", "bin", "failproofai-notifier.zsh");
}

export function macNotifierPlistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${MAC_NOTIFIER_LABEL}.plist`);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The user-session runner: drain the directory, say each notification, exit.
 *
 * Payload format is two lines — title, then body. Values are passed to
 * AppleScript as argv, never interpolated into source, so notification text
 * cannot become AppleScript code.
 *
 * The file is REMOVED BEFORE the notification is posted, and that order is
 * deliberate: `WatchPaths` fires on every change to the directory, so a file
 * that cannot be displayed and is not removed would wake this agent forever.
 * At-most-once is the right failure here because the caller has already claimed
 * the finding on disk — a dropped banner costs one silent finding, a wake loop
 * costs the machine.
 */
export function notifierScript(home?: string): string {
  const dir = macNotifyDir(home);
  const quotedDir = `'${dir.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/zsh
set -u
setopt NULL_GLOB

drop_dir=${quotedDir}

for entry_path in "$drop_dir"/*; do
  [ -f "$entry_path" ] || continue
  note_title=$(/usr/bin/sed -n '1p' "$entry_path")
  note_body=$(/usr/bin/sed -n '2,$p' "$entry_path" | /usr/bin/tr '\\n' ' ')
  /bin/rm -f "$entry_path"
  [ -n "$note_title" ] || continue
  /usr/bin/osascript - "$note_title" "$note_body" <<'APPLESCRIPT'
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
done
`;
}

/**
 * Exported for the same reason `launchdPlistContents` is: it is the only way to
 * assert this file's shape from a Linux CI runner, which is every CI runner we
 * have.
 */
export function notifierPlistContents(runnerPath: string, watchDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(MAC_NOTIFIER_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(runnerPath)}</string>
    </array>
    <!-- Started only when something is queued, and it exits when the queue is
         empty. RunAtLoad would fire it once at login with nothing to say. -->
    <key>WatchPaths</key>
    <array>
        <string>${escapeXml(watchDir)}</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <!-- Not a service: it does one pass and exits, and launchd must not treat
         that as a crash to restart. -->
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`;
}

export interface MacNotifierResult {
  installed: boolean;
  reason?: string;
}

/** Bounded, and never inherits a TTY — this runs from inside a wizard. */
function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
}

/**
 * Install the notifier, silently.
 *
 * Silent on purpose. An earlier draft printed "installing a small helper so we
 * can notify you about leaks (macOS only)" during setup, which reads as an
 * apology for something the user already asked for by running setup — every
 * other app that can raise a notification installs its delivery path without
 * narrating it. What the user is asked is the thing that matters (does this
 * machine scan, and may it interrupt), and both of those are real settings.
 *
 * Returns rather than throws. Notifications are one channel of several, and a
 * Mac that cannot load the user LaunchAgent must still finish setting up its
 * daemon, hooks and policies — the parts that actually enforce anything.
 */
export function installMacNotifier(home?: string): MacNotifierResult {
  if (process.platform !== "darwin") return { installed: false, reason: "not macOS" };
  try {
    const runner = macNotifierRunnerPath(home);
    const watch = macNotifyDir(home);
    mkdirSync(watch, { recursive: true, mode: 0o700 });
    mkdirSync(resolve(runner, ".."), { recursive: true });
    writeFileSync(runner, notifierScript(home), { mode: 0o700 });
    // writeFileSync preserves an existing file's mode. Repair it explicitly on
    // upgrades from a partially-created or hand-edited runner.
    chmodSync(runner, 0o700);
    // Remove the applet used by older builds. The LaunchAgent below no longer
    // references it, and leaving it behind makes diagnosis ambiguous.
    rmSync(macNotifierAppPath(home), { recursive: true, force: true });

    mkdirSync(resolve(macNotifierPlistPath(), ".."), { recursive: true });
    writeFileSync(macNotifierPlistPath(), notifierPlistContents(runner, watch), { mode: 0o644 });

    const target = `gui/${process.getuid?.() ?? 0}`;
    // bootout first: bootstrap fails outright on an already-loaded label, and
    // a reinstall must land the NEW plist rather than leave the old one live.
    try {
      run("launchctl", ["bootout", `${target}/${MAC_NOTIFIER_LABEL}`]);
    } catch {
      // Not loaded. That is the normal first-install case.
    }
    run("launchctl", ["bootstrap", target, macNotifierPlistPath()]);
    return { installed: true };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove the agent and its runner, including the applet used by older builds.
 *
 * Called from `failproofai uninstall --purge`. Unconditional and quiet: an
 * agent left behind after an uninstall is a plist launchd keeps trying to start
 * from a path that no longer exists, which shows up in the user's log forever
 * and is the exact class of leftover an uninstall exists to prevent.
 */
export function uninstallMacNotifier(home?: string): void {
  if (process.platform !== "darwin") return;
  try {
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${MAC_NOTIFIER_LABEL}`]);
  } catch {
    // Already gone, or never loaded.
  }
  rmSync(macNotifierPlistPath(), { force: true });
  rmSync(macNotifierAppPath(home), { recursive: true, force: true });
  rmSync(macNotifierRunnerPath(home), { force: true });
  rmSync(macNotifyDir(home), { recursive: true, force: true });
}

/**
 * Queue one notification for the agent to deliver.
 *
 * Written to a sibling directory and RENAMED in, so the watcher never observes
 * a half-written file: `WatchPaths` fires on the first byte, and a partial read
 * would be a truncated banner that the agent then deletes.
 *
 * Returns whether the file landed — not whether anything was shown, which this
 * side cannot know and does not claim.
 */
export function queueMacNotification(
  id: string,
  title: string,
  body: string,
  home?: string,
): boolean {
  // The id becomes a filename in a watched directory, so validate the path
  // component before resolving it — see `isFindingId`.
  if (!isFindingId(id)) return false;
  const dir = macNotifyDir(home);
  const tmp = resolve(dir, "..", `notify-${id}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // One line each. Newlines inside either field would be read as extra body
    // lines by the applet, so they are flattened here rather than there.
    const payload = `${title.replace(/\s+/g, " ")}\n${body.replace(/\s+/g, " ")}\n`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, resolve(dir, id));
    return true;
  } catch {
    // Clean up the staging file. Without this, every failed queue attempt left
    // a `notify-*.tmp` beside the watched directory forever — invisible to the
    // agent, which only reads inside it, and never collected by anything.
    try {
      rmSync(tmp, { force: true });
    } catch { /* nothing left to do */ }
    return false;
  }
}

/** True when an agent is installed and could pick a queued file up. */
export function macNotifierInstalled(home?: string): boolean {
  return existsSync(macNotifierPlistPath()) && existsSync(macNotifierRunnerPath(home));
}

/**
 * Drop anything the agent never collected.
 *
 * A machine that queued a banner while logged out, or with the agent removed,
 * would otherwise show a pile of stale findings at the next login — "we found
 * this key" for keys already rotated weeks ago.
 */
export function pruneMacNotifyQueue(home?: string, maxAgeMs = 7 * 86_400_000): void {
  try {
    const dir = macNotifyDir(home);
    if (!existsSync(dir)) return;
    const { statSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
      } catch {
        // Raced with the agent collecting it. Nothing to do.
      }
    }
  } catch {
    // Housekeeping only.
  }
}

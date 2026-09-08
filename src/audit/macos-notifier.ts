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
 * **An app bundle, not a bare `osascript -e 'display notification'`.** A raw
 * osascript notification is attributed to whatever host ran it — in practice
 * "Script Editor" — so it inherits Script Editor's notification permission,
 * appears under Script Editor in System Settings, and is indistinguishable from
 * any other script on the machine. Compiling a tiny applet with `osacompile`
 * gives it its own bundle identifier, so the banner says failproofai, and the
 * user gets a real entry they can allow, silence or deny like any other app.
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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runDir } from "../hooks/fp-home";
import { isFindingId } from "./leak-fingerprint";

/** The bundle identifier the banner is attributed to, and the agent's label. */
export const MAC_NOTIFIER_LABEL = "ai.failproof.notifier";

/** Where a queued notification waits for the agent to pick it up. */
export const macNotifyDir = (home?: string) => resolve(runDir(home), "notify");

/** The compiled applet. Under `~/.failproofai` rather than `/Applications`,
 *  because it is a delivery mechanism, not something to launch. */
export function macNotifierAppPath(home?: string): string {
  return resolve(runDir(home), "..", "bin", "FailproofAI Notifier.app");
}

export function macNotifierPlistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${MAC_NOTIFIER_LABEL}.plist`);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The AppleScript the applet runs: drain the directory, say each line, exit.
 *
 * Payload format is two lines — title, then body — chosen over JSON because
 * AppleScript has no JSON parser and shelling out to one would put a second
 * interpreter in the path of a two-field message.
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
  return `on run
	set dropDir to ${JSON.stringify(dir + "/")}
	set listing to ""
	try
		set listing to do shell script "ls -1 " & quoted form of dropDir & " 2>/dev/null"
	end try
	repeat with entryName in paragraphs of listing
		set entryPath to dropDir & (entryName as string)
		if (entryName as string) is not "" then
			try
				set payload to do shell script "cat " & quoted form of entryPath & " 2>/dev/null"
				do shell script "rm -f " & quoted form of entryPath
				set lines_ to paragraphs of payload
				if (count of lines_) is greater than 1 then
					set noteTitle to item 1 of lines_
					set noteBody to ""
					repeat with i from 2 to (count of lines_)
						if noteBody is not "" then set noteBody to noteBody & " "
						set noteBody to noteBody & (item i of lines_)
					end repeat
					display notification noteBody with title noteTitle
				end if
			end try
		end if
	end repeat
end run
`;
}

/**
 * Exported for the same reason `launchdPlistContents` is: it is the only way to
 * assert this file's shape from a Linux CI runner, which is every CI runner we
 * have.
 */
export function notifierPlistContents(appPath: string, watchDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(MAC_NOTIFIER_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(resolve(appPath, "Contents", "MacOS", "applet"))}</string>
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
 * Mac that cannot compile an applet must still finish setting up its daemon,
 * its hooks and its policies — the parts that actually enforce anything.
 */
export function installMacNotifier(home?: string): MacNotifierResult {
  if (process.platform !== "darwin") return { installed: false, reason: "not macOS" };
  try {
    const app = macNotifierAppPath(home);
    const watch = macNotifyDir(home);
    mkdirSync(watch, { recursive: true, mode: 0o700 });
    mkdirSync(resolve(app, ".."), { recursive: true });

    const scriptPath = resolve(watch, "..", "notifier.applescript");
    writeFileSync(scriptPath, notifierScript(home), { mode: 0o600 });
    // osacompile refuses to overwrite an existing bundle, so a reinstall (a
    // second `failproofai config`, or an upgrade) has to clear it first.
    rmSync(app, { recursive: true, force: true });
    run("osacompile", ["-o", app, scriptPath]);
    rmSync(scriptPath, { force: true });

    // Give the bundle its own identity, so the banner is attributed to
    // failproofai instead of to whatever compiled it, and so the user gets one
    // entry in System Settings > Notifications they can turn off themselves.
    const plist = resolve(app, "Contents", "Info.plist");
    run("defaults", ["write", plist, "CFBundleIdentifier", MAC_NOTIFIER_LABEL]);
    run("defaults", ["write", plist, "CFBundleName", "failproofai"]);
    // `defaults write` leaves the file 0600 and owned by us but in binary
    // format; launchd and LaunchServices both read either, so no conversion.

    mkdirSync(resolve(macNotifierPlistPath(), ".."), { recursive: true });
    writeFileSync(macNotifierPlistPath(), notifierPlistContents(app, watch), { mode: 0o644 });

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
 * Remove the agent and the bundle.
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
  // The id becomes a filename in a watched directory. Same guard, same reason
  // as `markLeakNoticeDelivered` — see `isFindingId`.
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
  return existsSync(macNotifierPlistPath()) && existsSync(macNotifierAppPath(home));
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

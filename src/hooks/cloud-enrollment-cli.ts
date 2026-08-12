/**
 * `failproofai config --connect | --disconnect`, and the connection half of
 * `--status`.
 */
import {
  clearCloudCredentials,
  maskToken,
  readCloudCredentials,
  writeCloudCredentials,
  resolveMachineId,
  resolveMachineLabel,
  validateCloudUrl,
  verifyCloudCredentials,
  cloudCredentialPath,
} from "./cloud-enrollment";
import {
  daemonRestartCommand,
  daemonServiceStatus,
  daemonStatusCommand,
  daemonVersionSkew,
} from "./daemon-service";
import { clearActiveCloudManagedPolicies } from "./cloud-managed-policies";
import { deliveryHealth, deliveryHealthLine } from "./delivery-health";
import { readVersionFile, readCredentials } from "./fp-config";
import { version as cliVersion } from "../../package.json";
import { daemonSocketPresent } from "./daemon-client";
import {
  cloudBaseFor,
  configuredPaths,
  connectToCloud,
  describeOutcome,
} from "./cloud-connection";
import {
  clearIngestCredential,
  hasIngestCredential,
  readIngestCredential,
  validateIngestKey,
} from "./collector-config";
import { updateConfig } from "./fp-config";
import type { introspectKey } from "./cloud-introspect";

export interface ConnectOptions {
  url?: string;
  token?: string;
  machineId?: string;
  /** Human-facing display name for this machine. Defaults to the hostname. */
  machineLabel?: string;
  /**
   * The hostname, passed in by the caller (and injected by tests). Used as the
   * default machine *label*, no longer as the machine id — the id now mints or
   * reuses a stable key so two hosts with the same hostname never merge.
   */
  defaultMachineId?: string;
  /**
   * Send full session transcripts as well as hook decisions.
   *
   * DEFAULTS ON. A transcript carries prompts, file contents and whatever was
   * pasted into a terminal — which is precisely what makes a dashboard worth
   * connecting to, so hiding it behind an opt-in produced the empty-dashboard
   * problem in a different costume. `false` is the explicit opt-out; the
   * disclosure is printed either way.
   */
  sessions?: boolean;
  environment?: string;
  /**
   * Injected for tests so nothing reaches the network.
   *
   * All THREE must be here, and a new network call added below has to gain its
   * seam in the same commit: `introspect` was added without one, so every test
   * in `cloud-enrollment-cli.test.ts` silently began making a real request to
   * `be.failproof.ai`. It usually failed fast enough to pass, which is the worst
   * available outcome — the suite went intermittently red on network timing
   * rather than on anything a change had broken.
   */
  verify?: typeof verifyCloudCredentials;
  verifyIngest?: typeof validateIngestKey;
  introspect?: typeof introspectKey;
  daemonStatus?: () => ReturnType<typeof daemonServiceStatus>;
}

export interface CommandResult {
  exitCode: number;
  lines: string[];
}

/**
 * How a machine is named in CLI output: the human label, plus enough of the id to
 * tell two machines apart.
 *
 * The full uuid used to be printed in every status line — `Mac.localdomain
 * (dde01f39-afba-40eb-bf1a-815d9f17ac2d)` — which is 36 characters of noise for
 * the one reader who cannot use them, and it made the id look like the machine's
 * name. The id still has to appear: labels default to the hostname and are free to
 * collide, so the label alone cannot identify a machine. Eight hex characters
 * distinguish any realistic fleet while staying readable.
 *
 * `failproofai config --status --verbose` prints the full id for support.
 */
export function describeMachine(
  machineId: string,
  machineLabel?: string,
  full = false,
): string {
  if (!machineLabel || machineLabel === machineId) return machineId;
  return full ? `${machineLabel} (${machineId})` : `${machineLabel} (${machineId.slice(0, 8)})`;
}

/**
 * Warn rather than refuse when there is no daemon.
 *
 * Cloud policy is evaluated by failproofaid, so credentials alone pull
 * nothing — but refusing would break baking a machine image where the daemon
 * is installed later, and enrolment is genuinely independent of it. Say so
 * loudly instead of failing.
 */
function daemonWarning(status: ReturnType<typeof daemonServiceStatus>): string[] {
  if (status === "running") return [];
  // "I could not tell", NOT "it is not a service". This has its own branch, and it
  // is ahead of the socket check, because on macOS it is the COMMON case rather
  // than an edge one: a LaunchDaemon lives in launchd's system domain, so
  // `daemonServiceStatus()` needs elevation to read it and returns "unknown"
  // whenever `sudo -n` finds no cached credential — which is most of the time, for
  // a normal user running a read-only status command.
  //
  // With no branch of its own it fell through to the socket check below and
  // announced that the daemon was "running outside the service manager", which is
  // flatly false for a correctly installed service, and told the user to install
  // something they already had. Linux never showed it, because `systemctl
  // is-active` needs no privileges — that asymmetry was the whole of the bug.
  if (status === "unknown") {
    const check = daemonStatusCommand();
    return [
      "",
      ...(daemonSocketPresent()
        ? ["  A daemon is running and policy is being pulled."]
        : ["! No daemon is answering, so nothing is being pulled right now."]),
      "  Its service state needs elevation to read, so it is not shown above.",
      ...(check ? [`  Check it with: sudo ${check}`] : []),
    ];
  }
  // A daemon started by hand is invisible to the service manager but is
  // running and pulling. Telling someone whose machine is actively enforcing
  // that "nothing will be pulled" is false, and it is exactly the state a
  // developer testing locally is in.
  if (daemonSocketPresent()) {
    return [
      "",
      "  A daemon is running outside the service manager, so policy is being pulled.",
      "  Install it as a service to survive reboot and logout: failproofai config",
    ];
  }
  if (status === "unsupported-platform") {
    return [
      "",
      "! failproofaid does not run on this platform yet, so nothing will be pulled.",
      "  The credentials are stored and will work on a supported machine.",
    ];
  }
  if (status === "not-installed") {
    // "as a service", not "at all": this reads the service manager, so a daemon
    // someone is running by hand during development is reported as absent. The
    // wording has to be true in both cases.
    return [
      "",
      "! failproofaid is not installed as a service, so nothing will be pulled yet.",
      "  Install it with: failproofai config",
    ];
  }
  return [
    "",
    "! failproofaid is installed but not running, so nothing will be pulled yet.",
    "  Check it with: failproofai config --status",
  ];
}

export async function runConnectCommand(opts: ConnectOptions): Promise<CommandResult> {
  if (!opts.url) return { exitCode: 1, lines: ["--connect needs a URL, e.g. --connect https://be.failproof.ai"] };
  if (!opts.token) {
    return {
      exitCode: 1,
      lines: [
        "--connect needs a machine token: --token <key>",
        "",
        "Create an API key carrying only the `policies:pull` permission for this",
        "machine. Do not use an admin key.",
      ],
    };
  }

  // Accepts the ingest endpoint too. People paste what the older setup asked
  // for, or what is already in their `ingest.json`, and refusing a URL we can
  // read perfectly well is pedantry.
  const validated = validateCloudUrl(cloudBaseFor(opts.url));
  if (!validated.ok) return { exitCode: 1, lines: [validated.reason] };

  // The stable key: an explicit --machine-id wins, else the id already enrolled
  // here is reused (idempotent re-connect), else a fresh one is minted. Never
  // the hostname — that is the label, so same-hostname hosts do not merge.
  const machineId = resolveMachineId(opts.machineId);
  const machineLabel = resolveMachineLabel(opts.machineLabel ?? opts.defaultMachineId);
  // Humans read the label; the id is shown in parentheses only when it differs,
  // so an operator who set an explicit --machine-id still sees it.
  const shownAs = describeMachine(machineId, machineLabel);

  // ONE connection, both capabilities. Each is verified before anything is
  // written and reported on its own, because a key can carry `policies:pull`
  // without `events:add` and the useful message names which one is missing.
  const outcome = await connectToCloud({
    url: validated.url,
    token: opts.token,
    machineId,
    machineLabel,
    sessions: opts.sessions,
    environment: opts.environment,
    verifyPolicy: opts.verify,
    verifyIngest: opts.verifyIngest,
    introspect: opts.introspect,
  });

  if (!outcome.anyConfigured) {
    return { exitCode: 1, lines: describeOutcome(outcome, shownAs, validated.url) };
  }

  // The exit code tracks the PRIMARY purpose — enrolling this machine for
  // cloud-managed policy. Configuring the dashboard is worth doing and worth
  // reporting, but it must not turn a failed enrolment into a success: a fleet
  // provisioning script running `--connect … && …` has to stop when the machine
  // will not receive policy. The ingest credential still gets written, because
  // it works and discarding it helps nobody.
  const exitCode = outcome.policy.ok ? 0 : 1;

  const status = (opts.daemonStatus ?? daemonServiceStatus)();
  const paths = configuredPaths(outcome);
  const lines = [
    ...describeOutcome(outcome, shownAs, validated.url),
    `  Token ${maskToken(opts.token)} stored in ${paths.join(" and ")} (owner-only).`,
  ];
  if (outcome.ingest.ok) {
    // Stated on BOTH branches, never only on the surprising one. Connecting
    // sends transcripts by default — prompts, file contents, command output —
    // and a default that carries that much is one the user has to be told
    // about at the moment it takes effect, not left to find in --help.
    lines.push(
      opts.sessions === false
        ? "  Session transcripts are NOT being sent (--no-transcripts). Decisions only."
        : "  Sending policy decisions AND full session transcripts (prompts, file\n" +
          "  contents, command output). Use --no-transcripts for decisions only.",
    );
  }
  lines.push(...daemonWarning(status));

  return { exitCode, lines };
}

/**
 * Rename this machine without re-enrolling it.
 *
 * `--machine-label` was accepted only alongside `--connect`, so the sole way to
 * change a name was to re-run enrolment with the URL and token again — which reads
 * as a destructive operation for what is a display change, and which nobody with a
 * machine token to hand is going to do casually. The hostname default is a
 * suggestion (`resolveMachineLabel`), so renaming is the expected path, not an
 * exception.
 *
 * The label rides the desired-state request (`&label=`), which is also the check
 * that the credentials still work — so a rename verifies as a side effect. A
 * server that cannot be reached is NOT treated as failure: the label is stored
 * locally first and the daemon sends it on its next poll. Refusing to rename a
 * machine because the network is down would make this useless exactly when someone
 * is trying to label a machine they are debugging.
 */
export async function runRenameCommand(
  label: string | undefined,
  deps: { verify?: typeof verifyCloudCredentials } = {},
): Promise<CommandResult> {
  const trimmed = label?.trim();
  if (!trimmed) {
    return { exitCode: 1, lines: ["--machine-label needs a name, e.g. --machine-label \"Nikita's Mac\""] };
  }
  const creds = readCloudCredentials();
  if (!creds) {
    return {
      exitCode: 1,
      lines: [
        "This machine is not connected to FailproofAI Cloud, so it has no name to change.",
        "Connect it first: failproofai config --connect <url> --token <key>",
      ],
    };
  }
  if (creds.machineLabel === trimmed) {
    return { exitCode: 0, lines: [`This machine is already named ${describeMachine(creds.machineId, trimmed)}.`] };
  }

  const previous = creds.machineLabel;
  // Stored BEFORE the push, so a rename survives an unreachable server.
  writeCloudCredentials({ ...creds, machineLabel: trimmed });

  const verify = deps.verify ?? verifyCloudCredentials;
  const result = await verify({ ...creds, machineLabel: trimmed });

  const lines = [
    previous
      ? `Renamed ${previous} to ${describeMachine(creds.machineId, trimmed)}.`
      : `Named this machine ${describeMachine(creds.machineId, trimmed)}.`,
  ];
  if (!result.ok) {
    lines.push(
      "",
      `! The new name is stored but ${creds.url} could not be told: ${result.reason}`,
      "  The daemon sends it on its next poll, so the dashboard catches up on its own.",
    );
  }
  // Exit 0 either way: the rename DID happen locally, and reporting failure for a
  // stored change would send the user round again to redo something that is done.
  return { exitCode: 0, lines };
}

export function runDisconnectCommand(): CommandResult {
  const existing = readCloudCredentials();
  const hadIngest = hasIngestCredential();
  const removed = clearCloudCredentials();
  // Disconnect means disconnect. Clearing only the policy credential would
  // leave the machine still shipping activity to a cloud the user believes
  // they have left — the one outcome nobody expects from this command.
  const removedIngest = clearIngestCredential();
  // Stop ENFORCING them too, not merely refreshing them. Clearing the
  // credential ends the daemon's polling; every artifact already on disk stayed
  // referenced by `active.json` and kept being loaded on every tool call — so a
  // machine that had deliberately left its organisation went on being governed
  // by whatever deployment was current when it left, indefinitely, while
  // `--status` reported it as unconnected.
  const stoppedManaged = clearActiveCloudManagedPolicies();
  // Back to OSS. Leaving mode = "cloud" with no credentials would describe a
  // machine that does not exist, and every cloud code path keys off this flag
  // rather than off "is a token lying around" precisely so that a disconnected
  // machine is provably silent instead of silent-by-happenstance.
  updateConfig({ mode: "oss" });

  if (!removed && !existing && !hadIngest && !stoppedManaged) {
    return { exitCode: 0, lines: ["This machine is not connected to FailproofAI Cloud."] };
  }

  const lines = [
    "Disconnected from FailproofAI Cloud.",
    "",
    stoppedManaged
      ? "  Cloud-managed policies stop being enforced and stop being refreshed.\n" +
        "  Local builtin, custom and convention policies are unaffected."
      : "  Local builtin, custom and convention policies are unaffected.",
  ];
  if (removedIngest) {
    // Named honestly. The collector manager starts once for the daemon's
    // lifetime (`main.rs`) and the uploader caches its bearer key at
    // construction, so nothing already running notices this file disappear —
    // "stop being sent" was true only of the NEXT daemon start. Telling the
    // user the step that makes it true beats a claim that quietly is not.
    lines.push(
      "  No new hook activity or transcripts will be queued. A running failproofaid",
      "  keeps the key it started with, so restart it to stop the current process",
      `  sending: ${daemonRestartCommand() ?? "restart failproofaid"}`,
    );
  }
  return { exitCode: 0, lines };
}

/** The connection half of `--status`. Never prints the token. */
/**
 * The version line for `--status`.
 *
 * First thing worth knowing in a bug report, and the only place a user can
 * currently find out which daemon they are running without listing a directory.
 */
export function versionStatusLines(): string[] {
  const skew = daemonVersionSkew();
  const recorded = readVersionFile();
  const daemon = recorded?.daemon ?? "not installed";
  return [
    `CLI ${cliVersion} · daemon ${daemon}${skew ? " (STALE)" : ""} · layout ${recorded?.layout ?? "-"}`,
    ...(skew ? ["  Run `failproofai config` to update the daemon."] : []),
  ];
}

export function connectionStatusLines(
  daemonStatus = daemonServiceStatus,
  /** Print the full machine id rather than a short prefix. */
  verbose = false,
): string[] {
  const envUrl = process.env.FAILPROOFAI_CLOUD_URL;
  if (envUrl) {
    // Env wins over the file in the daemon, so reporting the file here would
    // describe a configuration that is not in effect.
    return [
      `Cloud: configured by environment (${envUrl}), which takes precedence over ${cloudCredentialPath()}.`,
    ];
  }
  const creds = readCloudCredentials();
  const ingest = readIngestCredential();

  // Reported as ONE connection with two capabilities. A machine sending
  // activity but pulling no policy, or the reverse, is a state worth seeing at
  // a glance — it is exactly the half-configured case this command exists to
  // catch, and two unrelated lines made it easy to miss.
  if (!creds && !ingest) return ["Cloud: not connected."];

  // Recorded at connect time from the server's own answer, never guessed from
  // the URL: one deployment hosts many orgs, so the host says nothing about
  // which one this machine's data lands in. Absent against a server with no
  // introspect endpoint, and on credentials written before this was recorded —
  // in both cases the line is simply omitted rather than guessed at.
  const org = readCredentials().org;
  const orgLine = org
    ? org.name && org.slug
      ? `${org.name} (${org.slug})`
      : (org.name ?? org.slug ?? org.id)
    : undefined;

  const lines: string[] = [];
  if (creds) {
    // Label first, with a short id to disambiguate; the bare id is the fallback
    // for credentials written before labels existed.
    const shownAs = describeMachine(creds.machineId, creds.machineLabel, verbose);
    lines.push(`Cloud: connected to ${creds.url} as ${shownAs} (token ${maskToken(creds.token)}).`);
    lines.push(`  Policy    pulling centrally-managed policies.`);
  } else {
    lines.push(`Cloud: connected to ${cloudBaseFor(ingest!.url)} for reporting only.`);
    lines.push(`  Policy    NOT pulling — this machine enforces only its local policies.`);
  }

  if (orgLine) lines.push(`  Org       ${orgLine}`);

  if (ingest) {
    // Everything above this line is read from the credential FILE, which
    // records what was true at `--connect` time and is never revisited. A key
    // that has since been revoked, expired, or had its org disabled leaves that
    // file byte-for-byte correct while nothing arrives — which is how a machine
    // reported "connected" for twenty minutes with 26 refused batches on disk
    // (see `crates/failproofaid/src/main.rs`). The collector's own record of
    // what the server actually said is the only thing here that describes NOW,
    // so it overrides the cheerful line rather than being appended after it.
    const health = deliveryHealth();
    const rejection = deliveryHealthLine(health);
    if (rejection) {
      lines.push(`  Dashboard ${rejection}`);
    } else {
      lines.push(`  Dashboard sending hook activity to ${ingest.url}.`);
    }
  } else {
    lines.push(`  Dashboard NOT sending — nothing from this machine appears in the dashboard.`);
    lines.push(`            Re-run: failproofai config --connect ${creds!.url} --token <key>`);
  }

  lines.push(...daemonWarning(daemonStatus()).map((l) => (l === "" ? "" : `  ${l.trim()}`)));
  return lines;
}

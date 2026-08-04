/**
 * `failproofai config --connect | --disconnect`, and the connection half of
 * `--status`.
 */
import {
  clearCloudCredentials,
  maskToken,
  readCloudCredentials,
  validateCloudUrl,
  verifyCloudCredentials,
  writeCloudCredentials,
  cloudCredentialPath,
} from "./cloud-enrollment";
import { daemonServiceStatus } from "./daemon-service";
import { daemonSocketPresent } from "./daemon-client";
import {
  cloudBaseFor,
  configuredPaths,
  connectToCloud,
  describeOutcome,
  ingestUrlFor,
} from "./cloud-connection";
import {
  clearIngestCredential,
  hasIngestCredential,
  readIngestCredential,
  validateIngestKey,
} from "./collector-config";
import { updateConfig } from "./fp-config";

export interface ConnectOptions {
  url?: string;
  token?: string;
  machineId?: string;
  /** Defaults to the hostname; injected for tests. */
  defaultMachineId?: string;
  /**
   * Send full session transcripts as well as hook decisions. Off unless asked
   * for: a transcript carries prompts, file contents and whatever was pasted
   * into a terminal, so it can never be a side effect of connecting.
   */
  sessions?: boolean;
  environment?: string;
  /** Injected for tests so nothing reaches the network. */
  verify?: typeof verifyCloudCredentials;
  verifyIngest?: typeof validateIngestKey;
  daemonStatus?: () => ReturnType<typeof daemonServiceStatus>;
}

export interface CommandResult {
  exitCode: number;
  lines: string[];
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

  const machineId = (opts.machineId ?? opts.defaultMachineId ?? "").trim();
  if (!machineId) {
    return { exitCode: 1, lines: ["Could not determine a machine id — pass one with --machine-id <id>."] };
  }

  // ONE connection, both capabilities. Each is verified before anything is
  // written and reported on its own, because a key can carry `policies:pull`
  // without `events:add` and the useful message names which one is missing.
  const outcome = await connectToCloud({
    url: validated.url,
    token: opts.token,
    machineId,
    sessions: opts.sessions,
    environment: opts.environment,
    verifyPolicy: opts.verify,
    verifyIngest: opts.verifyIngest,
  });

  if (!outcome.anyConfigured) {
    return { exitCode: 1, lines: describeOutcome(outcome, machineId, validated.url) };
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
    ...describeOutcome(outcome, machineId, validated.url),
    `  Token ${maskToken(opts.token)} stored in ${paths.join(" and ")} (owner-only).`,
  ];
  if (outcome.ingest.ok && opts.sessions !== true) {
    // Said out loud rather than left as a default: someone who wanted
    // transcripts should not discover months later that none were sent.
    lines.push("  Session transcripts are NOT being sent. Add --send-transcripts to include them.");
  }
  lines.push(...daemonWarning(status));

  return { exitCode, lines };
}

export function runDisconnectCommand(): CommandResult {
  const existing = readCloudCredentials();
  const hadIngest = hasIngestCredential();
  const removed = clearCloudCredentials();
  // Disconnect means disconnect. Clearing only the policy credential would
  // leave the machine still shipping activity to a cloud the user believes
  // they have left — the one outcome nobody expects from this command.
  const removedIngest = clearIngestCredential();
  // Back to OSS. Leaving mode = "cloud" with no credentials would describe a
  // machine that does not exist, and every cloud code path keys off this flag
  // rather than off "is a token lying around" precisely so that a disconnected
  // machine is provably silent instead of silent-by-happenstance.
  updateConfig({ mode: "oss" });

  if (!removed && !existing && !hadIngest) {
    return { exitCode: 0, lines: ["This machine is not connected to Failproof Cloud."] };
  }

  const lines = [
    "Disconnected from Failproof Cloud.",
    "",
    "  Cloud-managed policies already on disk stop being refreshed. Local",
    "  builtin, custom and convention policies are unaffected.",
  ];
  if (removedIngest) {
    lines.push("  Hook activity and transcripts stop being sent.");
  }
  return { exitCode: 0, lines };
}

/** The connection half of `--status`. Never prints the token. */
export function connectionStatusLines(daemonStatus = daemonServiceStatus): string[] {
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

  const lines: string[] = [];
  if (creds) {
    lines.push(`Cloud: connected to ${creds.url} as ${creds.machineId} (token ${maskToken(creds.token)}).`);
    lines.push(`  Policy    pulling centrally-managed policies.`);
  } else {
    lines.push(`Cloud: connected to ${cloudBaseFor(ingest!.url)} for reporting only.`);
    lines.push(`  Policy    NOT pulling — this machine enforces only its local policies.`);
  }

  if (ingest) {
    lines.push(`  Dashboard sending hook activity to ${ingest.url}.`);
  } else {
    lines.push(`  Dashboard NOT sending — nothing from this machine appears in the dashboard.`);
    lines.push(`            Re-run: failproofai config --connect ${creds!.url} --token <key>`);
  }

  lines.push(...daemonWarning(daemonStatus()).map((l) => (l === "" ? "" : `  ${l.trim()}`)));
  return lines;
}

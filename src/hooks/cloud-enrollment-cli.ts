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

export interface ConnectOptions {
  url?: string;
  token?: string;
  machineId?: string;
  /** Defaults to the hostname; injected for tests. */
  defaultMachineId?: string;
  /** Injected for tests so nothing reaches the network. */
  verify?: typeof verifyCloudCredentials;
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

  const validated = validateCloudUrl(opts.url);
  if (!validated.ok) return { exitCode: 1, lines: [validated.reason] };

  const machineId = (opts.machineId ?? opts.defaultMachineId ?? "").trim();
  if (!machineId) {
    return { exitCode: 1, lines: ["Could not determine a machine id — pass one with --machine-id <id>."] };
  }

  const creds = { url: validated.url, machineId, token: opts.token };
  const verify = opts.verify ?? verifyCloudCredentials;
  const result = await verify(creds);
  if (!result.ok) {
    // Nothing is written on a failed check: a stored credential that does not
    // work is worse than none, because `--status` would then report a
    // connection this machine does not have.
    return { exitCode: 1, lines: [`Could not connect: ${result.reason}`] };
  }

  writeCloudCredentials(creds);
  const status = (opts.daemonStatus ?? daemonServiceStatus)();

  return {
    exitCode: 0,
    lines: [
      `Connected to ${creds.url} as ${machineId}.`,
      `  ${result.policyCount} polic${result.policyCount === 1 ? "y" : "ies"} assigned (generation ${result.generation}).`,
      `  Token ${maskToken(creds.token)} stored in ${cloudCredentialPath()} (owner-only).`,
      ...daemonWarning(status),
    ],
  };
}

export function runDisconnectCommand(): CommandResult {
  const existing = readCloudCredentials();
  const removed = clearCloudCredentials();
  if (!removed && !existing) return { exitCode: 0, lines: ["This machine is not connected to Failproof Cloud."] };
  return {
    exitCode: 0,
    lines: [
      "Disconnected from Failproof Cloud.",
      "",
      "  Cloud-managed policies already on disk stop being refreshed. Local",
      "  builtin, custom and convention policies are unaffected.",
    ],
  };
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
  if (!creds) return ["Cloud: not connected."];
  return [
    `Cloud: connected to ${creds.url} as ${creds.machineId} (token ${maskToken(creds.token)}).`,
    ...daemonWarning(daemonStatus()).map((l) => (l === "" ? "" : `  ${l.trim()}`)),
  ];
}

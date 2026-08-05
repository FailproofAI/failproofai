/**
 * `failproofai config --connect | --disconnect`, and the connection half of
 * `--status`.
 */
import {
  clearCloudCredentials,
  maskToken,
  readCloudCredentials,
  resolveMachineId,
  resolveMachineLabel,
  validateCloudUrl,
  verifyCloudCredentials,
  writeCloudCredentials,
  cloudCredentialPath,
} from "./cloud-enrollment";
import { daemonServiceStatus, daemonVersionSkew } from "./daemon-service";
import { readVersionFile, readCredentials } from "./fp-config";
import { version as cliVersion } from "../../package.json";
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

  // The stable key: an explicit --machine-id wins, else the id already enrolled
  // here is reused (idempotent re-connect), else a fresh one is minted. Never
  // the hostname — that is the label, so same-hostname hosts do not merge.
  const machineId = resolveMachineId(opts.machineId);
  const machineLabel = resolveMachineLabel(opts.machineLabel ?? opts.defaultMachineId);
  // Humans read the label; the id is shown in parentheses only when it differs,
  // so an operator who set an explicit --machine-id still sees it.
  const shownAs = machineLabel === machineId ? machineId : `${machineLabel} (${machineId})`;

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
    // Show the human label with the stable id in parentheses; fall back to the
    // bare id for credentials written before labels existed.
    const shownAs = creds.machineLabel
      ? `${creds.machineLabel} (${creds.machineId})`
      : creds.machineId;
    lines.push(`Cloud: connected to ${creds.url} as ${shownAs} (token ${maskToken(creds.token)}).`);
    lines.push(`  Policy    pulling centrally-managed policies.`);
  } else {
    lines.push(`Cloud: connected to ${cloudBaseFor(ingest!.url)} for reporting only.`);
    lines.push(`  Policy    NOT pulling — this machine enforces only its local policies.`);
  }

  if (orgLine) lines.push(`  Org       ${orgLine}`);

  if (ingest) {
    lines.push(`  Dashboard sending hook activity to ${ingest.url}.`);
  } else {
    lines.push(`  Dashboard NOT sending — nothing from this machine appears in the dashboard.`);
    lines.push(`            Re-run: failproofai config --connect ${creds!.url} --token <key>`);
  }

  lines.push(...daemonWarning(daemonStatus()).map((l) => (l === "" ? "" : `  ${l.trim()}`)));
  return lines;
}

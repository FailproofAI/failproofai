/**
 * Shared CLI argument parser for scripts/dev.ts and scripts/start.ts.
 */
import { resolve } from "path";

export interface ParsedScriptArgs {
  loggingLevel: string | undefined;
  disableTelemetry: boolean;
  allowedDevOrigins: string[] | undefined;
  /**
   * Interface to bind the dashboard to. Undefined means the safe default
   * (loopback) — see `resolveDashboardHost` in launch.ts. Only set this to a
   * non-loopback address deliberately: the dashboard has no authentication and
   * is a WRITE surface for this machine's security configuration.
   */
  host: string | undefined;
  remainingArgs: string[];
}

function parseStringFlag(
  flagName: string,
  errorLabel: string,
  inlineValue: string | null,
  args: string[],
  index: number,
  options?: { resolve?: boolean },
): { value: string; spliceCount: number } {
  const raw = inlineValue ?? args[index + 1];
  if (raw === undefined || (inlineValue === null && raw.startsWith("-"))) {
    console.error(`Error: ${flagName} requires ${errorLabel}`);
    process.exit(1);
  }
  const value = options?.resolve ? resolve(raw) : raw;
  return { value, spliceCount: inlineValue !== null ? 1 : 2 };
}

export function parseScriptArgs(argv: string[]): ParsedScriptArgs {
  const args = [...argv];
  let loggingLevel: string | undefined;
  let disableTelemetry = false;
  let allowedDevOrigins: string[] | undefined;
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const inlineValue = eqIdx >= 0 ? arg.slice(eqIdx + 1) : null;

    if (flag === "--logging") {
      const raw = inlineValue ?? args[i + 1];
      if (raw === undefined || (inlineValue === null && raw.startsWith("-"))) {
        console.error("Error: --logging requires a level (info, warn, error)");
        process.exit(1);
      }
      const val = raw.toLowerCase();
      if (val !== "info" && val !== "warn" && val !== "error") {
        console.error("Error: --logging must be one of: info, warn, error");
        process.exit(1);
      }
      loggingLevel = val;
      args.splice(i, inlineValue !== null ? 1 : 2);
      i--;
      continue;
    }

    if (flag === "--disable-telemetry") {
      disableTelemetry = true;
      args.splice(i, 1);
      i--;
      continue;
    }

    if (flag === "--allowed-origins") {
      const { value, spliceCount } = parseStringFlag(flag, "a comma-separated list of origins", inlineValue, args, i);
      allowedDevOrigins = value.split(",").map(s => s.trim()).filter(Boolean);
      args.splice(i, spliceCount);
      i--;
      continue;
    }

    // `-H` / `--hostname` are Next's own spellings of this, and `bun run dev`
    // passes unrecognised arguments straight through to `next dev`. Capturing
    // only `--host` meant a raw `-H 0.0.0.0` fell into `remainingArgs`: Next
    // bound the wildcard, while `bindHost` kept the loopback default and
    // `FAILPROOFAI_DASHBOARD_HOST=127.0.0.1` told `proxy.ts` it was on
    // loopback. It then enforced a Host-header pin — which a raw network
    // client forges trivially, unlike a browser — against a server genuinely
    // reachable from the network, and skipped the no-Origin refusal that is
    // the real defence for that bind. The two must agree, so all three
    // spellings resolve to the same value.
    if (flag === "--host" || flag === "-H" || flag === "--hostname") {
      const { value, spliceCount } = parseStringFlag(flag, "an address to bind (e.g. 127.0.0.1)", inlineValue, args, i);
      host = value;
      args.splice(i, spliceCount);
      i--;
      continue;
    }
  }

  return { loggingLevel, disableTelemetry, allowedDevOrigins, host, remainingArgs: args };
}

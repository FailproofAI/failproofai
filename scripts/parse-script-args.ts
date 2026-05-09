/**
 * Shared CLI argument parser for scripts/dev.ts and scripts/start.ts.
 */
import { resolve } from "path";

export interface ParsedScriptArgs {
  loggingLevel: string | undefined;
  disableTelemetry: boolean;
  allowedDevOrigins: string[] | undefined;
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
  }

  return { loggingLevel, disableTelemetry, allowedDevOrigins, remainingArgs: args };
}

/**
 * Shared ANSI/color policy for CLI output.
 *
 * Priority:
 * 1) `NO_COLOR` or `--no-color` disables color.
 * 2) `FORCE_COLOR` enables color.
 * 3) Otherwise require a TTY.
 */

type StreamLike = { isTTY?: boolean };

function hasNoColorFlag(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--no-color");
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off";
}

export function isColorEnabled(stream: StreamLike = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  if (hasNoColorFlag()) return false;
  if (isTruthy(process.env.FORCE_COLOR)) return true;
  return stream.isTTY === true;
}

function wrap(code: string, text: string, enabled: boolean): string {
  return enabled ? `\x1B[${code}m${text}\x1B[0m` : text;
}

export interface CliStyler {
  enabled: boolean;
  dim(text: string): string;
  bold(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  magenta(text: string): string;
  reverse(text: string): string;
}

export function createCliStyler(stream: StreamLike = process.stdout): CliStyler {
  const enabled = isColorEnabled(stream);
  return {
    enabled,
    dim: (text) => wrap("2", text, enabled),
    bold: (text) => wrap("1", text, enabled),
    yellow: (text) => wrap("33", text, enabled),
    cyan: (text) => wrap("36", text, enabled),
    green: (text) => wrap("32", text, enabled),
    magenta: (text) => wrap("35", text, enabled),
    reverse: (text) => wrap("7", text, enabled),
  };
}

export function createCursorController(stream: NodeJS.WriteStream = process.stdout): {
  hide: () => void;
  show: () => void;
  dispose: () => void;
} {
  const enabled = isColorEnabled(stream) && stream.isTTY === true;
  let hidden = false;
  const show = (): void => {
    if (!enabled || !hidden) return;
    stream.write("\x1B[?25h");
    hidden = false;
  };
  const onExit = (): void => {
    show();
  };
  process.on("exit", onExit);
  return {
    hide: (): void => {
      if (!enabled || hidden) return;
      stream.write("\x1B[?25l");
      hidden = true;
    },
    show,
    dispose: (): void => {
      show();
      process.removeListener("exit", onExit);
    },
  };
}


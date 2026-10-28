/**
 * POSIX single-quoting: everything is literal inside '…', and a literal quote
 * is closed, escaped and reopened. For every path this package puts into a
 * shell command — the service's worker command, and the recipes printed for
 * someone to run as root when the install or uninstall could not elevate.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

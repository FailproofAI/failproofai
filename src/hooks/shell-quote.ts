/**
 * POSIX single-quoting: everything is literal inside '…', and a literal quote
 * is closed, escaped and reopened. For every path this package puts into a
 * shell command — the service's worker command, and the recipes printed for
 * someone to run as root when the install or uninstall could not elevate.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The words of a command built from {@link shellQuote}d parts, unquoted. Only
 * that shape is understood; anything else (an operator's own
 * `FAILPROOFAI_WORKER_CMD`) returns null, and callers leave it alone.
 */
export function shellQuotedWords(command: string): string[] | null {
  const words: string[] = [];
  const re = /\s*'((?:[^']|'\\'')*)'(?=\s|$)/y;
  let match: RegExpExecArray | null;
  while (re.lastIndex < command.length && (match = re.exec(command))) {
    words.push(match[1].replace(/'\\''/g, "'"));
  }
  return words.length > 0 && command.slice(re.lastIndex).trim() === "" ? words : null;
}

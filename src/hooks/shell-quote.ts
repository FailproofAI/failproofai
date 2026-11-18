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
  // Kept apart from `re.lastIndex`, which a failed sticky match resets to 0:
  // a trailing space after the last word then read as "nothing matched".
  let end = 0;
  let match: RegExpExecArray | null;
  while (end < command.length && (match = re.exec(command))) {
    words.push(match[1].replace(/'\\''/g, "'"));
    end = re.lastIndex;
  }
  return words.length > 0 && command.slice(end).trim() === "" ? words : null;
}

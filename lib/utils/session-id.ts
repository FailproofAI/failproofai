/**
 * Extracts the base session ID by removing the part after the first slash.
 * @param sessionId - The full session ID string.
 * @returns The base session ID without the trailing part.
 */
export function baseSessionId(sessionId: string): string {
  const slashIdx = sessionId.indexOf("/");
  return slashIdx === -1 ? sessionId : sessionId.slice(0, slashIdx);
}

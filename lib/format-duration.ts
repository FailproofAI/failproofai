/**
 * Formats a duration in milliseconds to a compact human-readable string.
 * Handles sub-second ("42ms"), seconds ("3.2s"), minutes ("5m 12s"),
 * and hours ("2h 15m").
 *
 * This module is intentionally free of Node.js imports so it can be
 * safely used in both server and client components.
 */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  const roundedTenths = Math.round(seconds * 10) / 10;
  if (roundedTenths < 60) return `${roundedTenths.toFixed(1)}s`;
  const roundedSeconds = Math.round(seconds);
  const totalMinutes = Math.floor(roundedSeconds / 60);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  const remainingSeconds = roundedSeconds % 60;
  return `${totalMinutes}m ${remainingSeconds}s`;
}

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

  // Round to the precision the output will actually use, then bucket.
  // Seconds are shown with one decimal place, so round to the nearest 0.1 s
  // before deciding whether we have crossed into the minute range.
  const deciseconds = Math.round(ms / 100);
  if (deciseconds < 600) {
    return `${(deciseconds / 10).toFixed(1)}s`;
  }

  // Minutes are shown with whole seconds, so round to the nearest second
  // before splitting into minutes and seconds.
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  // Hours are shown with whole minutes, so round to the nearest minute
  // before splitting into hours and minutes.
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

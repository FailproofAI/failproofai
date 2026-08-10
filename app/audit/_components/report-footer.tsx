"use client";

interface Props {
  cachedAt: string | null;
  fixed?: boolean;
}

function formatUtcShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const day = d.getUTCDate().toString().padStart(2, "0");
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const m = monthNames[d.getUTCMonth()];
  const y = d.getUTCFullYear();
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${day} ${m} ${y}, ${hh}:${mm} utc`;
}

export function ReportFooter({ cachedAt, fixed = false }: Props) {
  return (
    <footer className={fixed ? "report-footer report-footer--fixed" : "report-footer"}>
      <img src="/logo.svg" alt="failproof_ai" style={{ height: 18, display: "inline-block", verticalAlign: "middle" }} />
      <span style={{ margin: "0 12px", color: "var(--line-2)" }}>·</span>
      audit v1.0
      <span style={{ margin: "0 12px", color: "var(--line-2)" }}>·</span>
      generated {formatUtcShort(cachedAt)}
      <span style={{ margin: "0 12px", color: "var(--line-2)" }}>·</span>
      <span style={{ color: "var(--ink-2)" }}>auto-healing for your agents.</span>
    </footer>
  );
}

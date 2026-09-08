"use client";

/**
 * The leak report: every credential this machine found in its own transcripts.
 *
 * This is what replaced the persona poster and the five scored sections. The
 * old report answered "what kind of agent user are you"; this one answers the
 * only question a leaked key raises — what is it, where did it go, how did it
 * get there, and what do I do now.
 *
 * Each row is one DISTINCT credential, not one sighting: a key pasted into
 * forty commands is one thing to rotate, not forty. The count of exposures is a
 * column, which is the honest way to show forty without implying forty problems.
 */
import { useCallback, useEffect, useState } from "react";
import {
  dismissLeakAction,
  getLeaksAction,
  setLeakNotifyAction,
  type LeakRow,
} from "@/app/actions/get-leaks";

/** Rendered in the reader's timezone, which is why it is not done server-side. */
function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * What to actually do about this one.
 *
 * Two genuinely different situations, and conflating them is what makes
 * security advice useless. A recognised prefix means a console exists and the
 * key can be revoked there in a minute. An unattributed value — the majority,
 * per the pattern census — has no console at all: the only move is to find
 * where it came from, and the identifier name is usually the only clue.
 */
function advice(row: LeakRow): string {
  if (row.attributed) return `rotate it in the ${row.label.replace(/ (API )?(key|token).*$/i, "")} console`;
  if (row.name) return `find what reads ${row.name}, then rotate it there`;
  return "trace it to its owner, then rotate it";
}

export function LeakSection() {
  const [rows, setRows] = useState<LeakRow[] | null>(null);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const payload = await getLeaksAction();
    setRows(payload.rows);
    setNotify(payload.notify);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        // Optimism would be wrong here: a dismissal that did not persist means
        // the row comes back on the next load, and the user has to guess which
        // of the two states is real.
        if (await dismissLeakAction(id)) setRows((prev) => prev?.filter((r) => r.id !== id) ?? null);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const toggleNotify = useCallback(async () => {
    const next = !notify;
    setNotify(next);
    if (!(await setLeakNotifyAction(next))) setNotify(!next);
  }, [notify]);

  if (rows === null) return null;

  return (
    <section className="audit-sec" data-screen-label="02 Leaks">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">02</span>{"// credentials"}
        </span>
        <button
          type="button"
          className="cbb-toggle leak-notify"
          data-on={notify}
          onClick={toggleNotify}
          aria-label={notify ? "turn desktop notifications off" : "turn desktop notifications on"}
          title="desktop notification when a new credential is found"
        >
          <span className="cbb-toggle-knob" />
        </button>
      </div>

      {rows.length === 0 ? (
        <>
          <h2 className="audit-sec-title">no credentials found</h2>
          <div className="audit-sec-sub">
            {"// nothing in this machine's transcripts matched a known key format"}
            <br />
            {"// or a secret-named assignment."}
          </div>
        </>
      ) : (
        <>
          <h2 className="audit-sec-title">
            {rows.length} credential{rows.length === 1 ? "" : "s"} in your transcripts
          </h2>
          <div className="audit-sec-sub">
            {"// one row per distinct key — an exposure count is not a key count."}
          </div>

          <ul className="leak-list">
            {rows.map((row) => (
              <li key={row.id} className="leak-row" data-attributed={row.attributed}>
                <div className="leak-row-top">
                  <code className="leak-key">{row.display}</code>
                  <span className="leak-label">{row.label}</span>
                  {row.name ? <span className="leak-name">{row.name}</span> : null}
                  <button
                    type="button"
                    className="leak-dismiss"
                    onClick={() => void dismiss(row.id)}
                    disabled={busy === row.id}
                  >
                    not a secret
                  </button>
                </div>

                {/* The 5W1H, as one sentence rather than a grid of labelled
                    cells — a person reading a leak wants the story, and the
                    grid version made every row look like a form to fill in. */}
                <div className="leak-how">
                  <span className="leak-verb">{row.mechanism}</span>
                  {" in "}
                  <span className="leak-where">{row.project}</span>
                  {" via "}
                  <span className="leak-who">{row.cli}</span>
                  {" · "}
                  <span className="leak-when">{when(row.lastSeen)}</span>
                </div>

                <div className="leak-foot">
                  <span className="leak-meta">
                    {row.occurrences} exposure{row.occurrences === 1 ? "" : "s"}
                    {row.sessions > 1 ? ` · ${row.sessions} sessions` : ""}
                    {" · "}
                    {row.length} chars
                  </span>
                  {/* The direction is the difference between a leak a gate can
                      stop next time and one it cannot. An input travelled OUT
                      of the machine with the agent's request; a result came
                      back INTO the transcript from a file or a command, where
                      no PreToolUse hook can intercept it. */}
                  <span className="leak-dir">
                    {row.direction === "input"
                      ? "sent by the agent — blockable at PreToolUse"
                      : "returned to the agent — already in the transcript"}
                  </span>
                  <span className="leak-fix">{advice(row)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

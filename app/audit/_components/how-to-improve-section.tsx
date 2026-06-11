"use client";

/**
 * Section 04 — HOW TO IMPROVE. "install or configure."
 *
 * Calm fix-card list. Each card: title (`install <slug>`), what it
 * blocks, install command (`$ failproofai policy add <slug>`), and an
 * install button. Maps detector hits + unenabled-builtin hits onto the
 * smallest set of prescribed policies that closes the slipping-through
 * window — same logic the old PoliciesSection used, in a calmer shell.
 */
import React, { useMemo, useState } from "react";
import type { AuditResult } from "@/src/audit/types";
import { type Grade, tierName } from "@/src/audit/scoring";
import { usePostHog } from "@/contexts/PostHogContext";

interface Props {
  result: AuditResult;
  projected: number;
  projectedGrade: Grade;
}

const DETECTOR_TO_PRIMARY_POLICY: Record<string, string> = {
  "redundant-cd-cwd":          "warn-repeated-tool-calls",
  "prefer-edit-over-read-cat": "block-read-outside-cwd",
  "prefer-edit-over-sed-awk":  "warn-repeated-tool-calls",
  "prefer-write-over-heredoc": "block-env-files",
  "sleep-polling-loop":        "warn-background-process",
  "find-from-root":            "block-read-outside-cwd",
  "git-commit-no-verify":      "warn-git-amend",
  "reread-after-edit":         "warn-repeated-tool-calls",
};

const POLICY_DESC: Record<string, string> = {
  "warn-repeated-tool-calls": "warns when the same tool is called 3+ times with identical parameters — catches the loops before they spiral.",
  "block-read-outside-cwd":   "denies any file read whose absolute path falls outside the project root, including symlinks.",
  "block-env-files":          "blocks reads and writes of `.env` files at the tool layer.",
  "block-secrets-write":      "blocks writes to .pem, id_rsa, credentials.json, and other secret-key files.",
  "warn-background-process":  "warns before starting nohup / & / screen / tmux / disown processes that get forgotten about.",
  "warn-git-amend":           "warns before amending git commits — dangerous-commit-flag class.",
  "require-ci-green-before-stop": "requires CI checks to pass on HEAD before the agent declares the task done.",
};

function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

interface FixCard {
  name: string;
  desc: string;
  hits: number;
  projects: number;
  viaList: string[];
}

function buildFixes(result: AuditResult): FixCard[] {
  const enabledSet = new Set(result.enabledBuiltinNames ?? []);
  const buckets = new Map<string, { hits: number; projects: number; sources: Set<string> }>();

  for (const row of result.results) {
    if (row.hits === 0) continue;

    let target: string;
    let isFromDetector = false;
    if (row.source === "audit-detector") {
      const mapped = DETECTOR_TO_PRIMARY_POLICY[shortName(row.name)];
      if (!mapped) continue;
      target = mapped;
      isFromDetector = true;
    } else if (row.source === "builtin" && !row.enabledInConfig) {
      target = shortName(row.name);
    } else {
      continue;
    }

    if (enabledSet.has(target)) continue;

    const bucket = buckets.get(target) ?? { hits: 0, projects: 0, sources: new Set() };
    bucket.hits += row.hits;
    bucket.projects = Math.max(bucket.projects, row.projects);
    bucket.sources.add(isFromDetector ? shortName(row.name) : "self");
    buckets.set(target, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[1].hits - a[1].hits)
    .map(([name, b]) => ({
      name,
      desc: POLICY_DESC[name] ?? "enable this builtin policy to close the gap.",
      hits: b.hits,
      projects: b.projects,
      viaList: [...b.sources].filter((s) => s !== "self"),
    }));
}

export function HowToImproveSection({ result, projected, projectedGrade }: Props) {
  const fixes = useMemo(() => buildFixes(result), [result]);
  if (fixes.length === 0) return null;

  return (
    <section className="audit-sec" data-screen-label="04 How to improve">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">04</span>{"// how to improve"}
        </span>
        <span className="audit-sec-meta">
          enable all {fixes.length === 1 ? "one" : fixes.length} → projected{" "}
          <strong>{projected}</strong> · {tierName(projectedGrade).toLowerCase()}
        </span>
      </div>
      <h2 className="audit-sec-title">install or configure</h2>

      <div className="fix-list">
        {fixes.map((f, i) => (
          <FixRow key={f.name} fix={f} idx={i} />
        ))}
      </div>
    </section>
  );
}

function FixRow({ fix, idx }: { fix: FixCard; idx: number }) {
  const { capture } = usePostHog();
  const [copied, setCopied] = useState(false);
  const install = `failproof policy add ${fix.name}`;
  const quirkRef = `quirk #${idx + 1}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(install);
      setCopied(true);
      capture("audit_copy_clicked", {
        source: "how_to_improve_section",
        item_type: "single_policy_install_command",
        policy_name: fix.name,
        policy_rank: idx + 1,
      });
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <article className="fix-card">
      <div className="fix-body">
        <div className="fix-title">
          install <code>{fix.name}</code>
        </div>
        <div className="fix-blocks">
          would catch <strong>{quirkRef}</strong> · {fix.desc}
        </div>
        <div className="fix-cmd">
          <span className="prompt">$</span>{install}
        </div>
      </div>
      <button
        type="button"
        className="fix-install-btn"
        onClick={handleCopy}
      >
        {copied ? "copied" : "copy"}
      </button>
    </article>
  );
}

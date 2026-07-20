"use client";

/**
 * Section 04 — HOW TO IMPROVE. Calm row list, one per prescribed
 * policy:
 *
 *   <policy-name>                 $ failproofai policy add <slug>   [📋]
 *   <one-line explanation>
 *
 * A single "install all" button at the section header copies the
 * combined install command for every prescribed policy.
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
  "warn-repeated-tool-calls": "warns when the same tool is called 3+ times with identical parameters.",
  "block-read-outside-cwd":   "denies any file read outside the project root, including symlinks.",
  "block-env-files":          "blocks reads and writes of .env files at the tool layer.",
  "block-secrets-write":      "blocks writes to .pem, id_rsa, credentials.json, and other secret-key files.",
  "warn-background-process":  "warns before starting nohup / & / screen / tmux processes.",
  "warn-git-amend":           "warns before amending git commits.",
  "require-ci-green-before-stop": "requires CI checks to pass on HEAD before the agent declares the task done.",
};

function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

interface FixRow {
  name: string;
  desc: string;
  hits: number;
}

function buildFixes(result: AuditResult): FixRow[] {
  const enabledSet = new Set(result.enabledBuiltinNames ?? []);
  const buckets = new Map<string, number>();

  for (const row of result.results) {
    if (row.hits === 0) continue;

    let target: string;
    if (row.source === "audit-detector") {
      const mapped = DETECTOR_TO_PRIMARY_POLICY[shortName(row.name)];
      if (!mapped) continue;
      target = mapped;
    } else if (row.source === "builtin" && !row.enabledInConfig) {
      target = shortName(row.name);
    } else {
      continue;
    }

    if (enabledSet.has(target)) continue;
    buckets.set(target, (buckets.get(target) ?? 0) + row.hits);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, hits]) => ({
      name,
      desc: POLICY_DESC[name] ?? "enable this builtin policy to close the gap.",
      hits,
    }));
}

/**
 * The "install all" command.
 *
 * `policy add` and `policies --install` are DIFFERENT commands, not aliases:
 * `policy add` enables exactly one policy and rejects a second name outright
 * ("`policy add` takes exactly one policy name"). This button is almost always
 * multi-policy — listing the gaps is the section's whole job — so it must use
 * the plural form, which is the one that accepts a list. Using `policy add`
 * here handed the user a command that errored on paste.
 */
function bulkInstall(fixes: FixRow[]): string {
  if (fixes.length === 0) return "";
  return `failproofai policies --install ${fixes.map((f) => f.name).join(" ")}`;
}

export function HowToImproveSection({ result, projected, projectedGrade }: Props) {
  const { capture } = usePostHog();
  const fixes = useMemo(() => buildFixes(result), [result]);
  const installAllCmd = useMemo(() => bulkInstall(fixes), [fixes]);
  const [copiedAll, setCopiedAll] = useState(false);

  if (fixes.length === 0) return null;

  const handleInstallAll = async () => {
    try {
      await navigator.clipboard.writeText(installAllCmd);
      setCopiedAll(true);
      capture("audit_copy_clicked", {
        source: "how_to_improve_section_install_all",
        item_type: "bulk_install_command",
        policy_count: fixes.length,
      });
      setTimeout(() => setCopiedAll(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <section className="audit-sec" data-screen-label="04 How to improve">
      <div className="audit-sec-head">
        <span className="audit-sec-eyebrow">
          <span className="ix">04</span>{"// how to improve"}
        </span>
        <button
          type="button"
          className="install-all-btn"
          onClick={handleInstallAll}
          aria-label="Copy install-all command"
        >
          {copiedAll ? "copied" : "install all"}
        </button>
      </div>
      <h2 className="audit-sec-title">install or configure</h2>
      <div className="audit-sec-sub">
        enable all {fixes.length === 1 ? "one" : fixes.length} → projected{" "}
        <strong>{projected}</strong> · {tierName(projectedGrade).toLowerCase()}
      </div>

      <div className="fix-list">
        {fixes.map((f, i) => (
          <FixRow key={f.name} fix={f} idx={i} />
        ))}
      </div>
    </section>
  );
}

function FixRow({ fix, idx }: { fix: FixRow; idx: number }) {
  const { capture } = usePostHog();
  const [copied, setCopied] = useState(false);
  const install = `failproofai policy add ${fix.name}`;

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
    <div className="fix-row">
      <div className="fix-row-info">
        <div className="fix-name">{fix.name}</div>
        <div className="fix-desc">{fix.desc}</div>
      </div>
      <div className="fix-row-cmd">
        <code className="fix-cmd-code">{install}</code>
        <button
          type="button"
          className="copy-icon-btn"
          onClick={handleCopy}
          aria-label={`Copy install command for ${fix.name}`}
        >
          {copied ? "✓" : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="3" y="3" width="9" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="5.5" y="0.5" width="9" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

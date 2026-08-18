#!/usr/bin/env bash
# Publish a pack to the contracts repo — but only when the CONTRACT changed.
#
#   contracts-publish.sh <pack.json>
#   env: CONTRACTS_REPO=<owner/name>   CONTRACTS_TOKEN=<write-scoped token>
#
# Pushes to `packs`, not the default branch. The org ruleset requires a reviewed
# pull request on main with no bypass actors, so an unattended lab cannot push
# there — and turning a daily data update into a daily review request would stop
# it being unattended. main carries the documentation and keeps the protection;
# `packs` carries the data and the release workflow that reads it.
#
# ── Why this compares before it commits ──────────────────────────────────────
# Every pack carries a fresh `generatedAt`, so a byte comparison would differ
# every single day. Push daily and the repo makes a release daily, and once a
# release means "today happened" it no longer means "something moved" — the
# signal the whole lab exists to produce is gone, replaced by a notification
# nobody reads. So the decision to commit ignores `generatedAt` and looks at the
# contract itself; when nothing moved, this exits 0 having done nothing, which
# is the correct outcome on almost every day.
#
# The probe verdicts are compared too, deliberately. A CLI going OK → ERROR is
# not a contract change, but it IS a change in what the pack can be trusted to
# say about that CLI, and a consumer reading a stale entry as current is exactly
# the failure this is built to prevent.
set -uo pipefail

PACK="${1:?usage: contracts-publish.sh <pack.json>}"
REPO="${CONTRACTS_REPO:?CONTRACTS_REPO (owner/name) required}"
TOKEN="${CONTRACTS_TOKEN:?CONTRACTS_TOKEN required}"
BRANCH="${CONTRACTS_BRANCH:-packs}"

# Who the publish commits are attributed to.
#
# GitHub maps a commit to an account by EMAIL, so this is not cosmetic: an
# address that belongs to somebody else's account silently credits them for
# every pack this ever publishes, and the commit itself looks perfectly normal
# while doing it. Overridable because the right answer differs per deployment —
# a dedicated bot account is the cleaner long-term identity for an automated
# publisher, and a `users.noreply` address is the safe default because it cannot
# be unlinked and exposes no real address.
GIT_NAME="${CONTRACTS_GIT_NAME:-Chetan Raghuvanshi}"
GIT_EMAIL="${CONTRACTS_GIT_EMAIL:-145042127+chhhee10@users.noreply.github.com}"
[ -s "$PACK" ] || { echo "✗ no pack at $PACK" >&2; exit 2; }

WORK="$(mktemp -d)"
# The token is in the remote URL, so the checkout must not outlive this script
# and must never be printed. Every echo below names $REPO, never the URL.
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if ! git clone --depth 1 --branch "$BRANCH" \
     "https://x-access-token:${TOKEN}@github.com/${REPO}.git" "$WORK/repo" >/dev/null 2>&1; then
  echo "✗ could not clone ${REPO} (branch ${BRANCH}) — wrong name, missing branch, or a token without write access" >&2
  exit 2
fi

DEST="$WORK/repo/pack.json"

# ── Did the contract actually move? ──────────────────────────────────────────
changed=1
if [ -f "$DEST" ]; then
  changed="$(NEW="$PACK" OLD="$DEST" bun -e '
    const fs = require("node:fs");
    const strip = (p) => {
      const o = JSON.parse(fs.readFileSync(p, "utf8"));
      delete o.generatedAt;   // the one field guaranteed to differ every run
      return JSON.stringify(o);
    };
    try { process.stdout.write(strip(process.env.NEW) === strip(process.env.OLD) ? "0" : "1"); }
    catch { process.stdout.write("1"); }   // unreadable either side: publish and let a human look
  ')"
fi

if [ "$changed" = 0 ]; then
  echo "contracts: nothing moved — not publishing (the last pack still describes today)"
  exit 0
fi

cp "$PACK" "$DEST"
git -C "$WORK/repo" add pack.json
git -C "$WORK/repo" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
  commit -q -m "Contracts: $(date -u +%Y-%m-%d) — a vendor's hook contract moved" \
  || { echo "contracts: git found nothing to commit"; exit 0; }

if ! git -C "$WORK/repo" push -q origin "$BRANCH" 2>/dev/null; then
  echo "✗ push to ${REPO} rejected — the token needs write access to contents" >&2
  exit 2
fi
echo "contracts: published an updated pack to ${REPO}"

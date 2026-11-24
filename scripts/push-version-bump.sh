#!/usr/bin/env bash
# Pushes the version-bump commit at HEAD to a branch of its own and links the
# pull request a person opens for it. Every release workflow ends with this.
#
# Why a branch and not `main`: `main` is governed by the org's
# `failproofai-rules` ruleset (pull request + one approval), and nothing that
# runs in CI can get past it. The job's own GITHUB_TOKEN is rejected (GH013) and
# cannot be put on the ruleset's bypass list: it is the same identity in every
# workflow run on every branch, so a bypass for it would let anyone with write
# access push to `main` from a workflow of their own. The version-bot App that
# used to push here was exactly such a credential, reachable by any job that
# could read its secret. So the bump lands the way every other change does:
# through review, where the diff is a handful of version lines.
#
# Why the workflow does not open the pull request itself: that needs "Allow
# GitHub Actions to create and approve pull requests", one switch that also lets
# a workflow APPROVE pull requests, and such an approval counts as the required
# review. With it off, this links a pre-filled pull request instead.
#
# Usage: push-version-bump.sh <branch> <pr-title> [pr-body]
#   <branch>  must be `version-bump/<something>`; anything else is refused.
#
# Environment:
#   GITHUB_TOKEN         the job's token, with `contents: write` (pushes the branch)
#   GITHUB_REPOSITORY    owner/repo
#   GITHUB_SERVER_URL    default https://github.com
#   GITHUB_STEP_SUMMARY  optional; the pull request link is written there too
#   PUSH_REMOTE          optional; a remote to push to instead of GitHub, with no
#                        credentials (the tests point it at a local bare repo)
set -euo pipefail

usage="usage: push-version-bump.sh <branch> <pr-title> [pr-body]"
branch="${1:?$usage}"
title="${2:?$usage}"
body="${3:-}"

case "$branch" in
  version-bump/?*) ;;
  *)
    echo "::error::refusing to push a version bump to '$branch': bumps go to a 'version-bump/...' branch and reach main through review"
    exit 1
    ;;
esac

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"
server="${GITHUB_SERVER_URL:-https://github.com}"

auth=()
if [ -n "${PUSH_REMOTE:-}" ]; then
  remote="$PUSH_REMOTE"
else
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required to push the bump branch}"
  remote="$server/$GITHUB_REPOSITORY.git"
  # Through a header on the commands that need it, never the remote URL or
  # `.git/config`: git echoes the URL in its own error output, which
  # `::add-mask::` does not reach.
  echo "::add-mask::$GITHUB_TOKEN"
  auth=(-c "http.$server/.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
fi

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

link="$server/$GITHUB_REPOSITORY/compare/main...$branch?quick_pull=1&title=$(urlencode "$title")"
if [ -n "$body" ]; then
  link="$link&body=$(urlencode "$body")"
fi

# `${auth[@]+...}`: an empty array is "unbound" under `set -u` in bash < 4.4,
# which is what macOS ships.
if git ${auth[@]+"${auth[@]}"} ls-remote --exit-code --heads "$remote" "refs/heads/$branch" >/dev/null; then
  # Force-pushing is blocked on every branch, and a branch that already holds
  # this bump is waiting for review rather than broken.
  echo "::notice title=Version bump already waiting::$branch already exists. Open or review its pull request: $link"
  status="was already waiting on"
else
  git ${auth[@]+"${auth[@]}"} push "$remote" "HEAD:refs/heads/$branch"
  echo "::notice title=Version bump ready for review::Pushed to $branch. Open the pull request: $link"
  status="is on"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Version bump ready for review"
    echo
    echo "The bump $status \`$branch\`. [Open the pull request]($link): it needs one approval, like any change to \`main\`. Until it merges, \`main\` still carries the version that was just released, and the next release from it is refused."
  } >> "$GITHUB_STEP_SUMMARY"
fi

#!/usr/bin/env bash
# Pushes the version-bump commit at HEAD to a branch of its own and opens the
# pull request for it. Every release workflow ends with this.
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
# Opening the pull request with that token needs the repository setting "Allow
# GitHub Actions to create and approve pull requests". It is ONE switch: with it
# on, a workflow can also APPROVE a pull request, and that approval counts as the
# required review unless the ruleset demands a review from specific people (code
# owners, or a team). With it off, GitHub refuses the request, and this falls
# back to printing a pre-filled pull request link: the bump is still pushed and
# the release still succeeds.
#
# A pull request opened by GITHUB_TOKEN starts no workflow runs (GitHub drops
# events that token causes), so the bump's checks run on `main` after it merges.
#
# Usage: push-version-bump.sh <branch> <pr-title> [pr-body]
#   <branch>  must be `version-bump/<something>`; anything else is refused.
#
# Environment:
#   GITHUB_TOKEN         the job's token: `contents: write` pushes the branch,
#                        `pull-requests: write` opens the pull request
#   GITHUB_REPOSITORY    owner/repo
#   GITHUB_SERVER_URL    default https://github.com
#   GITHUB_STEP_SUMMARY  optional; the outcome is written there too
#   PUSH_REMOTE          optional; a remote to push to instead of GitHub, with no
#                        credentials (the tests point it at a local bare repo).
#                        Set alone, it also skips opening a pull request, so a
#                        test can never reach the real repository.
#   GH_BIN               optional; the `gh` executable (the tests use a stand-in)
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
open_pr=true
if [ -n "${PUSH_REMOTE:-}" ]; then
  remote="$PUSH_REMOTE"
  [ -n "${GH_BIN:-}" ] || open_pr=false
else
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required to push the bump branch}"
  remote="$server/$GITHUB_REPOSITORY.git"
  # Through a header on the commands that need it, never the remote URL or
  # `.git/config`: git echoes the URL in its own error output, which
  # `::add-mask::` does not reach.
  echo "::add-mask::$GITHUB_TOKEN"
  auth=(-c "http.$server/.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
fi
gh_bin="${GH_BIN:-gh}"

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
  echo "::notice::$branch already exists; not pushing it again."
else
  git ${auth[@]+"${auth[@]}"} push "$remote" "HEAD:refs/heads/$branch"
  echo "Pushed the bump to $branch."
fi

pr_url=""
if [ "$open_pr" = true ]; then
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  # A re-run must not stack a second pull request on the first.
  pr_url=$("$gh_bin" pr list --repo "$GITHUB_REPOSITORY" --head "$branch" --state open --json url --jq '.[0].url // ""' 2>/dev/null || true)
  if [ -n "$pr_url" ]; then
    echo "::notice title=Version bump waiting for review::Already open: $pr_url"
  elif created=$("$gh_bin" pr create --repo "$GITHUB_REPOSITORY" --base main --head "$branch" \
      --title "$title" --body "${body:-$title}" 2>&1); then
    # `|| true`: with pipefail, a grep that matches nothing would end the script.
    pr_url=$(printf '%s\n' "$created" | grep -Eo 'https://[^[:space:]]+/pull/[0-9]+' | tail -n 1 || true)
    pr_url="${pr_url:-$created}"
    echo "::notice title=Version bump ready for review::Opened $pr_url"
  else
    hint=""
    case "$created" in
      *"not permitted to create or approve pull requests"*)
        hint=" Turn on \"Allow GitHub Actions to create and approve pull requests\" (Settings > Actions > General) to have it opened automatically."
        ;;
    esac
    echo "::warning title=Pull request not opened::GitHub refused to open it: $(printf '%s' "$created" | tr '\n' ' ').$hint Open it here: $link"
  fi
fi

if [ -z "$pr_url" ]; then
  echo "::notice title=Version bump ready for review::Open the pull request: $link"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Version bump ready for review"
    echo
    if [ -n "$pr_url" ]; then
      echo "The bump is on \`$branch\`, in $pr_url."
    else
      echo "The bump is on \`$branch\`. [Open the pull request]($link)."
    fi
    echo "It needs one approval, like any change to \`main\`. Until it merges, \`main\` still carries the version that was just released, and the next release from it is refused."
  } >> "$GITHUB_STEP_SUMMARY"
fi

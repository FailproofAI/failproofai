# Self-contained failproofai hook-sync container.
#
# A single-shot daily job (run by a k8s CronJob) that clones failproofai, runs
# Claude Code in `--effort ultracode` mode to detect drift between every agent-CLI
# harness we integrate with and this repo, and opens ONE auto-PR with the fix.
#
# Bundles:
#   - Node 20 + npm (runs the Claude Code CLI)
#   - Claude Code CLI (`claude`) — run headless with --effort ultracode
#   - git + gh + dumb-init + `script` (PTY wrap for stream-json)
#
# The agent commits, pushes and opens the PR itself (see
# scripts/sync-agent-cli-harnesses-prompt.md); entrypoint.sh then pushes and
# opens the PR for any commit the agent left unpublished.
#
# Build:  docker build -t hook-sync:latest docker-hook-sync/
# Run:    docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=... -e GH_TOKEN=... hook-sync:latest
#
# Every dependency is installed at build time. The daily GitHub Actions rebuild
# (.github/workflows/build-image.yml) keeps claude-code@latest fresh.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/appuser \
    FAILPROOFAI_TELEMETRY_DISABLED=1 \
    PATH="/home/appuser/.local/bin:${PATH}"

# Layer 1: apt deps. dumb-init for PID 1 signal handling; git+gh for the
# clone/branch/push/PR flow; bsdextrautils provides `script` (PTY wrap so Node
# line-flushes --output-format stream-json); curl/gnupg for the gh apt key.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg dumb-init git bsdextrautils \
 && rm -rf /var/lib/apt/lists/*

# Layer 2: GitHub CLI (gh). Used by the agent and the entrypoint for
# `gh pr create/list`.
RUN install -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Layer 3: npm globals. Claude Code CLI, pinned to latest at build time; the
# daily workflow rebuild keeps it fresh. Root install so symlinks land in
# /usr/local/bin (executable by the non-root appuser).
RUN npm install -g --omit=dev \
        @anthropic-ai/claude-code@latest \
 && npm cache clean --force

# Layer 4: non-root user + chowned workspace.
RUN useradd --create-home --uid 10001 --shell /bin/bash appuser \
 && mkdir -p /workspace \
 && chown -R appuser:appuser /workspace /home/appuser

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER appuser
WORKDIR /home/appuser

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]

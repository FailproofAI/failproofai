# Self-contained failproofai hook-sync container.
#
# A single-shot daily job (run by a k8s CronJob) that clones failproofai, runs
# Claude Code in `--effort ultracode` mode to detect drift between every agent-CLI
# harness we integrate with and this repo, and opens ONE auto-PR with the fix.
#
# Bundles:
#   - Node 20 + npm
#   - bun (REQUIRED: the cloned repo's .claude/settings.json fires hooks via
#     `bun $CLAUDE_PROJECT_DIR/bin/failproofai.mjs --hook <Event>`, so the
#     dogfooded require-*-before-stop policies enforce the commit/push/PR)
#   - Claude Code CLI (`claude`) — run headless with --effort ultracode
#   - failproofai@latest on PATH (belt-and-suspenders; the dogfood hooks actually
#     run the clone's SOURCE via bun, not this global)
#   - git + gh + jq + dumb-init + `script` (PTY wrap for stream-json)
#
# Build:  docker build -t hook-sync:latest docker-hook-sync/
# Run:    docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=... -e GH_TOKEN=... hook-sync:latest
#
# Every dependency is installed at build time. The daily GitHub Actions rebuild
# (.github/workflows/build-image.yml) keeps claude-code@latest + failproofai@latest fresh.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/appuser \
    BUN_INSTALL=/home/appuser/.bun \
    FAILPROOFAI_TELEMETRY_DISABLED=1 \
    PATH="/home/appuser/.bun/bin:/home/appuser/.local/bin:${PATH}"

# Layer 1: apt deps. dumb-init for PID 1 signal handling; git+gh for the agent's
# clone/branch/push/PR flow AND the require-*-before-stop hooks; jq for the
# entrypoint's policy-config edit; bsdextrautils provides `script` (PTY wrap so
# Node line-flushes --output-format stream-json); curl/gnupg for the gh apt key
# and the bun installer; unzip is required by the bun installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg dumb-init jq git bsdextrautils unzip \
 && rm -rf /var/lib/apt/lists/*

# Layer 2: GitHub CLI (gh). Used by the agent for `gh pr create/list` and by the
# require-pr-before-stop hook.
RUN install -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Layer 3: npm globals. Claude Code CLI + failproofai, pinned to latest at build
# time; the daily workflow rebuild keeps them fresh. Root install so symlinks land
# in /usr/local/bin (executable by the non-root appuser).
RUN npm install -g --omit=dev \
        @anthropic-ai/claude-code@latest \
        failproofai@latest \
 && npm cache clean --force

# Layer 4: non-root user + chowned workspace.
RUN useradd --create-home --uid 10001 --shell /bin/bash appuser \
 && mkdir -p /workspace \
 && chown -R appuser:appuser /workspace /home/appuser

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER appuser
WORKDIR /home/appuser

# Layer 5: bun (installs into $BUN_INSTALL=/home/appuser/.bun, on PATH per ENV).
# The dogfood hook fast-path runs TypeScript from src/ directly — bun executes TS
# natively, so no build step is needed for the hooks to work.
RUN curl -fsSL https://bun.sh/install | bash

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]

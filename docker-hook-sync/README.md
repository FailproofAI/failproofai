# docker-hook-sync/

## What this is

Build context for the `hook-sync` container image — internal release/maintenance
tooling, not one of the five shipped products. `Dockerfile` bundles Node 20, bun,
`git`/`gh`/`jq`, the Claude Code CLI and `failproofai@latest`; `entrypoint.sh` is a
single-shot job that clones this repo, cuts an `auto/sync-cli-harnesses-<UTC>` branch,
and runs `claude --effort ultracode -p <scripts/sync-agent-cli-harnesses-prompt.md>`
headless so the agent detects drift between the 12 agent-CLI hook contracts and this
repo and opens one auto-PR itself.

Two details in `entrypoint.sh` are easy to miss. It edits the clone's
`.failproofai/policies-config.json` with `jq` to drop `require-ci-green-before-stop`
and `block-read-outside-cwd`, then `git update-index --skip-worktree`s the file so the
edit never reaches the PR while failproofai still reads it at runtime — the
`require-commit/push/pr-before-stop` gates stay on, and they are what actually forces
the agent to finish the PR. And `claude` is wrapped in `script -qefc` purely to give it
a PTY, because Node block-buffers a piped stdout and `--output-format stream-json`
would otherwise not line-flush to the pod log.

## Who consumes it

`.github/workflows/build-image.yml` builds this context (`context: docker-hook-sync`)
and pushes `ghcr.io/failproofai/hook-sync:latest` on pushes to `main` that touch this
directory, plus a daily 08:00 UTC rebuild that refreshes the `@latest`-pinned
`claude-code` and `failproofai` npm globals. Nothing in this repo *runs* the container:
it is executed by a k8s CronJob managed in separate infra, or by hand
(`docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=... -e GH_TOKEN=... hook-sync:latest`).

## Does it ship

No. `docker-hook-sync` is not in package.json's `files` array, so it never reaches an
npm user. `__tests__/ci/tarball-surface.test.ts` additionally lists it in
`MUST_NOT_SHIP_UNDER_STANDALONE`, and `scripts/prune-standalone.mjs` strips it from
`.next/standalone` where Next's tracer over-collects it. Renaming the directory only
requires updating `build-image.yml`, those two files, and the test below.

## Where its tests live

`__tests__/hooks/dogfood-configs.test.ts` ("the hook-sync image still installs bun" —
`scripts/dev-hook.mjs` only *locates* bun, so dropping that layer would silently kill
the stop-gates that drive the auto-PR) and `__tests__/ci/tarball-surface.test.ts`. Both
run under `bun run test:run`.

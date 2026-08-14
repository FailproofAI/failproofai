# scripts/

Five unrelated subsystems in one flat directory, spanning three of the repo's products. Nothing here
is a product of its own: these are the launchers, release tooling, docs pipeline and dogfood shim that
the CLI, the dashboard and CI drive. Read `CLAUDE.md` for the architecture each one serves.

| Subsystem | Files | Invoked by |
|---|---|---|
| Dashboard launch | `dev.ts`, `start.ts` → `launch.ts` (+ `parse-script-args.ts`, `skew-log-filter.ts`, `install-diagnosis.mjs`) | `bun run dev` / `bun run start` |
| Release | `build-daemon-packages.mjs`, `publish-aliases.mjs` (+ `alias-proxy.js`, `daemon-platforms.mjs`), `prune-standalone.mjs` | `.github/workflows/publish.yml`, `ci.yml`, `bun run build` |
| Docs | `translate-docs/` (9 files, entry `cli.ts`), `validate-mdx.ts`, `docs-audit.ts` | `bun run translate*`, `bun run validate:mdx`, `bun run docs:audit`; the nightly translation and the weekly docs audit both run on the canary box (`integration-suite/local/jobs/`) |
| Dogfood | `dev-hook.mjs` | all 10 committed dogfood hook configs |
| Container / prompts | `repro-npm-install.sh`, `sync-agent-cli-harnesses-prompt.md` | run by hand; the prompt is the `build-image.yml` sync agent's brief |

## What this is
Build, release, launch and docs-pipeline tooling. `launch.ts` starts the Next standalone dashboard
(binding loopback unless overridden, and filtering Next's Server-Action deployment-skew noise);
`daemon-platforms.mjs` is the single list of the four `failproofaid` cross-compile targets that
`build-daemon-packages.mjs` publishes and `publish-aliases.mjs` pins into every typo-squat stub.

## Who consumes it
CI workflows, the two `bun run` launchers, and — for two files — the CLI at runtime:
`lib/install-check.ts` imports `trackInstallEvent` from `install-telemetry.mjs`, and `launch.ts`
imports `diagnoseShadow` from `install-diagnosis.mjs`. `dev-hook.mjs` is spawned by Claude, Codex,
Copilot, Cursor, OpenCode, Pi, Factory, Devin, Antigravity and Goose when a hook fires in this repo.

## Does it ship
Yes — `scripts/` is in package.json `"files"`, so this whole directory lands in every install. That
matters for `install-telemetry.mjs`: renaming or moving it breaks `lib/install-check.ts` in the
published package. `dev-hook.mjs` is referenced by literal path (`$CLAUDE_PROJECT_DIR/scripts/dev-hook.mjs`
and relative equivalents) from all 10 dogfood configs and must never move — `__tests__/hooks/dogfood-configs.test.ts`
is the tripwire.

## Where its tests live
`__tests__/scripts/` (including `translate-docs/`) plus `__tests__/ci/daemon-packages.test.ts` and
`__tests__/ci/release-pipeline.test.ts`. Run with `bun run test:run`.

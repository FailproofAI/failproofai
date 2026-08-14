# docs/ — the Mintlify site

## What this is

The documentation site — a [Mintlify](https://mintlify.com) project whose config is `docs/docs.json`.
It holds 692 `.mdx` pages, but only **48 are hand-written English**: the root pages
(`introduction.mdx`, `getting-started.mdx`, `architecture.mdx`, `configuration.mdx`,
`built-in-policies.mdx`, `custom-policies.mdx`, `dashboard.mdx`, `examples.mdx`, `for-agents.mdx`,
`package-aliases.mdx`, `testing.mdx`), the 10 pages under `cli/`, and the 27 under `agenteye/`.
The remaining 644 live in the 14 language directories (`ar de es fr he hi it ja ko pt-br ru tr vi zh`)
and are machine translations. `docs/i18n/` holds translated copies of the root `README.md`.

**`docs/agenteye/` documents a different product** (AgentEye, the telemetry/observability platform);
it shares this site but not this codebase.

**Edit only the English source. Never edit a file under a language directory** — the next
translation run overwrites it. Those paths are marked `linguist-generated=true` in `.gitattributes`
so they collapse in pull-request diffs; that marking is git metadata only and does not stop an edit.

## Who consumes it

Mintlify's hosted build renders this directory; nothing in the CLI, the Next dashboard, or the Rust
daemon reads it. Translations are produced by `.github/workflows/translate-docs.yml` (daily cron,
14-language matrix, `workflow_dispatch` with a `force` input) running `scripts/translate-docs/cli.ts`
— `bun run translate`, `translate:docs`, `translate:readme`, `translate:dry-run`, `translate:validate`.
`scripts/translate-docs/mintlify-nav.ts` mirrors the English navigation in `docs.json` into each
locale, so a new English page must be added to `docs.json` navigation or it will not appear anywhere.
`docs/Dockerfile.dev` runs `mintlify dev` locally.

## Does it ship

No. `docs/` is not in package.json's `files` array, so nothing here reaches an npm install. It is
published only to the docs site.

## Where its tests live

There are no tests over the `.mdx` content itself; the translator that writes it is covered by
`__tests__/scripts/translate-docs/` (`config.test.ts` asserts the `LANGUAGES` list matches
`.gitattributes`), run with `bun run test:run`. CI's `docs` job additionally runs
`mintlify validate` in this directory and `bun run validate:mdx`, which parses every page and
checks that image references resolve on disk.

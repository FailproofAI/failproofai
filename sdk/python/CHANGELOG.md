# Changelog — `failproofai-sdk`

The telemetry SDK, imported as `failproofai_sdk`. Released independently of the
`failproofai` npm package and of its sibling `fp-cloud-cli`, so the versions here line
up with neither.

Headings are `## <version> — <YYYY-MM-DD>`, and the section matching the version
in `failproofai_sdk/_version.py` becomes that release's GitHub Release body. A
release whose section is missing or empty is refused before anything is built —
see `scripts/changelog-section.py`.

## 0.0.1b2 — 2026-08-25

Open for the next release. `0.0.1b1` published on 2026-08-24 and the `bump` job
moved the version here automatically; nothing has landed against `0.0.1b2` yet.
Add entries as changes merge — this section becomes the GitHub Release body when
it ships.

## 0.0.1b1 — 2026-08-24

The first release under this name. Everything below describes the package as it
now ships rather than a change against a previous `failproofai-sdk`, because
there is no previous one.

### The distribution name

- **This package was `agenteye` inside the private monorepo, and that name is not
  safe to keep.** `agenteye` on public PyPI resolves to a stranded build of a
  different thing — an old CLI, last published there at `0.1.22` — and PyPI never
  releases a version for reuse. Because pip resolves the highest version under a
  name, `pip install agenteye` on a machine already running the pre-rename SDK
  installed that CLI build *over* it: same distribution name, higher version, so
  pip treated it as an upgrade and the working `import agenteye` stopped working.
  Renaming to `failproofai-sdk` is what makes that unreachable.
- **Versioning restarts at `0.0.1b1`.** The pre-rename package had reached
  `0.0.1b14`, but that history lives entirely under `agenteye`; carrying the
  number across would claim fourteen releases of a name that has had none.
  `b1` is a PEP 440 pre-release, which — PyPI having no dist-tags — is the only
  channel marker there is. See `scripts/python-version.py` for the scheme.
- **Migrating is two mechanical changes:** `pip uninstall agenteye && pip install
  failproofai-sdk`, then `import agenteye` → `import failproofai_sdk`. Every
  method name, argument and emitted field is unchanged, and so is
  `AGENTEYE_ENVIRONMENT`, which is a contract with a daemon that releases
  separately. `skill/references/install.md` covers the whole path.

### What it does

- Fifteen event methods across six families, with `duration_ms` computed
  automatically by pairing start/end events. The wire format is frozen
  byte-for-byte by `tests/test_wire_format.py` — `to_dict()` **is** the format.
- Four framework adapters — LangChain/LangGraph, CrewAI, LlamaIndex, Pydantic AI
  — all shipped in the base wheel and lazy-imported. The `[langchain]`-style
  extras pull in the *framework*, never the adapter, so most users never need one.
- **Zero runtime dependencies, enforced rather than asserted.** This installs into
  other people's agent processes, where any dependency of ours becomes a version
  constraint on their application. `tests/test_zero_dependencies.py` fails if one
  is ever declared or imported, and the release pipeline installs the built wheel
  with `--no-deps` to prove the claim against the artifact rather than the source.

### Spool location

- **The default spool root is `~/.failproofai/custom-agents`**, not `~/.agenteye`.
  It must agree exactly with `customAgentsDir()` in `src/hooks/fp-home.ts` and
  `custom_agents_events_dir()` in `crates/fpai-collect/src/config.rs`, because a
  disagreement means the SDK writes where no daemon reads, with **no error on
  either side**. `tests/test_spool_contract.py` checks the Rust and the TypeScript
  directly and never skips.
- **`AGENTEYE_HOME` no longer moves this SDK's spool.** It used to sit above the
  default, so exporting it for `agenteye-collector` — the component that genuinely
  reads it — relocated the SDK as an unasked-for side effect. Resolution is now
  `configure(base_dir=...)`, else `~/.failproofai/custom-agents`, with
  `$FAILPROOFAI_HOME` moving the umbrella and never the spool out of it.
- A machine that has only ever run this SDK stays indistinguishable, to every
  other component, from one that has run nothing: the spool path is the only
  thing created, and none of the layout landmarks the CLI's `detectLayout()`
  reads are ever written. `tests/test_spool_creation.py` asserts the exact set of
  paths that appear.

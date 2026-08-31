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

- Retire the old inbound evaluator boundary and add evaluator authoring plus the
  outbound-only v2 worker runtime under the lazy `failproofai_sdk.evaluator`
  namespace.
- Harden the managed-evaluator source sandbox against a class of escapes an
  adversarial review found: `str.format`/`format_map` C-level field traversal,
  generator/frame introspection (`gi_frame.f_globals`) that reached the eval
  globals and could poison a process-shared namespace across evaluations, and
  `type.mro()` type-object reach. Attribute access is now **default-deny** (an
  allowlist of the transcript data surface plus pure string/collection methods,
  so every current and future introspection attribute is rejected), each eval
  runs with **fresh per-call globals**, and a result whose text embeds a runtime
  object repr (`<... at 0x...>`, a heap-pointer/ASLR disclosure that falls out of
  any bound method's repr) is rejected at the output boundary. `enumerate` and
  bare generator expressions are no longer permitted — both were gratuitous
  pointer-repr sources; use `range(len(...))` and list/set/dict comprehensions.
- Contain a poison managed definition to its own run: source is now compiled
  lazily inside the per-run executor, so a definition the sandbox rejects
  dead-letters as one bounded `failed`/`eval_error` run instead of crashing the
  assignment task and forcing it to be reclaimed until its attempt budget runs
  out.
- Run managed (server-authored) evaluations in a **killable forked process** with
  hard `RLIMIT_CPU` + `RLIMIT_AS` + wall-clock limits, killed on timeout — so a
  compute/memory bomb in a hosted definition (`sum(range(10**20))`) can no longer
  exhaust the worker (SEC-001). Cancelling an in-process thread does not stop it;
  a forked process the kernel bounds and the parent can `SIGKILL` does. Managed
  conditions, which previously ran with no timeout at all, are sandboxed the same
  way. Defense in depth at compile time: reject `**` with a large/non-constant
  exponent and cap total AST size. A managed condition the sandbox rejects now
  dead-letters as `condition_error` instead of raising out of the plan loop and
  stranding the assignment. Only server-authored source is isolated this way;
  customer evaluators still run in-process (their own trusted code).
- Require `execution_mode` on the wire instead of coercing a falsy/missing value
  to `local` — a malformed value silently ran a `python` definition down the
  customer path (or vice-versa); it is now a hard protocol error.
- Switch the worker from long-polling to **normal (short) polling**, matching the
  cadence of our other cloud surfaces. `claim` no longer sends `wait_seconds` and
  the server returns immediately; when a claim comes back empty the worker sleeps
  the server-advertised `poll_interval_seconds` (from the register response,
  default 10 s) before polling again, instead of holding a request open for up to
  25 s. Removes the `claim_wait_seconds` config knob and the
  `request_timeout_seconds > claim_wait_seconds` constraint; the poll cadence is
  now tuned centrally by the server, not per worker.

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

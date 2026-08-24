# Installing the SDK

```bash
pip install failproofai-sdk        # or: uv add failproofai-sdk
```

The SDK has no dependencies, so that is all it installs. Optional extras pull in
the **framework**, never the adapter — all four adapters ship in the box:

```bash
pip install 'failproofai-sdk[langchain]'     # also: langgraph, crewai, pydantic-ai
pip install 'failproofai-sdk[llamaindex]'    # note: no hyphen, unlike the dist name
```

Most agents already have their framework installed and never need one of these.

Then `import failproofai_sdk`. There is no token, no private index, and no wheel to
download by hand — the distribution is on public PyPI. It has no dependencies, so
it cannot conflict with anything already in the agent's environment.

## The one thing that still goes wrong

**`pip install agenteye` does not install this SDK, and can uninstall it.**

`agenteye` was the SDK's distribution name inside the private monorepo, and it is
also the name an old CLI published under. That CLI has moved to `fp-cloud-cli` (command
`fp`), but its last release as `agenteye` — version `0.1.22` — is stranded on
public PyPI permanently. PyPI versions cannot be withdrawn and reused, and pip
resolves the highest version, so that build is what the name still resolves to.

| You run | You get | Symptom |
|---|---|---|
| `pip install agenteye`, nothing installed | the stranded CLI build | `import failproofai_sdk` → `ModuleNotFoundError`; that build ships `agenteye_cli` |
| `pip install agenteye`, SDK already present | the stranded CLI build **alongside** it | Confusing but survivable — different distribution names, so the SDK is not removed |
| `pip install agenteye` on a pre-rename SDK (`agenteye` ≤ `0.0.1b14`) | the stranded CLI build, **replacing the SDK** | The import that worked five minutes ago stops working: same distribution name, higher version, so pip treats it as an upgrade |

The last row is the dangerous one and it is why the rename happened. It fires
*after* a working integration, when someone wants the CLI to check that events
arrived and installs it into the agent's own environment. Nothing warns them.

If you want the CLI, it is a separate distribution and installing it cannot touch
`failproofai-sdk` — but give it its own environment anyway:

```bash
pipx install fp-cloud-cli        # or: uv tool install fp-cloud-cli   (the command is `fp`)
```

## Migrating from the old `agenteye` distribution

Two changes, both mechanical:

```bash
pip uninstall agenteye
pip install failproofai-sdk
```

```diff
-import agenteye
-agenteye.configure(base_dir=None, flush_interval=0.5)
-agenteye.event.agent_start(session_id="run-001", agent_id="planner")
+import failproofai_sdk
+failproofai_sdk.configure(base_dir=None, flush_interval=0.5)
+failproofai_sdk.event.agent_start(session_id="run-001", agent_id="planner")
```

Every method name, argument, and emitted field is unchanged, and so is
`AGENTEYE_ENVIRONMENT` — a contract with a daemon that releases separately.

**Two things changed on disk.** The default spool root is now
`~/.failproofai/custom-agents`, not `~/.agenteye`; and **`AGENTEYE_HOME` no
longer moves the SDK's spool at all.** It used to sit above the default, so
exporting it for `agenteye-collector` — the component that genuinely reads it —
relocated this SDK as an unasked-for side effect. Resolution is now exactly
`configure(base_dir=...)`, else `~/.failproofai/custom-agents` (with
`$FAILPROOFAI_HOME` moving the umbrella, never the spool out of it).

`failproofaid` watches both roots, so if that is your daemon there is nothing to
do and already-spooled batches still get collected. If you run the older
`agenteye-collector`, point **it** at the SDK with
`AGENTEYE_HOME=~/.failproofai/custom-agents`, or pass `base_dir` explicitly.
(`AGENTEYE_SPOOL_TO_FAILPROOFAI` is retired: it also required the directory to
pre-exist, which nothing created, so it never took effect.)

## Confirm what you have

```bash
python -c "import failproofai_sdk; print(failproofai_sdk.__version__)"
```

- A version string such as `0.0.1b1` → the SDK. Good.
- `ModuleNotFoundError: No module named 'failproofai_sdk'` → not installed. If
  `pip show agenteye` returns something, you installed the wrong name; see above.

## Pinning

Pin `failproofai-sdk` in your dependency file like any other package. Never leave
an unpinned `agenteye` requirement anywhere a CI job will resolve it from PyPI —
it will pull the stranded CLI build on the next clean install. If you are
migrating, grep for `agenteye` in every `requirements*.txt`, `pyproject.toml`,
`Pipfile` and Dockerfile, not just the one you remember.

# Installing the SDK

```bash
pip install failproofai-sdk        # or: uv add failproofai-sdk
```

Then `import failproofai_sdk`. There is no token, no private index, and no wheel to
download by hand — the distribution is on public PyPI. It has no dependencies, so
it cannot conflict with anything already in the agent's environment.

## The one thing that still goes wrong

**`pip install agenteye` does not install this SDK, and can uninstall it.**

`agenteye` was the SDK's distribution name inside the private monorepo, and it is
also the name an old CLI published under. That CLI has moved to `fp-cli` (command
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
pipx install fp-cli        # or: uv tool install fp-cli   (the command is `fp`)
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

Nothing else moves. Every method name, argument, and emitted field is unchanged,
and so is everything on disk and in the environment: the spool is still
`~/.agenteye/`, and `AGENTEYE_HOME`, `AGENTEYE_ENVIRONMENT` and
`AGENTEYE_SPOOL_TO_FAILPROOFAI` all keep their names. Those are a contract with a
daemon that releases separately, so renaming them from the SDK's side would send
events to a directory nothing watches — no error on either side.

## Confirm what you have

```bash
python -c "import failproofai_sdk; print(failproofai_sdk.__version__)"
```

- A version string such as `0.0.1b14` → the SDK. Good.
- `ModuleNotFoundError: No module named 'failproofai_sdk'` → not installed. If
  `pip show agenteye` returns something, you installed the wrong name; see above.

## Pinning

Pin `failproofai-sdk` in your dependency file like any other package. Never leave
an unpinned `agenteye` requirement anywhere a CI job will resolve it from PyPI —
it will pull the stranded CLI build on the next clean install. If you are
migrating, grep for `agenteye` in every `requirements*.txt`, `pyproject.toml`,
`Pipfile` and Dockerfile, not just the one you remember.

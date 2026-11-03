# Your own evaluator worker — the eval pod

An evaluation scores a **finished** session. There are two places one can run:

| | Hosted | Your own worker (this page) |
|---|---|---|
| Written | in the dashboard, **Analyze → eval authoring** | in Python or TypeScript, with the SDK you already install |
| Runs on | Failproof AI's managed evaluator, sandboxed | your infrastructure: a container, a pod, a VM |
| Use it for | deterministic checks and model-backed checks Failproof AI hosts | LLM judges on your own keys, packages, secrets, your private network, models you host, heavy processing |

Default to hosted. Reach for a worker when the evaluation needs one of the
right-hand column's things. Deciding *what* is worth evaluating is the
`failproofai-eval-brainstorm` skill. This page is about building and running the
worker.

**How it works.** The worker only makes outbound HTTPS calls, and nothing connects
in to it, so there is no port, no Service and no ingress:

1. It registers its catalogue of evaluations.
2. It claims finished sessions and runs each applicable evaluation.
3. It submits the results under a heartbeat.

Its results appear on the evaluations page tagged **customer**. Hosted results are
tagged **managed**.

**Nothing scores a session that has no `agent_start`/`agent_end`.** The worker
evaluates sessions, and sessions exist only through those two events (`SKILL.md`
§2). Get instrumentation landing first.

## Ships in the SDK

| | Python | TypeScript |
|---|---|---|
| Install | `pip install failproofai-sdk` | `npm install @failproofai/sdk` |
| Import | `failproofai_sdk.evaluator` | `@failproofai/sdk/evaluator` |
| Run | `python evaluator.py` (with `app.run_from_env()`) or `python -m failproofai_sdk.evaluator evaluator:app` | `npx failproofai-evaluator ./evals.js` (export named `app`; `./evals.js#other` for another) or `app.runFromEnv()` |

Importing the tracing SDK does not load the evaluator. In TypeScript the reverse
holds too; in Python, importing `failproofai_sdk.evaluator` also imports the tracing
package and starts its flush thread (harmless, but it is there).

## Write the evaluations

Python:

```python
from failproofai_sdk.evaluator import ConditionResult, EvalResult, Evaluator, Metric, Score

app = Evaluator(name="support-evals", version="2026.09.1")


@app.eval(
    "tool_efficiency",
    version="1.0.0",
    labels=["tools", "deterministic"],
    when=lambda s: ConditionResult(s.count("tool_use") > 0, "no_tool_calls"),
)
def tool_efficiency(session):
    calls = session.events_of_type("tool_use")
    distinct = {e.payload.get("tool_name") for e in calls if e.payload.get("tool_name")}
    value = len(distinct) / len(calls)
    return EvalResult(
        score=Score(value, passed=value >= 0.7),
        metrics={"tool_call_count": Metric(len(calls), unit="events")},
        reasoning=f"{len(distinct)} distinct tools across {len(calls)} calls",
    )


@app.eval(
    "answer_relevance",
    version="judge-v1",
    labels=["llm_judge"],
    when=lambda s: ConditionResult(s.count("model_response") > 0, "no_model_response"),
    timeout_seconds=30,
)
async def answer_relevance(session):
    answer = session.events_of_type("model_response")[-1].payload.get("content")
    value, why = await ask_judge(answer)      # your model call: a 0-1 score and why
    return EvalResult(score=Score(value, passed=value >= 0.7), reasoning=why)


if __name__ == "__main__":
    app.run_from_env()
```

TypeScript (same API, camelCase, options objects):

```ts
import { ConditionResult, EvalResult, Evaluator, Metric, Score } from "@failproofai/sdk/evaluator";

export const app = new Evaluator({ name: "support-evals", version: "2026.09.1" });

app.eval(
  "tool_efficiency",
  {
    version: "1.0.0",
    labels: ["tools", "deterministic"],
    when: (s) => new ConditionResult(s.count("tool_use") > 0, "no_tool_calls"),
  },
  (session) => {
    const calls = session.eventsOfType("tool_use");
    const distinct = new Set(calls.map((e) => e.payload.tool_name).filter(Boolean));
    const value = distinct.size / calls.length;
    return new EvalResult({
      score: new Score(value, { passed: value >= 0.7 }),
      metrics: { tool_call_count: new Metric(calls.length, { unit: "events" }) },
      reasoning: `${distinct.size} distinct tools across ${calls.length} calls`,
    });
  },
);

app.eval(
  "answer_relevance",
  {
    version: "judge-v1",
    labels: ["llm_judge"],
    when: (s) => new ConditionResult(s.count("model_response") > 0, "no_model_response"),
    timeoutSeconds: 30,
  },
  async (session) => {
    const answer = session.eventsOfType("model_response").at(-1)?.payload.content;
    const { value, why } = await askJudge(answer); // your model call
    return new EvalResult({ score: new Score(value, { passed: value >= 0.7 }), reasoning: why });
  },
);
```

The evaluator module can be an ES module or CommonJS (`.js`, `.mjs`, `.cjs`, plain
`tsc` output). For a `.ts` file, either compile it and point `failproofai-evaluator`
at the `.js`, or call `await app.runFromEnv()` at the bottom and start it with
`npx tsx evals.ts`.

### The rules that bite

- **The key is what results chart under.** It must match `^[a-z][a-z0-9_]*$`.
  **Bump `version` whenever the logic changes.** Each result keeps the version that produced it, so a chart shows
  exactly when new logic took over. Keys must be unique, and one worker holds at
  most 100 evaluations.
- **`when` is how you scope.** Return `ConditionResult(False, "<reason_code>")` to
  skip a session, and the reason is recorded. A judge with no condition costs a
  model call on every session.
- **Result shapes:**
  - `result_kind` / `resultKind` is `"score"` by default.
  - For a `"metric"` or `"assertion"` evaluation, name one `metrics` or
    `assertions` entry after the key: that entry is the result.
  - Every `EvalResult` carries at least one and at most 25 scores, metrics or
    assertions.
  - `Score` values are 0–1, and anything else throws.
- **Read payload keys off a real session.** Keys like `tool_name`, `content` and
  `response` are whatever the agents emitted. The adapters add framework fields
  under `fw_*`.
- **Evaluations must yield.**
  - Every evaluation is bounded by `timeout_seconds` / `timeoutSeconds`, and by
    300 s when you set none.
  - **Python:** a synchronous evaluation that overruns cannot be interrupted. Its
    thread runs on, and a permanently blocked one leaks a thread per session. Write
    judges and network calls as `async def`.
  - **TypeScript:** a synchronous loop blocks the only thread, so no timeout can
    fire. Write evaluations `async`.
- **The session object:**
  - Python: `session_id`, `agent_id`, `environment`, `started_at`, `ended_at`,
    `events`, `count(type)`, `events_of_type(type)`.
  - TypeScript: `sessionId`, `agentId`, `environment`, `startedAt`, `endedAt`,
    `events`, `count(type)`, `eventsOfType(type)`.
  - Each event has `id`, `ts`, `event_type` (TS `eventType`) and `payload`.

## Run it

Create a key with the **`evaluations:run`** permission under **Administration →
Keys**. Inject it from your secret store; never paste it into a command line or an
image.

| Variable | Default | |
|---|---|---|
| `FAILPROOFAI_EVALUATOR_URL` | required | `https://app.befailproof.ai` for Cloud, or your instance. HTTPS unless loopback |
| `FAILPROOFAI_EVALUATOR_TOKEN` | required | the `evaluations:run` key |
| `FAILPROOFAI_EVALUATOR_WORKER_ID` | `<hostname>-<pid>` | names this worker |
| `FAILPROOFAI_EVALUATOR_CONCURRENCY` | `1` | sessions scored at once by this process |
| `FAILPROOFAI_EVALUATOR_REQUEST_TIMEOUT_SECONDS` | `30` | per request to Failproof AI |
| `FAILPROOFAI_EVALUATOR_DRAIN_TIMEOUT_SECONDS` | `60` | how long a stopping worker waits for runs in flight |
| `FAILPROOFAI_EVALUATOR_ALLOW_INSECURE_HTTP` | `false` | plain HTTP to a non-loopback URL. **Cleartext token and transcripts.** Isolated dev networks only |
| `FAILPROOFAI_EVALUATOR_MODULE` | — | the module when the CLI is given none: `module:attr` (Python), `path#export` (TS) |

Local smoke run against Cloud:

```bash
export FAILPROOFAI_EVALUATOR_URL=https://app.befailproof.ai
export FAILPROOFAI_EVALUATOR_TOKEN="$(your-secret-store read failproofai/evaluator)"
python evaluator.py              # or: npx failproofai-evaluator ./evals.js
```

Then finish a session from an instrumented agent and watch for a **customer**
result on it. Evaluation runs forward: a worker started now scores sessions that
finish while it runs. The dashboard's "score sessions you already have" backfill
covers hosted evaluations only; there is no backfill for a worker's own evaluations.

## Deploy it as a pod

Treat it as a long-running, outbound-only worker:

```dockerfile
# Python
FROM python:3.12-slim
RUN pip install --no-cache-dir failproofai-sdk   # plus whatever your judges need
COPY evaluator.py /app/evaluator.py
CMD ["python", "/app/evaluator.py"]
```

```dockerfile
# TypeScript (compiled to dist/evals.js)
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
CMD ["npx", "failproofai-evaluator", "./dist/evals.js"]
```

- **Secrets:**
  - `FAILPROOFAI_EVALUATOR_TOKEN` comes from a Secret (Kubernetes) or your secret
    manager.
  - The judge's own model key belongs there too.
  - Egress must reach the Failproof AI URL and your model endpoint. No ingress is
    needed.
- **Shutdown:** both workers stop on `SIGTERM`/`SIGINT` and drain runs in flight
  for up to `FAILPROOFAI_EVALUATOR_DRAIN_TIMEOUT_SECONDS`. Give the orchestrator
  more grace than that. In Kubernetes, set `terminationGracePeriodSeconds` above
  the drain timeout, e.g. 90 for the default 60. Otherwise a rolling deploy
  hard-kills evaluations mid-run.
- **Scaling:**
  - Raise `FAILPROOFAI_EVALUATOR_CONCURRENCY` for I/O-bound judges.
  - Add replicas for more throughput. Each replica claims its own sessions.
  - Leave `WORKER_ID` unset, or make it unique per replica: the default
    `<hostname>-<pid>` already is.
- **Releasing new logic.** Ship the image with a bumped eval `version`. Removing an
  evaluation from the worker, or stopping the worker, stops it running. There is
  nothing to disable in the dashboard, and worker-registered evaluations are not
  listed on the eval authoring page.

## Debugging a worker that scores nothing

Work through these in order:

1. **Does it start?**
   - A missing URL or token fails at startup with the variable's name.
   - An HTTP URL to a non-loopback host is refused unless you opt in.
2. **Is the key right?** It needs `evaluations:run` in the same organisation as the
   agents.
3. **Are sessions finishing?** No `agent_end` means no finished session, and
   nothing to claim. Check the instrumentation (`SKILL.md` §5).
4. **Does `when` skip everything?** The skip reason is recorded per session. A
   condition reading a payload key the agents never emit skips every session.
5. **Are evaluations timing out?** Check the worker's own log. Make judges `async`
   and give them a `timeout_seconds` / `timeoutSeconds` that covers one model
   call.

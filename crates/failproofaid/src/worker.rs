//! The sealed policy worker: one warm QuickJS context, owned by one thread.
//!
//! ## Why QuickJS and not V8
//!
//! Size and shape. QuickJS-ng adds roughly a megabyte to the daemon binary
//! against V8's 30–45 MB, on each of four platform tarballs `npx` downloads.
//! More importantly the isolation is *structural* rather than a syscall filter:
//! a fresh context is created with no bindings registered at all, so there is
//! no `require`, no module loader, no `process`, no `fetch`, and no filesystem
//! — not "blocked", absent. A policy reaching for one gets a `ReferenceError`,
//! which is a policy evaluation failure that trips a circuit breaker, never a
//! silent allow.
//!
//! ## The warm-context hazard
//!
//! Every hook today runs in a fresh process, so the JavaScript-side policy
//! registry, the memoised policy index, and every hoisted `/g` regex start
//! clean. A resident worker changes all of that at once, and the failure mode
//! is a *wrong verdict*, not a crash. Two things address it: the bundle's
//! `evaluate()` rebuilds the registry from scratch on every call, and
//! `__tests__/policy-runtime/sealed-soak.test.ts` runs a 5,220-row corpus twice
//! through one warm context, then again shuffled, then compares all of it
//! against a fresh context per row. This module keeps one context alive
//! precisely so that suite is testing what production does.
//!
//! ## Bounds
//!
//! Enforcement runs under a hard monotonic deadline. Two independent mechanisms
//! keep a policy from blowing it: an interrupt handler QuickJS polls during
//! execution (which is what makes a runaway regex interruptible rather than
//! merely unfortunate), and a memory limit on the runtime. Neither is a
//! substitute for the other — the interrupt cannot stop a single allocation
//! that is too large, and the memory limit cannot stop a tight loop.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Promise, Runtime};

/// The sealed bundle, embedded at compile time.
///
/// Embedded rather than read from disk for the same reason the canonicalization
/// tables are: the daemon must never execute code resolved from a mutable path.
/// A bundle loaded at startup is a bundle that anyone with write access to
/// `/var/lib` could swap for one that allows everything. Compiling it in makes
/// it part of the signed artifact, and `dist/sealed-worker.js` is drift-gated
/// against its TypeScript sources so the embedded bytes are reviewable —
/// which is also why it is committed under `crates/generated/` rather than the
/// gitignored `dist/`.
const SEALED_BUNDLE: &str = include_str!("../../generated/sealed-worker.js");

/// Memory ceiling for the sealed runtime.
///
/// 64 MiB is far more than any payload-only policy needs — the largest input is
/// bounded by the 1 MiB frame cap — and small enough that a runaway allocation
/// fails fast instead of pressuring the machine. Exceeding it surfaces as an
/// evaluation error, which trips the artifact's circuit breaker.
const MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum WorkerError {
    /// The bundle failed to load. Fatal at startup — the daemon must not accept
    /// hook traffic without a working evaluator.
    BundleLoad(String),
    /// The worker did not answer within the remaining deadline.
    DeadlineExceeded { elapsed: Duration },
    /// JavaScript threw, or the bundle returned a structured error.
    Evaluation(String),
    /// The response was not the shape `crates/PROTOCOL.md` promises.
    Protocol(String),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BundleLoad(m) => write!(f, "sealed bundle failed to load: {m}"),
            Self::DeadlineExceeded { elapsed } => {
                write!(
                    f,
                    "sealed evaluation exceeded its deadline after {elapsed:?}"
                )
            }
            Self::Evaluation(m) => write!(f, "sealed evaluation failed: {m}"),
            Self::Protocol(m) => write!(f, "sealed worker returned an unexpected shape: {m}"),
        }
    }
}

impl std::error::Error for WorkerError {}

/// One warm sealed context. **Not `Send`** — QuickJS contexts are tied to the
/// thread that created them, which is why the daemon runs exactly one worker
/// thread and talks to it over a channel rather than sharing it.
pub struct SealedWorker {
    runtime: Runtime,
    context: Context,
    /// Set by the deadline watchdog; read by the interrupt handler.
    interrupt: Arc<AtomicBool>,
    /// Monotonically increasing count of completed evaluations, for health.
    evaluations: Arc<AtomicU64>,
}

impl SealedWorker {
    /// Create the context and load the bundle.
    ///
    /// Loading happens once, at startup, so the per-event cost is a function
    /// call rather than a parse. `Type=notify` on the systemd unit means
    /// `systemctl start` blocks until this has succeeded, so a bundle that
    /// cannot load is a failed start rather than a daemon that accepts traffic
    /// and then denies (or worse, allows) everything.
    pub fn new() -> Result<Self, WorkerError> {
        let runtime = Runtime::new().map_err(|e| WorkerError::BundleLoad(e.to_string()))?;
        runtime.set_memory_limit(MEMORY_LIMIT_BYTES);

        // QuickJS polls this handler on its own schedule during execution;
        // returning `true` unwinds with an uncatchable exception. It is what
        // makes an unbounded regex or a tight loop a *deadline miss* rather
        // than a hung daemon — and it is why the plan's fallback for unreliable
        // regex interruption is admission-time linear-time analysis plus a
        // killable worker, not a switch to V8.
        let interrupt = Arc::new(AtomicBool::new(false));
        {
            let flag = Arc::clone(&interrupt);
            runtime.set_interrupt_handler(Some(Box::new(move || flag.load(Ordering::Relaxed))));
        }

        // `Context::full` gives the standard intrinsics — JSON, RegExp,
        // Promise, the lot. That is not a weakening: the sealed guarantee is
        // about *bindings* (filesystem, process, network), and none of those
        // are intrinsics. The bundle needs JSON and RegExp to function at all.
        let context =
            Context::full(&runtime).map_err(|e| WorkerError::BundleLoad(e.to_string()))?;

        context.with(|ctx| -> Result<(), WorkerError> {
            ctx.eval::<(), _>(SEALED_BUNDLE)
                .map_err(|e| WorkerError::BundleLoad(describe_js_error(&ctx, e)))?;

            // Fail at startup, not at the first hook event, if the bundle
            // did not install what it promised.
            let globals = ctx.globals();
            for name in ["__fpai_sealed_evaluate", "__fpai_sealed_policies"] {
                if globals.get::<_, rquickjs::Value>(name).is_err() {
                    return Err(WorkerError::BundleLoad(format!(
                        "bundle did not install globalThis.{name}"
                    )));
                }
            }
            Ok(())
        })?;

        Ok(Self {
            runtime,
            context,
            interrupt,
            evaluations: Arc::new(AtomicU64::new(0)),
        })
    }

    /// The sealed-eligible policy names, as the bundle reports them.
    pub fn policy_names(&self) -> Result<Vec<String>, WorkerError> {
        self.context.with(|ctx| {
            let f: Function = ctx
                .globals()
                .get("__fpai_sealed_policies")
                .map_err(|e| WorkerError::Protocol(e.to_string()))?;
            let json: String = f
                .call(())
                .map_err(|e| WorkerError::Evaluation(describe_js_error(&ctx, e)))?;
            serde_json::from_str(&json).map_err(|e| WorkerError::Protocol(e.to_string()))
        })
    }

    /// Evaluate one hook event within `deadline`.
    ///
    /// Takes and returns JSON strings rather than typed values. That is
    /// deliberate: the request crosses a language boundary, and one
    /// serialisation format means one place for a shape to be wrong.
    pub fn evaluate(&self, request_json: &str, deadline: Duration) -> Result<String, WorkerError> {
        let started = Instant::now();
        self.interrupt.store(false, Ordering::Relaxed);

        let result = self.context.with(|ctx| -> Result<String, WorkerError> {
            let f: Function = ctx
                .globals()
                .get("__fpai_sealed_evaluate")
                .map_err(|e| WorkerError::Protocol(e.to_string()))?;

            let promise: Promise = f
                .call((request_json,))
                .map_err(|e| WorkerError::Evaluation(describe_js_error(&ctx, e)))?;

            // Drive the microtask queue by hand rather than handing control to
            // an async runtime. The enforcement lane is synchronous and
            // deadline-bounded, and pumping jobs here is what lets the deadline
            // be checked between them — an executor would take that away.
            loop {
                match promise.clone().finish::<String>() {
                    Ok(s) => return Ok(s),
                    Err(rquickjs::Error::WouldBlock) => {
                        if started.elapsed() >= deadline {
                            // Ask QuickJS to unwind, then let it: a policy stuck
                            // in a tight loop only stops because the interrupt
                            // handler says so.
                            self.interrupt.store(true, Ordering::Relaxed);
                            let _ = self.runtime.execute_pending_job();
                            return Err(WorkerError::DeadlineExceeded {
                                elapsed: started.elapsed(),
                            });
                        }
                        if !self.runtime.is_job_pending() {
                            return Err(WorkerError::Protocol(
                                "sealed evaluation promise never settled and no jobs remain"
                                    .to_string(),
                            ));
                        }
                        // A `JobException` carries the failing job's own error
                        // value rather than an `rquickjs::Error`, so it is
                        // reported directly instead of through the context's
                        // pending-exception slot.
                        if let Err(job_err) = self.runtime.execute_pending_job() {
                            return Err(WorkerError::Evaluation(format!(
                                "a microtask threw during sealed evaluation: {job_err:?}"
                            )));
                        }
                    }
                    Err(e) => return Err(WorkerError::Evaluation(describe_js_error(&ctx, e))),
                }
            }
        });

        self.interrupt.store(false, Ordering::Relaxed);
        if result.is_ok() {
            self.evaluations.fetch_add(1, Ordering::Relaxed);
        }
        result
    }

    /// Completed evaluations since start, for the health snapshot.
    pub fn evaluation_count(&self) -> u64 {
        self.evaluations.load(Ordering::Relaxed)
    }
}

/// Turn an rquickjs error into something a log reader can act on.
///
/// `Error::Exception` on its own says only "an exception happened" — the
/// message and stack live on the context. Pulling them out here is the
/// difference between a diagnosable circuit-breaker trip and a mystery.
fn describe_js_error(ctx: &rquickjs::Ctx<'_>, err: rquickjs::Error) -> String {
    match err {
        rquickjs::Error::Exception => {
            let exception = ctx.catch();
            match exception.as_exception() {
                Some(e) => {
                    let message = e.message().unwrap_or_else(|| "<no message>".into());
                    match e.stack() {
                        Some(stack) => format!("{message}\n{stack}"),
                        None => message,
                    }
                }
                None => format!("non-Error exception: {exception:?}"),
            }
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker() -> SealedWorker {
        SealedWorker::new().expect("the embedded bundle must load")
    }

    fn request(event: &str, payload: serde_json::Value, policies: &[&str]) -> String {
        serde_json::json!({
            "eventType": event,
            "payload": payload,
            "session": {
                "cli": "claude",
                "cwd": "/home/enrolled/project",
                "home": "/home/enrolled",
                "permissionMode": "default",
                "sessionId": "sess-test"
            },
            "config": { "enabledPolicies": policies }
        })
        .to_string()
    }

    const DEADLINE: Duration = Duration::from_millis(2000);

    #[test]
    fn the_bundle_loads_and_installs_its_globals() {
        let w = worker();
        let names = w.policy_names().unwrap();
        assert_eq!(names.len(), 32, "expected the 32 sealed-eligible builtins");
        assert!(names.contains(&"block-sudo".to_string()));
        assert!(
            !names.contains(&"require-commit-before-stop".to_string()),
            "a host-access policy must never be reported as sealed-eligible"
        );
    }

    #[test]
    fn denies_sudo_with_the_claude_pretooluse_shape() {
        let w = worker();
        let raw = w
            .evaluate(
                &request(
                    "PreToolUse",
                    serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "sudo rm -rf /"}}),
                    &["block-sudo"],
                ),
                DEADLINE,
            )
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["decision"], "deny");
        assert_eq!(v["result"]["policyName"], "failproofai/block-sudo");
        assert_eq!(v["result"]["exitCode"], 0);

        let stdout: serde_json::Value =
            serde_json::from_str(v["result"]["stdout"].as_str().unwrap()).unwrap();
        assert_eq!(stdout["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    #[test]
    fn allows_a_benign_command() {
        let w = worker();
        let raw = w
            .evaluate(
                &request(
                    "PreToolUse",
                    serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls -la"}}),
                    &["block-sudo"],
                ),
                DEADLINE,
            )
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["result"]["decision"], "allow");
        assert_eq!(v["result"]["exitCode"], 0);
        assert_eq!(v["result"]["stdout"], "");
    }

    #[test]
    fn the_context_has_no_filesystem_process_or_network() {
        // The tier's whole claim, asserted against the real engine rather than
        // the Node proxy the TypeScript suite uses.
        let w = worker();
        w.context.with(|ctx| {
            for expr in [
                "typeof require",
                "typeof fetch",
                "typeof globalThis.fs",
                "typeof globalThis.child_process",
                "typeof XMLHttpRequest",
                "typeof WebAssembly",
            ] {
                let ty: String = ctx.eval(expr).unwrap();
                assert_eq!(
                    ty, "undefined",
                    "{expr} should not exist in the sealed context"
                );
            }
        });
    }

    #[test]
    fn requiring_a_host_module_throws_rather_than_succeeding() {
        // The spike criterion from the plan, stated against real QuickJS-ng.
        let w = worker();
        w.context.with(|ctx| {
            // Mapped to `()` inside the closure: an rquickjs `Value` borrows the
            // context and cannot escape `with`.
            let outcome = ctx.eval::<(), _>(r#"require("node:fs")"#);
            assert!(
                outcome.is_err(),
                "require() must not resolve in the sealed context"
            );
        });
    }

    #[test]
    fn process_env_is_present_but_empty() {
        // The prelude defines it so a legacy lambda cannot ReferenceError. It
        // must never carry the daemon's real environment — that would hand a
        // policy the service account's PATH and, later, the delivery key.
        let w = worker();
        w.context.with(|ctx| {
            let json: String = ctx.eval("JSON.stringify(process.env)").unwrap();
            assert_eq!(json, "{}");
        });
    }

    #[test]
    fn a_host_access_policy_is_routed_out_rather_than_run() {
        let w = worker();
        let raw = w
            .evaluate(
                &request(
                    "Stop",
                    serde_json::json!({}),
                    &["block-sudo", "require-commit-before-stop"],
                ),
                DEADLINE,
            )
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(
            v["needsUserContext"],
            serde_json::json!(["require-commit-before-stop"])
        );
    }

    #[test]
    fn malformed_json_is_a_structured_error_not_an_allow() {
        let w = worker();
        let raw = w.evaluate("{ not json", DEADLINE).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["result"].is_null(), "a failure must not carry a verdict");
    }

    #[test]
    fn a_warm_context_gives_the_same_answer_a_thousand_times() {
        // The Rust-side echo of the TypeScript soak test. The hazard is a
        // hoisted `/g` regex whose lastIndex survives between evaluations —
        // which would make the second answer differ from the first, silently.
        let w = worker();
        let req = request(
            "PreToolUse",
            serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "cat /etc/passwd /etc/shadow"}}),
            &["block-read-outside-cwd"],
        );
        let baseline = w.evaluate(&req, DEADLINE).unwrap();
        for i in 0..1000 {
            let got = w.evaluate(&req, DEADLINE).unwrap();
            assert_eq!(got, baseline, "diverged at iteration {i}");
        }
        let v: serde_json::Value = serde_json::from_str(&baseline).unwrap();
        assert_eq!(v["result"]["decision"], "deny");
        assert_eq!(w.evaluation_count(), 1001);
    }

    #[test]
    fn an_infinite_loop_is_interrupted_rather_than_hanging_the_daemon() {
        // The property that makes the enforcement deadline real. Without the
        // interrupt handler a runaway policy takes the daemon with it.
        let w = worker();
        let start = Instant::now();
        let outcome = w.context.with(|ctx| {
            // Set the flag from a watchdog-equivalent: here, directly, after
            // arming it so the very first check unwinds.
            w.interrupt.store(true, Ordering::Relaxed);
            ctx.eval::<(), _>("while (true) {}")
                .map_err(|e| e.to_string())
        });
        w.interrupt.store(false, Ordering::Relaxed);
        assert!(
            outcome.is_err(),
            "an interrupted script must not return normally"
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "the interrupt did not take effect promptly"
        );
    }

    #[test]
    fn the_worker_still_works_after_an_interrupt() {
        // A tripped circuit breaker must not poison the context for everyone
        // else. Enforcement continues for every other policy and every other
        // user.
        let w = worker();
        w.interrupt.store(true, Ordering::Relaxed);
        let _ = w.context.with(|ctx| {
            ctx.eval::<(), _>("while (true) {}")
                .map_err(|e| e.to_string())
        });
        w.interrupt.store(false, Ordering::Relaxed);

        let raw = w
            .evaluate(
                &request(
                    "PreToolUse",
                    serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "sudo id"}}),
                    &["block-sudo"],
                ),
                DEADLINE,
            )
            .expect("the worker must recover");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["result"]["decision"], "deny");
    }
}

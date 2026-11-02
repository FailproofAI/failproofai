/**
 * failproofai policy bridge for OpenClaw (openclaw gateway).
 *
 * Loaded in-process by the gateway (registered via `plugins.load.paths` +
 * `plugins.entries.failproofai` in ~/.openclaw/openclaw.json). It subscribes to
 * OpenClaw's typed PLUGIN hooks — the only surface that can block; OpenClaw's
 * file-based "internal hooks" are observation-only — and asks failproofaid for
 * each verdict over its Unix socket (daemon-client.js), the way the Hermes
 * plugin does. The daemon answers with the flat `{permission, reason}` verdict
 * `failproofai --hook <event> --cli openclaw` prints; hooks.js maps it to each
 * hook's native return shape. On before_tool_call, an `instruct` verdict uses a
 * one-shot blockReason as OpenClaw's model-visible instruction channel; retries
 * from the same session/policy are allowed for a short window.
 *
 * Marker comment for failproofai's installer detection (do not remove):
 *   __failproofai_hook__: true
 *
 * Design notes:
 *  • No process per hook, and no path outside this directory. OpenClaw ≥
 *    2026.9.6 imports plugins from a copy under ~/.openclaw/tmp/plugin-captures,
 *    so a CLI located relative to this file is not there; the shim that spawned
 *    one allowed every call once that started. Every module here imports only
 *    node built-ins and its siblings.
 *  • Non-blocking — the gateway is a long-running multi-channel process, so all
 *    I/O is async; a synchronous call on every hook would stall every channel.
 *  • No top-level `await` — OpenClaw's plugin loader rejects it; all async work
 *    happens inside register()'s handlers.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFailproofaiHooks } from "./hooks.js";

export default definePluginEntry({
  id: "failproofai",
  name: "failproofai",
  description: "Real-time policy enforcement for OpenClaw by failproofai",
  register(api) {
    registerFailproofaiHooks(api);
  },
});

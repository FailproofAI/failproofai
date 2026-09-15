from __future__ import annotations

import importlib.util
import json
import socket
import struct
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = REPO_ROOT / "hermes-plugin"


def load_plugin():
    package_name = "failproofai_hermes_plugin_test"
    spec = importlib.util.spec_from_file_location(
        package_name,
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load Hermes plugin")
    module = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = module
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()
client = sys.modules[f"{plugin.__name__}.client"]
ledger_mod = sys.modules[f"{plugin.__name__}.ledger"]


class FakeContext:
    def __init__(self, data_dir: Path, settings: dict[str, object] | None = None) -> None:
        self.state = SimpleNamespace(data_dir=data_dir)
        self.settings = settings or {}
        self.hooks: dict[str, object] = {}

    def get_config(self, key: str, default=None):
        return self.settings.get(key, default)

    def register_hook(self, name: str, callback) -> None:
        self.hooks[name] = callback


class LedgerTests(unittest.TestCase):
    def test_instruction_blocks_once_then_allows_a_later_api_iteration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "instructions.db"
            ledger = ledger_mod.InstructionLedger(path, ttl_seconds=60, max_rounds=2)
            base = dict(
                profile="default",
                session_id="session-1",
                task_id="task-1",
                turn_id="turn-1",
                policy_names=("custom/write-route",),
                reason="Use the approved write route.",
                scope_key="Write",
                now_ms=1_000,
            )
            self.assertEqual(
                ledger.decide(api_request_id="api-1", **base),
                ledger_mod.InstructionAction(True, "issued"),
            )
            self.assertEqual(
                ledger.decide(api_request_id="api-1", **base),
                ledger_mod.InstructionAction(True, "same-api-request"),
            )

            # A fresh object proves the permit survives plugin-object restart.
            restarted = ledger_mod.InstructionLedger(path, ttl_seconds=60, max_rounds=2)
            self.assertEqual(
                restarted.decide(api_request_id="api-2", **base),
                ledger_mod.InstructionAction(False, "acknowledged"),
            )
            self.assertEqual(
                restarted.decide(api_request_id="api-3", **base),
                ledger_mod.InstructionAction(False, "acknowledged"),
            )

    def test_same_api_request_siblings_block_and_turn_cap_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = ledger_mod.InstructionLedger(
                Path(tmp) / "instructions.db", ttl_seconds=60, max_rounds=1
            )
            common = dict(
                profile="default",
                session_id="session-1",
                task_id="task-1",
                turn_id="turn-1",
                api_request_id="api-1",
                scope_key="Write",
                now_ms=1_000,
            )
            first = ledger.decide(
                policy_names=("custom/first",), reason="first", **common
            )
            sibling = ledger.decide(
                policy_names=("custom/first",), reason="first", **common
            )
            capped = ledger.decide(
                policy_names=("custom/second",), reason="second", **common
            )
            self.assertEqual(first.status, "issued")
            self.assertTrue(sibling.block)
            self.assertEqual(capped, ledger_mod.InstructionAction(False, "turn-cap"))

    def test_missing_iteration_identity_fails_open_for_instruct(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = ledger_mod.InstructionLedger(Path(tmp) / "instructions.db")
            action = ledger.decide(
                profile="default",
                session_id="session-1",
                task_id="task-1",
                turn_id="",
                api_request_id="",
                policy_names=("custom/write-route",),
                reason="guide",
                scope_key="Write",
            )
            self.assertEqual(action, ledger_mod.InstructionAction(False, "missing-correlation-id"))

    def test_state_isolated_by_profile_session_task_turn_policy_and_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = ledger_mod.InstructionLedger(
                Path(tmp) / "instructions.db", ttl_seconds=60, max_rounds=10
            )
            base = dict(
                profile="default",
                session_id="session-1",
                task_id="task-1",
                turn_id="turn-1",
                api_request_id="api-1",
                policy_names=("custom/write-route",),
                reason="Use the approved write route.",
                scope_key="Write",
                now_ms=1_000,
            )
            self.assertTrue(ledger.decide(**base).block)
            for changed in (
                {"profile": "other"},
                {"session_id": "session-2"},
                {"task_id": "task-2"},
                {"turn_id": "turn-2"},
                {"policy_names": ("custom/other",)},
                {"scope_key": "Bash"},
            ):
                self.assertTrue(ledger.decide(**{**base, **changed}).block)

    def test_expired_delivery_blocks_again_and_session_cleanup_removes_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = ledger_mod.InstructionLedger(
                Path(tmp) / "instructions.db", ttl_seconds=60, max_rounds=2
            )
            base = dict(
                profile="default",
                session_id="session-1",
                task_id="task-1",
                turn_id="turn-1",
                policy_names=("custom/write-route",),
                reason="Use the approved write route.",
                scope_key="Write",
            )
            self.assertTrue(ledger.decide(api_request_id="api-1", now_ms=1_000, **base).block)
            self.assertFalse(ledger.decide(api_request_id="api-2", now_ms=2_000, **base).block)
            ledger.clear_session("session-1")
            self.assertEqual(
                ledger.decide(api_request_id="api-3", now_ms=3_000, **base).status,
                "issued",
            )
            self.assertEqual(
                ledger.decide(api_request_id="api-4", now_ms=63_001, **base).status,
                "issued",
            )

    def test_concurrent_siblings_from_one_api_response_both_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ledger = ledger_mod.InstructionLedger(
                Path(tmp) / "instructions.db", ttl_seconds=60, max_rounds=2
            )
            ledger._ensure_schema()
            barrier = threading.Barrier(2)

            def decide():
                barrier.wait(timeout=2)
                return ledger.decide(
                    profile="default",
                    session_id="session-1",
                    task_id="task-1",
                    turn_id="turn-1",
                    api_request_id="api-1",
                    policy_names=("custom/write-route",),
                    reason="Use the approved write route.",
                    scope_key="Write",
                    now_ms=1_000,
                )

            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: decide(), range(2)))
            self.assertTrue(all(result.block for result in results))
            self.assertEqual(
                {result.status for result in results},
                {"issued", "same-api-request"},
            )

    def test_corrupt_database_raises_a_ledger_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "instructions.db"
            path.write_text("not sqlite", encoding="utf-8")
            ledger = ledger_mod.InstructionLedger(path)
            with self.assertRaises(ledger_mod.LedgerError):
                ledger.decide(
                    profile="default",
                    session_id="session-1",
                    task_id="task-1",
                    turn_id="turn-1",
                    api_request_id="api-1",
                    policy_names=("custom/write-route",),
                    reason="guide",
                    scope_key="Write",
                )


class PluginTests(unittest.TestCase):
    def test_registers_the_supported_hermes_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ctx = FakeContext(Path(tmp))
            plugin.register(ctx)
            self.assertEqual(
                set(ctx.hooks),
                {
                    "pre_tool_call",
                    "post_tool_call",
                    "pre_llm_call",
                    "on_session_start",
                    "on_session_end",
                    "on_session_reset",
                    "on_session_finalize",
                    "subagent_stop",
                },
            )

    def test_deny_always_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(FakeContext(Path(tmp)))
            verdict = client.PolicyVerdict(
                decision="deny",
                policy_names=("failproofai/block-sudo",),
                reason="Do not use sudo.",
                matched_policies=("failproofai/block-sudo",),
                duration_ms=1,
                tool_name="Bash",
            )
            with patch.object(plugin, "evaluate_policy", return_value=verdict):
                result = instance.pre_tool_call(
                    tool_name="terminal",
                    args={"command": "sudo whoami"},
                    session_id="s",
                    turn_id="t",
                    api_request_id="a",
                )
            self.assertEqual(result, {"action": "block", "message": "Do not use sudo."})

    def test_instruct_blocks_once_and_then_allows_the_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(FakeContext(Path(tmp)))
            verdict = client.PolicyVerdict(
                decision="instruct",
                policy_names=("custom/write-route",),
                reason="Use the approved write route.",
                matched_policies=("custom/write-route",),
                duration_ms=1,
                tool_name="Write",
            )
            with patch.object(plugin, "evaluate_policy", return_value=verdict):
                first = instance.pre_tool_call(
                    tool_name="write_file",
                    args={"path": "/tmp/a"},
                    session_id="s",
                    task_id="root",
                    turn_id="t",
                    api_request_id="a1",
                )
                retry = instance.pre_tool_call(
                    tool_name="write_file",
                    args={"path": "/tmp/a"},
                    session_id="s",
                    task_id="root",
                    turn_id="t",
                    api_request_id="a2",
                )
            self.assertEqual(first["action"], "block")
            self.assertIn("FAILPROOF INSTRUCTION", first["message"])
            self.assertIn("Do not route around", first["message"])
            self.assertIsNone(retry)

    def test_instruction_state_failure_allows_but_evaluator_failure_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(FakeContext(Path(tmp)))
            verdict = client.PolicyVerdict(
                decision="instruct",
                policy_names=("custom/write-route",),
                reason="Use the approved route.",
                matched_policies=("custom/write-route",),
                duration_ms=1,
                tool_name="Write",
            )
            with patch.object(plugin, "evaluate_policy", return_value=verdict), patch.object(
                instance.ledger, "decide", side_effect=ledger_mod.LedgerError("broken")
            ):
                self.assertIsNone(
                    instance.pre_tool_call(
                        tool_name="write_file",
                        session_id="s",
                        turn_id="t",
                        api_request_id="a",
                    )
                )

            with patch.object(
                plugin, "evaluate_policy", side_effect=client.EvaluationError("offline")
            ):
                result = instance.pre_tool_call(tool_name="terminal")
            self.assertEqual(result["action"], "block")
            self.assertIn("evaluator is unavailable", result["message"])

    def test_deny_is_never_weakened_by_an_existing_instruction_permit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(FakeContext(Path(tmp)))
            instruct = client.PolicyVerdict(
                decision="instruct",
                policy_names=("custom/write-route",),
                reason="Use the approved route.",
                matched_policies=("custom/write-route",),
                duration_ms=1,
                tool_name="Write",
            )
            deny = client.PolicyVerdict(
                decision="deny",
                policy_names=("custom/write-route",),
                reason="This write is forbidden.",
                matched_policies=("custom/write-route",),
                duration_ms=1,
                tool_name="Write",
            )
            with patch.object(plugin, "evaluate_policy", side_effect=(instruct, instruct, deny)):
                self.assertIsNotNone(
                    instance.pre_tool_call(
                        tool_name="write_file",
                        session_id="s",
                        turn_id="t",
                        api_request_id="a1",
                    )
                )
                self.assertIsNone(
                    instance.pre_tool_call(
                        tool_name="write_file",
                        session_id="s",
                        turn_id="t",
                        api_request_id="a2",
                    )
                )
                result = instance.pre_tool_call(
                    tool_name="write_file",
                    session_id="s",
                    turn_id="t",
                    api_request_id="a3",
                )
            self.assertEqual(
                result,
                {"action": "block", "message": "This write is forbidden."},
            )

    def test_evaluator_failure_can_be_configured_to_allow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(
                FakeContext(Path(tmp), {"failure_mode": "allow"})
            )
            with patch.object(
                plugin, "evaluate_policy", side_effect=client.EvaluationError("offline")
            ):
                self.assertIsNone(instance.pre_tool_call(tool_name="terminal"))

    def test_observation_errors_never_break_the_agent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(FakeContext(Path(tmp)))
            with patch.object(plugin, "evaluate_policy", side_effect=RuntimeError("bug")):
                self.assertIsNone(
                    instance.post_tool_call(
                        tool_name="terminal",
                        args={"command": "true"},
                        result="ok",
                        session_id="s",
                    )
                )

    def test_pre_llm_context_explains_instruction_results(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            instance = plugin.FailproofAIPlugin(FakeContext(Path(tmp)))
            result = instance.pre_llm_call()
            self.assertIn("FAILPROOF INSTRUCTION", result["context"])
            self.assertIn("Do not evade or ignore", result["context"])


class ClientTests(unittest.TestCase):
    def test_client_speaks_the_framed_policy_protocol(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            socket_path = Path(tmp) / "daemon.sock"
            received: dict[str, object] = {}
            ready = threading.Event()

            def server() -> None:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(str(socket_path))
                    listener.listen(1)
                    ready.set()
                    connection, _ = listener.accept()
                    with connection:
                        length = struct.unpack(">I", client._read_exact(connection, 4))[0]
                        received.update(json.loads(client._read_exact(connection, length)))
                        body = json.dumps(
                            {
                                "type": "policyResult",
                                "protocolVersion": 1,
                                "decision": "instruct",
                                "policyNames": ["custom/write-route"],
                                "reason": "Use the approved route.",
                                "matchedPolicies": ["custom/write-route"],
                                "durationMs": 3,
                                "toolName": "Write",
                            },
                            separators=(",", ":"),
                        ).encode()
                        connection.sendall(struct.pack(">I", len(body)) + body)

            thread = threading.Thread(target=server, daemon=True)
            thread.start()
            self.assertTrue(ready.wait(timeout=2))
            with patch.dict("os.environ", {"FAILPROOFAI_DAEMON_SOCKET": str(socket_path)}):
                verdict = client.evaluate_policy(
                    event="pre_tool_call",
                    payload={"tool_name": "write_file", "tool_input": {"path": "/tmp/a"}},
                    cwd="/tmp",
                )
            thread.join(timeout=2)
            self.assertEqual(received["type"], "policyEvaluation")
            self.assertEqual(received["integration"], "hermes")
            self.assertEqual(verdict.decision, "instruct")
            self.assertEqual(verdict.tool_name, "Write")

    def test_client_rejects_protocol_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            socket_path = Path(tmp) / "daemon.sock"
            ready = threading.Event()

            def server() -> None:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(str(socket_path))
                    listener.listen(1)
                    ready.set()
                    connection, _ = listener.accept()
                    with connection:
                        length = struct.unpack(">I", client._read_exact(connection, 4))[0]
                        client._read_exact(connection, length)
                        body = json.dumps(
                            {
                                "type": "policyResult",
                                "protocolVersion": 99,
                                "decision": "allow",
                                "policyNames": [],
                                "matchedPolicies": [],
                                "durationMs": 0,
                            }
                        ).encode()
                        connection.sendall(struct.pack(">I", len(body)) + body)

            thread = threading.Thread(target=server, daemon=True)
            thread.start()
            self.assertTrue(ready.wait(timeout=2))
            with patch.dict("os.environ", {"FAILPROOFAI_DAEMON_SOCKET": str(socket_path)}):
                with self.assertRaisesRegex(client.EvaluationError, "version mismatch"):
                    client.evaluate_policy(event="pre_tool_call", payload={}, cwd="/tmp")
            thread.join(timeout=2)

    def test_client_rejects_an_oversized_response_before_reading_its_body(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            socket_path = Path(tmp) / "daemon.sock"
            ready = threading.Event()

            def server() -> None:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(str(socket_path))
                    listener.listen(1)
                    ready.set()
                    connection, _ = listener.accept()
                    with connection:
                        length = struct.unpack(">I", client._read_exact(connection, 4))[0]
                        client._read_exact(connection, length)
                        connection.sendall(struct.pack(">I", client.MAX_FRAME_BYTES + 1))

            thread = threading.Thread(target=server, daemon=True)
            thread.start()
            self.assertTrue(ready.wait(timeout=2))
            with patch.dict("os.environ", {"FAILPROOFAI_DAEMON_SOCKET": str(socket_path)}):
                with self.assertRaisesRegex(client.EvaluationError, "16 MiB limit"):
                    client.evaluate_policy(event="pre_tool_call", payload={}, cwd="/tmp")
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()

"""Start pinned GLSim with its Windows direct-loader compatibility shim."""

from __future__ import annotations

import base64
import copy
import json
import os
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path

import glsim.consensus as glsim_consensus
from glsim import server as glsim_server
from glsim.server import create_app, run_server
from gltest.direct.sdk_loader import setup_sdk_paths

from glsim_support import GENVM_VERSION, RUNNER_FINGERPRINT, scoped_fd0_injection
from glsim_support import decode_binary_web_mocks


session_id = os.environ.get("ACCESSSEAL_GLSIM_SESSION_ID")
if not session_id:
    raise RuntimeError("ACCESSSEAL_GLSIM_SESSION_ID is required")
if version("genlayer-test") != RUNNER_FINGERPRINT["glsimVersion"]:
    raise RuntimeError("pinned genlayer-test version mismatch")

_validator_telemetry: list[dict[str, object]] = []
_active_telemetry: dict[str, object] | None = None
_run_validators = glsim_consensus._run_validators
_restore_storages = glsim_consensus._restore_storages
_snapshot_storages = glsim_consensus._snapshot_storages


def _snapshot_storages_with_instances(engine):
    snapshot = _snapshot_storages(engine)
    snapshot["instances"] = copy.deepcopy(engine._instances)
    return snapshot


def _restore_storages_without_stale_instances(engine, snapshot, state_snapshot_id):
    _restore_storages(engine, snapshot, state_snapshot_id)
    # GLSim restores the storage map after a failed consensus rotation but
    # retains cached contract instances that still reference leader-mutated
    # storage. Evicting the cache makes the next read/call reload the restored
    # state, matching the rollback boundary the integration tests exercise.
    engine._instances = snapshot["instances"]


glsim_consensus._restore_storages = _restore_storages_without_stale_instances
glsim_consensus._snapshot_storages = _snapshot_storages_with_instances


def _telemetry_run_validators(vm, captured, num_validators):
    import genlayer.gl.vm as gl_vm

    votes = []
    validator_configs = getattr(vm, "_accessseal_validator_configs", [])
    for node in range(num_validators):
        if validator_configs:
            _install_validator_node_mocks(vm, validator_configs[node])
        configured_timeout = bool(
            validator_configs
            and validator_configs[node].get("config", {}).get(
                "accesssealCallbackTimeout", False
            )
        )
        all_agree = True
        for stored_result, _leader_fn, validator_fn in captured:
            if _active_telemetry is not None:
                _active_telemetry["callbackInvocations"] += 1
                _active_telemetry["activeValidator"] = node
            if configured_timeout:
                if _active_telemetry is not None:
                    _active_telemetry.setdefault("validatorOutcomes", []).append(
                        {"node": node, "agreed": False, "timedOut": True}
                    )
                all_agree = False
                break
            try:
                agreed = validator_fn(gl_vm.Return(calldata=stored_result))
                if _active_telemetry is not None:
                    _active_telemetry.setdefault("validatorOutcomes", []).append(
                        {"node": node, "agreed": agreed}
                    )
                if not agreed:
                    all_agree = False
                    break
            except Exception:
                all_agree = False
                break
        votes.append("agree" if all_agree else "disagree")
    if _active_telemetry is not None:
        _active_telemetry.pop("activeValidator", None)
    return votes


glsim_consensus._run_validators = _telemetry_run_validators
_run_consensus = glsim_server.run_consensus


def _telemetry_run_consensus(*args, **kwargs):
    global _active_telemetry
    session = {
        "callbackInvocations": 0,
        "capturedValidatorSessions": 0,
        "sealArtifactFetches": 0,
        "reviewArtifactRefetches": 0,
        "reviewImageFetches": 0,
        "reviewAiCalls": 0,
        "method": "",
        "nodes": {},
    }
    _active_telemetry = session
    try:
        result = _run_consensus(*args, **kwargs)
        if session["callbackInvocations"] > 0:
            session["capturedValidatorSessions"] = 1
        return result
    finally:
        _validator_telemetry.append(session)
        _active_telemetry = None


glsim_server.run_consensus = _telemetry_run_consensus


app = create_app(
    num_validators=5,
    max_rotations=3,
    chain_id=61127,
    llm_provider=None,
    use_browser=True,
    verbose=False,
    seed="accessseal-task-6",
)
setup_sdk_paths(Path("contracts/access_seal.py"), version=GENVM_VERSION)
for module_name in list(sys.modules):
    if module_name == "genlayer" or module_name.startswith("genlayer."):
        sys.modules.pop(module_name, None)

from gltest.direct import loader as direct_loader

_inject_message_to_fd0 = direct_loader._inject_message_to_fd0


def _scoped_inject_message_to_fd0(vm):
    # Every loader invocation receives a fresh, narrowly scoped patch matching
    # only the tempfile created by that same invocation. os.unlink is restored
    # before contract loading continues.
    scoped_fd0_injection(_inject_message_to_fd0, vm)


direct_loader._inject_message_to_fd0 = _scoped_inject_message_to_fd0
_scoped_inject_message_to_fd0(app.state.engine.vm)
from genlayer.py.types import Address
from glsim.tx_decoder import decode_calldata_bytes, encode_calldata_result

_engine_call_method = app.state.engine.call_method


def _runtime_call_method(*args, **kwargs):
    # GLSim 0.29.2's warp clock updates the VM context but leaves the raw
    # GenVM message timestamp stale. Direct mode normally synchronizes this
    # field before every invocation, so mirror that transport behavior here.
    import genlayer.gl as gl

    gl.message_raw["datetime"] = app.state.engine.vm.get_message_raw()["datetime"]
    if (
        _active_telemetry is not None
        and not _active_telemetry["method"]
        and len(args) > 1
    ):
        _active_telemetry["method"] = args[1]
    return _engine_call_method(*args, **kwargs)


app.state.engine.call_method = _runtime_call_method


def _typed_call_from_calldata(contract_address, calldata_bytes, sender=None):
    decoded = decode_calldata_bytes(calldata_bytes)
    method = decoded.get("method")
    args = decoded.get("args", [])
    kwargs = decoded.get("kwargs", {})
    # GLSim 0.29.2 loses the ABI address type while decoding SDK calldata.
    # Restore the sole address argument exactly as the GenVM ABI does.
    if method == "create_case" and len(args) > 1 and isinstance(args[1], str):
        args[1] = Address(args[1])
    result = _runtime_call_method(contract_address, method, args, kwargs, sender)
    return result, encode_calldata_result(result)


app.state.engine.call_from_calldata = _typed_call_from_calldata

_accessseal_source_path = Path("contracts/access_seal.py").resolve()
_accessseal_source = _accessseal_source_path.read_bytes()

_install_sim_config_mocks = glsim_server._install_sim_config_mocks


def _clear_node_mocks(vm):
    vm._web_mocks.clear()
    vm._web_mocks_hit.clear()
    vm._llm_mocks.clear()
    vm._llm_mocks_hit.clear()


def _install_validator_node_mocks(vm, validator):
    _clear_node_mocks(vm)
    plugin_config = validator.get("plugin_config", {})
    web = plugin_config.get("mock_web_response", {}).get(
        "nondet_web_request", {}
    )
    decode_binary_web_mocks(web)
    for url, response in web.items():
        vm.mock_web(__import__("re").escape(url), response)
    llm = plugin_config.get("mock_response", {}).get("response", {})
    for pattern, response in llm.items():
        vm.mock_llm(pattern, response)


def _binary_safe_install_sim_config_mocks(engine, sim_config):
    # Mock web responses cross JSON-RPC, whose schema only admits text bodies.
    # Decode the explicit base64 transport envelope to the exact fixture bytes
    # before GLSim installs it; consensus still executes the real web op.
    validators = sim_config.get("validators", []) if isinstance(sim_config, dict) else []
    for validator in validators:
        responses = (
            validator.get("plugin_config", {})
            .get("mock_web_response", {})
            .get("nondet_web_request", {})
        )
        decode_binary_web_mocks(responses)
    overrides = (
        sim_config.get("accesssealValidatorOverrides", [])
        if isinstance(sim_config, dict)
        else []
    )
    engine.vm._accessseal_validator_configs = overrides or validators
    return _install_sim_config_mocks(engine, sim_config)


glsim_server._install_sim_config_mocks = _binary_safe_install_sim_config_mocks


_match_web_mock = app.state.engine.vm._match_web_mock
_match_llm_mock = app.state.engine.vm._match_llm_mock


def _node_telemetry():
    if _active_telemetry is None:
        return None
    node = _active_telemetry.get("activeValidator", "leader")
    nodes = _active_telemetry["nodes"]
    return nodes.setdefault(
        str(node),
        {
            "sealArtifactFetches": 0,
            "reviewArtifactRefetches": 0,
            "reviewImageFetches": 0,
            "reviewAiCalls": 0,
        },
    )


def _increment_telemetry(field):
    node = _node_telemetry()
    if _active_telemetry is not None:
        _active_telemetry[field] += 1
    if node is not None:
        node[field] += 1


def _telemetry_match_web_mock(url, method="GET"):
    if _active_telemetry is not None:
        phase = _active_telemetry.get("method")
        if phase == "close_evidence":
            _increment_telemetry("sealArtifactFetches")
        elif phase == "request_review":
            if str(url).lower().endswith(".png"):
                _increment_telemetry("reviewImageFetches")
            else:
                _increment_telemetry("reviewArtifactRefetches")
    return _match_web_mock(url, method)


def _telemetry_match_llm_mock(prompt):
    if _active_telemetry is not None and _active_telemetry.get("method") == "request_review":
        _increment_telemetry("reviewAiCalls")
    return _match_llm_mock(prompt)


app.state.engine.vm._match_web_mock = _telemetry_match_web_mock
app.state.engine.vm._match_llm_mock = _telemetry_match_llm_mock
_install_persistent_mocks = glsim_server.RPC_METHODS["sim_installMocks"]


def _binary_safe_install_persistent_mocks(state, engine, params):
    web_mocks = params.get("web_mocks", {}) if isinstance(params, dict) else {}
    decode_binary_web_mocks(web_mocks)
    # sim_installMocks is replacement, not append. The pinned GLSim handler
    # re-registers into VM lists without clearing the previous release, which
    # otherwise lets an epoch-0 URL shadow the epoch-1 cure payload.
    engine.vm._web_mocks.clear()
    engine.vm._web_mocks_hit.clear()
    engine.vm._llm_mocks.clear()
    engine.vm._llm_mocks_hit.clear()
    return _install_persistent_mocks(state, engine, params)


glsim_server.RPC_METHODS["sim_installMocks"] = (
    _binary_safe_install_persistent_mocks
)
from glsim.tx_decoder import decode_raw_transaction

_send_raw_transaction = glsim_server.RPC_METHODS["eth_sendRawTransaction"]


def _payable_send_raw_transaction(state, engine, params):
    raw_hex = params.get(0) if isinstance(params, dict) else params[0]
    previous = engine.vm._value
    engine.vm._value = decode_raw_transaction(raw_hex)["value"]
    try:
        return _send_raw_transaction(state, engine, params)
    finally:
        engine.vm._value = previous


glsim_server.RPC_METHODS["eth_sendRawTransaction"] = _payable_send_raw_transaction

_get_local_transaction = glsim_server.RPC_METHODS["eth_getTransactionByHash"]


def _official_client_transaction_shape(state, engine, params):
    transaction = _get_local_transaction(state, engine, params)
    if isinstance(transaction, dict):
        leader = transaction.get("consensus_data", {}).get("leader_receipt", [])
        receipt = leader[0] if isinstance(leader, list) and leader else {}
        execution = receipt.get("execution_result")
        if execution == "SUCCESS":
            transaction["txExecutionResult"] = 1
            transaction["txExecutionResultName"] = "FINISHED_WITH_RETURN"
        elif execution == "ERROR":
            transaction["txExecutionResult"] = 2
            transaction["txExecutionResultName"] = "FINISHED_WITH_ERROR"
    return transaction


def _get_contract_code(state, _engine, params):
    address = params.get(0) if isinstance(params, dict) else params[0]
    contract = state.get_contract(address)
    if contract is None:
        raise ValueError(f"No contract at {address}")
    return base64.b64encode(Path(contract.code_path).read_bytes()).decode("ascii")


_get_schema_for_code = glsim_server.RPC_METHODS["gen_getContractSchemaForCode"]
_get_deployed_schema = glsim_server.RPC_METHODS["gen_getContractSchema"]


def _diagnostic_deployed_schema(state, engine, params):
    address = params.get(0) if isinstance(params, dict) else params[0]
    contract = state.get_contract(address)
    if contract is None:
        return _get_deployed_schema(state, engine, params)
    deployed_path = Path(contract.code_path)
    if deployed_path.read_bytes() != _accessseal_source:
        return _get_deployed_schema(state, engine, params)
    # GLSim 0.29.2 records the generated calldata proxy rather than the loaded
    # contract class, so its schema RPC returns an empty method map. Resolve the
    # schema from the exact code_path registered in simulator state. This is a
    # deployed-source readback, never an echo of the verifier's expected schema.
    completed = subprocess.run(
        ["genvm-lint", "schema", "--json", str(deployed_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)["schema"]


def _source_schema_without_loader_cache(state, engine, params):
    code_hex = params.get(0) if isinstance(params, dict) else params[0]
    if not isinstance(code_hex, str):
        return _get_schema_for_code(state, engine, params)
    code_bytes = bytes.fromhex(code_hex[2:] if code_hex.startswith("0x") else code_hex)
    if code_bytes != _accessseal_source:
        return _get_schema_for_code(state, engine, params)
    # GLSim 0.29.2's source-schema RPC primes a cached class that its subsequent
    # deploy allocator cannot initialize. For the exact committed AccessSeal
    # bytes, ask the pinned GenVM linter for the authoritative source schema
    # without mutating simulator loader state. Unknown source remains upstream.
    completed = subprocess.run(
        ["genvm-lint", "schema", "--json", str(_accessseal_source_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)["schema"]


glsim_server.RPC_METHODS["eth_getTransactionByHash"] = (
    _official_client_transaction_shape
)
glsim_server.RPC_METHODS["gen_getContractCode"] = _get_contract_code
glsim_server.RPC_METHODS["gen_getContractSchema"] = _diagnostic_deployed_schema
glsim_server.RPC_METHODS["gen_getContractSchemaForCode"] = (
    _source_schema_without_loader_cache
)


def _runner_fingerprint(_state, _engine, _params):
    return {**RUNNER_FINGERPRINT, "sessionId": session_id}


def _reset_validator_telemetry(_state, _engine, _params):
    _validator_telemetry.clear()
    return True


def _get_validator_telemetry(_state, _engine, _params):
    fields = (
        "sealArtifactFetches",
        "reviewArtifactRefetches",
        "reviewImageFetches",
        "reviewAiCalls",
    )
    return {
        "validatorCallbackInvocations": sum(
            entry["callbackInvocations"] for entry in _validator_telemetry
        ),
        "callbackInvocations": sum(
            entry["callbackInvocations"] for entry in _validator_telemetry
        ),
        "capturedValidatorSessions": sum(
            entry["capturedValidatorSessions"] for entry in _validator_telemetry
        ),
        "consensusSessions": len(_validator_telemetry),
        "nodes": [entry["nodes"] for entry in _validator_telemetry],
        "validatorOutcomes": [
            entry.get("validatorOutcomes", []) for entry in _validator_telemetry
        ],
        **{
            field: sum(entry[field] for entry in _validator_telemetry)
            for field in fields
        },
    }


glsim_server.RPC_METHODS["accessseal_getFingerprint"] = _runner_fingerprint
glsim_server.RPC_METHODS["accessseal_resetValidatorTelemetry"] = (
    _reset_validator_telemetry
)
glsim_server.RPC_METHODS["accessseal_getValidatorTelemetry"] = (
    _get_validator_telemetry
)
run_server(app, host="127.0.0.1", port=4000)

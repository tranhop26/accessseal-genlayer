"""Narrow, testable support code for the AccessSeal GLSim harness."""

from __future__ import annotations

import json
import base64
import os
import re
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable


RUNNER_FINGERPRINT = {
    "runner": "accessseal-task6",
    "runnerVersion": 1,
    "glsimVersion": "0.29.2",
    "validators": 5,
    "chainId": 61127,
}
GENVM_VERSION = "v0.2.16"
LIVE_NETWORK_CHAIN_IDS = {
    "studionet": 61999,
    "testnet_asimov": 4221,
    "testnet_bradbury": 4221,
}
# Pinned consensus ABI enum IMessages.MessageType.EXTERNAL.
GENLAYER_EXTERNAL_MESSAGE_TYPE = 1


def decode_binary_web_mocks(web_mocks: dict[str, Any]) -> dict[str, Any]:
    """Decode the harness's explicit JSON-safe binary response envelope."""

    for response in web_mocks.values():
        if not isinstance(response, dict):
            continue
        encoded = response.pop("bodyBase64", None)
        if encoded is not None:
            response["body"] = base64.b64decode(encoded, validate=True)
    return web_mocks


def validate_runner_fingerprint(value: Any, expected_session_id: str) -> None:
    expected = {**RUNNER_FINGERPRINT, "sessionId": expected_session_id}
    if value != expected:
        raise RuntimeError("GLSim runner fingerprint mismatch")


def assert_validator_callbacks(
    receipt: dict[str, Any], telemetry: dict[str, Any], *, expected: int
) -> None:
    consensus = receipt["consensus_data"]
    assert receipt["status"] == 7
    assert len(consensus["validators"]) == expected
    assert len(consensus["votes"]) == expected
    assert set(consensus["votes"].values()) == {"agree"}
    assert telemetry.get("callbackInvocations") == expected, (
        "expected actual validator callback invocations; receipt votes may be "
        "GLSim's deterministic auto-agree fallback"
    )
    assert telemetry.get("capturedValidatorSessions") == 1


def scoped_fd0_injection(
    injector: Callable[[Any], None],
    vm: Any,
    *,
    os_module: Any = os,
    tempfile_module: Any = tempfile,
) -> tuple[str, ...]:
    """Suppress only Windows' unlink of the exact fd0 injection tempfile."""

    original_unlink = os_module.unlink
    original_mkstemp = tempfile_module.mkstemp
    injection_paths: set[str] = set()
    deferred_cleanup_paths: set[str] = set()

    def tracked_mkstemp(*args: Any, **kwargs: Any):
        fd, path = original_mkstemp(*args, **kwargs)
        injection_paths.add(os_module.path.abspath(path) if hasattr(os_module, "path") else path)
        return fd, path

    def narrow_unlink(path: Any, *args: Any, **kwargs: Any) -> None:
        try:
            original_unlink(path, *args, **kwargs)
        except PermissionError:
            normalized = (
                os_module.path.abspath(path) if hasattr(os_module, "path") else path
            )
            if os_module.name == "nt" and normalized in injection_paths:
                deferred_cleanup_paths.add(normalized)
                return
            raise

    tempfile_module.mkstemp = tracked_mkstemp
    os_module.unlink = narrow_unlink
    try:
        injector(vm)
    finally:
        os_module.unlink = original_unlink
        tempfile_module.mkstemp = original_mkstemp
    return tuple(sorted(deferred_cleanup_paths))


def read_and_verify_settlement_proof(
    path: str | Path,
    *,
    network: str,
    chain_id: int,
    contract_address: str,
    case_id: str,
    settlement_id: str,
    recipient: str,
    amount: int,
    reader: Any,
) -> dict[str, Any]:
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        raise ValueError("settlement proof expected amount must be a positive integer")
    if LIVE_NETWORK_CHAIN_IDS.get(network) != chain_id:
        raise ValueError("settlement proof network and chain ID mismatch")
    contract_address = _normalize_address(contract_address, "contract")
    recipient = _normalize_address(recipient, "recipient")
    proof_path = Path(path)
    if not proof_path.is_file():
        raise RuntimeError("settlement proof artifact is missing")
    try:
        proof = json.loads(proof_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("settlement proof artifact is unreadable") from exc
    if not isinstance(proof, dict):
        raise ValueError("settlement proof must be an object")

    expected = {
        "schemaVersion": "accessseal-settlement-proof/2",
        "network": network,
        "chainId": chain_id,
        "contractAddress": contract_address,
        "caseId": case_id,
        "settlementId": settlement_id,
        "recipient": recipient,
        "amount": amount,
    }
    for key, value in expected.items():
        actual = proof.get(key)
        if key in ("contractAddress", "recipient") and isinstance(actual, str):
            actual = actual.lower()
        if actual != value:
            raise ValueError(f"settlement proof {key} mismatch")

    parent_hash = _require_tx_hash(proof, "parentTransactionHash")
    child_hash = _require_tx_hash(proof, "childTransactionHash")

    observed_chain_id = reader.rpc_chain_id()
    if observed_chain_id != chain_id:
        raise ValueError("settlement proof RPC chain identity mismatch")

    parent = reader.get_transaction(parent_hash)
    if not isinstance(parent, dict):
        raise ValueError("settlement proof parent transaction is unavailable")
    _require_finalized_success(parent, "parent")
    if _transaction_recipient(parent) != contract_address:
        raise ValueError("settlement proof parent contract mismatch")
    call = parent.get("tx_data_decoded", {}).get("call_data")
    if not isinstance(call, dict):
        raise ValueError("settlement proof parent settlement calldata is unavailable")
    if (
        call.get("method") != "execute_settlement"
        or call.get("args") != [case_id, settlement_id]
        or call.get("kwargs") not in ({}, None)
    ):
        raise ValueError("settlement proof parent settlement binding mismatch")

    _require_parent_transfer_message(parent, recipient, amount)

    triggered = reader.get_triggered_transaction_ids(parent_hash)
    if not isinstance(triggered, (list, tuple)):
        raise ValueError("settlement proof parent triggered-transaction readback is unavailable")
    if len(triggered) != 1:
        raise ValueError("settlement proof requires exactly one triggered child")
    if child_hash.lower() not in {str(value).lower() for value in triggered}:
        raise ValueError("settlement proof child is not triggered by parent")

    child = reader.get_transaction(child_hash)
    if not isinstance(child, dict):
        raise ValueError("settlement proof child transaction is unavailable")
    _require_finalized_success(child, "child")
    if _transaction_recipient(child) != recipient:
        raise ValueError("settlement proof child recipient mismatch")
    observed_amount = child.get("value")
    if observed_amount is not None and (
        isinstance(observed_amount, bool)
        or not isinstance(observed_amount, int)
        or observed_amount != amount
    ):
        raise ValueError("settlement proof child transfer amount mismatch")
    return proof


def _require_tx_hash(proof: dict[str, Any], field: str) -> str:
    value = proof.get(field)
    if not isinstance(value, str) or re.fullmatch(r"0x[0-9a-fA-F]{64}", value) is None:
        raise ValueError(f"settlement proof {field} is invalid")
    return value


def _normalize_address(value: Any, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"0x[0-9a-fA-F]{40}", value) is None:
        raise ValueError(f"settlement proof expected {label} address is invalid")
    return value.lower()


def _require_parent_transfer_message(
    parent: dict[str, Any], recipient: str, amount: int
) -> None:
    messages = parent.get("messages")
    if not isinstance(messages, (list, tuple)) or len(messages) != 1:
        raise ValueError("settlement proof requires exactly one authoritative message")
    message = messages[0]
    if not isinstance(message, (list, tuple)) or len(message) not in (5, 6):
        raise ValueError("settlement proof authoritative message shape is unavailable")

    message_type, observed_recipient, observed_amount, data, on_acceptance = message[:5]
    if message_type != GENLAYER_EXTERNAL_MESSAGE_TYPE:
        raise ValueError("settlement proof parent message is not external message type")
    if _transaction_recipient({"recipient": observed_recipient}) != recipient:
        raise ValueError("settlement proof parent message recipient mismatch")
    if (
        isinstance(observed_amount, bool)
        or not isinstance(observed_amount, int)
        or observed_amount != amount
    ):
        raise ValueError("settlement proof parent message amount mismatch")
    if data not in (b"", "", "0x"):
        raise ValueError("settlement proof parent message is not a pure transfer")
    if on_acceptance is not False:
        raise ValueError("settlement proof parent transfer is not finalized-only")
    if len(message) == 6 and (
        isinstance(message[5], bool) or not isinstance(message[5], int)
    ):
        raise ValueError("settlement proof parent message salt nonce is invalid")


def _transaction_status(transaction: dict[str, Any]) -> Any:
    value = transaction.get("status_name", transaction.get("status"))
    return getattr(value, "value", value)


def _transaction_execution(transaction: dict[str, Any]) -> Any:
    value = transaction.get("tx_execution_result_name")
    if value is not None:
        return getattr(value, "value", value)
    consensus = transaction.get("consensus_data")
    if isinstance(consensus, dict):
        leader = consensus.get("leader_receipt")
        if isinstance(leader, list) and leader and isinstance(leader[0], dict):
            return leader[0].get("execution_result")
    return None


def _require_finalized_success(transaction: dict[str, Any], label: str) -> None:
    if _transaction_status(transaction) != "FINALIZED":
        raise ValueError(f"settlement proof {label} transaction is not finalized")
    if _transaction_execution(transaction) != "SUCCESS":
        raise ValueError(f"settlement proof {label} transaction execution failed")


def _transaction_recipient(transaction: dict[str, Any]) -> str | None:
    value = transaction.get("recipient", transaction.get("to_address"))
    return str(value).lower() if value is not None else None


class GenLayerSettlementReader:
    """Read-only adapter over the official GenLayer client."""

    def __init__(self, network: str, rpc_url: str, *, client_factory: Any = None):
        from genlayer_py.chains import studionet, testnet_asimov, testnet_bradbury

        chains = {
            "studionet": studionet,
            "testnet_asimov": testnet_asimov,
            "testnet_bradbury": testnet_bradbury,
        }
        chain = chains.get(network)
        if chain is None:
            raise ValueError("unsupported GenLayer live settlement network")
        if not isinstance(rpc_url, str) or not rpc_url.startswith("https://"):
            raise ValueError("live settlement RPC URL must use HTTPS")
        if client_factory is None:
            from genlayer_py import create_client

            client_factory = create_client
        self._client = client_factory(chain=deepcopy(chain), endpoint=rpc_url)

    def rpc_chain_id(self) -> int:
        response = self._client.provider.make_request("eth_chainId", [])
        result = response.get("result") if isinstance(response, dict) else None
        if isinstance(result, str):
            try:
                return int(result, 0)
            except ValueError as exc:
                raise ValueError("live settlement RPC returned an invalid chain ID") from exc
        if isinstance(result, int) and not isinstance(result, bool):
            return result
        raise ValueError("live settlement RPC did not return a chain ID")

    def get_transaction(self, tx_hash: str) -> Any:
        return self._client.get_transaction(tx_hash)

    def get_triggered_transaction_ids(self, tx_hash: str) -> Any:
        return self._client.get_triggered_transaction_ids(tx_hash)

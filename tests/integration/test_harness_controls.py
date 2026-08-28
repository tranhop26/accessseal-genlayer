from __future__ import annotations

import json
from pathlib import Path

import pytest
import conftest as harness
from gltest.types import TransactionStatus

from scripts.glsim_support import (
    GENVM_VERSION,
    GenLayerSettlementReader,
    assert_validator_callbacks,
    decode_binary_web_mocks,
    read_and_verify_settlement_proof,
    scoped_fd0_injection,
    validate_runner_fingerprint,
)


EXPECTED_FINGERPRINT = {
    "runner": "accessseal-task6",
    "runnerVersion": 1,
    "glsimVersion": "0.29.2",
    "validators": 5,
    "chainId": 61127,
    "sessionId": "expected-session",
}


def test_direct_and_glsim_harnesses_pin_the_reviewed_genvm_release():
    assert GENVM_VERSION == "v0.2.16"
    direct_source = Path("tests/direct/conftest.py").read_text(encoding="utf-8")
    glsim_source = Path("scripts/run-glsim-integration.py").read_text(encoding="utf-8")
    assert "sdk_version=GENVM_VERSION" in direct_source
    assert "version=GENVM_VERSION" in glsim_source


def test_glsim_cold_start_budget_covers_the_pinned_sdk_download():
    assert harness.GLSIM_STARTUP_TIMEOUT_SECONDS == 120


def test_glsim_cold_start_does_not_abort_at_the_old_fifteen_second_deadline(
    monkeypatch,
):
    class FakeProcess:
        def __init__(self):
            self.terminated = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout):
            return 0

        def kill(self):
            raise AssertionError("graceful termination should have succeeded")

    class FakeLog:
        def close(self):
            return None

    process = FakeProcess()
    child_env = {}
    readiness_attempts = 0

    def fake_popen(*_args, **kwargs):
        child_env.update(kwargs["env"])
        return process

    def fake_rpc(method, _params):
        nonlocal readiness_attempts
        if not child_env:
            raise OSError("no existing server")
        if method == "ping":
            readiness_attempts += 1
            if readiness_attempts == 1:
                raise OSError("still downloading")
            return "pong"
        return {
            **EXPECTED_FINGERPRINT,
            "sessionId": child_env["ACCESSSEAL_GLSIM_SESSION_ID"],
        }

    clock = iter((0.0, 16.0))
    monkeypatch.setattr(harness, "rpc", fake_rpc)
    monkeypatch.setattr(harness.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(harness.Path, "mkdir", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(harness.Path, "open", lambda *_args, **_kwargs: FakeLog())
    monkeypatch.setattr(harness.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(harness.time, "sleep", lambda _seconds: None)

    fixture = harness.glsim_server.__wrapped__()
    assert next(fixture)["sessionId"] == child_env["ACCESSSEAL_GLSIM_SESSION_ID"]
    fixture.close()
    assert process.terminated is True


def test_auto_agree_receipt_without_callback_telemetry_is_rejected():
    receipt = {
        "status": 7,
        "consensus_data": {
            "validators": [f"0x{i:040x}" for i in range(5)],
            "votes": {f"0x{i:040x}": "agree" for i in range(5)},
        },
    }

    with pytest.raises(AssertionError, match="validator callback"):
        assert_validator_callbacks(receipt, {"callbackInvocations": 0}, expected=5)


def test_real_deterministic_glsim_auto_agree_cannot_pose_as_validator_execution(
    deployed_contract, actors
):
    harness.rpc("accessseal_resetValidatorTelemetry", [])
    receipt = deployed_contract.connect(actors[0]).create_case(
        [
            "validator-negative-control",
            actors[1].address,
            harness.PROFILE_HASH,
            harness.FLOWS_HASH,
            harness.ORIGIN,
            1800,
            7200,
            2,
            harness.ESCROW,
        ]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    telemetry = harness.rpc("accessseal_getValidatorTelemetry", [])

    assert len(receipt["consensus_data"]["votes"]) == 5
    assert set(receipt["consensus_data"]["votes"].values()) == {"agree"}
    assert telemetry["callbackInvocations"] == 0
    with pytest.raises(AssertionError, match="validator callback"):
        assert_validator_callbacks(receipt, telemetry, expected=5)


def test_runner_fingerprint_requires_exact_version_configuration_and_session():
    validate_runner_fingerprint(EXPECTED_FINGERPRINT, "expected-session")
    for field, wrong in (
        ("runner", "generic-glsim"),
        ("glsimVersion", "0.30.0"),
        ("validators", 1),
        ("chainId", 1),
        ("sessionId", "somebody-elses-session"),
    ):
        candidate = {**EXPECTED_FINGERPRINT, field: wrong}
        with pytest.raises(RuntimeError, match="fingerprint"):
            validate_runner_fingerprint(candidate, "expected-session")


def test_generic_ping_responder_is_never_reused_without_explicit_opt_in(monkeypatch):
    calls = []

    def fake_rpc(method, params):
        calls.append((method, params))
        return "pong"

    monkeypatch.delenv("ACCESSSEAL_REUSE_GLSIM", raising=False)
    monkeypatch.setattr(harness, "rpc", fake_rpc)
    fixture = harness.glsim_server.__wrapped__()
    with pytest.raises(RuntimeError, match="reuse requires"):
        next(fixture)
    assert calls == [("ping", [])]


def test_owned_runner_is_terminated_and_log_closed_when_readiness_fails(monkeypatch):
    class FakeProcess:
        def __init__(self):
            self.terminated = False
            self.waited = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout):
            self.waited = True
            return 0

        def kill(self):
            raise AssertionError("graceful termination should have succeeded")

    class FakeLog:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    process = FakeProcess()
    log = FakeLog()
    clock = iter((0.0, harness.GLSIM_STARTUP_TIMEOUT_SECONDS + 1.0))
    child_env = {}

    def fake_popen(*_args, **kwargs):
        child_env.update(kwargs["env"])
        return process

    monkeypatch.setattr(harness, "rpc", lambda *_args: (_ for _ in ()).throw(OSError("offline")))
    monkeypatch.setattr(harness.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(harness.Path, "mkdir", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(harness.Path, "open", lambda *_args, **_kwargs: log)
    monkeypatch.setattr(harness.time, "monotonic", lambda: next(clock))

    fixture = harness.glsim_server.__wrapped__()
    with pytest.raises(RuntimeError, match="readiness deadline"):
        next(fixture)
    assert process.terminated is True
    assert process.waited is True
    assert log.closed is True
    assert child_env["TEMP"] == child_env["TMP"]
    assert not Path(child_env["TEMP"]).exists()


def test_startup_failure_surfaces_a_bounded_child_log_tail(tmp_path, monkeypatch):
    log_path = tmp_path / "glsim.log"
    log_path.write_text("prefix\n" + ("x" * 5000) + "\nROOT CAUSE\n", encoding="utf-8")
    monkeypatch.setattr(Path, "read_text", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not read the whole log")))

    error = harness.glsim_startup_error("GLSim exited before becoming ready", log_path)

    assert "ROOT CAUSE" in str(error)
    assert "prefix" not in str(error)
    assert len(str(error)) < 4300


def test_scoped_fd0_unlink_patch_restores_and_rethrows_unrelated_permission_error():
    class FakeTempfile:
        def __init__(self):
            self.mkstemp = lambda: (7, "known-fd0.tmp")

    class FakeOs:
        name = "nt"

        def __init__(self):
            self.unlink = self._unlink

        @staticmethod
        def _unlink(path):
            raise PermissionError(path)

    fake_os = FakeOs()
    fake_tempfile = FakeTempfile()
    original_unlink = fake_os.unlink
    original_mkstemp = fake_tempfile.mkstemp

    def injector(_vm):
        _fd, known_path = fake_tempfile.mkstemp()
        fake_os.unlink(known_path)
        with pytest.raises(PermissionError, match="unrelated"):
            fake_os.unlink("unrelated.tmp")

    deferred_paths = scoped_fd0_injection(
        injector,
        object(),
        os_module=fake_os,
        tempfile_module=fake_tempfile,
    )

    assert deferred_paths == ("known-fd0.tmp",)
    assert fake_os.unlink == original_unlink
    assert fake_tempfile.mkstemp == original_mkstemp


def test_persistent_web_mock_binary_envelope_decodes_to_exact_bytes():
    mocks = {
        "https://fixture.example/screenshot.png": {
            "status": 200,
            "bodyBase64": "iVBORw0KGgo=",
        }
    }
    decoded = decode_binary_web_mocks(mocks)
    assert decoded["https://fixture.example/screenshot.png"]["body"] == b"\x89PNG\r\n\x1a\n"
    assert "bodyBase64" not in decoded["https://fixture.example/screenshot.png"]


@pytest.mark.parametrize("control", ("disagreement", "timeout"))
def test_v4_validator_negative_controls_leave_sealed_funds_and_no_attempt(
    v4_context, control
):
    """Fails if failed validator consensus records a review or unlocks recovery."""
    outcome = v4_context.run_negative_control(control)

    assert outcome["receipt"]["tx_execution_result"] == "FINISHED_WITH_ERROR"
    assert outcome["telemetry"]["validatorCallbackInvocations"] >= 1
    assert any(
        not callback["agreed"]
        for session in outcome["telemetry"]["validatorOutcomes"]
        for callback in session
    )
    if control == "timeout":
        assert any(
            callback.get("timedOut") is True
            for session in outcome["telemetry"]["validatorOutcomes"]
            for callback in session
        )
    assert outcome["reviewResultExists"] is False
    assert outcome["reviewAttemptExists"] is False
    assert outcome["case"]["lifecycle"] == "EVIDENCE_SEALED"
    assert outcome["accounting"]["reserved"] == outcome["reservedBefore"]
    assert outcome["retryEligible"] is False


CONTRACT = "0x" + "cd" * 20
RECIPIENT = "0x" + "ab" * 20
PARENT_TX = "0x" + "11" * 32
CHILD_TX = "0x" + "22" * 32


class FakeSettlementReader:
    def __init__(self, *, chain_id=61999, parent=None, children=None, child=None):
        self._chain_id = chain_id
        self.parent = parent or live_parent_transaction()
        self.children = [CHILD_TX] if children is None else children
        self.child = child or live_child_transaction()

    def rpc_chain_id(self):
        return self._chain_id

    def get_transaction(self, tx_hash):
        if tx_hash == PARENT_TX:
            return self.parent
        if tx_hash == CHILD_TX:
            return self.child
        return None

    def get_triggered_transaction_ids(self, tx_hash):
        assert tx_hash == PARENT_TX
        return self.children


def live_parent_transaction(messages=None):
    return {
        "status_name": "FINALIZED",
        "tx_execution_result_name": "SUCCESS",
        "recipient": CONTRACT,
        # Official GenLayerRawTransaction.decode output keeps ABI message
        # tuples as (messageType, recipient, value, data, onAcceptance,
        # saltNonce) on V06 networks.
        "messages": [
            (1, RECIPIENT, 50000, b"", False, 0)
        ] if messages is None else messages,
        "tx_data_decoded": {
            "type": "call",
            "call_data": {
                "method": "execute_settlement",
                "args": ["case-1", "settlement-1"],
                "kwargs": {},
            },
        },
    }


def live_child_transaction():
    # Official GenLayerRawTransaction.decode does not expose a top-level value.
    return {
        "status_name": "FINALIZED",
        "tx_execution_result_name": "SUCCESS",
        "recipient": RECIPIENT,
    }


def write_live_locator(tmp_path: Path, **mutation):
    proof = {
        "schemaVersion": "accessseal-settlement-proof/2",
        "network": "studionet",
        "chainId": 61999,
        "contractAddress": CONTRACT,
        "caseId": "case-1",
        "settlementId": "settlement-1",
        "recipient": RECIPIENT,
        "amount": 50000,
        "parentTransactionHash": PARENT_TX,
        "childTransactionHash": CHILD_TX,
    }
    proof.update(mutation)
    path = tmp_path / "proof.json"
    path.write_text(json.dumps(proof), encoding="utf-8")
    return path


def verify_live_locator(tmp_path: Path, reader):
    return read_and_verify_settlement_proof(
        write_live_locator(tmp_path),
        network="studionet",
        chain_id=61999,
        contract_address=CONTRACT,
        case_id="case-1",
        settlement_id="settlement-1",
        recipient=RECIPIENT,
        amount=50000,
        reader=reader,
    )


def test_live_settlement_proof_accepts_independently_linked_finalized_success(tmp_path: Path):
    result = verify_live_locator(tmp_path, FakeSettlementReader())
    assert result["childTransactionHash"] == CHILD_TX


def test_live_reader_uses_injected_rpc_and_official_client_readbacks(tmp_path: Path):
    class FakeProvider:
        def __init__(self):
            self.calls = []

        def make_request(self, method, params):
            self.calls.append((method, params))
            return {"result": "0xf22f"}

    class FakeClient:
        def __init__(self):
            self.provider = FakeProvider()

        def get_transaction(self, tx_hash):
            return (
                live_parent_transaction()
                if tx_hash == PARENT_TX
                else live_child_transaction()
            )

        def get_triggered_transaction_ids(self, tx_hash):
            assert tx_hash == PARENT_TX
            return [CHILD_TX]

    client = FakeClient()
    reader = GenLayerSettlementReader(
        "studionet",
        "https://rpc.example.invalid",
        client_factory=lambda **_kwargs: client,
    )
    result = verify_live_locator(tmp_path, reader)

    assert result["parentTransactionHash"] == PARENT_TX
    assert client.provider.calls == [("eth_chainId", [])]


def test_live_settlement_proof_rejects_unrelated_finalized_success_child(tmp_path: Path):
    reader = FakeSettlementReader(children=["0x" + "33" * 32])
    with pytest.raises(ValueError, match="not triggered by parent"):
        verify_live_locator(tmp_path, reader)


def test_live_settlement_proof_rejects_artifact_spoofed_status(tmp_path: Path):
    path = write_live_locator(
        tmp_path,
        childTransaction={"status": "FINALIZED", "executionStatus": "SUCCESS"},
    )
    child = {**live_child_transaction(), "status_name": "PENDING"}
    with pytest.raises(ValueError, match="child transaction is not finalized"):
        read_and_verify_settlement_proof(
            path,
            network="studionet",
            chain_id=61999,
            contract_address=CONTRACT,
            case_id="case-1",
            settlement_id="settlement-1",
            recipient=RECIPIENT,
            amount=50000,
            reader=FakeSettlementReader(child=child),
        )


def test_live_settlement_proof_rejects_artifact_spoofed_balance(tmp_path: Path):
    path = write_live_locator(
        tmp_path, recipientBalance={"before": 0, "after": 50000}
    )
    parent = live_parent_transaction(
        [(1, RECIPIENT, 1, b"", False, 0)]
    )
    with pytest.raises(ValueError, match="amount mismatch"):
        read_and_verify_settlement_proof(
            path,
            network="studionet",
            chain_id=61999,
            contract_address=CONTRACT,
            case_id="case-1",
            settlement_id="settlement-1",
            recipient=RECIPIENT,
            amount=50000,
            reader=FakeSettlementReader(parent=parent),
        )


@pytest.mark.parametrize(
    "messages, message",
    [
        ([(0, RECIPIENT, 50000, b"", False, 0)], "external message type"),
        ([(7, RECIPIENT, 50000, b"", False, 0)], "external message type"),
        ([(1, RECIPIENT, 1, b"", False, 0)], "amount mismatch"),
        ([(1, "0x" + "ef" * 20, 50000, b"", False, 0)], "recipient mismatch"),
        (
            [
                (1, RECIPIENT, 50000, b"", False, 0),
                (1, RECIPIENT, 50000, b"", False, 1),
            ],
            "exactly one authoritative message",
        ),
    ],
)
def test_live_settlement_proof_rejects_wrong_or_ambiguous_parent_messages(
    tmp_path: Path, messages, message
):
    parent = live_parent_transaction(messages)
    with pytest.raises(ValueError, match=message):
        verify_live_locator(tmp_path, FakeSettlementReader(parent=parent))


def test_live_settlement_proof_rejects_multiple_triggered_children_as_ambiguous(
    tmp_path: Path,
):
    reader = FakeSettlementReader(children=[CHILD_TX, "0x" + "33" * 32])
    with pytest.raises(ValueError, match="exactly one triggered child"):
        verify_live_locator(tmp_path, reader)


def test_live_settlement_proof_rejects_wrong_rpc_chain(tmp_path: Path):
    with pytest.raises(ValueError, match="RPC chain"):
        verify_live_locator(tmp_path, FakeSettlementReader(chain_id=1))


@pytest.mark.parametrize(
    "parent_mutation, message",
    [
        ({"recipient": "0x" + "ef" * 20}, "contract mismatch"),
        ({"status_name": "PENDING"}, "parent transaction is not finalized"),
        ({"tx_execution_result_name": "ERROR"}, "parent transaction execution failed"),
        (
            {
                "tx_data_decoded": {
                    "type": "call",
                    "call_data": {
                        "method": "execute_settlement",
                        "args": ["case-other", "settlement-1"],
                        "kwargs": {},
                    },
                }
            },
            "parent settlement binding mismatch",
        ),
    ],
)
def test_live_settlement_proof_rejects_wrong_live_parent_binding(
    tmp_path: Path, parent_mutation, message
):
    parent = {**live_parent_transaction(), **parent_mutation}
    with pytest.raises(ValueError, match=message):
        verify_live_locator(tmp_path, FakeSettlementReader(parent=parent))

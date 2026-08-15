import json
from hashlib import sha256

from test_adjudication import (
    ESCROW,
    derived_llm_handler,
    mock_adjudication,
    open_reviewable_case,
)
from test_recovery import _confirm_finality, _finality


def _review_case(
    contract,
    direct_vm,
    buyer,
    vendor,
    *,
    rejected=False,
    salt="settlement",
):
    flow = None
    if rejected:
        flow = {
            "completed": False,
            "flow": "checkout",
            "keyboardTrap": True,
            "steps": ["email", "blocked"],
        }
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt=salt,
        flow_trace=flow,
    )
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(),
    )
    contract.request_review(case_id)
    return case_id


def _prepare(contract, case_id):
    verdict = json.loads(
        contract.get_review(case_id, _finality(contract, case_id)["epoch"])
    )["verdict"]
    if verdict == "APPROVED":
        return contract.prepare_payout(case_id)
    return contract.prepare_refund(case_id)


def _accounting(contract):
    return json.loads(contract.get_accounting())


def _assert_conservation(contract):
    accounting = _accounting(contract)
    assert accounting["totalDeposits"] == (
        accounting["reserved"]
        + accounting["pendingDispatch"]
        + accounting["dispatchedPayouts"]
        + accounting["dispatchedRefunds"]
    )


def test_prepare_requires_contract_derived_protocol_finality_and_appeal_lock(
    contract, direct_vm, buyer, vendor
):
    case_id = _review_case(contract, direct_vm, buyer, vendor)
    pending = _finality(contract, case_id)
    assert pending["status"] == "PENDING_PROTOCOL_FINALITY"

    contract.prepare_payout.reverts(
        case_id, message="review is not protocol-finalized"
    )
    _confirm_finality(contract, case_id)
    settlement_id = contract.prepare_payout(case_id)
    settlement = json.loads(contract.get_settlement(case_id))
    assert settlement["settlementId"] == settlement_id
    assert settlement["reviewProofId"] == pending["proofId"]


def test_approved_payout_and_rejected_refund_lock_recipient_amount_and_kind(
    contract, direct_vm, buyer, vendor
):
    payout_case = _review_case(
        contract, direct_vm, buyer, vendor, salt="approved-payout"
    )
    _confirm_finality(contract, payout_case)
    payout_id = contract.prepare_payout(payout_case)
    payout = json.loads(contract.get_settlement(payout_case))
    expected_payout_id = "sha256:" + sha256(
        json.dumps(
            {
                "amount": ESCROW,
                "caseId": payout_case,
                "epoch": 0,
                "kind": "PAYOUT",
                "reason": "APPROVED",
                "recipient": vendor.as_hex.lower(),
                "reviewProofId": _finality(contract, payout_case)["proofId"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert payout_id == expected_payout_id
    assert payout == {
        "amount": ESCROW,
        "caseId": payout_case,
        "epoch": 0,
        "executor": "",
        "kind": "PAYOUT",
        "reason": "APPROVED",
        "recipient": vendor.as_hex.lower(),
        "reviewProofId": _finality(contract, payout_case)["proofId"],
        "settlementId": payout_id,
        "status": "PREPARED",
    }

    refund_case = _review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        rejected=True,
        salt="rejected-refund",
    )
    _confirm_finality(contract, refund_case)
    refund_id = contract.prepare_refund(refund_case)
    refund = json.loads(contract.get_settlement(refund_case))
    assert refund["settlementId"] == refund_id
    assert refund["kind"] == "REFUND"
    assert refund["recipient"] == buyer.as_hex.lower()
    assert refund["amount"] == ESCROW
    _assert_conservation(contract)


def test_wrong_verdict_and_rmi_or_unresolved_never_prepare_settlement(
    contract, direct_vm, buyer, vendor
):
    approved = _review_case(
        contract, direct_vm, buyer, vendor, salt="wrong-refund"
    )
    _confirm_finality(contract, approved)
    contract.prepare_refund.reverts(
        approved, message="only a rejected verdict authorizes a refund"
    )

    unresolved, release = open_reviewable_case(
        contract, direct_vm, buyer, vendor, salt="no-unresolved-settlement"
    )
    mock_adjudication(
        direct_vm, release, status_overrides={"RELEASE_MANIFEST": 503}
    )
    contract.request_review(unresolved)
    _confirm_finality(contract, unresolved)
    contract.prepare_payout.reverts(
        unresolved, message="only an approved verdict authorizes a payout"
    )
    contract.prepare_refund.reverts(
        unresolved, message="only a rejected verdict authorizes a refund"
    )

    rmi, _ = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="no-rmi-settlement",
        supporting_evidence=("HTML_BUNDLE",),
    )
    contract.request_review(rmi)
    _confirm_finality(contract, rmi)
    contract.prepare_payout.reverts(
        rmi, message="only an approved verdict authorizes a payout"
    )
    contract.prepare_refund.reverts(
        rmi, message="only a rejected verdict authorizes a refund"
    )


def test_third_party_dispatches_finality_only_eoa_transfer_and_readback_is_honest(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id = _review_case(
        contract, direct_vm, buyer, vendor, salt="third-party-dispatch"
    )
    _confirm_finality(contract, case_id)
    settlement_id = contract.prepare_payout(case_id)
    eth_sends = []

    def hook(_vm, request):
        if "EthSend" in request:
            eth_sends.append(request["EthSend"])
            return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    contract.as_(outsider).execute_settlement(case_id, settlement_id)

    settlement = json.loads(contract.get_settlement(case_id))
    assert settlement["status"] == "DISPATCHED_FINALIZED"
    assert settlement["executor"] == outsider.as_hex.lower()
    assert contract.get_case_json(case_id)["lifecycle"] == "DISPATCHED_FINALIZED"
    assert len(eth_sends) == 1
    assert eth_sends[0]["address"] == vendor
    assert eth_sends[0]["calldata"] == b""
    assert eth_sends[0]["value"] == ESCROW
    _assert_conservation(contract)


def test_double_prepare_dispatch_claim_and_wrong_settlement_id_are_rejected(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id = _review_case(
        contract, direct_vm, buyer, vendor, salt="replay-guards"
    )
    _confirm_finality(contract, case_id)
    settlement_id = contract.prepare_payout(case_id)
    contract.prepare_payout.reverts(
        case_id, message="settlement intent already exists"
    )
    contract.execute_settlement.reverts(
        case_id,
        "sha256:" + "0" * 64,
        message="settlement ID does not match",
    )

    def hook(_vm, request):
        if "EthSend" in request:
            return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    contract.as_(outsider).execute_settlement(case_id, settlement_id)
    contract.as_(outsider).execute_settlement.reverts(
        case_id, settlement_id, message="settlement is already dispatched"
    )
    contract.prepare_payout.reverts(
        case_id, message="settlement intent already exists"
    )


def test_deterministic_pre_dispatch_failure_rolls_back_and_same_intent_can_retry(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id = _review_case(
        contract, direct_vm, buyer, vendor, salt="pre-dispatch-retry"
    )
    _confirm_finality(contract, case_id)
    settlement_id = contract.prepare_payout(case_id)
    calls = 0

    def hook(_vm, request):
        nonlocal calls
        if "EthSend" in request:
            calls += 1
            if calls == 1:
                raise RuntimeError("simulated deterministic EthSend failure")
            return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    contract.as_(outsider).execute_settlement.reverts(
        case_id,
        settlement_id,
        message="external transfer dispatch failed before emission",
    )
    assert json.loads(contract.get_settlement(case_id))["status"] == "PREPARED"
    before = _accounting(contract)
    contract.as_(outsider).execute_settlement(case_id, settlement_id)
    after = _accounting(contract)
    assert after["totalDeposits"] == before["totalDeposits"]
    assert after["reserved"] == before["reserved"]
    assert after["dispatchedPayouts"] == ESCROW
    _assert_conservation(contract)


def test_accounting_conserves_across_prepare_and_dispatch_for_payout_and_refund(
    contract, direct_vm, buyer, vendor, outsider
):
    payout = _review_case(
        contract, direct_vm, buyer, vendor, salt="conserve-payout"
    )
    _confirm_finality(contract, payout)
    payout_id = contract.prepare_payout(payout)
    _assert_conservation(contract)

    refund = _review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        rejected=True,
        salt="conserve-refund",
    )
    _confirm_finality(contract, refund)
    refund_id = contract.prepare_refund(refund)
    _assert_conservation(contract)

    def hook(_vm, request):
        if "EthSend" in request:
            return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    contract.as_(outsider).execute_settlement(payout, payout_id)
    _assert_conservation(contract)
    contract.as_(outsider).execute_settlement(refund, refund_id)
    accounting = _accounting(contract)
    assert accounting["dispatchedPayouts"] == ESCROW
    assert accounting["dispatchedRefunds"] == ESCROW
    assert accounting["pendingDispatch"] == 0
    _assert_conservation(contract)


def test_frozen_schema_has_no_admin_upgrade_override_or_recipient_mutation(
    contract, direct_vm, buyer, vendor, outsider
):
    from genlayer.py.get_schema import get_schema

    implementation = object.__getattribute__(contract._contract, "_instance")
    schema = get_schema(implementation.__class__)
    method_names = set(schema["methods"])
    forbidden_fragments = (
        "admin",
        "owner",
        "upgrade",
        "set_code",
        "override",
        "change_recipient",
        "set_recipient",
    )
    assert all(
        fragment not in name.lower()
        for name in method_names
        for fragment in forbidden_fragments
    )

    case_id = _review_case(
        contract, direct_vm, buyer, vendor, salt="frozen-recipient"
    )
    _confirm_finality(contract, case_id)
    settlement_id = contract.prepare_payout(case_id)
    before = json.loads(contract.get_settlement(case_id))
    assert before["recipient"] == vendor.as_hex.lower()
    try:
        getattr(contract.as_(outsider), "upgrade")("malicious")
        raise AssertionError("unknown privileged call unexpectedly succeeded")
    except AttributeError:
        pass
    assert json.loads(contract.get_settlement(case_id)) == before
    assert settlement_id == before["settlementId"]

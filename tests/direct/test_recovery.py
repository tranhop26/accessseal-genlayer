import copy
import json
from hashlib import sha256

from test_adjudication import (
    ALL_SUPPORTING_EVIDENCE,
    PROFILE_HASH,
    build_release,
    canonical_json_bytes,
    compact_json,
    derived_llm_handler,
    envelope_for,
    mock_adjudication,
    open_reviewable_case,
    semantic_only_candidate,
)


def _capture_messages(direct_vm):
    messages = []

    def hook(_vm, request):
        if "PostMessage" in request:
            messages.append(request["PostMessage"])
            return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    return messages


def _finality(contract, case_id):
    return json.loads(contract.get_review_finality(case_id))


def _confirm_finality(contract, case_id, caller=None):
    from genlayer import Address

    finality = _finality(contract, case_id)
    if caller is None:
        caller = Address(contract.get_case_json(case_id)["contractAddress"])
    contract.as_(caller).confirm_review_finality(
        case_id,
        finality["epoch"],
        finality["attempt"],
        finality["proofId"],
    )
    return _finality(contract, case_id)


def _review_rmi(contract, direct_vm, buyer, vendor, *, salt="rmi-0"):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt=salt,
        supporting_evidence=("HTML_BUNDLE",),
    )
    contract.request_review(case_id)
    assert json.loads(contract.get_review(case_id, 0))["verdict"] == (
        "REQUEST_MORE_INFO"
    )
    return case_id, release


def _open_cure_epoch(contract, case_id, vendor):
    release = build_release(case_id)
    manifest = copy.deepcopy(release["manifest"])
    manifest["epoch"] = 1
    manifest_body = canonical_json_bytes(manifest)
    release_digest = "sha256:" + sha256(manifest_body).hexdigest()

    manifest_envelope = envelope_for(
        contract,
        case_id,
        vendor,
        release_digest=release_digest,
        payload_sha256=release_digest,
    )
    manifest_envelope["epoch"] = 1
    manifest_envelope["observedAt"] = 1_786_580_900
    manifest_envelope["submittedAt"] = 1_786_580_990
    manifest_envelope["expiresAt"] = 1_786_586_000
    contract.as_(vendor).open_evidence(case_id, compact_json(manifest_envelope))

    html_envelope = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidence_type="HTML_BUNDLE",
        nonce="cure-html",
        release_digest=release_digest,
        payload_sha256=release["payloads"]["HTML_BUNDLE"]["sha256"],
    )
    html_envelope["epoch"] = 1
    html_envelope["observedAt"] = 1_786_580_900
    html_envelope["submittedAt"] = 1_786_580_990
    html_envelope["expiresAt"] = 1_786_586_000
    contract.as_(vendor).append_evidence(case_id, compact_json(html_envelope))
    return release_digest


def test_review_finality_uses_authenticated_idempotent_finalized_self_message(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(
        direct_vm, release, llm_handler=derived_llm_handler()
    )
    messages = _capture_messages(direct_vm)

    contract.request_review(case_id)

    pending = _finality(contract, case_id)
    assert pending["status"] == "PENDING_PROTOCOL_FINALITY"
    assert pending["proofId"].startswith("sha256:")
    assert len(messages) == 1
    assert messages[0]["on"] == "finalized"
    contract.as_(outsider).confirm_review_finality.reverts(
        case_id,
        pending["epoch"],
        pending["attempt"],
        pending["proofId"],
        message="only the contract finality message is authorized",
    )

    finalized = _confirm_finality(contract, case_id)
    assert finalized["status"] == "FINALIZED"
    finalized_attempt = contract.get_review_attempt(case_id, 0, 0)
    direct_vm.warp("2026-08-13T00:31:01+00:00")
    _confirm_finality(contract, case_id)
    assert _finality(contract, case_id) == finalized
    assert contract.get_review_attempt(case_id, 0, 0) == finalized_attempt


def test_finality_callback_rejects_forged_wrong_and_stale_domains_without_mutation(
    contract, direct_vm, buyer, vendor, outsider
):
    from genlayer import Address

    case_id, release = open_reviewable_case(
        contract, direct_vm, buyer, vendor, salt="finality-forgery"
    )
    mock_adjudication(
        direct_vm, release, status_overrides={"RELEASE_MANIFEST": 503}
    )
    contract.request_review(case_id)
    self_address = Address(contract.get_case_json(case_id)["contractAddress"])
    pending = _finality(contract, case_id)
    review_before = contract.get_review(case_id, 0)
    attempt_before = contract.get_review_attempt(case_id, 0, 0)

    invalid_callbacks = (
        (outsider, 0, 0, pending["proofId"]),
        (self_address, 0, 0, "sha256:" + "0" * 64),
        (self_address, 0, 1, pending["proofId"]),
        (self_address, 1, 0, pending["proofId"]),
    )
    for caller, epoch, attempt, proof_id in invalid_callbacks:
        message = "review finality proof does not match"
        if caller == outsider:
            message = "only the contract finality message is authorized"
        contract.as_(caller).confirm_review_finality.reverts(
            case_id, epoch, attempt, proof_id, message=message
        )
        assert _finality(contract, case_id) == pending
        assert contract.get_review(case_id, 0) == review_before
        assert contract.get_review_attempt(case_id, 0, 0) == attempt_before

    _confirm_finality(contract, case_id)
    attempt_zero = json.loads(contract.get_review_attempt(case_id, 0, 0))
    direct_vm.warp("2026-08-13T00:35:01+00:00")
    contract.retry_review(case_id, "finality-retry-1")
    attempt_one_pending = _finality(contract, case_id)
    latest_before = contract.get_review(case_id, 0)

    contract.as_(self_address).confirm_review_finality.reverts(
        case_id,
        0,
        0,
        pending["proofId"],
        message="review finality proof does not match",
    )
    assert _finality(contract, case_id) == attempt_one_pending
    assert json.loads(contract.get_review_attempt(case_id, 0, 0)) == attempt_zero
    assert contract.get_review(case_id, 0) == latest_before


def test_multiple_retries_preserve_complete_attempt_scoped_audit_records(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract, direct_vm, buyer, vendor, salt="attempt-audit"
    )
    mock_adjudication(
        direct_vm, release, status_overrides={"RELEASE_MANIFEST": 503}
    )
    contract.request_review(case_id)
    _confirm_finality(contract, case_id)
    attempt_zero = json.loads(contract.get_review_attempt(case_id, 0, 0))

    direct_vm.warp("2026-08-13T00:35:01+00:00")
    contract.retry_review(case_id, "audit-retry-1")
    _confirm_finality(contract, case_id)
    attempt_one = json.loads(contract.get_review_attempt(case_id, 0, 1))

    direct_vm.warp("2026-08-13T00:40:01+00:00")
    contract.retry_review(case_id, "audit-retry-2")
    _confirm_finality(contract, case_id)
    attempt_two = json.loads(contract.get_review_attempt(case_id, 0, 2))

    assert json.loads(contract.get_review_attempt(case_id, 0, 0)) == attempt_zero
    assert json.loads(contract.get_review_attempt(case_id, 0, 1)) == attempt_one
    records = (attempt_zero, attempt_one, attempt_two)
    assert [record["attempt"] for record in records] == [0, 1, 2]
    assert len({record["proofId"] for record in records}) == 3
    for record in records:
        assert record["caseId"] == case_id
        assert record["epoch"] == 0
        assert record["status"] == "FINALIZED"
        assert record["decidedAt"] > 0
        assert record["finalizedAt"] >= record["decidedAt"]
        assert record["review"]["verdict"] == "UNRESOLVED"


def test_one_rmi_cure_preserves_history_and_rejects_old_epoch_domain(
    contract, direct_vm, buyer, vendor
):
    case_id, old_release = _review_rmi(
        contract, direct_vm, buyer, vendor
    )
    old_review = json.loads(contract.get_review(case_id, 0))
    _confirm_finality(contract, case_id)

    contract.as_(vendor).start_cure(case_id)

    case = contract.get_case_json(case_id)
    assert case["epoch"] == 1
    assert case["lifecycle"] == "EVIDENCE_OPEN"
    assert case["evidenceSealed"] is False
    assert case["evidenceSealedAt"] == 0
    assert case["evidenceSealedBy"] == "0x" + "00" * 20
    assert json.loads(contract.get_review(case_id, 0)) == old_review
    assert json.loads(contract.get_review_attempt(case_id, 0, 0))["review"] == (
        old_review
    )
    new_digest = _open_cure_epoch(contract, case_id, vendor)
    assert new_digest != old_release["releaseDigest"]

    old_envelope = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidence_type="DOM_FACTS",
        nonce="old-domain",
        release_digest=old_release["releaseDigest"],
    )
    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(old_envelope),
        message="evidence epoch does not match current epoch",
    )

    contract.request_review(case_id)
    _confirm_finality(contract, case_id)
    contract.as_(vendor).start_cure.reverts(
        case_id, message="cure budget is exhausted"
    )


def test_cure_epoch_resets_seal_and_requires_a_new_seal_before_cutoff(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="sealed-rmi-before-cutoff",
        advance_to_cutoff=False,
    )
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=lambda _data: {
            "ok": semantic_only_candidate(
                "REQUEST_MORE_INFO",
                missing=["CRITICAL_FLOW_TRACE"],
                rationale="The critical flow evidence needs clarification.",
            )
        },
    )
    contract.as_(buyer).close_evidence(case_id)
    contract.request_review(case_id)
    _confirm_finality(contract, case_id)

    contract.as_(vendor).start_cure(case_id)

    cured = contract.get_case_json(case_id)
    assert cured["epoch"] == 1
    assert cured["lifecycle"] == "EVIDENCE_OPEN"
    assert cured["evidenceSealed"] is False
    assert cured["evidenceSealedAt"] == 0
    assert cured["evidenceSealedBy"] == "0x" + "00" * 20

    direct_vm.warp("2026-08-13T00:29:51+00:00")
    _open_cure_epoch(contract, case_id, vendor)
    contract.request_review.reverts(
        case_id,
        message="review is not eligible before the evidence cutoff",
    )


def test_cure_requires_vendor_rmi_finality_and_never_changes_funded_terms(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, _release = _review_rmi(contract, direct_vm, buyer, vendor)
    funded_terms = contract.get_case_json(case_id)
    contract.as_(vendor).start_cure.reverts(
        case_id, message="review is not protocol-finalized"
    )
    _confirm_finality(contract, case_id)
    contract.as_(outsider).start_cure.reverts(
        case_id, message="only the vendor can start a cure"
    )
    contract.as_(vendor).start_cure(case_id)
    cured = contract.get_case_json(case_id)
    for field in (
        "buyer",
        "vendor",
        "profileHash",
        "flowsHash",
        "subjectOrigin",
        "evidenceDeadline",
        "hardDeadline",
        "escrowAmount",
        "termsHash",
    ):
        assert cured[field] == funded_terms[field]


def test_approved_review_cannot_enter_cure(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    _confirm_finality(contract, case_id)

    contract.as_(vendor).start_cure.reverts(
        case_id, message="only request-more-info can enter cure"
    )


def test_unresolved_retry_enforces_active_gate_cooldown_unique_ids_and_budget(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(
        direct_vm, release, status_overrides={"RELEASE_MANIFEST": 503}
    )
    contract.request_review(case_id)
    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "UNRESOLVED"

    contract.as_(outsider).retry_review.reverts(
        case_id, "retry-1", message="review is not protocol-finalized"
    )
    _confirm_finality(contract, case_id)
    contract.as_(outsider).retry_review.reverts(
        case_id, "retry-1", message="retry cooldown has not elapsed"
    )

    direct_vm.warp("2026-08-13T00:35:01+00:00")
    contract.as_(outsider).retry_review(case_id, "retry-1")
    assert _finality(contract, case_id)["attempt"] == 1
    contract.as_(outsider).retry_review.reverts(
        case_id, "retry-2", message="review is not protocol-finalized"
    )
    _confirm_finality(contract, case_id)

    direct_vm.warp("2026-08-13T00:40:01+00:00")
    contract.as_(outsider).retry_review.reverts(
        case_id, "retry-1", message="retry ID was already used"
    )
    contract.as_(outsider).retry_review(case_id, "retry-2")
    assert _finality(contract, case_id)["attempt"] == 2
    _confirm_finality(contract, case_id)
    direct_vm.warp("2026-08-13T00:45:01+00:00")
    contract.as_(outsider).retry_review.reverts(
        case_id, "retry-3", message="unresolved retry budget is exhausted"
    )
    assert json.loads(contract.get_review_attempt(case_id, 0, 0))["review"][
        "verdict"
    ] == (
        "UNRESOLVED"
    )
    assert json.loads(contract.get_review_attempt(case_id, 0, 1))["review"][
        "verdict"
    ] == (
        "UNRESOLVED"
    )
    assert json.loads(contract.get_review_attempt(case_id, 0, 2))["review"][
        "verdict"
    ] == (
        "UNRESOLVED"
    )


def test_unresolved_retry_before_cutoff_reuses_current_epoch_seal(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="sealed-retry-before-cutoff",
        advance_to_cutoff=False,
    )
    mock_adjudication(
        direct_vm, release, status_overrides={"RELEASE_MANIFEST": 503}
    )
    contract.as_(buyer).close_evidence(case_id)
    sealed = contract.get_case_json(case_id)
    contract.request_review(case_id)
    _confirm_finality(contract, case_id)

    direct_vm.warp("2026-08-13T00:05:01+00:00")
    contract.as_(outsider).retry_review(case_id, "sealed-retry-1")

    assert _finality(contract, case_id)["attempt"] == 1
    retried = contract.get_case_json(case_id)
    assert retried["evidenceSealed"] is True
    assert retried["evidenceSealedAt"] == sealed["evidenceSealedAt"]
    assert retried["evidenceSealedBy"] == sealed["evidenceSealedBy"]


def test_expire_unresolved_creates_deterministic_buyer_refund_only_after_budget(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(
        direct_vm, release, status_overrides={"RELEASE_MANIFEST": 503}
    )
    contract.request_review(case_id)
    _confirm_finality(contract, case_id)
    contract.as_(outsider).expire_unresolved.reverts(
        case_id, message="unresolved recovery budget remains"
    )
    for attempt in (1, 2):
        direct_vm.warp(f"2026-08-13T00:{30 + attempt * 5}:01+00:00")
        contract.as_(outsider).retry_review(case_id, f"retry-{attempt}")
        _confirm_finality(contract, case_id)

    contract.as_(outsider).expire_unresolved(case_id)
    case = contract.get_case_json(case_id)
    settlement = json.loads(contract.get_settlement(case_id))
    assert case["lifecycle"] == "SETTLEMENT_PENDING"
    assert settlement["kind"] == "REFUND"
    assert settlement["recipient"] == buyer.as_hex.lower()
    assert settlement["reason"] == "UNRESOLVED_EXHAUSTED"


def test_hard_timeout_refund_is_permissionless_and_blocked_by_active_review(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    direct_vm.warp("2026-08-13T02:00:01+00:00")

    contract.as_(outsider).timeout_refund.reverts(
        case_id, message="timeout is blocked by an active review"
    )
    _confirm_finality(contract, case_id)
    contract.as_(outsider).timeout_refund.reverts(
        case_id, message="decided approval or rejection cannot time out"
    )

    timeout_case, _ = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="timeout-no-review",
        advance_to_cutoff=False,
        supporting_evidence=("HTML_BUNDLE",),
    )
    direct_vm.warp("2026-08-13T02:00:01+00:00")
    contract.as_(outsider).timeout_refund(timeout_case)
    settlement = json.loads(contract.get_settlement(timeout_case))
    assert settlement["recipient"] == buyer.as_hex.lower()
    assert settlement["reason"] == "HARD_TIMEOUT"

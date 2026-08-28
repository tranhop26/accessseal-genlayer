from gltest.assertions import tx_execution_failed
from gltest.types import TransactionStatus

from conftest import (
    CUTOFF_TIME,
    RETRY_TIME,
    TIMEOUT_TIME,
    assert_accounting_conservation,
    candidate,
    create_funded_case,
    io_context,
    open_release,
    read_json,
    rpc,
    submit_complete_evidence,
    submit_release_epoch,
)


def _review(contract, actors, fixture_site, salt, verdict, *, keyboard_trap=False, supporting=None, unavailable=False):
    kwargs = {"keyboard_trap": keyboard_trap}
    if supporting is not None:
        kwargs["supporting"] = supporting
    case_id, release = open_release(contract, actors, fixture_site, salt, **kwargs)
    context = io_context(
        release,
        candidate(contract, case_id, release, verdict),
        unavailable_manifest=unavailable,
    )
    receipt = contract.connect(actors[2]).request_review([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context=context,
    )
    return case_id, release, receipt


def test_rejected_review_prepares_buyer_refund_only_after_finality(
    deployed_contract, actors, fixture_site
):
    case_id, _, receipt = _review(
        deployed_contract,
        actors,
        fixture_site,
        "integration-rejected",
        "REJECTED",
        keyboard_trap=True,
    )
    assert receipt["status"] == 7
    assert read_json(deployed_contract, "get_review", [case_id, 0])["verdict"] == "REJECTED"
    deployed_contract.connect(actors[2]).prepare_refund([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    settlement = read_json(deployed_contract, "get_settlement", [case_id])
    assert settlement["kind"] == "REFUND"
    assert settlement["recipient"] == actors[0].address.lower()
    assert settlement["status"] == "PREPARED"
    assert_accounting_conservation(deployed_contract)


def test_request_more_info_opens_one_vendor_cure_epoch(
    deployed_contract, actors, fixture_site
):
    case_id, _, _ = _review(
        deployed_contract,
        actors,
        fixture_site,
        "integration-rmi",
        "REQUEST_MORE_INFO",
    )
    assert read_json(deployed_contract, "get_review", [case_id, 0])["verdict"] == "REQUEST_MORE_INFO"
    deployed_contract.connect(actors[1]).start_cure([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": CUTOFF_TIME},
    )
    case = read_json(deployed_contract, "get_case", [case_id])
    assert case["epoch"] == 1
    assert case["lifecycle"] == "EVIDENCE_OPEN"
    assert read_json(deployed_contract, "get_review_attempt", [case_id, 0, 0])["status"] == "FINALIZED"
    cure_release = submit_release_epoch(
        deployed_contract, actors[1], fixture_site, case_id, epoch=1
    )
    submit_complete_evidence(
        deployed_contract, case_id, actors[0], actors[1], cure_release, epoch=1
    )
    cure = deployed_contract.connect(actors[2]).request_review([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context=io_context(
            cure_release,
            candidate(deployed_contract, case_id, cure_release, "APPROVED", epoch=1),
            when=RETRY_TIME,
        ),
    )
    assert cure["status"] == 7
    assert read_json(deployed_contract, "get_review", [case_id, 1])["verdict"] == "APPROVED"
    assert read_json(deployed_contract, "get_review_finality", [case_id])["status"] == "FINALIZED"


def test_unavailable_manifest_finalizes_unresolved_then_permissionless_retry(
    deployed_contract, actors, fixture_site
):
    case_id, release, _ = _review(
        deployed_contract,
        actors,
        fixture_site,
        "integration-unresolved",
        "UNRESOLVED",
        unavailable=True,
    )
    assert read_json(deployed_contract, "get_review", [case_id, 0])["verdict"] == "UNRESOLVED"
    retry = deployed_contract.connect(actors[2]).retry_review([case_id, "integration-retry-1"]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context=io_context(
            release,
            candidate(deployed_contract, case_id, release, "APPROVED"),
            when=RETRY_TIME,
        ),
    )
    assert retry["status"] == 7
    assert read_json(deployed_contract, "get_review_attempt", [case_id, 0, 0])["review"]["verdict"] == "UNRESOLVED"
    assert read_json(deployed_contract, "get_review_attempt", [case_id, 0, 1])["review"]["verdict"] == "APPROVED"


def test_timeout_refund_is_permissionless_and_replay_is_rejected(
    deployed_contract, actors
):
    case_id = create_funded_case(deployed_contract, actors, "integration-timeout")
    rpc("sim_setTime", [TIMEOUT_TIME])
    first = deployed_contract.connect(actors[2]).timeout_refund([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": TIMEOUT_TIME},
    )
    assert first["status"] == 7
    settlement = read_json(deployed_contract, "get_settlement", [case_id])
    assert settlement["reason"] == "HARD_TIMEOUT"
    replay = deployed_contract.connect(actors[3]).timeout_refund([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": TIMEOUT_TIME},
    )
    assert tx_execution_failed(replay, "case is not eligible for timeout refund")
    assert read_json(deployed_contract, "get_settlement", [case_id]) == settlement
    assert_accounting_conservation(deployed_contract)


def test_v4_outsider_permissionlessly_prepares_and_executes_vendor_payout(
    v4_context,
):
    """Fails if settlement authority can change the approved vendor recipient."""
    settlement, accounting = v4_context.run_outsider_payout()

    assert settlement["recipient"] == settlement["vendor"]
    assert settlement["executor"] == settlement["outsider"]
    assert accounting["totalDeposits"] == (
        accounting["reserved"]
        + accounting["pendingDispatch"]
        + accounting["dispatchedPayouts"]
        + accounting["dispatchedRefunds"]
    )


def test_settlement_and_retry_gates_reject_wrong_phase_without_state_advance(
    deployed_contract, actors, fixture_site
):
    case_id, _ = open_release(
        deployed_contract, actors, fixture_site, "integration-finality-gates"
    )
    before = read_json(deployed_contract, "get_case", [case_id])
    prepare = deployed_contract.connect(actors[2]).prepare_payout([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    retry = deployed_contract.connect(actors[2]).retry_review([case_id, "too-early"]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": CUTOFF_TIME},
    )
    assert tx_execution_failed(prepare, "case has no review result")
    assert tx_execution_failed(retry, "case has no review result")
    after = read_json(deployed_contract, "get_case", [case_id])
    assert after["readAt"] >= before["readAt"]
    assert {key: value for key, value in after.items() if key != "readAt"} == {
        key: value for key, value in before.items() if key != "readAt"
    }

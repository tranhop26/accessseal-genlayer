import json
import os

import pytest
from gltest.assertions import tx_execution_failed
from gltest.types import TransactionStatus

from conftest import (
    assert_accounting_conservation,
    assert_five_validator_consensus,
    build_release,
    candidate,
    EVIDENCE_TYPES,
    FLOWS_HASH,
    io_context,
    open_release,
    ORIGIN,
    PATHS,
    read_json,
    record_evidence,
    rpc,
)
from scripts.glsim_support import GenLayerSettlementReader, read_and_verify_settlement_proof


def test_release_fixture_binds_runtime_case_and_complete_pages_scans_flows(
    fixture_site,
):
    runtime_case_id = "runtime-case-id"
    release = build_release(runtime_case_id, fixture_site)
    dom_facts = json.loads(release["served"][PATHS["DOM_FACTS"]])
    scanner_report = json.loads(release["served"][PATHS["SCANNER_REPORT"]])
    flow_trace = json.loads(release["served"][PATHS["CRITICAL_FLOW_TRACE"]])
    urls = [
        ORIGIN + "/cases",
        ORIGIN + "/cases/new",
        ORIGIN + "/cases/" + runtime_case_id,
    ]

    assert release["manifest"]["caseId"] == runtime_case_id
    assert flow_trace["caseId"] == runtime_case_id
    assert [page["url"] for page in dom_facts["pages"]] == urls
    assert all(
        set(page) == {
            "url",
            "landmarks",
            "headings",
            "accessibleNames",
            "formLabels",
            "imageAlternatives",
            "skipLinkTarget",
            "focusableControlOrder",
            "disabledStates",
        }
        for page in dom_facts["pages"]
    )
    assert {item["label"] for item in dom_facts["pages"][1]["formLabels"]} == {
        "Vendor wallet",
        "Website origin",
        "Accessibility profile hash",
        "Critical flow 1",
        "Critical flow 2",
        "Critical flow 3",
        "Simulated escrow (wei)",
    }
    assert scanner_report["tool"] == {"name": "axe-core", "version": "4.13.0"}
    assert [scan["url"] for scan in scanner_report["scans"]] == urls
    assert [flow["id"] for flow in flow_trace["flows"]] == [
        "workspace-navigation",
        "create-case-preview",
        "case-section-navigation",
    ]
    assert all(flow["passed"] and flow["steps"] for flow in flow_trace["flows"])
    assert all(
        {step["page"] for step in flow["steps"]} == {urls[index]}
        for index, flow in enumerate(flow_trace["flows"])
    )
    assert all(
        set(step) == {
            "checkpoint",
            "page",
            "action",
            "expected",
            "actual",
            "passed",
        }
        for flow in flow_trace["flows"]
        for step in flow["steps"]
    )


def test_release_fixture_uses_case_timeline_for_all_artifacts(fixture_site):
    release = build_release("runtime-case-timeline", fixture_site)
    observed_at = 1_786_579_500

    assert {
        json.loads(release["served"][PATHS[kind]])["observedAt"]
        for kind in ("DOM_FACTS", "SCANNER_REPORT", "CRITICAL_FLOW_TRACE")
    } == {observed_at}


def test_submitted_envelopes_share_served_case_and_observation_time(
    deployed_contract, actors, fixture_site
):
    case_id, release = open_release(
        deployed_contract,
        actors,
        fixture_site,
        "integration-evidence-bindings",
    )
    observed_at = json.loads(
        release["served"][PATHS["CRITICAL_FLOW_TRACE"]]
    )["observedAt"]
    evidence = read_json(deployed_contract, "get_evidence", [case_id, 0])

    assert len(evidence["envelopes"]) == len(EVIDENCE_TYPES) + 1
    assert {item["caseId"] for item in evidence["envelopes"]} == {case_id}
    assert {item["observedAt"] for item in evidence["envelopes"]} == {
        observed_at
    }
    assert all(
        item["observedAt"] <= item["submittedAt"] < item["expiresAt"]
        for item in evidence["envelopes"]
    )


def test_five_validators_finalize_semantic_approval_and_contract_finality(
    deployed_contract, actors, fixture_site
):
    case_id, release = open_release(
        deployed_contract, actors, fixture_site, "integration-approved"
    )
    dom_facts = json.loads(release["served"][PATHS["DOM_FACTS"]])
    scanner_report = json.loads(release["served"][PATHS["SCANNER_REPORT"]])
    flow_trace = json.loads(release["served"][PATHS["CRITICAL_FLOW_TRACE"]])
    urls = [
        ORIGIN + "/cases",
        ORIGIN + "/cases/new",
        ORIGIN + "/cases/" + case_id,
    ]
    evidence = read_json(deployed_contract, "get_evidence", [case_id, 0])

    assert release["manifest"]["caseId"] == case_id
    assert flow_trace["caseId"] == case_id
    assert flow_trace["flowsHash"] == FLOWS_HASH
    assert [page["url"] for page in dom_facts["pages"]] == urls
    assert [scan["url"] for scan in scanner_report["scans"]] == urls
    assert [flow["id"] for flow in flow_trace["flows"]] == [
        "workspace-navigation",
        "create-case-preview",
        "case-section-navigation",
    ]
    assert all(flow["passed"] and flow["steps"] for flow in flow_trace["flows"])
    assert {
        dom_facts["observedAt"],
        scanner_report["observedAt"],
        flow_trace["observedAt"],
        *(item["observedAt"] for item in evidence["envelopes"]),
    } == {release["observedAt"]}
    leader_candidate = candidate(
        deployed_contract, case_id, release, "APPROVED"
    )
    assert leader_candidate == {
        "verdict": "APPROVED",
        "materialBlockers": [],
        "missingEvidence": [],
        "rationale": "Bound artifact content establishes no material blocker.",
    }
    context = io_context(release, leader_candidate)
    llm_routes = context["validators"][0]["plugin_config"]["mock_response"][
        "response"
    ]
    assert llm_routes == {
        r"[\s\S]*LEADER_REVIEW_JSON=[\s\S]*": '{"supported":true}',
        r"[\s\S]*UNTRUSTED_BINDING_AND_DATA_JSON=[\s\S]*": (
            '{"verdict":"APPROVED","materialBlockers":[],"missingEvidence":[],'
            '"rationale":"Bound artifact content establishes no material blocker."}'
        ),
    }
    rpc("accessseal_resetValidatorTelemetry", [])
    receipt = deployed_contract.connect(actors[2]).request_review([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context=context,
    )

    telemetry = rpc("accessseal_getValidatorTelemetry", [])
    assert_five_validator_consensus(receipt, telemetry)
    assert receipt["consensus_data"]["leader_receipt"]
    assert telemetry["consensusSessions"] >= 1
    assert telemetry["callbackInvocations"] == 5
    review = read_json(deployed_contract, "get_review", [case_id, 0])
    finality = read_json(deployed_contract, "get_review_finality", [case_id])
    assert review["verdict"] == "APPROVED"
    assert finality["status"] == "FINALIZED"
    assert read_json(deployed_contract, "get_case", [case_id])["lifecycle"] == "DECIDED"
    record_evidence(
        "five-validator-approval",
        {
            "caseId": case_id,
            "transactionHash": receipt["hash"],
            "validatorCount": len(receipt["consensus_data"]["validators"]),
            "validatorCallbackInvocations": telemetry["callbackInvocations"],
            "votes": receipt["consensus_data"]["votes"],
            "verdict": review["verdict"],
            "finality": finality["status"],
        },
    )


def test_glsim_exposes_eoa_dispatch_limit_without_claiming_recipient_delivery(
    deployed_contract, actors, fixture_site
):
    case_id, release = open_release(
        deployed_contract, actors, fixture_site, "integration-glsim-eoa-limit"
    )
    deployed_contract.request_review([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context=io_context(
            release, candidate(deployed_contract, case_id, release, "APPROVED")
        ),
    )
    deployed_contract.prepare_payout([case_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    settlement = read_json(deployed_contract, "get_settlement", [case_id])
    vendor_balance_before = rpc("sim_getBalance", {"account_address": actors[1].address})

    receipt = deployed_contract.connect(actors[2]).execute_settlement(
        [case_id, settlement["settlementId"]]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)

    assert tx_execution_failed(receipt, "external transfer dispatch failed before emission")
    after = read_json(deployed_contract, "get_settlement", [case_id])
    # Pinned GLSim lacks EthSend/ghost execution and also does not roll storage
    # back after that missing host operation. This is a simulator limitation,
    # not settlement proof: terminal storage exists without recipient delivery.
    assert after["status"] == "DISPATCHED_FINALIZED"
    assert after["executor"] == actors[2].address.lower()
    assert rpc("sim_getBalance", {"account_address": actors[1].address}) == vendor_balance_before
    assert_accounting_conservation(deployed_contract)
    record_evidence(
        "glsim-eoa-limit",
        {
            "caseId": case_id,
            "transactionHash": receipt["hash"],
            "executionFailed": True,
            "settlementStatus": after["status"],
            "recipientBalanceBefore": vendor_balance_before,
            "recipientBalanceAfter": rpc(
                "sim_getBalance", {"account_address": actors[1].address}
            ),
        },
    )


@pytest.mark.skipif(
    not __import__("os").environ.get("ACCESSSEAL_LIVE_SETTLEMENT"),
    reason="GLSim 0.29.2 has no EthSend/ghost execution; requires Studionet proof",
)
def test_studionet_only_dispatch_requires_child_or_recipient_readback():
    required = {
        "proof_path": "ACCESSSEAL_SETTLEMENT_PROOF_PATH",
        "rpc_url": "ACCESSSEAL_LIVE_RPC_URL",
        "network": "ACCESSSEAL_LIVE_NETWORK",
        "chain_id": "ACCESSSEAL_LIVE_CHAIN_ID",
        "contract_address": "ACCESSSEAL_LIVE_CONTRACT_ADDRESS",
        "case_id": "ACCESSSEAL_LIVE_CASE_ID",
        "settlement_id": "ACCESSSEAL_LIVE_SETTLEMENT_ID",
        "recipient": "ACCESSSEAL_LIVE_RECIPIENT",
        "amount": "ACCESSSEAL_LIVE_AMOUNT",
    }
    values = {name: os.environ.get(env_name) for name, env_name in required.items()}
    missing = [required[name] for name, value in values.items() if not value]
    if missing:
        pytest.fail("live settlement proof inputs are missing: " + ", ".join(missing))
    try:
        amount = int(values["amount"])
    except (TypeError, ValueError):
        pytest.fail("ACCESSSEAL_LIVE_AMOUNT must be an integer")
    try:
        chain_id = int(values["chain_id"], 0)
    except (TypeError, ValueError):
        pytest.fail("ACCESSSEAL_LIVE_CHAIN_ID must be an integer")
    try:
        reader = GenLayerSettlementReader(values["network"], values["rpc_url"])
    except (RuntimeError, ValueError) as exc:
        pytest.fail(f"cannot initialize live GenLayer settlement reader: {exc}")
    proof = read_and_verify_settlement_proof(
        values["proof_path"],
        network=values["network"],
        chain_id=chain_id,
        contract_address=values["contract_address"],
        case_id=values["case_id"],
        settlement_id=values["settlement_id"],
        recipient=values["recipient"],
        amount=amount,
        reader=reader,
    )
    assert proof["caseId"] == values["case_id"]

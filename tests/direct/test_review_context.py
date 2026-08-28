import json
from hashlib import sha256

import pytest


EXPECTED_CONTEXT_KEYS = {
    "binding",
    "criticalFlows",
    "dom",
    "evidence",
    "expiresAt",
    "observedAt",
    "scanner",
    "schemaVersion",
    "screenshot",
}


def test_close_evidence_stores_bounded_canonical_review_context(
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id, release = complete_v4_case(contract, buyer, vendor)
    v4_web_routes(release)

    contract.as_(buyer).close_evidence(case_id)

    readback = json.loads(contract.get_review_context(case_id, 0))
    context = json.loads(readback["contextJson"])
    assert set(readback) == {
        "caseId",
        "contextHash",
        "contextJson",
        "epoch",
        "imageSha256",
        "imageUri",
        "ready",
        "schemaVersion",
    }
    assert readback["schemaVersion"] == "accessseal-review-context/1"
    assert readback["ready"] is True
    assert len(readback["contextJson"].encode("utf-8")) <= 16_384
    assert readback["contextHash"] == "sha256:" + sha256(
        readback["contextJson"].encode("utf-8")
    ).hexdigest()
    assert set(context) == EXPECTED_CONTEXT_KEYS
    assert readback["imageSha256"] == context["screenshot"]["sha256"]
    assert readback["imageUri"] == context["screenshot"]["uri"]
    assert context["binding"]["caseId"] == case_id
    assert [item["evidenceType"] for item in context["evidence"]] == [
        "RELEASE_MANIFEST",
        "HTML_BUNDLE",
        "SCREENSHOT",
        "DOM_FACTS",
        "SCANNER_REPORT",
        "CRITICAL_FLOW_TRACE",
    ]
    assert context["scanner"]["scans"][0]["incompleteIds"] == [
        "color-contrast"
    ]
    assert context["criticalFlows"]["flows"][0]["checkpoints"] == [
        {"checkpoint": "skip-focused", "passed": True}
    ]
    case = contract.get_case_json(case_id)
    assert case["lifecycle"] == "EVIDENCE_SEALED"
    assert case["reviewContextReady"] is True
    assert case["reviewContextHash"] == readback["contextHash"]
    assert direct_vm._live_llm_handler is None


@pytest.mark.parametrize(
    "failure", ["hash", "origin", "profile", "epoch", "stale", "oversize"]
)
def test_close_evidence_failure_leaves_case_open(
    failure,
    contract,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id, release = complete_v4_case(
        contract, buyer, vendor, failure=failure
    )
    v4_web_routes(release)

    contract.as_(buyer).close_evidence.reverts(case_id)

    case = contract.get_case_json(case_id)
    assert case["lifecycle"] == "EVIDENCE_OPEN"
    assert case["evidenceSealed"] is False
    assert case["reviewContextReady"] is False
    contract.get_review_context.reverts(
        case_id, 0, message="review context does not exist"
    )


@pytest.mark.parametrize("failure", ["schema", "passed", "unsafe"])
def test_close_evidence_rejects_invalid_consumed_artifact_types(
    failure,
    contract,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id, release = complete_v4_case(
        contract, buyer, vendor, failure=failure
    )
    v4_web_routes(release)

    contract.as_(buyer).close_evidence.reverts(case_id)

    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_seal_validator_rebuilds_context_and_rejects_changed_artifact(
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id, release = complete_v4_case(contract, buyer, vendor)
    v4_web_routes(release)
    contract.as_(buyer).close_evidence(case_id)
    assert direct_vm.run_validator() is True

    changed = {
        **release,
        "bodies": {**release["bodies"]},
        "failure": "hash",
    }
    v4_web_routes(changed)
    assert direct_vm.run_validator() is False

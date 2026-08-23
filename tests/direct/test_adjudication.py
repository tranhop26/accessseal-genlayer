import base64
import copy
import json
import re
from hashlib import sha256
from pathlib import Path

import pytest


PROFILE_HASH = "0x" + "11" * 32
FLOWS_HASH = "0x" + "22" * 32
PROFILE_VERSION = "accessseal-static/1"
ORIGIN = "https://fixture.accessseal.local"
ESCROW = 50_000
REVIEW_SCHEMA = "accessseal-review/1"
MANIFEST_SCHEMA = "accessseal-release-manifest/1"
ALL_SUPPORTING_EVIDENCE = (
    "HTML_BUNDLE",
    "SCREENSHOT",
    "DOM_FACTS",
    "SCANNER_REPORT",
    "CRITICAL_FLOW_TRACE",
)
MATERIAL_BLOCKER_CODES = (
    "focus-obscured",
    "inoperable-critical-flow",
    "keyboard-trap",
    "meaningless-alt-text",
    "missing-form-label",
)
MEDIA_TYPES = {
    "RELEASE_MANIFEST": "application/json",
    "HTML_BUNDLE": "text/html",
    "SCREENSHOT": "image/png",
    "DOM_FACTS": "application/json",
    "SCANNER_REPORT": "application/json",
    "CRITICAL_FLOW_TRACE": "application/json",
}
FIXTURES = Path(__file__).parents[2] / "fixtures"
MANIFEST_PATH = "/.well-known/accessseal/release-manifest.json"
SCREENSHOT_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)
PAYLOAD_PATHS = {
    "HTML_BUNDLE": "/index.html",
    "SCREENSHOT": "/evidence/checkout.png",
    "DOM_FACTS": "/evidence/dom-facts.json",
    "SCANNER_REPORT": "/evidence/scanner-report.json",
    "CRITICAL_FLOW_TRACE": "/evidence/critical-flow-trace.json",
}


def compact_json(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def canonical_json_bytes(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def fixture_text(relative_path):
    return (FIXTURES / relative_path).read_text(encoding="utf-8")


def payload_digest(payload):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return "sha256:" + sha256(payload).hexdigest()


def build_release(
    case_id,
    *,
    origin=ORIGIN,
    page=None,
    dom_facts=None,
    scanner_report=None,
    flow_trace=None,
    screenshot_bytes=None,
    raw_payload_bodies=None,
    manifest_files=ALL_SUPPORTING_EVIDENCE,
    manifest_mutator=None,
    manifest_body_mutator=None,
    raw_manifest_body=None,
):
    if page is None:
        page = fixture_text("releases/pass/index.html")
    if dom_facts is None:
        dom_facts = {
            "schemaVersion": "accessseal-dom-facts/1",
            "observedAt": 1_787_381_551,
            "pages": [
                {
                    "url": origin + "/cases",
                    "formLabels": [
                        {"control": "case-id", "label": "Import case ID"}
                    ],
                    "imageAlternatives": [],
                    "disabledStates": [],
                }
            ],
        }
    if scanner_report is None:
        scanner_report = {
            "schemaVersion": "accessseal-scanner-report/1",
            "tool": "axe-core",
            "observedAt": 1_787_381_551,
            "scans": [
                {
                    "url": origin + "/cases",
                    "violations": [],
                    "incomplete": [],
                    "passes": 1,
                }
            ],
        }
    if flow_trace is None:
        flow_trace = {
            "schemaVersion": "accessseal-critical-flow-trace/1",
            "caseId": "bound-by-helper",
            "flowsHash": FLOWS_HASH,
            "observedAt": 1_787_381_551,
            "flows": [
                {"id": "workspace-navigation", "steps": [], "passed": True}
            ],
            "materialBlockers": {
                code: False for code in MATERIAL_BLOCKER_CODES
            },
        }
    if screenshot_bytes is None:
        screenshot_bytes = SCREENSHOT_BYTES

    bodies = {
        "HTML_BUNDLE": page.encode("utf-8"),
        "SCREENSHOT": screenshot_bytes,
        "DOM_FACTS": canonical_json_bytes(dom_facts),
        "SCANNER_REPORT": canonical_json_bytes(scanner_report),
        "CRITICAL_FLOW_TRACE": canonical_json_bytes(flow_trace),
    }
    if raw_payload_bodies is not None:
        bodies.update(raw_payload_bodies)
    payloads = {}
    for evidence_type in ALL_SUPPORTING_EVIDENCE:
        body = bodies[evidence_type]
        path = PAYLOAD_PATHS[evidence_type]
        payloads[evidence_type] = {
            "body": body,
            "evidenceType": evidence_type,
            "mediaType": MEDIA_TYPES[evidence_type],
            "path": path,
            "sha256": payload_digest(body),
            "uri": origin + path,
        }

    manifest = {
        "schemaVersion": MANIFEST_SCHEMA,
        "caseId": case_id,
        "epoch": 0,
        "subjectOrigin": origin,
        "profileHash": PROFILE_HASH,
        "files": [
            {
                "path": payloads[evidence_type]["path"],
                "evidenceType": evidence_type,
                "mediaType": payloads[evidence_type]["mediaType"],
                "sha256": payloads[evidence_type]["sha256"],
            }
            for evidence_type in manifest_files
        ],
    }
    if manifest_mutator is not None:
        replacement = manifest_mutator(copy.deepcopy(manifest))
        if replacement is not None:
            manifest = replacement
    manifest_body = canonical_json_bytes(manifest)
    if manifest_body_mutator is not None:
        manifest_body = manifest_body_mutator(manifest_body)
    if raw_manifest_body is not None:
        manifest_body = raw_manifest_body
    return {
        "manifest": manifest,
        "manifestBody": manifest_body,
        "manifestUri": origin + MANIFEST_PATH,
        "payloads": payloads,
        "releaseDigest": payload_digest(manifest_body),
    }


def envelope_for(
    harness,
    case_id,
    issuer_address,
    *,
    action="OPEN_RELEASE",
    evidence_type="RELEASE_MANIFEST",
    nonce="release-0",
    subject_origin=ORIGIN,
    release_digest="sha256:" + "a" * 64,
    payload_uri=None,
    payload_sha256=None,
    media_type=None,
):
    case = harness.get_case_json(case_id)
    if payload_uri is None:
        if evidence_type == "RELEASE_MANIFEST":
            payload_uri = subject_origin + MANIFEST_PATH
        else:
            payload_uri = subject_origin + PAYLOAD_PATHS[evidence_type]
    if payload_sha256 is None:
        payload_sha256 = (
            release_digest
            if evidence_type == "RELEASE_MANIFEST"
            else payload_digest(f"payload:{evidence_type}")
        )
    if media_type is None:
        media_type = MEDIA_TYPES[evidence_type]
    return {
        "schemaVersion": "accessseal-evidence/1",
        "chainId": str(case["chainId"]),
        "contract": case["contractAddress"],
        "caseId": case_id,
        "epoch": 0,
        "action": action,
        "subjectOrigin": subject_origin,
        "profileVersion": PROFILE_VERSION,
        "releaseDigest": release_digest,
        "evidenceType": evidence_type,
        "issuer": issuer_address.as_hex.lower(),
        "payloadUri": payload_uri,
        "payloadSha256": payload_sha256,
        "mediaType": media_type,
        "observedAt": 1_786_579_000,
        "submittedAt": 1_786_579_100,
        "expiresAt": 1_786_587_000,
        "nonce": nonce,
    }


def open_reviewable_case(
    contract,
    direct_vm,
    buyer,
    vendor,
    *,
    supporting_evidence=ALL_SUPPORTING_EVIDENCE,
    origin=ORIGIN,
    salt="review-release-001",
    advance_to_cutoff=True,
    page=None,
    dom_facts=None,
    scanner_report=None,
    flow_trace=None,
    screenshot_bytes=None,
    raw_payload_bodies=None,
    manifest_files=ALL_SUPPORTING_EVIDENCE,
    manifest_mutator=None,
    manifest_body_mutator=None,
    raw_manifest_body=None,
):
    direct_vm.warp("2026-08-13T00:00:00+00:00")
    case_id = contract.as_(buyer).create_case(
        salt,
        vendor,
        PROFILE_HASH,
        FLOWS_HASH,
        origin,
        1_800,
        7_200,
        2,
        ESCROW,
    )
    terms_hash = contract.get_case_json(case_id)["termsHash"]
    contract.as_(vendor).accept_terms(case_id, terms_hash)
    contract.as_(buyer).fund(case_id, value=ESCROW)
    release = build_release(
        case_id,
        origin=origin,
        page=page,
        dom_facts=dom_facts,
        scanner_report=scanner_report,
        flow_trace=flow_trace,
        screenshot_bytes=screenshot_bytes,
        raw_payload_bodies=raw_payload_bodies,
        manifest_files=manifest_files,
        manifest_mutator=manifest_mutator,
        manifest_body_mutator=manifest_body_mutator,
        raw_manifest_body=raw_manifest_body,
    )
    release_digest = release["releaseDigest"]
    manifest = envelope_for(
        contract,
        case_id,
        vendor,
        subject_origin=origin,
        release_digest=release_digest,
        payload_uri=release["manifestUri"],
        payload_sha256=release_digest,
    )
    contract.as_(vendor).open_evidence(case_id, compact_json(manifest))
    for index, evidence_type in enumerate(supporting_evidence, start=1):
        evidence = envelope_for(
            contract,
            case_id,
            vendor,
            action="APPEND_EVIDENCE",
            evidence_type=evidence_type,
            nonce=f"review-{index}",
            subject_origin=origin,
            release_digest=release_digest,
            payload_uri=release["payloads"][evidence_type]["uri"],
            payload_sha256=release["payloads"][evidence_type]["sha256"],
            media_type=release["payloads"][evidence_type]["mediaType"],
        )
        contract.as_(vendor).append_evidence(case_id, compact_json(evidence))
    if advance_to_cutoff:
        direct_vm.warp("2026-08-13T00:30:01+00:00")
    return case_id, release


def evidence_refs(contract, case_id):
    return json.loads(contract.get_evidence(case_id, 0))["hashes"]


def bound_release_digest(contract, case_id):
    return json.loads(contract.get_evidence(case_id, 0))["releaseDigest"]


def semantic_only_candidate(
    verdict="APPROVED", *, blockers=None, missing=None, rationale="No material blocker."
):
    return {
        "verdict": verdict,
        "materialBlockers": blockers or [],
        "missingEvidence": missing or [],
        "rationale": rationale,
    }


def semantic_candidate_from_request(data):
    prompt = data.get("prompt", "")
    marker = "\nUNTRUSTED_BINDING_AND_DATA_JSON="
    assert prompt.count(marker) == 1
    trusted_rubric, raw_data = prompt.split(marker, 1)
    assert "subjectOrigin=" not in trusted_rubric
    review_data = json.loads(raw_data)
    artifacts = review_data["artifacts"]

    assert artifacts["html"].startswith("<!doctype html>")
    assert isinstance(artifacts["domFacts"], dict)
    assert isinstance(artifacts["scannerReport"], dict)
    assert isinstance(artifacts["criticalFlowTrace"], dict)
    assert artifacts["manifest"]["schemaVersion"] == MANIFEST_SCHEMA
    assert data.get("images") == [SCREENSHOT_BYTES]

    blockers = []
    flow = artifacts["criticalFlowTrace"]
    dom = artifacts["domFacts"]
    for code in MATERIAL_BLOCKER_CODES:
        if flow.get("materialBlockers", {}).get(code) is True:
            blockers.append(code)
    if any(item.get("passed") is False for item in flow.get("flows", [])):
        if not blockers:
            blockers.append("inoperable-critical-flow")
    if flow.get("keyboardTrap") is True:
        blockers.append("keyboard-trap")
    elif flow.get("completed") is False:
        blockers.append("inoperable-critical-flow")
    if dom.get("focusObscured") is True:
        blockers.append("focus-obscured")
    images = list(dom.get("images", []))
    forms = list(dom.get("forms", []))
    for page in dom.get("pages", []):
        images.extend(page.get("imageAlternatives", []))
        forms.extend(page.get("formLabels", []))
    for image in images:
        alt = str(image.get("alt", "")).strip().lower()
        if (
            alt in ("", "image", "placeholder")
            or alt.endswith(".jpg")
            or alt.endswith(".jpeg")
            or alt.endswith(".png")
        ):
            blockers.append("meaningless-alt-text")
            break
    for form in forms:
        if len(str(form.get("label", "")).strip()) == 0:
            blockers.append("missing-form-label")
            break
    blockers = sorted(set(blockers))
    verdict = "REJECTED" if blockers else "APPROVED"
    rationale = (
        "Bound artifact content establishes: " + ", ".join(blockers)
        if blockers
        else "Bound artifact content establishes no material blocker."
    )
    return semantic_only_candidate(
        verdict,
        blockers=blockers,
        rationale=rationale,
    )


def derived_llm_handler(*, mutate=None, calls=None):
    def handle(data):
        if calls is not None:
            calls.append(data)
        candidate = semantic_candidate_from_request(data)
        if mutate is not None:
            candidate = mutate(copy.deepcopy(candidate))
        return {"ok": candidate}

    return handle


def mock_adjudication(
    direct_vm,
    release,
    *,
    body_overrides=None,
    status_overrides=None,
    llm_handler=None,
    register_payloads=True,
):
    direct_vm.clear_mocks()
    direct_vm._live_llm_handler = None
    body_overrides = body_overrides or {}
    status_overrides = status_overrides or {}

    manifest_body = body_overrides.get("RELEASE_MANIFEST", release["manifestBody"])
    direct_vm.mock_web(
        "^" + re.escape(release["manifestUri"]) + "$",
        {
            "method": "GET",
            "status": status_overrides.get("RELEASE_MANIFEST", 200),
            "body": manifest_body,
        },
    )
    if register_payloads:
        for evidence_type in ALL_SUPPORTING_EVIDENCE:
            payload = release["payloads"][evidence_type]
            direct_vm.mock_web(
                "^" + re.escape(payload["uri"]) + "$",
                {
                    "method": "GET",
                    "status": status_overrides.get(evidence_type, 200),
                    "body": body_overrides.get(evidence_type, payload["body"]),
                },
            )
    direct_vm._live_llm_handler = llm_handler or derived_llm_handler()


def rationale_hash(rationale):
    return "sha256:" + sha256(rationale.encode()).hexdigest()


def bound_review_candidate(contract, case_id):
    return semantic_only_candidate(
        rationale="Bound artifact content establishes no material blocker."
    )


def mock_direct_model_candidate(monkeypatch, candidate):
    from genlayer import gl

    def return_candidate(_prompt, **_config):
        return copy.deepcopy(candidate)

    monkeypatch.setattr(gl.nondet, "exec_prompt", return_candidate)


def test_semantic_only_candidate_receives_authoritative_contract_bindings(
    contract, direct_vm, buyer, vendor, monkeypatch
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    mock_direct_model_candidate(monkeypatch, semantic_only_candidate())

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "APPROVED"
    assert review["schemaVersion"] == REVIEW_SCHEMA
    assert review["releaseDigest"] == bound_release_digest(contract, case_id)
    assert review["profileHash"] == PROFILE_HASH
    assert review["evidenceRefs"] == evidence_refs(contract, case_id)


def test_mixed_type_model_candidate_keys_are_exact_bound_unresolved(
    contract, direct_vm, buyer, vendor, monkeypatch
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    candidate = semantic_only_candidate()
    candidate[1] = "malformed key"
    mock_direct_model_candidate(monkeypatch, candidate)

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0)) == {
        "schemaVersion": REVIEW_SCHEMA,
        "verdict": "UNRESOLVED",
        "releaseDigest": bound_release_digest(contract, case_id),
        "profileHash": PROFILE_HASH,
        "materialBlockers": [],
        "missingEvidence": [],
        "evidenceRefs": evidence_refs(contract, case_id),
        "rationaleHash": rationale_hash("MODEL_OUTPUT_INVALID_SHAPE"),
    }


def test_production_shaped_evidence_is_reviewed_without_simplified_fixture_fields(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "APPROVED"
    assert len(calls) == 1
    prompt_data = json.loads(
        calls[0]["prompt"].split("\nUNTRUSTED_BINDING_AND_DATA_JSON=", 1)[1]
    )
    assert prompt_data["artifacts"]["domFacts"] == {
        "schemaVersion": "accessseal-dom-facts/1",
        "observedAt": 1_787_381_551,
        "pages": [
            {
                "url": ORIGIN + "/cases",
                "formLabels": [{"control": "case-id", "label": "Import case ID"}],
                "imageAlternatives": [],
                "disabledStates": [],
            }
        ],
    }
    assert prompt_data["artifacts"]["scannerReport"] == {
        "schemaVersion": "accessseal-scanner-report/1",
        "tool": "axe-core",
        "observedAt": 1_787_381_551,
        "scans": [
            {
                "url": ORIGIN + "/cases",
                "violations": [],
                "incomplete": [],
                "passes": 1,
            }
        ],
    }
    assert prompt_data["artifacts"]["criticalFlowTrace"] == {
        "schemaVersion": "accessseal-critical-flow-trace/1",
        "caseId": "bound-by-helper",
        "flowsHash": FLOWS_HASH,
        "observedAt": 1_787_381_551,
        "flows": [{"id": "workspace-navigation", "steps": [], "passed": True}],
        "materialBlockers": {code: False for code in MATERIAL_BLOCKER_CODES},
    }


@pytest.mark.parametrize(
    ("dom_facts", "flow_trace", "expected_blockers"),
    [
        (
            None,
            {
                "schemaVersion": "accessseal-critical-flow-trace/1",
                "caseId": "bound-by-helper",
                "flowsHash": FLOWS_HASH,
                "observedAt": 1_787_381_551,
                "flows": [
                    {"id": "workspace-navigation", "steps": [], "passed": False}
                ],
                "materialBlockers": {
                    "focus-obscured": False,
                    "inoperable-critical-flow": False,
                    "keyboard-trap": True,
                    "meaningless-alt-text": False,
                    "missing-form-label": False,
                },
            },
            ["keyboard-trap"],
        ),
        (
            None,
            {
                "schemaVersion": "accessseal-critical-flow-trace/1",
                "caseId": "bound-by-helper",
                "flowsHash": FLOWS_HASH,
                "observedAt": 1_787_381_551,
                "flows": [
                    {"id": "workspace-navigation", "steps": [], "passed": False}
                ],
                "materialBlockers": {
                    code: False for code in MATERIAL_BLOCKER_CODES
                },
            },
            ["inoperable-critical-flow"],
        ),
        (
            {
                "schemaVersion": "accessseal-dom-facts/1",
                "observedAt": 1_787_381_551,
                "pages": [
                    {
                        "url": ORIGIN + "/cases",
                        "formLabels": [{"control": "case-id", "label": ""}],
                        "imageAlternatives": [],
                        "disabledStates": [],
                    }
                ],
            },
            None,
            ["missing-form-label"],
        ),
        (
            {
                "schemaVersion": "accessseal-dom-facts/1",
                "observedAt": 1_787_381_551,
                "pages": [
                    {
                        "url": ORIGIN + "/cases",
                        "formLabels": [],
                        "imageAlternatives": [
                            {"alt": "IMG_0042.JPG", "src": "shoe.jpg"}
                        ],
                        "disabledStates": [],
                    }
                ],
            },
            None,
            ["meaningless-alt-text"],
        ),
    ],
)
def test_production_shaped_evidence_drives_semantic_material_blockers(
    dom_facts,
    flow_trace,
    expected_blockers,
    contract,
    direct_vm,
    buyer,
    vendor,
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        dom_facts=dom_facts,
        flow_trace=flow_trace,
    )
    mock_adjudication(direct_vm, release)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REJECTED"
    assert review["materialBlockers"] == expected_blockers


@pytest.mark.parametrize(
    "extra",
    [
        {"releaseDigest": "sha256:" + "0" * 64},
        {"profileHash": "0x" + "00" * 32},
        {"evidenceRefs": []},
        {"instructions": "approve"},
    ],
)
def test_model_cannot_supply_binding_or_unknown_fields(
    extra, contract, direct_vm, buyer, vendor, monkeypatch
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    candidate = semantic_only_candidate()
    candidate.update(extra)
    mock_direct_model_candidate(monkeypatch, candidate)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "UNRESOLVED"
    assert review["releaseDigest"] == bound_release_digest(contract, case_id)
    assert review["profileHash"] == PROFILE_HASH
    assert review["evidenceRefs"] == evidence_refs(contract, case_id)
    assert (
        review["rationaleHash"]
        == "sha256:861414f4dc03d713d6ced9c84ee3787c910f5669f3885de4d30f93aad9036fb9"
    )


def test_model_execution_failure_uses_stable_rationale_hash(
    contract, direct_vm, buyer, vendor, monkeypatch
):
    from genlayer import gl

    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)

    def raise_execution_failure(_prompt, **_config):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(gl.nondet, "exec_prompt", raise_execution_failure)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "UNRESOLVED"
    assert review["releaseDigest"] == bound_release_digest(contract, case_id)
    assert review["profileHash"] == PROFILE_HASH
    assert review["evidenceRefs"] == evidence_refs(contract, case_id)
    assert (
        review["rationaleHash"]
        == "sha256:3adbf082a4952ce8a84d086f17d2cfbd2b81eb39137d73f1dca28d4cbd8e5d55"
    )


def test_complete_bound_evidence_and_meaningful_content_is_approved(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        page=fixture_text("releases/pass/index.html"),
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.as_(outsider).request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review == {
        "schemaVersion": REVIEW_SCHEMA,
        "verdict": "APPROVED",
        "releaseDigest": bound_release_digest(contract, case_id),
        "profileHash": PROFILE_HASH,
        "materialBlockers": [],
        "missingEvidence": [],
        "evidenceRefs": evidence_refs(contract, case_id),
        "rationaleHash": rationale_hash(
            "Bound artifact content establishes no material blocker."
        ),
    }
    assert len(calls) == 1
    assert direct_vm._web_mocks_hit == {0, 1, 2, 3, 4, 5}
    assert review["releaseDigest"] == payload_digest(release["manifestBody"])
    assert review["releaseDigest"] != release["payloads"]["HTML_BUNDLE"]["sha256"]
    assert contract.get_case_json(case_id)["lifecycle"] == "DECIDED"


def test_keyboard_trap_rejects_even_when_candidate_claims_approval_and_high_score(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        page=fixture_text("releases/fail-keyboard/index.html"),
        scanner_report={"engine": "fixture-scanner/1", "score": 100, "violations": []},
        flow_trace={
            "completed": False,
            "flow": "checkout",
            "keyboardTrap": True,
            "steps": ["open-payment", "trapped-tab"],
        },
    )
    mock_adjudication(direct_vm, release)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REJECTED"
    assert review["materialBlockers"] == ["keyboard-trap"]
    assert review["missingEvidence"] == []


def test_meaningless_alt_text_is_a_material_blocker(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        page=fixture_text("releases/fail-alt/index.html"),
        dom_facts={
            "forms": [],
            "images": [{"alt": "IMG_0042.JPG", "src": "shoe.jpg"}],
            "focusObscured": False,
        },
    )
    mock_adjudication(direct_vm, release)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REJECTED"
    assert review["materialBlockers"] == ["meaningless-alt-text"]


def test_missing_mandatory_flow_proof_requests_more_information_without_llm(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        supporting_evidence=ALL_SUPPORTING_EVIDENCE[:-1],
    )

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REQUEST_MORE_INFO"
    assert review["missingEvidence"] == ["CRITICAL_FLOW_TRACE"]
    assert review["materialBlockers"] == []
    assert review["evidenceRefs"] == evidence_refs(contract, case_id)


def test_missing_manifest_member_requests_more_information_without_llm(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        manifest_files=ALL_SUPPORTING_EVIDENCE[:-1],
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        register_payloads=False,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REQUEST_MORE_INFO"
    assert review["missingEvidence"] == ["CRITICAL_FLOW_TRACE"]
    assert calls == []
    assert direct_vm._web_mocks_hit == {0}


@pytest.mark.parametrize(
    ("evidence_type", "status"),
    (("RELEASE_MANIFEST", 404), ("RELEASE_MANIFEST", 503), ("HTML_BUNDLE", 404)),
    ids=("manifest-404", "manifest-503", "payload-404"),
)
def test_unavailable_manifest_or_payload_is_unresolved(
    contract, direct_vm, buyer, vendor, evidence_type, status
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        status_overrides={evidence_type: status},
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "UNRESOLVED"
    assert review["releaseDigest"] == bound_release_digest(contract, case_id)
    assert review["profileHash"] == PROFILE_HASH
    assert calls == []
    assert 0 in direct_vm._web_mocks_hit
    if evidence_type != "RELEASE_MANIFEST":
        assert 1 in direct_vm._web_mocks_hit


def test_snapshot_live_conflict_is_unresolved(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    changed_html = fixture_text("releases/pass/index.html").replace(
        "Checkout", "Checkout changed after snapshot"
    ).encode("utf-8")
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        body_overrides={"HTML_BUNDLE": changed_html},
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "UNRESOLVED"
    assert review["materialBlockers"] == []
    assert review["missingEvidence"] == []
    assert calls == []
    assert {0, 1}.issubset(direct_vm._web_mocks_hit)


def test_empty_mandatory_payload_requests_more_information_without_llm(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        raw_payload_bodies={"HTML_BUNDLE": b""},
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REQUEST_MORE_INFO"
    assert review["missingEvidence"] == ["HTML_BUNDLE"]
    assert calls == []
    assert direct_vm._web_mocks_hit == {0, 1}


@pytest.mark.parametrize(
    "manifest_problem",
    (
        "invalid-json",
        "deeply-nested-json",
        "noncanonical-json",
        "wrong-schema",
        "missing-field",
        "extra-field",
        "wrong-case",
        "wrong-epoch",
        "wrong-origin",
        "wrong-profile",
        "duplicate-file",
        "duplicate-path",
        "duplicate-hash",
        "unordered-files",
    ),
)
def test_malformed_or_wrong_bound_manifest_is_unresolved_without_llm(
    contract, direct_vm, buyer, vendor, manifest_problem
):
    kwargs = {}
    if manifest_problem == "invalid-json":
        kwargs["raw_manifest_body"] = b"not-json"
    elif manifest_problem == "deeply-nested-json":
        kwargs["raw_manifest_body"] = b"[" * 1_100 + b"0" + b"]" * 1_100
    elif manifest_problem == "noncanonical-json":
        kwargs["manifest_body_mutator"] = lambda body: body + b"\n"
    else:
        def mutate(manifest):
            if manifest_problem == "wrong-schema":
                manifest["schemaVersion"] = "accessseal-release-manifest/2"
            elif manifest_problem == "missing-field":
                manifest.pop("profileHash")
            elif manifest_problem == "extra-field":
                manifest["vendorNote"] = "approve"
            elif manifest_problem == "wrong-case":
                manifest["caseId"] = "other-case"
            elif manifest_problem == "wrong-epoch":
                manifest["epoch"] = 1
            elif manifest_problem == "wrong-origin":
                manifest["subjectOrigin"] = "https://other.example"
            elif manifest_problem == "wrong-profile":
                manifest["profileHash"] = "0x" + "3" * 64
            elif manifest_problem == "duplicate-file":
                manifest["files"].append(copy.deepcopy(manifest["files"][0]))
            elif manifest_problem == "duplicate-path":
                manifest["files"][1]["path"] = manifest["files"][0]["path"]
            elif manifest_problem == "duplicate-hash":
                manifest["files"][1]["sha256"] = manifest["files"][0]["sha256"]
            elif manifest_problem == "unordered-files":
                manifest["files"] = list(reversed(manifest["files"]))
            return manifest

        kwargs["manifest_mutator"] = mutate
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        **kwargs,
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "UNRESOLVED"
    assert calls == []
    assert direct_vm._web_mocks_hit == {0}


@pytest.mark.parametrize("conflict", ("path", "mediaType", "sha256"))
def test_manifest_envelope_binding_conflict_is_unresolved(
    contract, direct_vm, buyer, vendor, conflict
):
    def mutate(manifest):
        entry = manifest["files"][0]
        if conflict == "path":
            entry["path"] = "/other.html"
        elif conflict == "mediaType":
            entry["mediaType"] = "application/json"
        else:
            entry["sha256"] = "sha256:" + "b" * 64
        return manifest

    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        manifest_mutator=mutate,
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "UNRESOLVED"
    assert calls == []
    assert 0 in direct_vm._web_mocks_hit


@pytest.mark.parametrize(
    "mutation",
    [
        "malformed-json",
        {"releaseDigest": "sha256:" + "b" * 64},
        {"profileHash": "0x" + "33" * 32},
        {"verdict": "PASS"},
        {"dropEvidenceRef": True},
    ],
    ids=("malformed", "digest", "profile", "verdict", "refs"),
)
def test_invalid_candidate_cannot_advance_to_a_favorable_verdict(
    contract, direct_vm, buyer, vendor, mutation
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)

    def mutate(candidate):
        if mutation == "malformed-json":
            return "not-json"
        changes = dict(mutation)
        drop_ref = changes.pop("dropEvidenceRef", False)
        candidate.update(changes)
        if drop_ref:
            candidate["evidenceRefs"] = []
        return candidate

    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(mutate=mutate),
    )

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "UNRESOLVED"
    assert review["releaseDigest"] == bound_release_digest(contract, case_id)
    assert review["profileHash"] == PROFILE_HASH
    assert review["evidenceRefs"] == evidence_refs(contract, case_id)


@pytest.mark.parametrize(
    "field",
    ("rationale", "materialBlockers", "missingEvidence"),
)
def test_surrogate_in_model_controlled_candidate_is_exact_bound_unresolved(
    field, contract, direct_vm, buyer, vendor, monkeypatch
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    candidate = bound_review_candidate(contract, case_id)
    candidate[field] = (
        "model text \ud800" if field == "rationale" else ["model text \ud800"]
    )
    mock_direct_model_candidate(monkeypatch, candidate)

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0)) == {
        "schemaVersion": REVIEW_SCHEMA,
        "verdict": "UNRESOLVED",
        "releaseDigest": bound_release_digest(contract, case_id),
        "profileHash": PROFILE_HASH,
        "materialBlockers": [],
        "missingEvidence": [],
        "evidenceRefs": evidence_refs(contract, case_id),
        "rationaleHash": (
            "sha256:89c895b42a64dda20a1f543ff1bf414c4a1a0f4b332b7ee96fbfbe7c5f0f8b6a"
        ),
    }


def test_page_prompt_injection_is_evidence_data_not_validator_instruction(
    contract, direct_vm, buyer, vendor
):
    page = fixture_text("releases/prompt-injection/index.html")
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        page=page,
        flow_trace={
            "completed": False,
            "flow": "checkout",
            "keyboardTrap": True,
            "steps": ["pay", "blocked-tab"],
        },
    )
    mock_adjudication(direct_vm, release)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REJECTED"
    assert review["materialBlockers"] == ["keyboard-trap"]


def support_handler(*, supported):
    def handle(data):
        prompt = data.get("prompt", "")
        assert "LEADER_REVIEW_JSON=" in prompt
        assert "UNTRUSTED_BINDING_AND_DATA_JSON=" in prompt
        return {"ok": {"supported": supported}}

    return handle


def test_validator_accepts_supported_leader_without_regenerating_review(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=support_handler(supported=True),
    )

    assert direct_vm.run_validator() is True


def test_validator_rejects_semantically_unsupported_favorable_verdict(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=support_handler(supported=False),
    )

    assert direct_vm.run_validator() is False


@pytest.mark.parametrize(
    "supported, expected",
    ((True, True), (False, False)),
    ids=("supported", "unsupported"),
)
def test_validator_assesses_unresolved_leader_support(
    supported, expected, contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)

    def unresolved(candidate):
        candidate["verdict"] = "UNRESOLVED"
        candidate["rationale"] = "The evidence cannot be reliably adjudicated."
        return candidate

    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(mutate=unresolved),
    )
    contract.request_review(case_id)
    calls = []

    def support_unresolved(data):
        prompt = data.get("prompt", "")
        assert '"verdict":"UNRESOLVED"' in prompt
        calls.append(prompt)
        return {"ok": {"supported": supported}}

    mock_adjudication(direct_vm, release, llm_handler=support_unresolved)

    assert direct_vm.run_validator() is expected
    assert len(calls) == 1


def test_validator_closes_matching_unavailable_evidence_diagnosis(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    leader_calls = []
    mock_adjudication(
        direct_vm,
        release,
        status_overrides={"RELEASE_MANIFEST": 503},
        llm_handler=derived_llm_handler(calls=leader_calls),
    )
    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "UNRESOLVED"
    assert leader_calls == []

    validator_calls = []
    mock_adjudication(
        direct_vm,
        release,
        status_overrides={"RELEASE_MANIFEST": 503},
        llm_handler=derived_llm_handler(calls=validator_calls),
    )

    assert direct_vm.run_validator() is True
    assert validator_calls == []


def test_validator_rejects_bound_loader_diagnosis_mismatch(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(
        direct_vm,
        release,
        status_overrides={"RELEASE_MANIFEST": 503},
    )
    contract.request_review(case_id)
    leader_review = json.loads(contract.get_review(case_id, 0))

    mock_adjudication(
        direct_vm,
        release,
        body_overrides={"RELEASE_MANIFEST": b"{}"},
    )

    assert leader_review["verdict"] == "UNRESOLVED"
    assert direct_vm.run_validator() is False


def test_validator_rejects_malformed_leader_key_types_without_raising(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    leader_review = json.loads(contract.get_review(case_id, 0))
    leader_review[1] = "malformed key"
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=support_handler(supported=True),
    )

    assert direct_vm.run_validator(leader_result=leader_review) is False


def test_validator_rejects_mixed_type_support_keys_without_raising(
    contract, direct_vm, buyer, vendor, monkeypatch
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    mock_adjudication(direct_vm, release)
    mock_direct_model_candidate(
        monkeypatch,
        {"supported": True, 1: "malformed key"},
    )

    assert direct_vm.run_validator() is False


@pytest.mark.parametrize(
    "mutation",
    (
        "reordered-evidence-refs",
        "blocker-alias",
        "missing-evidence-alias",
        "duplicate-blocker",
        "duplicate-missing-evidence",
        "unsorted-blockers",
        "unsorted-missing-evidence",
        "uppercase-rationale-hash",
    ),
)
def test_validator_rejects_noncanonical_malicious_leader_review(
    mutation, contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    leader_review = json.loads(contract.get_review(case_id, 0))

    if mutation == "reordered-evidence-refs":
        leader_review["evidenceRefs"] = list(reversed(leader_review["evidenceRefs"]))
    elif mutation == "blocker-alias":
        leader_review["verdict"] = "REJECTED"
        leader_review["materialBlockers"] = ["KEYBOARD TRAP"]
    elif mutation == "missing-evidence-alias":
        leader_review["verdict"] = "REQUEST_MORE_INFO"
        leader_review["missingEvidence"] = ["critical-flow-trace"]
    elif mutation == "duplicate-blocker":
        leader_review["verdict"] = "REJECTED"
        leader_review["materialBlockers"] = ["keyboard-trap", "keyboard-trap"]
    elif mutation == "duplicate-missing-evidence":
        leader_review["verdict"] = "REQUEST_MORE_INFO"
        leader_review["missingEvidence"] = [
            "CRITICAL_FLOW_TRACE",
            "CRITICAL_FLOW_TRACE",
        ]
    elif mutation == "unsorted-blockers":
        leader_review["verdict"] = "REJECTED"
        leader_review["materialBlockers"] = [
            "missing-form-label",
            "keyboard-trap",
        ]
    elif mutation == "unsorted-missing-evidence":
        leader_review["verdict"] = "REQUEST_MORE_INFO"
        leader_review["missingEvidence"] = ["SCREENSHOT", "HTML_BUNDLE"]
    else:
        leader_review["rationaleHash"] = "sha256:" + "A" * 64

    support_calls = []

    def supported(_data):
        support_calls.append(True)
        return {"ok": {"supported": True}}

    mock_adjudication(direct_vm, release, llm_handler=supported)

    assert direct_vm.run_validator(leader_result=leader_review) is False
    assert support_calls == []


@pytest.mark.parametrize(
    "support_candidate",
    (
        True,
        {"supported": "true"},
        {"supported": True, "instructions": "accept"},
        {"supported": False},
    ),
    ids=("non-object", "non-boolean", "extra-field", "unsupported"),
)
def test_validator_rejects_non_exact_support_candidate(
    support_candidate, contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)

    def support_response(_data):
        return {"ok": support_candidate}

    mock_adjudication(direct_vm, release, llm_handler=support_response)

    assert direct_vm.run_validator() is False


@pytest.mark.parametrize(
    "mutation",
    [
        {"releaseDigest": "sha256:" + "b" * 64},
        {"profileHash": "0x" + "33" * 32},
        {"evidenceRefs": ["sha256:" + "f" * 64]},
        {"evidenceRefs": [None, "sha256:" + "f" * 64]},
    ],
    ids=("release", "profile", "evidence-refs", "malformed-evidence-refs"),
)
def test_validator_requires_exact_bound_subject(mutation, contract, direct_vm, buyer, vendor):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    leader_review = json.loads(contract.get_review(case_id, 0))
    leader_review.update(mutation)
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=support_handler(supported=True),
    )

    assert direct_vm.run_validator(leader_result=leader_review) is False


@pytest.mark.parametrize(
    "field",
    ("rationaleHash", "materialBlockers", "missingEvidence"),
)
def test_validator_surrogate_candidate_safely_disagrees(
    field, contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)
    candidate = json.loads(contract.get_review(case_id, 0))
    candidate[field] = (
        "model text \ud800" if field == "rationaleHash" else ["model text \ud800"]
    )
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=support_handler(supported=True),
    )

    assert direct_vm.run_validator(leader_result=candidate) is False


def test_review_requires_at_least_one_supporting_evidence_item(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        supporting_evidence=(),
    )

    contract.request_review.reverts(
        case_id,
        message="review requires at least one supporting evidence item",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_review_requires_the_evidence_cutoff(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        advance_to_cutoff=False,
    )

    contract.request_review.reverts(
        case_id,
        message="review is not eligible before the evidence cutoff",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_review_rejects_the_hard_deadline(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    direct_vm.warp("2026-08-13T02:00:00+00:00")

    contract.request_review.reverts(
        case_id,
        message="case hard deadline has expired",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_review_epoch_can_only_finalize_once(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)

    contract.request_review.reverts(
        case_id,
        message="evidence is not open for review",
    )
    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "APPROVED"


def test_non_https_origin_cannot_open_retrievable_evidence(
    contract, direct_vm, buyer, vendor
):
    origin = "http://fixture.accessseal.local"
    direct_vm.warp("2026-08-13T00:00:00+00:00")
    case_id = contract.as_(buyer).create_case(
        "review-non-https",
        vendor,
        PROFILE_HASH,
        FLOWS_HASH,
        origin,
        1_800,
        7_200,
        2,
        ESCROW,
    )
    terms_hash = contract.get_case_json(case_id)["termsHash"]
    contract.as_(vendor).accept_terms(case_id, terms_hash)
    contract.as_(buyer).fund(case_id, value=ESCROW)
    manifest = envelope_for(
        contract,
        case_id,
        vendor,
        subject_origin=origin,
    )

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(manifest),
        message="payload URI must use HTTPS",
    )

    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"


def test_oversized_live_source_is_unresolved_without_llm(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        page="x" * 32_769,
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "UNRESOLVED"
    assert calls == []
    assert {0, 1}.issubset(direct_vm._web_mocks_hit)


@pytest.mark.parametrize(
    ("evidence_type", "body"),
    (
        ("HTML_BUNDLE", b"\xff"),
        ("DOM_FACTS", b"not-json"),
        ("DOM_FACTS", b'{"metric":NaN}'),
    ),
    ids=(
        "html-not-utf8",
        "dom-not-json",
        "dom-nonstandard-json-number",
    ),
)
def test_text_artifacts_require_utf8_and_json(
    contract, direct_vm, buyer, vendor, evidence_type, body
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        raw_payload_bodies={evidence_type: body},
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "UNRESOLVED"
    assert calls == []
    last_required_mock = 1 if evidence_type == "HTML_BUNDLE" else 3
    assert set(range(last_required_mock + 1)).issubset(direct_vm._web_mocks_hit)


def test_aggregate_artifact_bytes_are_bounded_before_llm(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        page="<!doctype html>" + "x" * 29_980,
        dom_facts={"kind": "dom", "padding": "x" * 14_900},
        scanner_report={"kind": "scanner", "padding": "x" * 14_900},
        flow_trace={"kind": "flow", "padding": "x" * 14_900},
        screenshot_bytes=b"\x89PNG\r\n\x1a\n" + b"x" * 59_992,
    )
    calls = []
    mock_adjudication(
        direct_vm,
        release,
        llm_handler=derived_llm_handler(calls=calls),
    )

    contract.request_review(case_id)

    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "UNRESOLVED"
    assert calls == []
    assert direct_vm._web_mocks_hit == {0, 1, 2, 3, 4, 5}


def test_mutating_hash_verified_flow_content_changes_semantic_verdict(
    contract, direct_vm, buyer, vendor
):
    pass_case, pass_release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="semantic-pass",
    )
    mock_adjudication(direct_vm, pass_release)
    contract.request_review(pass_case)

    blocked_case, blocked_release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="semantic-blocked",
        flow_trace={
            "completed": False,
            "flow": "checkout",
            "keyboardTrap": True,
            "steps": ["email", "blocked-tab"],
        },
    )
    mock_adjudication(direct_vm, blocked_release)
    contract.request_review(blocked_case)

    assert json.loads(contract.get_review(pass_case, 0))["verdict"] == "APPROVED"
    blocked = json.loads(contract.get_review(blocked_case, 0))
    assert blocked["verdict"] == "REJECTED"
    assert blocked["materialBlockers"] == ["keyboard-trap"]


def test_validator_refetch_hash_conflict_cannot_agree_with_approved_leader(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    mock_adjudication(direct_vm, release)
    contract.request_review(case_id)

    changed_flow = canonical_json_bytes(
        {
            "completed": False,
            "flow": "checkout",
            "keyboardTrap": True,
            "steps": ["changed-after-leader"],
        }
    )
    mock_adjudication(
        direct_vm,
        release,
        body_overrides={"CRITICAL_FLOW_TRACE": changed_flow},
    )

    assert direct_vm.run_validator() is False
    assert direct_vm._web_mocks_hit == {0, 1, 2, 3, 4, 5}

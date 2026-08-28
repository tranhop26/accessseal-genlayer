import base64
import copy
import json
import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

import pytest


PROFILE_HASH = "0x" + "11" * 32
FLOWS_HASH = "0x" + "22" * 32
PROFILE_VERSION = "accessseal-static/1"
ORIGIN = "https://fixture.accessseal.local"
ESCROW = 50_000
REVIEW_SCHEMA = "accessseal-review/2"
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
                    "landmarks": ["nav:Workspace", "main"],
                    "headings": [{"level": 1, "name": "AccessSeal"}],
                    "accessibleNames": [
                        {"role": "link", "name": "Skip to content"}
                    ],
                    "formLabels": [
                        {"control": "case-id", "label": "Import case ID"}
                    ],
                    "imageAlternatives": [],
                    "skipLinkTarget": "#main-content",
                    "focusableControlOrder": ["link:Skip to content"],
                    "disabledStates": [],
                }
            ],
        }
    else:
        dom_facts = copy.deepcopy(dom_facts)
        dom_facts.setdefault("schemaVersion", "accessseal-dom-facts/1")
        dom_facts.setdefault("observedAt", 1_787_381_551)
        for dom_page in dom_facts.setdefault("pages", []):
            dom_page.setdefault("url", origin + "/cases")
            dom_page.setdefault("landmarks", ["nav:Workspace", "main"])
            dom_page.setdefault("headings", [{"level": 1, "name": "AccessSeal"}])
            dom_page.setdefault(
                "accessibleNames",
                [{"role": "link", "name": "Skip to content"}],
            )
            dom_page.setdefault("formLabels", [])
            dom_page.setdefault("imageAlternatives", [])
            for image in dom_page["imageAlternatives"]:
                image.setdefault("decorative", False)
            dom_page.setdefault("skipLinkTarget", "#main-content")
            dom_page.setdefault("focusableControlOrder", ["link:Skip to content"])
            dom_page.setdefault("disabledStates", [])
    if scanner_report is None:
        scanner_report = {
            "schemaVersion": "accessseal-scanner-report/1",
            "tool": {"name": "axe-core", "version": "4.13.0"},
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
    elif "scans" not in scanner_report:
        scanner_report = {
            "schemaVersion": "accessseal-scanner-report/1",
            "tool": {
                "name": str(scanner_report.get("engine", "fixture-scanner")),
                "version": "1",
            },
            "observedAt": 1_787_381_551,
            "scans": [
                {
                    "url": origin + "/cases",
                    "violations": [],
                    "incomplete": [],
                    "passes": int(scanner_report.get("score", 0)),
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
    elif "schemaVersion" not in flow_trace:
        blockers = {code: False for code in MATERIAL_BLOCKER_CODES}
        if flow_trace.get("keyboardTrap") is True:
            blockers["keyboard-trap"] = True
        elif flow_trace.get("completed") is False:
            blockers["inoperable-critical-flow"] = True
        flow_trace = {
            "schemaVersion": "accessseal-critical-flow-trace/1",
            "caseId": "bound-by-helper",
            "flowsHash": FLOWS_HASH,
            "observedAt": 1_787_381_551,
            "flows": [
                {
                    "id": str(flow_trace.get("flow", "workspace-navigation")),
                    "steps": [],
                    "passed": flow_trace.get("completed", True) is True,
                }
            ],
            "materialBlockers": blockers,
        }
    else:
        flow_trace = copy.deepcopy(flow_trace)
    if flow_trace.get("caseId") == "bound-by-helper":
        flow_trace["caseId"] = case_id
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
    seal=True,
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
    if seal and tuple(supporting_evidence) == ALL_SUPPORTING_EVIDENCE:
        mock_adjudication(direct_vm, release)
        contract.as_(buyer).close_evidence(case_id)
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
    assert review_data["schemaVersion"] == "accessseal-review-context/1"
    assert isinstance(review_data["dom"], dict)
    assert isinstance(review_data["scanner"], dict)
    assert isinstance(review_data["criticalFlows"], dict)
    assert data.get("images") == [SCREENSHOT_BYTES]

    blockers = []
    flow = review_data["criticalFlows"]
    dom = review_data["dom"]
    for code in MATERIAL_BLOCKER_CODES:
        if flow.get("materialBlockers", {}).get(code) is True:
            blockers.append(code)
    if any(item.get("passed") is False for item in flow.get("flows", [])):
        if not blockers:
            blockers.append("inoperable-critical-flow")
    images = []
    forms = []
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
        "contextHash": json.loads(contract.get_review_context(case_id, 0))["contextHash"],
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
    context = json.loads(contract.get_review_context(case_id, 0))
    assert prompt_data == json.loads(context["contextJson"])
    assert context["contextHash"] == "sha256:" + sha256(
        context["contextJson"].encode("utf-8")
    ).hexdigest()


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
        "contextHash": json.loads(contract.get_review_context(case_id, 0))["contextHash"],
        "rationaleHash": rationale_hash(
            "Bound artifact content establishes no material blocker."
        ),
    }
    assert len(calls) == 1
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
            "schemaVersion": "accessseal-dom-facts/1",
            "observedAt": 1_787_381_551,
            "pages": [{
                "url": ORIGIN + "/cases",
                "landmarks": ["nav:Workspace", "main"],
                "headings": [{"level": 1, "name": "AccessSeal"}],
                "accessibleNames": [{"role": "link", "name": "Skip to content"}],
                "formLabels": [],
                "imageAlternatives": [{"alt": "IMG_0042.JPG", "src": "shoe.jpg", "decorative": False}],
                "skipLinkTarget": "#main-content",
                "focusableControlOrder": ["link:Skip to content"],
                "disabledStates": [],
            }],
        },
    )
    mock_adjudication(direct_vm, release)

    contract.request_review(case_id)

    review = json.loads(contract.get_review(case_id, 0))
    assert review["verdict"] == "REJECTED"
    assert review["materialBlockers"] == ["meaningless-alt-text"]


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
        "contextHash": json.loads(contract.get_review_context(case_id, 0))["contextHash"],
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


def raw_candidate(verdict="APPROVED", *, blockers=None, missing=None, rationale):
    return semantic_only_candidate(
        verdict,
        blockers=blockers,
        missing=missing,
        rationale=rationale,
    )


def _seal_v4_review_case(
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
    return case_id


def _return_raw_candidate(candidate, calls=None):
    def handle(data):
        if calls is not None:
            calls.append(data)
        return {"ok": copy.deepcopy(candidate)}

    return handle


def test_same_decision_with_different_rationale_agrees(
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id = _seal_v4_review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        complete_v4_case,
        v4_web_routes,
    )
    leader = raw_candidate("APPROVED", rationale="leader explanation")
    validator = raw_candidate("APPROVED", rationale="independent explanation")
    direct_vm._live_llm_handler = _return_raw_candidate(leader)
    contract.request_review(case_id)
    direct_vm._live_llm_handler = _return_raw_candidate(validator)

    assert direct_vm.run_validator() is True


@pytest.mark.parametrize("field", ["verdict", "materialBlockers", "missingEvidence"])
def test_different_stable_decision_field_disagrees(
    field,
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id = _seal_v4_review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        complete_v4_case,
        v4_web_routes,
    )
    leader = raw_candidate("APPROVED", rationale="leader explanation")
    validator = raw_candidate("APPROVED", rationale="validator explanation")
    if field == "verdict":
        validator["verdict"] = "UNRESOLVED"
    elif field == "materialBlockers":
        validator["verdict"] = "REJECTED"
        validator["materialBlockers"] = ["keyboard-trap"]
    else:
        validator["verdict"] = "REQUEST_MORE_INFO"
        validator["missingEvidence"] = ["SCREENSHOT"]
    direct_vm._live_llm_handler = _return_raw_candidate(leader)
    contract.request_review(case_id)
    direct_vm._live_llm_handler = _return_raw_candidate(validator)

    assert direct_vm.run_validator() is False


@dataclass
class ReviewTelemetry:
    web_gets: list[str]
    ai_prompts: int


def test_review_node_fetches_one_image_and_calls_ai_once(
    monkeypatch,
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    from genlayer import gl

    case_id = _seal_v4_review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        complete_v4_case,
        v4_web_routes,
    )
    screenshot_uri = json.loads(contract.get_review_context(case_id, 0))["imageUri"]
    calls = ReviewTelemetry(web_gets=[], ai_prompts=0)
    original_get = gl.nondet.web.get

    def track_get(uri, **kwargs):
        calls.web_gets.append(uri)
        return original_get(uri, **kwargs)

    def track_prompt(data):
        calls.ai_prompts += 1
        return {
            "ok": raw_candidate(
                "APPROVED",
                rationale="The sealed context establishes no material blocker.",
            )
        }

    monkeypatch.setattr(gl.nondet.web, "get", track_get)
    direct_vm._live_llm_handler = track_prompt

    contract.request_review(case_id)

    assert direct_vm.run_validator() is True
    assert calls.web_gets == [screenshot_uri, screenshot_uri]
    assert calls.ai_prompts == 2
    assert all("release-manifest" not in uri for uri in calls.web_gets)


def _assert_post_seal_review_failure_is_atomic(contract, case_id, before_case):
    after_case = contract.get_case_json(case_id)
    assert after_case["lifecycle"] == "EVIDENCE_SEALED"
    assert {
        key: value for key, value in after_case.items() if key != "readAt"
    } == {
        key: value for key, value in before_case.items() if key != "readAt"
    }
    contract.get_review.reverts(case_id, 0, message="review does not exist")
    contract.get_review_attempt.reverts(
        case_id, 0, 0, message="review attempt does not exist"
    )
    contract.get_review_finality.reverts(
        case_id, message="review finality proof does not exist"
    )


@pytest.mark.parametrize(
    ("failure", "body", "status", "message"),
    (
        (
            "unavailable",
            b"",
            404,
            "review screenshot returned an unavailable response",
        ),
        ("non-png", b"not-a-png", 200, "review screenshot was not a PNG"),
        (
            "oversize",
            b"\x89PNG\r\n\x1a\n" + b"x" * 16_377,
            200,
            "review screenshot exceeded its byte bound",
        ),
        (
            "hash-mismatch",
            b"\x89PNG\r\n\x1a\npost-seal-tamper",
            200,
            "review screenshot hash did not match its binding",
        ),
    ),
)
def test_post_seal_screenshot_failure_leaves_review_state_atomic(
    failure,
    body,
    status,
    message,
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    case_id = _seal_v4_review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        complete_v4_case,
        v4_web_routes,
    )
    screenshot_uri = json.loads(contract.get_review_context(case_id, 0))["imageUri"]
    before_case = contract.get_case_json(case_id)
    before_accounting = json.loads(contract.get_accounting())
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        "^" + re.escape(screenshot_uri) + "$",
        {"method": "GET", "status": status, "body": body},
    )

    contract.request_review.reverts(case_id, message=message)

    _assert_post_seal_review_failure_is_atomic(contract, case_id, before_case)
    assert json.loads(contract.get_accounting()) == before_accounting


def test_post_seal_screenshot_transport_failure_leaves_review_state_atomic(
    monkeypatch,
    contract,
    direct_vm,
    buyer,
    vendor,
    complete_v4_case,
    v4_web_routes,
):
    from genlayer import gl

    case_id = _seal_v4_review_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        complete_v4_case,
        v4_web_routes,
    )
    screenshot_uri = json.loads(contract.get_review_context(case_id, 0))["imageUri"]
    before_case = contract.get_case_json(case_id)
    before_accounting = json.loads(contract.get_accounting())
    original_get = gl.nondet.web.get

    def raise_for_screenshot(uri, **kwargs):
        if uri == screenshot_uri:
            raise RuntimeError("network unavailable")
        return original_get(uri, **kwargs)

    monkeypatch.setattr(gl.nondet.web, "get", raise_for_screenshot)

    contract.request_review.reverts(
        case_id, message="review screenshot could not be fetched"
    )

    _assert_post_seal_review_failure_is_atomic(contract, case_id, before_case)
    assert json.loads(contract.get_accounting()) == before_accounting


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
        message="evidence is not open for review",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_buyer_seal_allows_immediate_review_before_evidence_cutoff(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        advance_to_cutoff=False,
        seal=False,
    )
    mock_adjudication(direct_vm, release)

    contract.as_(buyer).close_evidence(case_id)

    sealed = contract.get_case_json(case_id)
    assert sealed["lifecycle"] == "EVIDENCE_SEALED"
    assert sealed["evidenceSealed"] is True
    assert sealed["evidenceSealedAt"] > 0
    assert sealed["evidenceSealedBy"] == buyer.as_hex.lower()

    contract.request_review(case_id)

    assert json.loads(contract.get_review_finality(case_id))["status"] == (
        "PENDING_PROTOCOL_FINALITY"
    )
    assert json.loads(contract.get_review(case_id, 0))["verdict"] == "APPROVED"


def test_unsealed_complete_evidence_requires_review_after_the_evidence_cutoff(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        advance_to_cutoff=False,
        seal=False,
    )
    direct_vm.warp("2026-08-13T00:30:00+00:00")

    contract.request_review.reverts(
        case_id,
        message="evidence is not open for review",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_unsealed_complete_evidence_remains_ineligible_after_evidence_cutoff(
    contract, direct_vm, buyer, vendor
):
    case_id, release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        advance_to_cutoff=False,
        seal=False,
    )
    direct_vm.warp("2026-08-13T00:30:01+00:00")

    contract.request_review.reverts(
        case_id,
        message="evidence is not open for review",
    )


def test_review_rejects_the_hard_deadline(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(contract, direct_vm, buyer, vendor)
    direct_vm.warp("2026-08-13T02:00:00+00:00")

    contract.request_review.reverts(
        case_id,
        message="case hard deadline has expired",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_SEALED"


def test_sealed_review_rejects_exact_hard_deadline_without_state_changes(
    contract, direct_vm, buyer, vendor
):
    case_id, _release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        salt="sealed-exact-hard-deadline",
        advance_to_cutoff=False,
    )
    before_case = contract.get_case_json(case_id)
    before_evidence = json.loads(contract.get_evidence(case_id, 0))
    before_accounting = json.loads(contract.get_accounting())

    direct_vm.warp("2026-08-13T02:00:00+00:00")
    contract.request_review.reverts(
        case_id,
        message="case hard deadline has expired",
    )

    assert before_case["lifecycle"] == "EVIDENCE_SEALED"
    assert before_case["evidenceSealed"] is True
    after_case = contract.get_case_json(case_id)
    assert after_case["readAt"] > before_case["readAt"]
    assert {key: value for key, value in after_case.items() if key != "readAt"} == {
        key: value for key, value in before_case.items() if key != "readAt"
    }
    assert json.loads(contract.get_evidence(case_id, 0)) == before_evidence
    assert json.loads(contract.get_accounting()) == before_accounting


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

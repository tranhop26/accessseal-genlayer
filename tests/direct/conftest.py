import base64
import json
import sys
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest
from gltest.direct import create_address

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from scripts.glsim_support import GENVM_VERSION, scoped_fd0_injection


if sys.platform == "win32":
    # genlayer-test 0.29.2 replaces fd0 with an open tempfile, then unlinks it.
    # Windows forbids that unlink, so keep the SDK behavior and suppress only
    # the expected cleanup error for the exact injection tempfile.
    from gltest.direct import loader as direct_loader
    from gltest.direct.vm import VMContext

    _sdk_inject_message_to_fd0 = direct_loader._inject_message_to_fd0
    _sdk_cleanup_after_deactivate = VMContext._cleanup_after_deactivate

    def _inject_message_to_fd0_on_windows(vm: Any) -> None:
        paths = scoped_fd0_injection(_sdk_inject_message_to_fd0, vm)
        pending = getattr(vm, "_accessseal_fd0_temp_paths", [])
        pending.extend(paths)
        vm._accessseal_fd0_temp_paths = pending

    def _cleanup_after_deactivate_on_windows(vm: Any) -> None:
        try:
            _sdk_cleanup_after_deactivate(vm)
        finally:
            paths = getattr(vm, "_accessseal_fd0_temp_paths", [])
            vm._accessseal_fd0_temp_paths = []
            for path in paths:
                Path(path).unlink(missing_ok=True)

    direct_loader._inject_message_to_fd0 = _inject_message_to_fd0_on_windows
    VMContext._cleanup_after_deactivate = _cleanup_after_deactivate_on_windows


CONTRACT_PATH = "contracts/access_seal.py"

V4_ORIGIN = "https://fixture.accessseal.local"
V4_PROFILE_HASH = "0x" + "11" * 32
V4_FLOWS_HASH = "0x" + "22" * 32
V4_ESCROW = 50_000
V4_OBSERVED_AT = 1_786_579_000
V4_SUBMITTED_AT = 1_786_579_100
V4_EXPIRES_AT = 1_786_583_200
V4_SCREENSHOT = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)
V4_EVIDENCE_TYPES = (
    "HTML_BUNDLE",
    "SCREENSHOT",
    "DOM_FACTS",
    "SCANNER_REPORT",
    "CRITICAL_FLOW_TRACE",
)
V4_MEDIA_TYPES = {
    "RELEASE_MANIFEST": "application/json",
    "HTML_BUNDLE": "text/html",
    "SCREENSHOT": "image/png",
    "DOM_FACTS": "application/json",
    "SCANNER_REPORT": "application/json",
    "CRITICAL_FLOW_TRACE": "application/json",
}
V4_PATHS = {
    "RELEASE_MANIFEST": "/.well-known/accessseal/release-manifest.json",
    "HTML_BUNDLE": "/index.html",
    "SCREENSHOT": "/evidence/checkout.png",
    "DOM_FACTS": "/evidence/dom-facts.json",
    "SCANNER_REPORT": "/evidence/scanner-report.json",
    "CRITICAL_FLOW_TRACE": "/evidence/critical-flow-trace.json",
}


def _v4_canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _v4_digest(body: bytes) -> str:
    return "sha256:" + sha256(body).hexdigest()


class _Invocation:
    def __init__(
        self,
        target: Callable[..., Any],
        vm: Any,
        sender: Any | None,
    ) -> None:
        self._target = target
        self._vm = vm
        self._sender = sender

    def __call__(self, *args: Any, value: int = 0) -> Any:
        previous_value = self._vm.value
        try:
            self._vm.value = value
            from genlayer import gl

            gl.message_raw["datetime"] = self._vm.get_message_raw()["datetime"]
            if self._sender is None:
                return self._target(*args)
            with self._vm.prank(self._sender):
                return self._target(*args)
        finally:
            self._vm.value = previous_value

    def reverts(
        self,
        *args: Any,
        value: int = 0,
        message: str | None = None,
    ) -> None:
        from genlayer import gl

        with pytest.raises(gl.vm.UserError) as error:
            self(*args, value=value)
        if message is not None:
            assert error.value.message == message


class ContractHarness:
    def __init__(self, contract: Any, vm: Any, sender: Any | None = None) -> None:
        self._contract = contract
        self._vm = vm
        self._sender = sender

    def as_(self, sender: Any) -> "ContractHarness":
        return ContractHarness(self._contract, self._vm, sender)

    def __getattr__(self, name: str) -> Any:
        target = getattr(self._contract, name)
        if callable(target):
            return _Invocation(target, self._vm, self._sender)
        return target

    def get_case_json(self, case_id: str) -> dict[str, Any]:
        return json.loads(self._contract.get_case(case_id))


@pytest.fixture
def contract(direct_deploy: Callable[..., Any], direct_vm: Any) -> ContractHarness:
    # direct_vm creates its default sender before the pinned SDK path is installed.
    # That probe can leave the empty compatibility `genlayer` package cached.
    sys.modules.pop("genlayer", None)
    return ContractHarness(
        direct_deploy(CONTRACT_PATH, sdk_version=GENVM_VERSION), direct_vm
    )


@pytest.fixture
def complete_v4_case(direct_vm: Any):
    def create(
        contract: ContractHarness,
        buyer: Any,
        vendor: Any,
        *,
        failure: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        direct_vm.warp("2026-08-13T00:00:00+00:00")
        case_id = contract.as_(buyer).create_case(
            "v4-review-context-" + (failure or "valid"),
            vendor,
            V4_PROFILE_HASH,
            V4_FLOWS_HASH,
            V4_ORIGIN,
            1_800,
            7_200,
            2,
            V4_ESCROW,
        )
        case = contract.get_case_json(case_id)
        contract.as_(vendor).accept_terms(case_id, case["termsHash"])
        contract.as_(buyer).fund(case_id, value=V4_ESCROW)

        screenshot = V4_SCREENSHOT
        if failure == "oversize":
            screenshot = b"\x89PNG\r\n\x1a\n" + b"x" * (16_385 - 8)
        dom_facts = {
            "schemaVersion": "accessseal-dom-facts/1",
            "observedAt": V4_OBSERVED_AT,
            "pages": [
                {
                    "url": V4_ORIGIN + "/cases",
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
        scanner = {
            "schemaVersion": "accessseal-scanner-report/1",
            "tool": {"name": "axe-core", "version": "4.13.0"},
            "observedAt": V4_OBSERVED_AT,
            "scans": [
                {
                    "url": V4_ORIGIN + "/cases",
                    "violations": [],
                    "incomplete": [{"id": "color-contrast"}],
                    "passes": 40,
                }
            ],
        }
        flow_trace = {
            "schemaVersion": "accessseal-critical-flow-trace/1",
            "caseId": case_id,
            "flowsHash": V4_FLOWS_HASH,
            "observedAt": V4_OBSERVED_AT,
            "flows": [
                {
                    "id": "workspace-navigation",
                    "steps": [
                        {"checkpoint": "skip-focused", "passed": True}
                    ],
                    "passed": True,
                }
            ],
            "materialBlockers": {
                "focus-obscured": False,
                "inoperable-critical-flow": False,
                "keyboard-trap": False,
                "meaningless-alt-text": False,
                "missing-form-label": False,
            },
        }
        if failure == "schema":
            dom_facts["schemaVersion"] = "accessseal-dom-facts/2"
        elif failure == "passed":
            flow_trace["flows"][0]["passed"] = 1
        elif failure == "unsafe":
            scanner["scans"][0]["passes"] = 9_007_199_254_740_992
        bodies = {
            "HTML_BUNDLE": b"<!doctype html><main id='main-content'>AccessSeal</main>",
            "SCREENSHOT": screenshot,
            "DOM_FACTS": _v4_canonical_bytes(dom_facts),
            "SCANNER_REPORT": _v4_canonical_bytes(scanner),
            "CRITICAL_FLOW_TRACE": _v4_canonical_bytes(flow_trace),
        }
        manifest = {
            "schemaVersion": "accessseal-release-manifest/1",
            "caseId": case_id,
            "epoch": 0,
            "subjectOrigin": V4_ORIGIN,
            "profileHash": V4_PROFILE_HASH,
            "files": [
                {
                    "path": V4_PATHS[evidence_type],
                    "evidenceType": evidence_type,
                    "mediaType": V4_MEDIA_TYPES[evidence_type],
                    "sha256": _v4_digest(bodies[evidence_type]),
                }
                for evidence_type in V4_EVIDENCE_TYPES
            ],
        }
        if failure == "origin":
            manifest["subjectOrigin"] = "https://other.example"
        elif failure == "profile":
            manifest["profileHash"] = "0x" + "33" * 32
        elif failure == "epoch":
            manifest["epoch"] = 1
        manifest_body = _v4_canonical_bytes(manifest)
        release_digest = _v4_digest(manifest_body)
        expires_at = V4_EXPIRES_AT

        def envelope(evidence_type: str, index: int) -> dict[str, object]:
            is_manifest = evidence_type == "RELEASE_MANIFEST"
            return {
                "schemaVersion": "accessseal-evidence/1",
                "chainId": str(case["chainId"]),
                "contract": case["contractAddress"],
                "caseId": case_id,
                "epoch": 0,
                "action": "OPEN_RELEASE" if is_manifest else "APPEND_EVIDENCE",
                "subjectOrigin": V4_ORIGIN,
                "profileVersion": "accessseal-static/1",
                "releaseDigest": release_digest,
                "evidenceType": evidence_type,
                "issuer": vendor.as_hex.lower(),
                "payloadUri": V4_ORIGIN + V4_PATHS[evidence_type],
                "payloadSha256": release_digest
                if is_manifest
                else _v4_digest(bodies[evidence_type]),
                "mediaType": V4_MEDIA_TYPES[evidence_type],
                "observedAt": V4_OBSERVED_AT,
                "submittedAt": V4_SUBMITTED_AT,
                "expiresAt": expires_at,
                "nonce": f"v4-{index}",
            }

        contract.as_(vendor).open_evidence(
            case_id,
            json.dumps(envelope("RELEASE_MANIFEST", 0), separators=(",", ":")),
        )
        for index, evidence_type in enumerate(V4_EVIDENCE_TYPES, start=1):
            contract.as_(vendor).append_evidence(
                case_id,
                json.dumps(envelope(evidence_type, index), separators=(",", ":")),
            )
        release = {
            "manifestBody": manifest_body,
            "bodies": bodies,
            "failure": failure,
        }
        if failure == "stale":
            direct_vm.warp("2026-08-13T01:30:01+00:00")
        return case_id, release

    return create


@pytest.fixture
def v4_web_routes(direct_vm: Any):
    def register(release: dict[str, Any]) -> None:
        import re

        direct_vm.clear_mocks()
        direct_vm._live_llm_handler = None
        direct_vm.mock_web(
            "^" + re.escape(V4_ORIGIN + V4_PATHS["RELEASE_MANIFEST"]) + "$",
            {"method": "GET", "status": 200, "body": release["manifestBody"]},
        )
        for evidence_type in V4_EVIDENCE_TYPES:
            body = release["bodies"][evidence_type]
            if release["failure"] == "hash" and evidence_type == "SCREENSHOT":
                body = body + b"tampered"
            direct_vm.mock_web(
                "^" + re.escape(V4_ORIGIN + V4_PATHS[evidence_type]) + "$",
                {"method": "GET", "status": 200, "body": body},
            )

    return register


@pytest.fixture
def buyer(contract: ContractHarness) -> Any:
    return create_address("accessseal-buyer")


@pytest.fixture
def vendor(contract: ContractHarness) -> Any:
    return create_address("accessseal-vendor")


@pytest.fixture
def outsider(contract: ContractHarness) -> Any:
    return create_address("accessseal-outsider")

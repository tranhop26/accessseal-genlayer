from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pytest
from genlayer_py import create_account
from gltest import get_validator_factory
from gltest.contracts.contract import Contract
from gltest.assertions import tx_execution_succeeded
from gltest.types import TransactionStatus

PROJECT_ROOT = Path(__file__).parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.glsim_support import (
    assert_validator_callbacks,
    validate_runner_fingerprint,
)


RPC_URL = "http://127.0.0.1:4000/api"
GLSIM_STARTUP_TIMEOUT_SECONDS = 120
ORIGIN = "https://fixture.accessseal.local"
PROFILE_HASH = "0x" + "11" * 32
FLOWS_HASH = "0x" + "22" * 32
PROFILE_VERSION = "accessseal-static/1"
ESCROW = 50_000
BASE_TIME = "2026-08-13T00:00:00+00:00"
EVIDENCE_TIME = "2026-08-13T00:05:00+00:00"
CUTOFF_TIME = "2026-08-13T00:30:01+00:00"
CURE_EVIDENCE_TIME = "2026-08-13T00:32:00+00:00"
RETRY_TIME = "2026-08-13T00:35:01+00:00"
TIMEOUT_TIME = "2026-08-13T02:00:01+00:00"
EVIDENCE_OBSERVED_AT = 1_786_579_500
CURE_EVIDENCE_OBSERVED_AT = 1_786_581_120
EVIDENCE_TTL_SECONDS = 7_200
MANIFEST_PATH = "/.well-known/accessseal/release-manifest.json"
EVIDENCE_TYPES = (
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
CREATE_FORM_LABELS = (
    "Vendor wallet",
    "Website origin",
    "Accessibility profile hash",
    "Critical flow 1",
    "Critical flow 2",
    "Critical flow 3",
    "Simulated escrow (wei)",
)
FLOW_CHECKPOINTS = {
    "workspace-navigation": (
        "skip-focused",
        "main-focused",
        "overview-navigation",
        "cases-navigation",
    ),
    "create-case-preview": (
        "skip-focused",
        "main-focused",
        "vendor-input",
        "no-keyboard-trap",
        "terms-step",
        "subject-origin",
        "profile-hash",
        "critical-flow-1",
        "critical-flow-2",
        "critical-flow-3",
        "escrow",
        "preview-no-send",
    ),
    "case-section-navigation": (
        "lifecycle-readback",
        "skip-focused",
        "main-focused",
        "terms-navigation",
        "terms-escape",
        "evidence-navigation",
        "evidence-escape",
        "decision-navigation",
        "decision-escape",
        "settlement-navigation",
        "settlement-escape",
    ),
}
MEDIA_TYPES = {
    "RELEASE_MANIFEST": "application/json",
    "HTML_BUNDLE": "text/html",
    "SCREENSHOT": "image/png",
    "DOM_FACTS": "application/json",
    "SCANNER_REPORT": "application/json",
    "CRITICAL_FLOW_TRACE": "application/json",
}
PATHS = {
    "HTML_BUNDLE": "/index.html",
    "SCREENSHOT": "/evidence/checkout.png",
    "DOM_FACTS": "/evidence/dom-facts.json",
    "SCANNER_REPORT": "/evidence/scanner-report.json",
    "CRITICAL_FLOW_TRACE": "/evidence/critical-flow-trace.json",
}
SCREENSHOT = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)


def rpc(method: str, params: Any) -> Any:
    request = Request(
        RPC_URL,
        data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        ).encode(),
        headers={"content-type": "application/json"},
    )
    with urlopen(request, timeout=2) as response:
        payload = json.load(response)
    if "error" in payload:
        raise RuntimeError(payload["error"])
    return payload["result"]


def compact(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def digest(body: bytes) -> str:
    return "sha256:" + sha256(body).hexdigest()


def read_json(contract: Any, method: str, args: list[Any]) -> dict[str, Any]:
    return json.loads(getattr(contract, method)(args).call())


def assert_five_validator_consensus(
    receipt: dict[str, Any], telemetry: dict[str, Any]
) -> None:
    # genlayer-py normalizes the GLSim FINALIZED wire status to protocol code 7.
    # Runner telemetry comes from the validator callable boundary, so GLSim's
    # deterministic auto-agree receipt fallback cannot satisfy this assertion.
    assert_validator_callbacks(receipt, telemetry, expected=5)


def assert_success(receipt: dict[str, Any]) -> dict[str, Any]:
    leader = receipt.get("consensus_data", {}).get("leader_receipt", [{}])[0]
    assert tx_execution_succeeded(receipt), leader.get("genvm_result", {}).get("stderr")
    return receipt


def assert_accounting_conservation(contract: Any) -> None:
    accounting = read_json(contract, "get_accounting", [])
    assert accounting["totalDeposits"] == (
        accounting["reserved"]
        + accounting["pendingDispatch"]
        + accounting["dispatchedPayouts"]
        + accounting["dispatchedRefunds"]
    )


def record_evidence(name: str, payload: dict[str, Any]) -> None:
    evidence_dir = Path("work/evidence")
    evidence_dir.mkdir(parents=True, exist_ok=True)
    path = evidence_dir / "task6-local-readback.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    current[name] = payload
    path.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")


class FixtureSite:
    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, str, bytes]] = {}

    def set(self, path: str, body: bytes, media_type: str, status: int = 200) -> None:
        self.routes[path] = (status, media_type, body)

    def fetch(self, base_url: str, path: str) -> bytes:
        with urlopen(base_url + path, timeout=2) as response:
            return response.read()


def glsim_startup_error(message: str, log_path: Path) -> RuntimeError:
    try:
        with log_path.open("rb") as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 8192))
            tail = stream.read(8192).decode("utf-8", errors="replace")[-4000:].strip()
    except (OSError, TypeError) as error:
        tail = f"unable to read child log: {error}"
    return RuntimeError(f"{message}\nGLSim child log tail:\n{tail or '<empty>'}")


@pytest.fixture(scope="session")
def glsim_server():
    process: subprocess.Popen | None = None
    log = None
    child_temp: tempfile.TemporaryDirectory[str] | None = None
    session_id = secrets.token_hex(16)
    try:
        existing = False
        try:
            rpc("ping", [])
            existing = True
        except Exception:
            pass

        if existing:
            if os.environ.get("ACCESSSEAL_REUSE_GLSIM") != "1":
                raise RuntimeError(
                    "port 4000 is already in use; external GLSim reuse requires "
                    "ACCESSSEAL_REUSE_GLSIM=1 and ACCESSSEAL_GLSIM_SESSION_ID"
                )
            expected_session = os.environ.get("ACCESSSEAL_GLSIM_SESSION_ID")
            if not expected_session:
                raise RuntimeError(
                    "ACCESSSEAL_GLSIM_SESSION_ID is required for explicit reuse"
                )
            fingerprint = rpc("accessseal_getFingerprint", [])
            validate_runner_fingerprint(fingerprint, expected_session)
            yield fingerprint
            return

        evidence_dir = Path("work/evidence")
        evidence_dir.mkdir(parents=True, exist_ok=True)
        log_path = evidence_dir / "glsim-task6.log"
        log = log_path.open("w", encoding="utf-8")
        child_env = os.environ.copy()
        child_env["ACCESSSEAL_GLSIM_SESSION_ID"] = session_id
        child_temp = tempfile.TemporaryDirectory(prefix="accessseal-glsim-")
        child_env["TEMP"] = child_temp.name
        child_env["TMP"] = child_temp.name
        process = subprocess.Popen(
            [sys.executable, "scripts/run-glsim-integration.py"],
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            env=child_env,
        )
        deadline = time.monotonic() + GLSIM_STARTUP_TIMEOUT_SECONDS
        while True:
            try:
                rpc("ping", [])
                fingerprint = rpc("accessseal_getFingerprint", [])
                validate_runner_fingerprint(fingerprint, session_id)
                break
            except Exception:
                if process.poll() is not None:
                    if hasattr(log, "flush"):
                        log.flush()
                    raise glsim_startup_error("GLSim exited before becoming ready", log_path)
                if time.monotonic() >= deadline:
                    if hasattr(log, "flush"):
                        log.flush()
                    raise glsim_startup_error("GLSim readiness deadline exceeded", log_path)
                time.sleep(0.1)
        yield fingerprint
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            else:
                process.wait(timeout=5)
        if log is not None:
            log.close()
        if child_temp is not None:
            child_temp.cleanup()


@pytest.fixture(scope="session")
def fixture_site():
    site = FixtureSite()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            route = site.routes.get(self.path)
            if route is None:
                self.send_error(404)
                return
            status, media_type, body = route
            self.send_response(status)
            self.send_header("content-type", media_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield site, f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    thread.join(timeout=2)


@pytest.fixture(scope="session")
def actors(glsim_server):
    values = [create_account(secrets.token_hex(32)) for _ in range(4)]
    for account in values:
        rpc("sim_fundAccount", [account.address, 10**18])
    return values


@pytest.fixture(scope="session")
def deployed_contract(glsim_server, actors):
    deployment = rpc(
        "sim_deploy",
        {
            "code_path": str(Path("contracts/access_seal.py").resolve()),
            "sender": actors[0].address,
        },
    )
    schema_result = subprocess.run(
        ["genvm-lint", "schema", "--json", "contracts/access_seal.py"],
        check=True,
        capture_output=True,
        text=True,
    )
    schema = json.loads(schema_result.stdout)["schema"]
    return Contract.new(deployment["contract_address"], schema, account=actors[0])


def evidence_timeline(epoch: int) -> dict[str, object]:
    if epoch == 0:
        transaction_time = EVIDENCE_TIME
        observed_at = EVIDENCE_OBSERVED_AT
    else:
        transaction_time = CURE_EVIDENCE_TIME
        observed_at = CURE_EVIDENCE_OBSERVED_AT
    return {
        "transactionTime": transaction_time,
        "observedAt": observed_at,
        "submittedAt": observed_at,
        "expiresAt": observed_at + EVIDENCE_TTL_SECONDS,
    }


def build_release(case_id: str, fixture_site, *, keyboard_trap=False, epoch=0):
    site, base_url = fixture_site
    fixture_root = Path(__file__).parents[2] / "fixtures" / "releases"
    html_name = "fail-keyboard" if keyboard_trap else "pass"
    timeline = evidence_timeline(epoch)
    observed_at = timeline["observedAt"]
    urls = [ORIGIN + "/cases", ORIGIN + "/cases/new", ORIGIN + "/cases/" + case_id]
    pages = []
    for index, url in enumerate(urls):
        labels = (
            [{"control": "input", "label": label} for label in CREATE_FORM_LABELS]
            if index == 1
            else (
                [{"control": "case-id", "label": "Import case ID"}]
                if index == 0
                else []
            )
        )
        pages.append(
            {
                "url": url,
                "landmarks": ["nav:Workspace", "main"],
                "headings": [{"level": 1, "name": "AccessSeal"}],
                "accessibleNames": [
                    {"role": "link", "name": "Skip to content"}
                ],
                "formLabels": labels,
                "imageAlternatives": [],
                "skipLinkTarget": "#main-content",
                "focusableControlOrder": ["link:Skip to content"],
                "disabledStates": [{"name": "New case", "disabled": False}],
            }
        )
    flows = []
    for index, (flow_id, checkpoints) in enumerate(FLOW_CHECKPOINTS.items()):
        steps = []
        for checkpoint in checkpoints:
            passed = not (
                keyboard_trap
                and flow_id == "create-case-preview"
                and checkpoint == "no-keyboard-trap"
            )
            steps.append(
                {
                    "checkpoint": checkpoint,
                    "page": urls[index],
                    "action": "Keyboard",
                    "expected": checkpoint + " expected",
                    "actual": checkpoint + (" blocked" if not passed else " observed"),
                    "passed": passed,
                }
            )
        flows.append({"id": flow_id, "steps": steps, "passed": all(step["passed"] for step in steps)})
    bodies = {
        "HTML_BUNDLE": (fixture_root / html_name / "index.html").read_bytes(),
        "SCREENSHOT": SCREENSHOT,
        "DOM_FACTS": canonical_bytes(
            {
                "schemaVersion": "accessseal-dom-facts/1",
                "observedAt": observed_at,
                "pages": pages,
            }
        ),
        "SCANNER_REPORT": canonical_bytes(
            {
                "schemaVersion": "accessseal-scanner-report/1",
                "tool": {"name": "axe-core", "version": "4.13.0"},
                "observedAt": observed_at,
                "scans": [
                    {
                        "url": url,
                        "violations": [],
                        "incomplete": [],
                        "passes": 40,
                    }
                    for url in urls
                ],
            }
        ),
        "CRITICAL_FLOW_TRACE": canonical_bytes(
            {
                "schemaVersion": "accessseal-critical-flow-trace/1",
                "caseId": case_id,
                "flowsHash": FLOWS_HASH,
                "observedAt": observed_at,
                "flows": flows,
                "materialBlockers": {
                    code: code == "keyboard-trap" and keyboard_trap
                    for code in MATERIAL_BLOCKER_CODES
                },
            }
        ),
    }
    manifest = {
        "schemaVersion": "accessseal-release-manifest/1",
        "caseId": case_id,
        "epoch": epoch,
        "subjectOrigin": ORIGIN,
        "profileHash": PROFILE_HASH,
        "files": [
            {
                "path": PATHS[kind],
                "evidenceType": kind,
                "mediaType": MEDIA_TYPES[kind],
                "sha256": digest(bodies[kind]),
            }
            for kind in EVIDENCE_TYPES
        ],
    }
    manifest_body = canonical_bytes(manifest)
    site.set(MANIFEST_PATH, manifest_body, "application/json")
    for kind, body in bodies.items():
        site.set(PATHS[kind], body, MEDIA_TYPES[kind])
    # Exercise a real fixture server. GLSim receives these exact bytes through its
    # strict I/O adapter because AccessSeal intentionally rejects localhost HTTP URIs.
    served = {MANIFEST_PATH: site.fetch(base_url, MANIFEST_PATH)}
    served.update({PATHS[k]: site.fetch(base_url, PATHS[k]) for k in EVIDENCE_TYPES})
    return {
        "manifest": manifest,
        "bodies": bodies,
        "served": served,
        "digest": digest(manifest_body),
        **timeline,
    }


def envelope(contract, case_id, issuer, release, kind, *, epoch=0, nonce="release"):
    case = read_json(contract, "get_case", [case_id])
    action = "OPEN_RELEASE" if kind == "RELEASE_MANIFEST" else "APPEND_EVIDENCE"
    path = MANIFEST_PATH if kind == "RELEASE_MANIFEST" else PATHS[kind]
    payload_hash = release["digest"] if kind == "RELEASE_MANIFEST" else digest(release["bodies"][kind])
    return compact(
        {
            "schemaVersion": "accessseal-evidence/1",
            "chainId": str(case["chainId"]),
            "contract": case["contractAddress"],
            "caseId": case_id,
            "epoch": epoch,
            "action": action,
            "subjectOrigin": ORIGIN,
            "profileVersion": PROFILE_VERSION,
            "releaseDigest": release["digest"],
            "evidenceType": kind,
            "issuer": issuer.address.lower(),
            "payloadUri": ORIGIN + path,
            "payloadSha256": payload_hash,
            "mediaType": MEDIA_TYPES[kind],
            "observedAt": release["observedAt"],
            "submittedAt": release["submittedAt"],
            "expiresAt": release["expiresAt"],
            "nonce": nonce,
        }
    )


def io_context(
    release,
    candidate=None,
    *,
    supported=True,
    unavailable_manifest=False,
    when=CUTOFF_TIME,
):
    rpc("sim_setTime", [when])
    web = _mock_web_routes(release)
    web = {ORIGIN + PATHS["SCREENSHOT"]: web[ORIGIN + PATHS["SCREENSHOT"]]}
    llm = (
        {
            r"[\s\S]*UNTRUSTED_BINDING_AND_DATA_JSON=[\s\S]*": compact(
                candidate
            ),
        }
        if candidate is not None
        else {}
    )
    validators = get_validator_factory().batch_create_mock_validators(
        5,
        mock_llm_response={"nondet_exec_prompt": llm},
        mock_web_response={"nondet_web_request": web},
    )
    return {"validators": [v.to_dict() for v in validators], "genvm_datetime": when}


def _mock_web_routes(release, *, screenshot_status=200):
    return {
        ORIGIN + path: {
            "method": "GET",
            "status": screenshot_status if path == PATHS["SCREENSHOT"] else 200,
            "body": "",
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        }
        for path, body in release["served"].items()
    }


def _v4_validator(
    release,
    candidate,
    *,
    screenshot_only=False,
    screenshot_status=200,
    callback_timeout=False,
):
    web = _mock_web_routes(release, screenshot_status=screenshot_status)
    if screenshot_only:
        web = {ORIGIN + PATHS["SCREENSHOT"]: web[ORIGIN + PATHS["SCREENSHOT"]]}
    llm = {
        r"[\s\S]*UNTRUSTED_BINDING_AND_DATA_JSON=[\s\S]*": compact(candidate)
    }
    validator = get_validator_factory().create_mock_validator(
        mock_llm_response={"nondet_exec_prompt": llm},
        mock_web_response={"nondet_web_request": web},
    ).to_dict()
    if callback_timeout:
        validator["config"]["accesssealCallbackTimeout"] = True
    return validator


def v4_io_context(
    release,
    leader_candidate,
    *,
    validator_candidates=None,
    validator_timeout=False,
    when=CUTOFF_TIME,
):
    rpc("sim_setTime", [when])
    leader = _v4_validator(release, leader_candidate, screenshot_only=True)
    if validator_candidates is None:
        validator_candidates = [leader_candidate] * 5
    validators = [leader] + [
        _v4_validator(
            release,
            candidate_value,
            screenshot_only=True,
            callback_timeout=validator_timeout,
        )
        for candidate_value in validator_candidates[1:]
    ]
    return {
        "validators": validators,
        "genvm_datetime": when,
    }


class V4IntegrationContext:
    def __init__(self, contract, actors, fixture_site):
        self.contract = contract
        self.actors = actors
        self.fixture_site = fixture_site
        self._sequence = 0

    def _next_salt(self, suffix):
        self._sequence += 1
        return f"v4-{suffix}-{self._sequence}-{secrets.token_hex(6)}"

    def _seal(self, suffix):
        buyer, _vendor, _reviewer, _outsider = self.actors
        case_id = create_funded_case(
            self.contract, self.actors, self._next_salt(suffix)
        )
        release = submit_release_epoch(
            self.contract,
            self.actors[1],
            self.fixture_site,
            case_id,
            epoch=0,
        )
        seal_web = _mock_web_routes(release)
        validators = get_validator_factory().batch_create_mock_validators(
            5,
            mock_web_response={"nondet_web_request": seal_web},
        )
        seal = self.contract.connect(buyer).close_evidence([case_id]).transact(
            wait_transaction_status=TransactionStatus.FINALIZED,
            transaction_context={
                "validators": [validator.to_dict() for validator in validators],
                "genvm_datetime": release["transactionTime"],
            },
        )
        assert_success(seal)
        return case_id, release

    @staticmethod
    def _receipt_readback(receipt):
        transaction = rpc("eth_getTransactionByHash", [receipt["hash"]])
        return {
            "status": transaction["status"],
            "tx_execution_result": transaction.get("txExecutionResultName"),
        }

    def run_happy_path(self):
        rpc("accessseal_resetValidatorTelemetry", [])
        case_id, release = self._seal("happy")
        _buyer, _vendor, reviewer, _outsider = self.actors
        review = self.contract.connect(reviewer).request_review([case_id]).transact(
            wait_transaction_status=TransactionStatus.FINALIZED,
            transaction_context=v4_io_context(
                release, candidate(self.contract, case_id, release, "APPROVED")
            ),
        )
        return (
            self._receipt_readback(review),
            rpc("accessseal_getValidatorTelemetry", []),
            {
                "review": read_json(self.contract, "get_review", [case_id, 0]),
                "attempt": read_json(
                    self.contract, "get_review_attempt", [case_id, 0, 0]
                ),
                "finality": read_json(
                    self.contract, "get_review_finality", [case_id]
                ),
            },
        )

    def run_negative_control(self, control):
        rpc("accessseal_resetValidatorTelemetry", [])
        case_id, release = self._seal(control)
        _buyer, _vendor, reviewer, outsider = self.actors
        approved = candidate(self.contract, case_id, release, "APPROVED")
        reserved_before = read_json(self.contract, "get_accounting", [])["reserved"]
        if control == "disagreement":
            rejected = candidate(self.contract, case_id, release, "REJECTED")
            rejected["materialBlockers"] = ["focus-obscured"]
            rejected["rationale"] = "Independent validator found obscured focus."
            validators = [
                approved,
                rejected,
                candidate(self.contract, case_id, release, "REJECTED"),
                rejected,
                approved,
            ]
            context = v4_io_context(
                release, approved, validator_candidates=validators
            )
        elif control == "timeout":
            context = v4_io_context(release, approved, validator_timeout=True)
        else:
            raise ValueError(f"unknown control: {control}")
        try:
            review = self.contract.connect(reviewer).request_review([case_id]).transact(
                wait_transaction_status=TransactionStatus.FINALIZED,
                transaction_context=context,
            )
            receipt = self._receipt_readback(review)
        except Exception:
            receipt = {
                "status": "UNDETERMINED",
                "tx_execution_result": "FINISHED_WITH_ERROR",
            }
        try:
            attempt = read_json(self.contract, "get_review_attempt", [case_id, 0, 0])
        except Exception:
            attempt = None
        try:
            retry = self.contract.connect(outsider).retry_review(
                [case_id, f"{control}-retry"]
            ).transact(
                wait_transaction_status=TransactionStatus.FINALIZED,
                transaction_context={"genvm_datetime": RETRY_TIME},
            )
            retry_rejected = not tx_execution_succeeded(retry)
        except Exception:
            retry_rejected = True
        return {
            "receipt": receipt,
            "telemetry": rpc("accessseal_getValidatorTelemetry", []),
            "reviewResultExists": attempt is not None,
            "reviewAttemptExists": attempt is not None,
            "case": read_json(self.contract, "get_case", [case_id]),
            "accounting": read_json(self.contract, "get_accounting", []),
            "reservedBefore": reserved_before,
            "retryEligible": not retry_rejected,
        }

    def run_outsider_payout(self):
        _receipt, _telemetry, readback = self.run_happy_path()
        case_id = readback["attempt"]["caseId"]
        _buyer, vendor, _reviewer, outsider = self.actors
        self.contract.connect(outsider).prepare_payout([case_id]).transact(
            wait_transaction_status=TransactionStatus.FINALIZED
        )
        prepared = read_json(self.contract, "get_settlement", [case_id])
        self.contract.connect(outsider).execute_settlement(
            [case_id, prepared["settlementId"]]
        ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
        settlement = read_json(self.contract, "get_settlement", [case_id])
        settlement["vendor"] = vendor.address.lower()
        settlement["outsider"] = outsider.address.lower()
        return settlement, read_json(self.contract, "get_accounting", [])


@pytest.fixture
def v4_context(deployed_contract, actors, fixture_site):
    return V4IntegrationContext(deployed_contract, actors, fixture_site)


def create_funded_case(contract, actors, salt: str, *, max_retries=2):
    rpc("sim_setTime", [BASE_TIME])
    buyer, vendor, _, _ = actors
    buyer_contract = contract.connect(buyer)
    create_receipt = assert_success(buyer_contract.create_case(
        [salt, vendor.address, PROFILE_HASH, FLOWS_HASH, ORIGIN, 1800, 7200, max_retries, ESCROW]
    ).transact(value=0, wait_transaction_status=TransactionStatus.FINALIZED, transaction_context={"genvm_datetime": BASE_TIME}))
    payload = create_receipt["consensus_data"]["leader_receipt"][0]["result"]["payload"]
    case_id = json.loads(payload["readable"])
    terms = read_json(contract, "get_case", [case_id])["termsHash"]
    assert_success(contract.connect(vendor).accept_terms([case_id, terms]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": BASE_TIME},
    ))
    assert_success(buyer_contract.fund([case_id]).transact(
        value=ESCROW,
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": BASE_TIME},
    ))
    return case_id


def submit_release_epoch(contract, vendor, fixture_site, case_id, *, epoch, keyboard_trap=False, supporting=EVIDENCE_TYPES):
    release = build_release(case_id, fixture_site, keyboard_trap=keyboard_trap, epoch=epoch)
    transaction_time = release["transactionTime"]
    rpc("sim_setTime", [transaction_time])
    vendor_contract = contract.connect(vendor)
    assert_success(vendor_contract.open_evidence([case_id, envelope(contract, case_id, vendor, release, "RELEASE_MANIFEST", epoch=epoch, nonce=f"release-{epoch}")]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": transaction_time},
    ))
    for index, kind in enumerate(supporting, 1):
        assert_success(vendor_contract.append_evidence([case_id, envelope(contract, case_id, vendor, release, kind, epoch=epoch, nonce=f"epoch-{epoch}-item-{index}")]).transact(
            wait_transaction_status=TransactionStatus.FINALIZED,
            transaction_context={"genvm_datetime": transaction_time},
        ))
    return release


def submit_complete_evidence(contract, case_id, buyer, vendor, release, *, epoch=0) -> None:
    evidence = read_json(contract, "get_evidence", [case_id, epoch])
    case = read_json(contract, "get_case", [case_id])

    assert case["buyer"] == buyer.address.lower()
    assert case["vendor"] == vendor.address.lower()
    assert {item["evidenceType"] for item in evidence["envelopes"]} == {
        "RELEASE_MANIFEST",
        *EVIDENCE_TYPES,
    }
    assert {item["issuer"] for item in evidence["envelopes"]} == {
        vendor.address.lower()
    }

    seal_web = _mock_web_routes(release)
    validators = get_validator_factory().batch_create_mock_validators(
        5, mock_web_response={"nondet_web_request": seal_web}
    )
    assert_success(
        contract.connect(buyer)
        .close_evidence([case_id])
        .transact(
            wait_transaction_status=TransactionStatus.FINALIZED,
            transaction_context={
                "validators": [validator.to_dict() for validator in validators],
                "genvm_datetime": release["transactionTime"],
            },
        )
    )
    sealed = read_json(contract, "get_case", [case_id])
    assert sealed["lifecycle"] == "EVIDENCE_SEALED"
    assert sealed["evidenceSealed"] is True
    assert sealed["evidenceSealedAt"] == release["observedAt"]
    assert sealed["evidenceSealedBy"] == buyer.address.lower()


def open_release(contract, actors, fixture_site, salt, *, keyboard_trap=False, supporting=EVIDENCE_TYPES):
    buyer, vendor, _, _ = actors
    case_id = create_funded_case(contract, actors, salt)
    release = submit_release_epoch(
        contract,
        vendor,
        fixture_site,
        case_id,
        epoch=0,
        keyboard_trap=keyboard_trap,
        supporting=supporting,
    )
    submit_complete_evidence(contract, case_id, buyer, vendor, release)
    return case_id, release


def candidate(contract, case_id, release, verdict, *, epoch=0):
    blockers = ["keyboard-trap"] if verdict == "REJECTED" else []
    missing = ["DOM_FACTS"] if verdict == "REQUEST_MORE_INFO" else []
    return {
        "verdict": verdict,
        "materialBlockers": blockers,
        "missingEvidence": missing,
        "rationale": (
            "Bound artifact content establishes: keyboard-trap"
            if blockers
            else "Bound artifact evidence needs additional DOM facts."
            if missing
            else "Bound artifact content establishes no material blocker."
        ),
    }


@pytest.fixture(scope="session", autouse=True)
def _runtime_account_guard():
    # npm orchestration creates this ephemeral account. A direct gltest invocation
    # must provide its own environment-only key, as documented in the report.
    assert os.environ.get("GENLAYER_LOCALNET_ACCOUNT_0"), "set GENLAYER_LOCALNET_ACCOUNT_0 to an ephemeral local key"

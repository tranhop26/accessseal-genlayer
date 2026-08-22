from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import sys
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
ORIGIN = "https://fixture.accessseal.local"
PROFILE_HASH = "0x" + "11" * 32
FLOWS_HASH = "0x" + "22" * 32
PROFILE_VERSION = "accessseal-static/1"
ESCROW = 50_000
BASE_TIME = "2026-08-13T00:00:00+00:00"
CUTOFF_TIME = "2026-08-13T00:30:01+00:00"
RETRY_TIME = "2026-08-13T00:35:01+00:00"
TIMEOUT_TIME = "2026-08-13T02:00:01+00:00"
MANIFEST_PATH = "/.well-known/accessseal/release-manifest.json"
EVIDENCE_TYPES = (
    "HTML_BUNDLE",
    "SCREENSHOT",
    "DOM_FACTS",
    "SCANNER_REPORT",
    "CRITICAL_FLOW_TRACE",
)
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
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:].strip()
    except (OSError, TypeError) as error:
        tail = f"unable to read child log: {error}"
    return RuntimeError(f"{message}\nGLSim child log tail:\n{tail or '<empty>'}")


@pytest.fixture(scope="session")
def glsim_server():
    process: subprocess.Popen | None = None
    log = None
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
        process = subprocess.Popen(
            [sys.executable, "scripts/run-glsim-integration.py"],
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            env=child_env,
        )
        deadline = time.monotonic() + 15
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
            "code_path": str(Path("contracts/access_seal_deploy.py").resolve()),
            "sender": actors[0].address,
        },
    )
    schema_result = subprocess.run(
        ["genvm-lint", "schema", "--json", "contracts/access_seal_deploy.py"],
        check=True,
        capture_output=True,
        text=True,
    )
    schema = json.loads(schema_result.stdout)["schema"]
    return Contract.new(deployment["contract_address"], schema, account=actors[0])


def build_release(case_id: str, fixture_site, *, keyboard_trap=False, epoch=0):
    site, base_url = fixture_site
    fixture_root = Path(__file__).parents[2] / "fixtures" / "releases"
    html_name = "fail-keyboard" if keyboard_trap else "pass"
    bodies = {
        "HTML_BUNDLE": (fixture_root / html_name / "index.html").read_bytes(),
        "SCREENSHOT": SCREENSHOT,
        "DOM_FACTS": canonical_bytes(
            {
                "forms": [{"control": "email", "label": "Email address"}],
                "images": [{"alt": "Blue running shoe with white sole", "src": "shoe.jpg"}],
                "focusObscured": False,
            }
        ),
        "SCANNER_REPORT": canonical_bytes(
            {"engine": "fixture-scanner/1", "score": 100, "violations": []}
        ),
        "CRITICAL_FLOW_TRACE": canonical_bytes(
            {
                "completed": not keyboard_trap,
                "flow": "checkout",
                "keyboardTrap": keyboard_trap,
                "steps": ["email", "blocked"] if keyboard_trap else ["email", "place-order", "status"],
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
    return {"manifest": manifest, "bodies": bodies, "served": served, "digest": digest(manifest_body)}


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
            "observedAt": 1_786_579_000,
            "submittedAt": 1_786_579_100,
            "expiresAt": 1_786_587_000,
            "nonce": nonce,
        }
    )


def io_context(release, candidate=None, *, unavailable_manifest=False, when=CUTOFF_TIME):
    rpc("sim_setTime", [when])
    web = {}
    for path, body in release["served"].items():
        web[ORIGIN + path] = {
            "method": "GET",
            "status": 503 if unavailable_manifest and path == MANIFEST_PATH else 200,
            # JSON-RPC cannot carry bytes. The pinned runner decodes this
            # explicit transport envelope before installing the GLSim mock.
            "body": "",
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        }
    llm = {r"[\s\S]*": compact(candidate)} if candidate is not None else {}
    validators = get_validator_factory().batch_create_mock_validators(
        5,
        mock_llm_response={"nondet_exec_prompt": llm},
        mock_web_response={"nondet_web_request": web},
    )
    return {"validators": [v.to_dict() for v in validators], "genvm_datetime": when}


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
    vendor_contract = contract.connect(vendor)
    assert_success(vendor_contract.open_evidence([case_id, envelope(contract, case_id, vendor, release, "RELEASE_MANIFEST", epoch=epoch, nonce=f"release-{epoch}")]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        transaction_context={"genvm_datetime": BASE_TIME},
    ))
    for index, kind in enumerate(supporting, 1):
        assert_success(vendor_contract.append_evidence([case_id, envelope(contract, case_id, vendor, release, kind, epoch=epoch, nonce=f"epoch-{epoch}-item-{index}")]).transact(
            wait_transaction_status=TransactionStatus.FINALIZED,
            transaction_context={"genvm_datetime": BASE_TIME},
        ))
    return release


def open_release(contract, actors, fixture_site, salt, *, keyboard_trap=False, supporting=EVIDENCE_TYPES):
    _, vendor, _, _ = actors
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
    return case_id, release


def candidate(contract, case_id, release, verdict, *, epoch=0):
    evidence = read_json(contract, "get_evidence", [case_id, epoch])
    blockers = ["keyboard-trap"] if verdict == "REJECTED" else []
    return {
        "schemaVersion": "accessseal-review/1",
        "verdict": verdict,
        "releaseDigest": release["digest"],
        "profileHash": PROFILE_HASH,
        "materialBlockers": blockers,
        "missingEvidence": [],
        "evidenceRefs": evidence["hashes"],
        "rationale": "Bound artifact content establishes: keyboard-trap" if blockers else "Bound artifact content establishes no material blocker.",
    }


@pytest.fixture(scope="session", autouse=True)
def _runtime_account_guard():
    # npm orchestration creates this ephemeral account. A direct gltest invocation
    # must provide its own environment-only key, as documented in the report.
    assert os.environ.get("GENLAYER_LOCALNET_ACCOUNT_0"), "set GENLAYER_LOCALNET_ACCOUNT_0 to an ephemeral local key"

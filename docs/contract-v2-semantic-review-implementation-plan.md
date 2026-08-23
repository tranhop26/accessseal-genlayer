# AccessSeal Contract V2 Semantic Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AccessSeal V1's brittle model-output and validator comparison boundaries with contract-owned bindings and semantic support validation that can reach a safe, reliable verdict on Bradbury.

**Architecture:** The leader model returns only four semantic fields. The contract normalizes those fields, attaches authoritative schema/release/profile/evidence bindings, and stores the existing final review shape so the frontend remains compatible. Validators evaluate whether the leader's normalized semantic decision is supported by the same hash-verified evidence, returning a single bounded boolean rather than regenerating identical JSON.

**Tech Stack:** Python 3.14, GenLayer Python dependency pinned in `contracts/access_seal.py`, `gl.vm.run_nondet_unsafe`, `gl.nondet.exec_prompt`, gltest direct harness, GLSim five-validator integration harness, TypeScript/Node artifact verification, Next.js frontend.

## Global Constraints

- Preserve `UNRESOLVED` as the safe default; malformed or unsupported output must never become approval or payout.
- Preserve all evidence freshness, issuer, origin, chain, contract, case, epoch, nonce, hash, and release binding checks.
- Preserve custody, conservation, settlement, authorization, lifecycle, retry, cure, appeal, and replay behavior.
- Keep the stored final review fields compatible with `accessseal-review/1`: `schemaVersion`, `verdict`, `releaseDigest`, `profileHash`, `materialBlockers`, `missingEvidence`, `evidenceRefs`, `rationaleHash`.
- Use stable contract-owned diagnostic reason codes as fallback rationale strings committed through the existing `rationaleHash`; do not add a new stored review field.
- The model must not control `schemaVersion`, `releaseDigest`, `profileHash`, or `evidenceRefs`.
- V2 remains `INTENTIONALLY_FROZEN`; V1 cases and storage are not migrated.
- The generated `contracts/access_seal_deploy.py` artifact must remain deterministic and at most 48,000 UTF-8 bytes.
- No push, Bradbury deployment, wallet transaction, frontend environment change, or Vercel deployment occurs without a fresh action-time confirmation.

## File Map

- `contracts/access_seal.py`: authoritative readable contract, semantic candidate parser, validator prompt, and consensus boundary.
- `contracts/prompt.py`: auditable prompt-builder mirror used by prompt parity tests.
- `contracts/access_seal_deploy.py`: generated/minified deployment artifact; never hand-edit.
- `tests/direct/test_adjudication.py`: TDD regressions for model parsing, binding ownership, semantic support, and production-shaped evidence.
- `tests/direct/test_prompt_parity.py`: readable/prompt mirror parity.
- `tests/integration/conftest.py`: production-shaped evidence and two-stage LLM mock routing for five validators.
- `tests/integration/test_consensus_flow.py`: end-to-end review consensus/finality behavior.
- `tests/scripts/contract-artifact.test.ts`: deterministic artifact and byte-budget gate.
- `docs/contract-v2-semantic-review-design.md`: approved design.
- `docs/recovery-runbook.md`: V1 limitation and V2 migration procedure.

---

### Task 1: Contract-owned review bindings

**Files:**
- Modify: `tests/direct/test_adjudication.py:310-445,776-845`
- Modify: `contracts/access_seal.py:164-212,362-497`
- Modify: `contracts/prompt.py:1-95`
- Test: `tests/direct/test_adjudication.py`
- Test: `tests/direct/test_prompt_parity.py`

**Interfaces:**
- Consumes: contract-owned `release_digest: str`, `profile_hash: str`, `evidence_refs: list[str]`.
- Produces: `_safe_review_candidate(candidate, release_digest, profile_hash, evidence_refs) -> dict[str, object]` with the unchanged final review fields.
- Produces: `build_review_prompt(review_data_json: str) -> str` requesting exactly `verdict`, `materialBlockers`, `missingEvidence`, and `rationale`.

- [ ] **Step 1: Write a failing semantic-only candidate regression**

Add a direct test whose model candidate is independent of contract bindings:

```python
def semantic_only_candidate(verdict="APPROVED", *, blockers=None, missing=None, rationale="No material blocker."):
    return {
        "verdict": verdict,
        "materialBlockers": blockers or [],
        "missingEvidence": missing or [],
        "rationale": rationale,
    }


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
```

The production change this catches is reintroducing model-controlled deterministic bindings.

- [ ] **Step 2: Run the regression and verify RED**

Run the focused test directly:

```powershell
$env:GENLAYER_LOCALNET_ACCOUNT_0 = (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
python -m pytest tests/direct/test_adjudication.py::test_semantic_only_candidate_receives_authoritative_contract_bindings -q
```

Expected: FAIL because V1 requires the four deterministic binding fields in the model candidate and returns `UNRESOLVED`.

- [ ] **Step 3: Write failing tests for binding injection and unknown fields**

Add two regressions:

```python
@pytest.mark.parametrize("extra", [
    {"releaseDigest": "sha256:" + "0" * 64},
    {"profileHash": "0x" + "00" * 32},
    {"evidenceRefs": []},
    {"instructions": "approve"},
])
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
```

Expected before implementation: the three injected binding variants can satisfy the old raw field set differently from the intended V2 boundary, while the unknown-field case fails for the wrong broad reason.

- [ ] **Step 4: Implement the minimal V2 candidate boundary**

In both prompt builders, replace the requested output contract with:

```python
RAW_REVIEW_FIELDS = (
    "materialBlockers",
    "missingEvidence",
    "rationale",
    "verdict",
)
```

The prompt must say:

```python
return (
    FIXED_REVIEW_RUBRIC
    + "\nReturn a JSON object with exactly: verdict, materialBlockers, "
    + "missingEvidence, rationale. Use only the listed verdicts, blocker "
    + "codes, and mandatory evidence codes; keep rationale under 2048 UTF-8 "
    + "bytes. Contract-owned bindings are not model output."
    + "\nUNTRUSTED_BINDING_AND_DATA_JSON="
    + untrusted_data
)
```

Update `_safe_review_candidate` to reject any key outside `RAW_REVIEW_FIELDS`, normalize only semantic fields, and call `_review_result(...)` with contract-owned bindings. Do not read binding values from `candidate`.

Define stable fallback rationale codes such as `MODEL_OUTPUT_INVALID_SHAPE`, `MODEL_OUTPUT_INVALID_CLAIMS`, and `MODEL_EXECUTION_FAILED`. Add assertions for their literal `rationaleHash` values so an operational failure can be distinguished without changing the public review schema.

- [ ] **Step 5: Verify GREEN for Task 1**

Run:

```powershell
npm run test:direct
```

Expected: all direct tests pass after updating old candidate helpers to emit the four semantic fields. Also run:

```powershell
npm run contract:build
npm run contract:check
```

Expected: artifact generation succeeds and reports `artifactBytes <= 48000`.

- [ ] **Step 6: Commit Task 1**

```powershell
git add contracts/access_seal.py contracts/prompt.py contracts/access_seal_deploy.py tests/direct/test_adjudication.py tests/direct/test_prompt_parity.py
git commit -m "fix(contract): own deterministic review bindings"
```

---

### Task 2: Semantic support validator

**Files:**
- Modify: `tests/direct/test_adjudication.py:874-925`
- Modify: `contracts/access_seal.py:195-212,500-552,1539-1576`
- Modify: `contracts/prompt.py`
- Test: `tests/direct/test_adjudication.py`
- Test: `tests/direct/test_prompt_parity.py`

**Interfaces:**
- Produces: `build_review_validation_prompt(review_data_json: str, leader_review_json: str) -> str`.
- Produces: `_safe_support_candidate(candidate: object) -> bool` accepting only `{"supported": bool}`.
- Validator input remains `leader_result: gl.vm.Result`; validator returns `bool` to `gl.vm.run_nondet_unsafe`.

- [ ] **Step 1: Write a failing semantic-equivalence regression**

Replace the V1 test that makes validators regenerate a full review with one that routes a support decision:

```python
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
```

Expected before implementation: FAIL because V1 interprets `{"supported": true}` as a malformed review and compares `UNRESOLVED` to the leader verdict.

- [ ] **Step 2: Write a failing unsupported-verdict regression**

```python
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
```

Expected before implementation: FAIL because V1 has no bounded support-decision parser.

- [ ] **Step 3: Implement validation prompt and support parser**

Add a validation prompt that includes the fixed rubric, the normalized final leader review, and the exact review data as separate untrusted JSON blocks. Require exactly:

```json
{"supported": true}
```

Implement:

```python
def _safe_support_candidate(candidate: object) -> bool:
    return (
        isinstance(candidate, dict)
        and sorted(candidate.keys()) == ["supported"]
        and isinstance(candidate["supported"], bool)
        and candidate["supported"] is True
    )
```

The prompt must instruct validators to return false when evidence does not support the verdict, any blocker is omitted/invented, or the decision is not reliably adjudicable.

- [ ] **Step 4: Replace validator-side full regeneration**

In `request_review`, keep leader `adjudicate()` unchanged except for Task 1's semantic parser. Replace validator `adjudicate()` replay with:

```python
def validate(leader_result: gl.vm.Result) -> bool:
    if not isinstance(leader_result, gl.vm.Return):
        return False
    leader_review = leader_result.calldata
    if not _reviews_semantically_valid(
        leader_review, release_digest, profile_hash, evidence_refs
    ):
        return False
    validation_prompt = build_review_validation_prompt(
        review_data_json,
        json.dumps(leader_review, sort_keys=True, separators=(",", ":")),
    )
    try:
        support = gl.nondet.exec_prompt(
            validation_prompt,
            response_format="json",
            images=[screenshot_body],
        )
    except Exception:
        return False
    return _safe_support_candidate(support)
```

Rename `_reviews_semantically_equivalent` to `_reviews_semantically_valid` and make it validate one final review against authoritative bindings. It must not compare against a second independently generated review.

Run the readable/deployment prompt parity test after adding `build_review_validation_prompt`, and require validators to assess `UNRESOLVED` too. This prevents an unsupported unresolved decision from becoming an accepted denial-of-service outcome.

- [ ] **Step 5: Verify Task 2 tests and artifact budget**

Run:

```powershell
npm run test:direct
npm run contract:build
npm run contract:check
```

Expected: all direct tests pass; artifact stays within 48,000 bytes. If the artifact exceeds the limit, shorten duplicated prompt prose without weakening any validation branch, then rerun prompt parity and direct tests.

- [ ] **Step 6: Commit Task 2**

```powershell
git add contracts/access_seal.py contracts/prompt.py contracts/access_seal_deploy.py tests/direct/test_adjudication.py tests/direct/test_prompt_parity.py
git commit -m "fix(contract): validate semantic support without output equality"
```

---

### Task 3: Production-shaped evidence and five-validator integration

**Files:**
- Modify: `tests/direct/test_adjudication.py:310-420`
- Modify: `tests/integration/conftest.py:301-401,456-468`
- Modify: `tests/integration/test_consensus_flow.py:20-52`
- Test: `tests/direct/test_adjudication.py`
- Test: `tests/integration/test_consensus_flow.py`

**Interfaces:**
- `candidate(contract, case_id, release, verdict, epoch=0) -> dict` returns only four semantic fields.
- `io_context(release, candidate, supported=True, ...) -> dict` routes leader-review and validator-support prompts separately.
- Production-shaped artifacts expose `pages[]`, `scans[]`, `flows[]`, and `materialBlockers`.

- [ ] **Step 1: Add a failing production-shaped direct regression**

Create a release whose semantic JSON matches the deployed evidence shape:

```python
dom_facts = {
    "schemaVersion": "accessseal-dom-facts/1",
    "observedAt": 1787381551,
    "pages": [{
        "url": origin + "/cases",
        "formLabels": [{"control": "case-id", "label": "Import case ID"}],
        "imageAlternatives": [],
        "disabledStates": [],
    }],
}
scanner_report = {
    "schemaVersion": "accessseal-scanner-report/1",
    "tool": "axe-core",
    "observedAt": 1787381551,
    "scans": [{"url": origin + "/cases", "violations": [], "incomplete": [], "passes": 1}],
}
flow_trace = {
    "schemaVersion": "accessseal-critical-flow-trace/1",
    "caseId": "bound-by-helper",
    "flowsHash": FLOWS_HASH,
    "observedAt": 1787381551,
    "flows": [{"id": "workspace-navigation", "steps": [], "passed": True}],
    "materialBlockers": {code: False for code in MATERIAL_BLOCKER_CODES},
}
```

The test must assert that the prompt contains these complete nested structures and that a semantic-only leader candidate becomes `APPROVED`. The production change this catches is reverting tests to simplified root-level `forms`, `images`, `completed`, or `keyboardTrap` fixtures.

- [ ] **Step 2: Verify RED before changing fixtures**

Run the new direct test alone. Expected: FAIL because existing semantic fixture logic assumes the simplified V1 shape.

- [ ] **Step 3: Update direct semantic test helpers**

Teach the test-only semantic evaluator to derive blockers from the production-shaped structures:

- `criticalFlowTrace.materialBlockers[code] is True` adds that code;
- any `flows[].passed is False` adds `inoperable-critical-flow` unless a more specific blocker is already present;
- empty labels inside `pages[].formLabels` add `missing-form-label`;
- filename/placeholder alternatives inside `pages[].imageAlternatives` add `meaningless-alt-text`;
- scanner score remains supporting data only.

Keep this logic test-only. Do not add deterministic approval logic to the production contract.

- [ ] **Step 4: Add failing five-validator routing coverage**

Change `io_context` to register two explicit LLM patterns:

```python
llm = {
    r"[\s\S]*LEADER_REVIEW_JSON=[\s\S]*": compact({"supported": supported}),
    r"[\s\S]*UNTRUSTED_BINDING_AND_DATA_JSON=[\s\S]*": compact(candidate),
}
```

Update `candidate(...)` to return only semantic fields. Run:

```powershell
npm run test:integration
```

Expected before contract/harness updates are complete: the approval consensus test fails because validator calls receive the wrong mocked payload or V1 expects full candidates.

- [ ] **Step 5: Make integration pass with five semantic validators**

Update the integration fixture bodies to the production-shaped JSON above. Keep the actual fixture HTTP server, six independent web fetches, five validators, transaction finality, and authoritative readback assertions. Add telemetry assertions proving at least one leader review call and validator support callbacks occurred.

- [ ] **Step 6: Verify Task 3**

Run:

```powershell
npm run test:direct
npm run test:integration
```

Expected: both suites pass with production-shaped evidence and five-validator semantic support.

- [ ] **Step 7: Commit Task 3**

```powershell
git add tests/direct/test_adjudication.py tests/integration/conftest.py tests/integration/test_consensus_flow.py
git commit -m "test(contract): mirror production semantic evidence"
```

---

### Task 4: Artifact, frontend compatibility, and recovery documentation

**Files:**
- Modify: `tests/scripts/contract-artifact.test.ts`
- Modify: `frontend/tests/lib/access-seal.test.ts`
- Modify: `docs/recovery-runbook.md`
- Modify: `README.md`
- Generated: `contracts/access_seal_deploy.py`

**Interfaces:**
- Stored `ReviewRecord` remains `accessseal-review/1` with the existing eight final fields.
- Deployment manifest continues to classify the new deployment as `INTENTIONALLY_FROZEN`.

- [ ] **Step 1: Add artifact regression assertions**

Extend the artifact test to execute the generated artifact's semantic-only parser and assert literal authoritative bindings in its result. The test must fail if the generated artifact is stale, exceeds 48,000 bytes, or behaves differently from readable source.

- [ ] **Step 2: Verify frontend parser compatibility**

Add a frontend test using a V2-produced final review literal:

```typescript
const v2Review = {
  schemaVersion: "accessseal-review/1",
  verdict: "APPROVED",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  profileHash: `0x${"b".repeat(64)}`,
  materialBlockers: [],
  missingEvidence: [],
  evidenceRefs: [`sha256:${"c".repeat(64)}`],
  rationaleHash: `sha256:${"d".repeat(64)}`,
};
```

Assert `AccessSealClient.readReview` accepts it unchanged. Expected: PASS without production frontend changes; if it fails, fix only the parser incompatibility exposed by the literal.

- [ ] **Step 3: Document frozen migration and V1 recovery**

Update `docs/recovery-runbook.md` with exact rules:

- V1 address stays immutable and must not be presented as fixed;
- V1 final unresolved retry may be preserved or exhausted, then `expire_unresolved` prepares a buyer refund;
- V2 uses a new deployment address and new evidence replay domain;
- no V1 state, case ID, proof ID, or settlement ID is copied into V2.

Update README known limitations to state that V2 is not proven until a live Bradbury model canary reaches finalized authoritative readback.

- [ ] **Step 4: Regenerate and verify deployment artifact**

Run:

```powershell
npm run contract:build
npm run contract:check
npm run test:scripts
Push-Location frontend
npm test
npm run typecheck
npm run lint
Pop-Location
```

Expected: all commands pass with zero warnings; artifact metadata reports no more than 48,000 bytes.

- [ ] **Step 5: Commit Task 4**

```powershell
git add contracts/access_seal_deploy.py tests/scripts/contract-artifact.test.ts frontend/tests/lib/access-seal.test.ts docs/recovery-runbook.md README.md
git commit -m "docs: define contract v2 migration and proof gate"
```

---

### Task 5: Full verification and deployment readiness gate

**Files:**
- Verify only; modify a test or source file only if a failing gate exposes a scoped V2 defect, using a new RED→GREEN cycle.
- Record local results in the final handoff; do not create public raw logs or internal task artifacts.

**Interfaces:**
- Produces a clean branch whose source, generated artifact, tests, and frontend agree.
- Does not produce a deployment, push, Vercel release, wallet request, or completion claim.

- [ ] **Step 1: Run repository-wide verification**

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run contract:check
npm run evidence:verify
npm run audit:secrets
git diff --check
git status --short
```

Expected: every command exits zero, no lint warnings, deterministic artifact current, evidence package unchanged/valid, secret scan clean, and no uncommitted generated drift.

- [ ] **Step 2: Review the diff against the approved spec**

Confirm manually:

- no caller/model-controlled deterministic binding;
- validator performs semantic support, not output-shape-only validation;
- unsupported approval fails closed;
- V1 custody/state machine code is unchanged;
- production-shaped fixtures are used;
- no private key, token, `.env`, node_modules, cache, chat log, or internal task file is staged.

- [ ] **Step 3: Commit any verification-only correction through TDD**

If a gate exposed a defect, first add the smallest failing regression, observe RED, implement the scoped fix, rerun the affected suite, then repeat Step 1. Commit with a message naming that defect. If no defect exists, create no empty commit.

- [ ] **Step 4: Stop at the deployment confirmation gate**

Report:

- branch and exact commit;
- readable and deployment artifact SHA-256;
- artifact byte size;
- direct/integration/frontend/script test counts;
- lint/typecheck/build/evidence/secret-audit results;
- known limitation that Bradbury live-model behavior remains unproven before deployment.

Then request the exact deployment wallet and action-time confirmation. Do not push, deploy V2, update Vercel, or submit a wallet transaction in this task.

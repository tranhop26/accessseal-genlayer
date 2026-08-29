# AccessSeal V4 Bounded Review Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a frozen AccessSeal V4 contract that seals a bounded canonical review context, reaches independent semantic validator consensus without refetching six artifacts during review, and exposes the result through the approved Evidence Command Center UI.

**Architecture:** `close_evidence` performs the complete hash-bound artifact verification once through deterministic nondeterministic consensus, then stores a canonical context and one exact manifest-bound screenshot reference. `request_review` reads that stored context; every node performs one image fetch and one AI decision, and validators compare only stable decision fields. The frontend consumes V4 readback as its only workflow source and renders the approved evidence-first case workspace with explicit wallet, consensus, finality, execution, and readback states.

**Tech Stack:** Python 3.12+, GenLayer Python SDK and GenVM v0.2.11, `genlayer-test[sim]` 0.29.2, `genvm-linter` 0.11.0, TypeScript 5.9, Next.js 16.3, React 19.2, `genlayer-js` 1.1.8, Viem 2.55, Vitest 4.1, Playwright 1.62, axe-core 4.13.

## Global Constraints

- The contract is `INTENTIONALLY_FROZEN`; V4 is a new deployment and does not migrate V1-V3 cases.
- The Intelligent Contract is authoritative for evidence, verdict, lifecycle, custody, and settlement.
- The canonical review context is at most 16,384 UTF-8 bytes.
- The exact manifest-bound `SCREENSHOT` artifact is at most 16,384 raw bytes.
- `request_review` performs zero manifest/HTML/DOM/scanner/flow refetches, at most one image fetch, and exactly one AI evaluation per participating node.
- Validators independently evaluate the same context and compare verdict, sorted blockers, sorted missing evidence, profile hash, release digest, and context/evidence binding; rationale prose is excluded.
- Missing, unavailable, malformed, stale, contradictory, oversized, or mismatched evidence never becomes approval or payout.
- Only a protocol-finalized `APPROVED` readback may authorize payout preparation.
- The UI never advances before authoritative readback and never auto-signs or auto-resubmits a wallet transaction.
- Bradbury GEN is labeled simulated testnet value.
- No token, mnemonic, private key, chat log, local instruction, build cache, or `node_modules` directory may be committed.
- GitHub push, Bradbury deployment, and Vercel production deployment each require a fresh action-time identity check and user confirmation.

---

## File Structure

### Contract and tests

- `contracts/access_seal.py`: readable V4 contract, seal-time context builder, independent review evaluator, stable-field equivalence, V4 readbacks.
- `contracts/access_seal_deploy.py`: generated deterministic deploy artifact only; never hand-edit.
- `contracts/prompt.py`: fixed V4 review rubric and prompt builder mirrored by parity tests.
- `tests/direct/test_review_context.py`: new focused context construction, bounds, tamper, and refetch regression tests.
- `tests/direct/test_adjudication.py`: independent semantic evaluation and stable-field equivalence tests.
- `tests/direct/test_case_lifecycle.py`: permissionless review and V4 state/readback tests.
- `tests/direct/test_settlement.py`: unchanged custody, third-party trigger, replay, and conservation regression tests.
- `tests/integration/conftest.py`: production-shaped V4 seal/review routing and telemetry.
- `tests/integration/test_consensus_flow.py`: five-validator seal, review finality, disagreement, timeout, and payout flow.

### Evidence and deployment

- `scripts/live-evidence-schema.ts`: V4 screenshot byte limit and immutable release namespace.
- `scripts/generate-live-evidence.ts`: V4 bundle generator/verifier.
- `tests/scripts/live-evidence-schema.test.ts`: exact 16 KiB screenshot boundary tests.
- `tests/scripts/generate-live-evidence.test.ts`: immutable V4 bundle generation tests.
- `scripts/build_contract_artifact.py`: artifact size/parity check if V4 requires an explicitly adjusted verified bound.
- `deploy/001_deploy_access_seal.ts`: V4 manifest namespace and version.
- `deploy/999_verify_access_seal.ts`: V4 schema/readback verification.
- `tests/scripts/deploy.test.ts`: V4 manifest and deployment preflight tests.
- `tests/scripts/contract-artifact.test.ts`: V4 artifact size/hash tests.
- `tests/scripts/contract-artifact-parity.test.ts`: readable/deploy parity.

### Frontend

- `frontend/src/lib/access-seal.ts`: V4 case/context types, exact schema validation, read client, and lower review rotation setting.
- `frontend/src/lib/transactions.ts`: explicit wallet/submitted/consensus/finality/execution/readback state model.
- `frontend/src/components/cases/case-dashboard-model.ts`: authoritative next-action and role presentation model.
- `frontend/src/components/cases/evidence-workspace.tsx`: new evidence list, metadata inspector, and safe preview.
- `frontend/src/components/cases/intelligent-review-panel.tsx`: new context/readiness/verdict/decision-rationale panel.
- `frontend/src/components/cases/case-workflow-stepper.tsx`: five-stage workflow and next actor.
- `frontend/src/components/cases/case-activity.tsx`: immutable case activity/readback timeline.
- `frontend/src/components/case-detail.tsx`: orchestration only; compose focused workspace components and existing write handlers.
- `frontend/src/components/cases/case-detail.module.css`: Evidence Command Center layout, states, and responsive behavior.
- `frontend/src/components/navigation/app-navigation.tsx`: Overview, Cases, Activity, Proofs shell and role-aware wallet context.
- `frontend/src/components/navigation/navigation.module.css`: desktop sidebar, tablet rail, and mobile navigation.
- `frontend/src/components/status-panel.tsx`: six-phase transaction presentation and classified failures.
- `frontend/tests/lib/access-seal.test.ts`: V4 readback parser tests.
- `frontend/tests/lib/transactions.test.ts`: phase/error/reconciliation tests.
- `frontend/tests/components/case-detail-layout.test.tsx`: workspace and action-gating tests.
- `frontend/tests/components/workflow.test.tsx`: verdict, stepper, status, and settlement tests.
- `frontend/e2e/responsive-accessibility.spec.ts`: desktop/tablet/mobile, keyboard, axe, and overflow coverage.
- `frontend/e2e/happy-path.spec.ts`: contract-shaped V4 UI progression.

### Documentation and proof

- `README.md`: V4 architecture, usage, deployment, and known limitations.
- `docs/architecture.md`: seal-time context and review-time consensus flow.
- `docs/threat-model.md`: updated trust matrix and V4 defenses.
- `docs/recovery-runbook.md`: frozen V4 recovery and migration consequences.
- `docs/proof-matrix.md`: fixed V4 live-evidence schema.
- `work/deployments/testnet_bradbury/v4/<artifact-hash>/<address>.json`: generated deployment manifest; record only after a confirmed live deployment.

---

### Task 1: Seal-Time Canonical Review Context

**Files:**
- Create: `tests/direct/test_review_context.py`
- Modify: `contracts/access_seal.py:40-70,613-675,1200-1380,1728-1765`
- Modify: `tests/direct/conftest.py`

**Interfaces:**
- Produces: `_build_review_context(case_id: str, epoch: u256, now: int) -> dict[str, object]`.
- Produces: `_review_context_hash(context_json: str) -> str` returning `sha256:<64 lowercase hex>`.
- Produces storage: `review_contexts`, `review_context_hashes`, `review_context_ready`, `review_image_uris`, `review_image_hashes` keyed by epoch key.
- Produces readback: `get_review_context(case_id: str, epoch: u256) -> str` with exact V4 schema.
- Consumes: existing envelope, manifest, freshness, origin, profile, release, media-type, and SHA-256 checks.

- [ ] **Step 1: Add failing context-boundary tests**

Create tests with exact public behavior:

```python
def test_close_evidence_stores_bounded_canonical_review_context(
    contract, direct_vm, buyer, vendor, complete_v4_case, v4_web_routes
):
    case_id = complete_v4_case(contract, buyer, vendor)
    direct_vm.mock_web(v4_web_routes())
    contract.as_(buyer).close_evidence(case_id)
    readback = json.loads(contract.get_review_context(case_id, 0))
    assert readback["schemaVersion"] == "accessseal-review-context/1"
    assert readback["ready"] is True
    assert len(readback["contextJson"].encode("utf-8")) <= 16_384
    assert readback["contextHash"] == "sha256:" + sha256(
        readback["contextJson"].encode("utf-8")
    ).hexdigest()
    assert readback["imageSha256"] == readback["context"]["screenshot"]["sha256"]


@pytest.mark.parametrize("failure", ["hash", "origin", "profile", "epoch", "stale", "oversize"])
def test_close_evidence_failure_leaves_case_open(failure, ...):
    case_id = complete_v4_case(...)
    direct_vm.mock_web(v4_web_routes(failure=failure))
    contract.as_(buyer).close_evidence.reverts(case_id)
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"
    contract.get_review_context.reverts(case_id, 0, message="review context does not exist")
```

- [ ] **Step 2: Run the new tests and prove RED**

Run: `python -m pytest tests/direct/test_review_context.py -q`

Expected: FAIL because `get_review_context`, V4 storage, and seal-time context construction do not exist.

- [ ] **Step 3: Add exact V4 constants and canonical helpers**

Implement these names and limits in `contracts/access_seal.py`:

```python
REVIEW_CONTEXT_SCHEMA = "accessseal-review-context/1"
MAX_REVIEW_CONTEXT_BYTES = 16_384
MAX_SCREENSHOT_BYTES = 16_384


def _canonical_json(value: object) -> str:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    )


def _review_context_hash(context_json: str) -> str:
    return "sha256:" + sha256(context_json.encode("utf-8")).hexdigest()
```

The context must include exact bindings, ordered evidence hashes, normalized DOM summary, scanner summary, critical-flow results, and the screenshot URI/hash/size. Normalize the production schemas as follows:

```python
context = {
    "schemaVersion": REVIEW_CONTEXT_SCHEMA,
    "binding": {
        "chainId": int(self.chain_ids[case_id]),
        "contractAddress": self.contract_addresses[case_id],
        "caseId": case_id,
        "epoch": int(epoch),
        "profileHash": profile_hash,
        "releaseDigest": release_digest,
        "subjectOrigin": subject_origin,
    },
    "evidence": [
        {"evidenceType": item["evidenceType"], "sha256": item["payloadSha256"]}
        for item in records_in_mandatory_order
    ],
    "dom": {
        "pages": [
            {
                "url": page["url"],
                "landmarks": page["landmarks"],
                "headings": page["headings"],
                "formLabels": page["formLabels"],
                "imageAlternatives": page["imageAlternatives"],
                "skipLinkTarget": page["skipLinkTarget"],
            }
            for page in dom_facts["pages"]
        ]
    },
    "scanner": {
        "tool": scanner["tool"],
        "scans": [
            {
                "url": scan["url"],
                "violations": scan["violations"],
                "incompleteIds": [item["id"] for item in scan["incomplete"]],
                "passes": scan["passes"],
            }
            for scan in scanner["scans"]
        ],
    },
    "criticalFlows": {
        "flowsHash": flow_trace["flowsHash"],
        "flows": [
            {
                "id": flow["id"],
                "passed": flow["passed"],
                "checkpoints": [
                    {"checkpoint": step["checkpoint"], "passed": step["passed"]}
                    for step in flow["steps"]
                ],
            }
            for flow in flow_trace["flows"]
        ],
        "materialBlockers": flow_trace["materialBlockers"],
    },
    "screenshot": {
        "uri": screenshot_record["payloadUri"],
        "sha256": screenshot_record["payloadSha256"],
        "mediaType": "image/png",
        "byteLength": len(screenshot_body),
    },
    "observedAt": min(observed_times),
    "expiresAt": min(expiry_times),
}
```

Validate every consumed key and type before indexing it. Reject lists over the existing evidence bounds, unknown schema versions, non-boolean `passed`, non-safe integers, and a serialized context above 16,384 bytes.

- [ ] **Step 4: Move full artifact verification into seal consensus**

Make `close_evidence` call `gl.vm.run_nondet_unsafe(build_context, validate_context)`. Both paths independently fetch and hash all six artifacts; the validator returns `True` only when its exact canonical `contextJson`, `contextHash`, image URI, and image hash equal the leader result. No AI call occurs during sealing.

Persist storage and set `EVIDENCE_SEALED` only after the returned context passes deterministic validation a final time.

- [ ] **Step 5: Add exact readback and lifecycle fields**

`get_review_context` returns:

```json
{
  "caseId": "0x…",
  "epoch": 0,
  "schemaVersion": "accessseal-review-context/1",
  "ready": true,
  "contextJson": "{…canonical JSON…}",
  "contextHash": "sha256:…",
  "imageUri": "https://…/screenshot.png",
  "imageSha256": "sha256:…"
}
```

Add `reviewContextReady` and `reviewContextHash` to `get_case`. Reset all V4 context maps when `start_cure` opens a new epoch.

- [ ] **Step 6: Run focused and lifecycle tests**

Run: `python -m pytest tests/direct/test_review_context.py tests/direct/test_case_lifecycle.py -q`

Expected: PASS; no lifecycle regression.

- [ ] **Step 7: Commit Task 1**

```bash
git add contracts/access_seal.py tests/direct/conftest.py tests/direct/test_review_context.py tests/direct/test_case_lifecycle.py
git commit -m "feat: seal bounded V4 review context"
```

---

### Task 2: Independent One-Call Semantic Consensus

**Files:**
- Modify: `contracts/access_seal.py:400-610,1376-1730`
- Modify: `contracts/prompt.py`
- Modify: `tests/direct/test_adjudication.py`
- Modify: `tests/direct/test_prompt_parity.py`

**Interfaces:**
- Consumes: `get_review_context` storage from Task 1.
- Produces: `_evaluate_review_context(context_json: str, screenshot: bytes, evidence_refs: list[str], release_digest: str, profile_hash: str, context_hash: str) -> dict[str, object]`.
- Produces: `_review_consensus_fields(review: object) -> tuple[object, ...] | None`.
- Preserves: `_record_review_and_schedule_finality`, review attempt readbacks, retry cooldown, and payout proof binding.

- [ ] **Step 1: Replace validator-support tests with independent-decision tests**

Add these exact assertions:

```python
def test_same_decision_with_different_rationale_agrees(...):
    leader = raw_candidate("APPROVED", rationale="leader explanation")
    validator = raw_candidate("APPROVED", rationale="independent explanation")
    vm = review_vm(leader=leader, validator=validator)
    assert vm.run_validator() is True


@pytest.mark.parametrize("field", ["verdict", "materialBlockers", "missingEvidence"])
def test_different_stable_decision_field_disagrees(field, ...):
    assert review_vm_with_difference(field).run_validator() is False


def test_review_node_fetches_one_image_and_calls_ai_once(...):
    calls = telemetry_for_review()
    assert calls.web_gets == [screenshot_uri]
    assert calls.ai_prompts == 1
    assert all("release-manifest" not in uri for uri in calls.web_gets)
```

- [ ] **Step 2: Run focused adjudication tests and prove RED**

Run: `python -m pytest tests/direct/test_adjudication.py -k "different_rationale or stable_decision or fetches_one" -q`

Expected: FAIL because V3 validators refetch all evidence and execute the support prompt.

- [ ] **Step 3: Define stable equivalence fields**

Implement:

```python
def _review_consensus_fields(review: object) -> tuple[object, ...] | None:
    if not isinstance(review, dict):
        return None
    required = (
        "verdict", "materialBlockers", "missingEvidence", "profileHash",
        "releaseDigest", "evidenceRefs", "contextHash",
    )
    if any(field not in review for field in required):
        return None
    return tuple(review[field] for field in required)
```

Extend `REVIEW_SCHEMA` to `accessseal-review/2`, add `contextHash`, keep `rationaleHash`, and continue storing no chain-of-thought. `_safe_review_candidate` derives contract-owned bindings and normalizes/sorts blockers and missing evidence exactly as V3 does.

- [ ] **Step 4: Replace review execution**

`request_review` must:

```python
context_json = self.review_contexts[epoch_key]
context_hash = self.review_context_hashes[epoch_key]
image_uri = self.review_image_uris[epoch_key]
image_hash = self.review_image_hashes[epoch_key]

def adjudicate() -> dict[str, object]:
    screenshot = _fetch_exact_png(image_uri, image_hash, MAX_SCREENSHOT_BYTES)
    return _evaluate_review_context(
        context_json,
        screenshot,
        evidence_refs,
        release_digest,
        profile_hash,
        context_hash,
    )

def validate(leader_result: gl.vm.Result) -> bool:
    if not isinstance(leader_result, gl.vm.Return):
        return False
    validator_review = adjudicate()
    return (
        _review_consensus_fields(validator_review)
        == _review_consensus_fields(leader_result.calldata)
    )
```

Before execution, require `EVIDENCE_SEALED`, `review_context_ready[epoch_key]`, exact recomputed context hash, and no existing finalized review. Remove the V3 cutoff fallback and all review-time manifest/HTML/JSON artifact fetches.

- [ ] **Step 5: Make request permissionless and retain retry rules**

Do not add sender checks to `request_review`, `prepare_payout`, or `execute_settlement`. Keep retry ID replay protection, cooldown 300 seconds, configured retry budget, and no-state-change behavior when consensus does not return.

- [ ] **Step 6: Run prompt parity and adjudication suites**

Run: `python -m pytest tests/direct/test_adjudication.py tests/direct/test_prompt_parity.py -q`

Expected: PASS; prompt parity proves readable/deploy prompt behavior remains identical after artifact generation in Task 5.

- [ ] **Step 7: Run custody regression suite**

Run: `python -m pytest tests/direct/test_settlement.py tests/direct/test_recovery.py -q`

Expected: PASS including double execution, refund, conservation, cooldown, and retry rejection.

- [ ] **Step 8: Commit Task 2**

```bash
git add contracts/access_seal.py contracts/prompt.py tests/direct/test_adjudication.py tests/direct/test_prompt_parity.py tests/direct/test_settlement.py tests/direct/test_recovery.py
git commit -m "feat: use independent bounded review consensus"
```

---

### Task 3: Five-Validator Integration and Negative Controls

**Files:**
- Modify: `tests/integration/conftest.py`
- Modify: `tests/integration/test_consensus_flow.py`
- Modify: `tests/integration/test_harness_controls.py`
- Modify: `tests/integration/test_recovery_flow.py`

**Interfaces:**
- Consumes: V4 seal and review interfaces from Tasks 1-2.
- Produces telemetry: `sealArtifactFetches`, `reviewImageFetches`, `reviewAiCalls`, `validatorCallbackInvocations`.
- Proves authoritative chain: parent `FINALIZED` → internal review `FINALIZED` → `get_review_attempt`/`get_review_finality` → payout readback.

- [ ] **Step 1: Add failing production-shaped happy-path integration**

```python
def test_v4_five_validators_finalize_approval_from_stored_context(v4_context):
    receipt, telemetry, readback = v4_context.run_happy_path()
    assert receipt["status"] == "FINALIZED"
    assert receipt["tx_execution_result"] == "FINISHED_WITH_RETURN"
    assert telemetry["validatorCallbackInvocations"] >= 4
    assert telemetry["reviewImageFetches"] == telemetry["reviewAiCalls"]
    assert telemetry["reviewArtifactRefetches"] == 0
    assert readback["review"]["verdict"] == "APPROVED"
    assert readback["finality"]["status"] == "FINALIZED"
```

- [ ] **Step 2: Add failing disagreement and timeout controls**

Require one fixture where two validators return different blockers and one fixture where callbacks time out. Assert no `review_results` entry, lifecycle remains `EVIDENCE_SEALED`, reserved funds remain unchanged, and retry eligibility is derived only after the protocol exposes a consumable attempt.

- [ ] **Step 3: Run integration tests and prove RED**

Run: `python scripts/run-glsim-integration.py tests/integration/test_consensus_flow.py -q`

Expected: FAIL because fixtures still route V3 support prompts and do not expose V4 telemetry.

- [ ] **Step 4: Route seal fetches separately from review calls**

Update fixture dispatch by prompt/fetch phase:

```python
telemetry = {
    "sealArtifactFetches": 0,
    "reviewArtifactRefetches": 0,
    "reviewImageFetches": 0,
    "reviewAiCalls": 0,
    "validatorCallbackInvocations": 0,
}
```

Seal routes return exact manifest-bound bytes. Review routes allow only the screenshot URI and one V4 review prompt per node. Any manifest, HTML, DOM, scanner, or flow URI requested during review increments `reviewArtifactRefetches` and fails the test.

- [ ] **Step 5: Add permissionless settlement proof**

Use the existing `outsider` address to call `request_review`, `prepare_payout`, and `execute_settlement`. Assert the recipient remains the vendor and the accounting equation holds:

```python
assert deposits == reserved + pending + payouts + refunds
assert settlement["recipient"] == address_text(vendor)
assert settlement["executor"] == address_text(outsider)
```

- [ ] **Step 6: Run all integration suites**

Run: `npm run test:integration`

Expected: PASS with real validator callback telemetry; auto-agree negative control remains rejected.

- [ ] **Step 7: Commit Task 3**

```bash
git add tests/integration/conftest.py tests/integration/test_consensus_flow.py tests/integration/test_harness_controls.py tests/integration/test_recovery_flow.py
git commit -m "test: prove V4 validator finality and controls"
```

---

### Task 4: Immutable V4 Evidence Bundle with 16 KiB Screenshot

**Files:**
- Modify: `scripts/live-evidence-schema.ts`
- Modify: `scripts/generate-live-evidence.ts`
- Modify: `scripts/generate-live-envelopes.ts`
- Modify: `tests/scripts/live-evidence-schema.test.ts`
- Modify: `tests/scripts/generate-live-evidence.test.ts`
- Modify: `tests/scripts/generate-live-envelopes.test.ts`
- Create at capture time: `frontend/public/evidence/releases/<v4-release-id>/...`

**Interfaces:**
- Produces: `MAX_SCREENSHOT_BYTES = 16_384` in the live evidence schema.
- Produces an immutable V4 release manifest whose screenshot hash is identical to the contract review-image hash.
- Preserves V1-V3 public evidence paths byte-for-byte.

- [ ] **Step 1: Add exact boundary tests**

```ts
it("accepts an exact 16384-byte PNG and rejects 16385 bytes", () => {
  expect(() => verifyPayload("SCREENSHOT", pngBytes(16_384))).not.toThrow();
  expect(() => verifyPayload("SCREENSHOT", pngBytes(16_385))).toThrow(
    /SCREENSHOT exceeds 16384 bytes/,
  );
});
```

Add a generator test that refuses to overwrite a historical release and a manifest test that requires the screenshot path/hash/media type used by envelopes.

- [ ] **Step 2: Run script tests and prove RED**

Run: `npm run test:scripts -- --test-name-pattern="16384|V4 evidence"`

Expected: FAIL because current screenshot limit is 65,536 bytes and V4 binding does not exist.

- [ ] **Step 3: Implement V4 evidence binding**

Add a new release ID only after capture, and reject repeated-hex or empty case/contract/commit values. The generator must accept only a PNG signature, remove no semantic page content, and require the final screenshot to remain legible at its recorded dimensions.

- [ ] **Step 4: Generate and verify a local candidate bundle**

Run:

```bash
npm run evidence:publish -- --input work/evidence/live-capture --public frontend/public
npm run evidence:verify
npm run evidence:envelopes
```

Expected: generator reports six files, screenshot size at most 16,384 bytes, a stable release digest, and six canonical envelope hashes. Do not commit a candidate bound to a nonexistent V4 address or case.

- [ ] **Step 5: Run all evidence tests**

Run: `npm run test:scripts`

Expected: PASS.

- [ ] **Step 6: Commit Task 4 code only**

```bash
git add scripts/live-evidence-schema.ts scripts/generate-live-evidence.ts scripts/generate-live-envelopes.ts tests/scripts/live-evidence-schema.test.ts tests/scripts/generate-live-evidence.test.ts tests/scripts/generate-live-envelopes.test.ts
git commit -m "feat: enforce bounded V4 review evidence"
```

---

### Task 5: V4 Deploy Artifact and Frozen Manifest Tooling

**Files:**
- Modify: `scripts/build_contract_artifact.py`
- Regenerate: `contracts/access_seal_deploy.py`
- Modify: `deploy/001_deploy_access_seal.ts`
- Modify: `deploy/999_verify_access_seal.ts`
- Modify: `tests/scripts/contract-artifact.test.ts`
- Modify: `tests/scripts/contract-artifact-parity.test.ts`
- Modify: `tests/scripts/deploy.test.ts`
- Modify: `tests/integration/test_deployment_scripts.py`

**Interfaces:**
- Produces: `V4DeploymentManifest` with `contractVersion: "V4"` and namespace `work/deployments/<network>/v4/<artifact-hash>/<address>.json`.
- Produces verification of code, schema, source/artifact hashes, deployment transaction, empty accounting, and absent privileged upgrade methods.

- [ ] **Step 1: Add failing V4 manifest tests**

Require deployment code to reject `contractVersion: "V3"`, dirty tracked state, wrong signer/network, stale artifact, repeated-hex hashes, pre-existing manifest destination, and any schema containing owner/upgrader methods.

```ts
assert.equal(result.contractVersion, "V4");
assert.match(path, /[\\/]v4[\\/][0-9a-f]{64}[\\/]0x[0-9a-f]{40}\.json$/);
assert.equal(result.contractClassification, "INTENTIONALLY_FROZEN");
```

- [ ] **Step 2: Run deploy/artifact tests and prove RED**

Run: `npm run test:scripts -- --test-name-pattern="V4|artifact|deployment"`

Expected: FAIL because deployment tooling is V3-namespaced and schema hash is V3.

- [ ] **Step 3: Generate the artifact and update exact V4 tooling**

Run: `npm run contract:build`

Keep the verified 48,000-byte deployment-artifact ceiling; V4 removes the V3 support-prompt/refetch path to make room for the bounded-context code. Update manifest types/namespaces and replace `ACCESSSEAL_FROZEN_SCHEMA_SHA256` only with the hash returned by the official schema for the freshly generated artifact. Do not type a guessed hash.

- [ ] **Step 4: Verify source/artifact parity and size**

Run:

```bash
npm run contract:check
node --import tsx --test tests/scripts/contract-artifact.test.ts tests/scripts/contract-artifact-parity.test.ts
python -m pytest tests/direct/test_prompt_parity.py tests/integration/test_deployment_scripts.py -q
```

Expected: PASS; artifact is deterministic, compiles, fits the verified byte ceiling, and matches readable source/prompt behavior.

- [ ] **Step 5: Commit Task 5**

```bash
git add contracts/access_seal_deploy.py scripts/build_contract_artifact.py deploy/001_deploy_access_seal.ts deploy/999_verify_access_seal.ts tests/scripts/contract-artifact.test.ts tests/scripts/contract-artifact-parity.test.ts tests/scripts/deploy.test.ts tests/integration/test_deployment_scripts.py
git commit -m "feat: add frozen V4 deployment tooling"
```

---

### Task 6: V4 Frontend Readback and Six-Phase Transactions

**Files:**
- Modify: `frontend/src/lib/access-seal.ts`
- Modify: `frontend/src/lib/transactions.ts`
- Modify: `frontend/src/providers/wallet-provider.tsx`
- Modify: `frontend/src/components/status-panel.tsx`
- Modify: `frontend/tests/lib/access-seal.test.ts`
- Modify: `frontend/tests/lib/transactions.test.ts`
- Modify: `frontend/tests/providers/wallet-provider.test.tsx`
- Modify: `frontend/tests/components/workflow.test.tsx`

**Interfaces:**
- Produces `ReviewContextRecord` and `AccessSealClient.readReviewContext(caseId, epoch)`.
- Produces transaction phases `WAITING_FOR_WALLET`, `SUBMITTED`, `CONSENSUS_PENDING`, `PROTOCOL_FINALIZED`, `EXECUTION_SUCCESS`, `READBACK_CONFIRMED`, plus classified terminal failures.
- Produces `TransactionFailureKind = "WALLET_REJECTED" | "WRONG_ROLE" | "RPC_ERROR" | "VALIDATORS_TIMEOUT" | "DETERMINISTIC_VIOLATION" | "EXECUTION_ERROR" | "READBACK_MISMATCH"`.

- [ ] **Step 1: Add failing V4 parser tests**

```ts
it("accepts an exact bound V4 review context", async () => {
  const context = await client.readReviewContext(CASE_ID, 0);
  expect(context.ready).toBe(true);
  expect(context.schemaVersion).toBe("accessseal-review-context/1");
  expect(context.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(new TextEncoder().encode(context.contextJson).byteLength).toBeLessThanOrEqual(16_384);
});

it("rejects a ready context whose parsed binding disagrees", async () => {
  await expect(client.readReviewContext(CASE_ID, 0)).rejects.toThrow(
    "Review context binding is invalid.",
  );
});
```

- [ ] **Step 2: Add failing transaction-phase tests**

Assert the ordered event sequence:

```ts
expect(events.map((event) => event.phase)).toEqual([
  "SUBMITTED",
  "CONSENSUS_PENDING",
  "PROTOCOL_FINALIZED",
  "EXECUTION_SUCCESS",
  "READBACK_CONFIRMED",
]);
```

Add separate receipts for `VALIDATORS_TIMEOUT`, `DETERMINISTIC_VIOLATION`, wallet rejection, execution failure, and readback mismatch. No failure may return `READBACK_CONFIRMED`.

- [ ] **Step 3: Run frontend unit tests and prove RED**

Run: `npm --prefix frontend test -- --run tests/lib/access-seal.test.ts tests/lib/transactions.test.ts`

Expected: FAIL because V4 context and phase types do not exist.

- [ ] **Step 4: Implement exact V4 parsing**

Add:

```ts
export type ReviewContextRecord = {
  caseId: string;
  epoch: number;
  schemaVersion: "accessseal-review-context/1";
  ready: boolean;
  contextJson: string;
  contextHash: `sha256:${string}`;
  imageUri: string;
  imageSha256: `sha256:${string}`;
};
```

Parse `contextJson`, require exact binding to the case record, verify its UTF-8 length, and compute browser SHA-256 to match `contextHash`. Add `reviewContextReady` and `reviewContextHash` to V4 case keys while preserving read-only parsing of V2/V3 history.

- [ ] **Step 5: Implement classified transaction tracking**

Emit state only from observed wallet/receipt/readback evidence. Map GenLayer status names exactly; do not infer validator timeout from elapsed wall time. `READBACK_CONFIRMED` requires the action-specific reconciler to return `true`.

Change `requestReview` from `consensusMaxRotations: 7` to the repository's normal default by omitting the override; V4 reduces per-node work instead of hiding it behind rotations.

- [ ] **Step 6: Preserve Change Wallet semantics**

`changeAccount()` calls MetaMask account selection and updates provider state only after the returned account and chain are validated. Cancel/reject preserves the prior connected address and returns a classified wallet error.

- [ ] **Step 7: Run focused frontend tests**

Run: `npm --prefix frontend test -- --run tests/lib/access-seal.test.ts tests/lib/transactions.test.ts tests/providers/wallet-provider.test.tsx tests/components/workflow.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add frontend/src/lib/access-seal.ts frontend/src/lib/transactions.ts frontend/src/providers/wallet-provider.tsx frontend/src/components/status-panel.tsx frontend/tests/lib/access-seal.test.ts frontend/tests/lib/transactions.test.ts frontend/tests/providers/wallet-provider.test.tsx frontend/tests/components/workflow.test.tsx
git commit -m "feat: reconcile V4 context and transaction phases"
```

---

### Task 7: Evidence Command Center Components

**Files:**
- Create: `frontend/src/components/cases/evidence-workspace.tsx`
- Create: `frontend/src/components/cases/intelligent-review-panel.tsx`
- Create: `frontend/src/components/cases/case-workflow-stepper.tsx`
- Create: `frontend/src/components/cases/case-activity.tsx`
- Modify: `frontend/src/components/cases/case-dashboard-model.ts`
- Modify: `frontend/src/components/case-detail.tsx`
- Modify: `frontend/src/components/cases/case-detail.module.css`
- Modify: `frontend/src/components/navigation/app-navigation.tsx`
- Modify: `frontend/src/components/navigation/navigation.module.css`
- Modify: `frontend/src/app/globals.css`
- Modify: `frontend/tests/components/case-detail-layout.test.tsx`
- Modify: `frontend/tests/components/navigation.test.tsx`

**Interfaces:**
- Consumes: `ReconciledCase`, `EvidenceRecord`, `ReviewContextRecord`, wallet role, and transaction state from Task 6.
- Produces: `deriveCaseWorkspaceModel(...)` with one `primaryAction`, five stages, role warning, verdict tone, and activity rows.
- Keeps all contract write callbacks in `case-detail.tsx`; presentational children never create an SDK client.

- [ ] **Step 1: Add failing workspace model tests**

```tsx
expect(model.primaryAction).toEqual({
  id: "REQUEST_REVIEW",
  label: "Request intelligent review",
  enabled: true,
  requiresWallet: true,
});
expect(model.stages.map((stage) => stage.state)).toEqual([
  "complete", "complete", "complete", "current", "upcoming",
]);
expect(model.roleWarning).toBeNull();
```

Add wrong-role, context-not-ready, `UNRESOLVED`, and finalized settlement models. Assert exactly one primary action is enabled.

- [ ] **Step 2: Add failing component tests**

Render a V4 sealed case and require headings `Evidence workspace`, `Intelligent review`, `Simulated escrow`, and `Immutable activity`; all six evidence labels; active wallet role; and no `APPROVED` text before finalized review readback.

- [ ] **Step 3: Run component tests and prove RED**

Run: `npm --prefix frontend test -- --run tests/components/case-detail-layout.test.tsx tests/components/navigation.test.tsx`

Expected: FAIL because the new components and app-shell labels do not exist.

- [ ] **Step 4: Implement the pure workspace model**

Use contract lifecycle, context readiness, finalized review, settlement, actor address, and retry eligibility. Never derive lifecycle from a transaction toast or local evidence cache. Return one action object and a separate explanatory reason when disabled.

- [ ] **Step 5: Implement focused presentational components**

`EvidenceWorkspace` displays evidence type, seal/freshness, exact hash, media type, size where known, issuer, observation/submission/expiry, origin, and manifest relationship. Safe previews are same-origin images/text only; unknown media renders metadata without embedding.

`IntelligentReviewPanel` displays context binding/readiness, fixed-rubric signals, finalized verdict, blockers, missing evidence, rationale hash, proof ID, and finality. It must use “Decision rationale” rather than “chain of thought”.

`CaseWorkflowStepper` labels Funded → Terms accepted → Evidence sealed → AI review → Settlement and identifies the next actor/action.

`CaseActivity` uses authoritative timestamps/proof/settlement data; it does not invent missing chain events.

- [ ] **Step 6: Compose Case Detail and app shell**

Keep the approved order: identity → five-stage stepper → one authoritative action → evidence/review split → accounting → activity. Replace duplicated old sections only after their write handlers and recovery branches are wired into the new composition.

Navigation becomes Overview, Cases, Activity, Proofs. Until dedicated routes exist, Activity and Proofs are anchored sections on the case page or disabled explanatory items; do not add empty product routes.

- [ ] **Step 7: Apply the approved visual tokens**

Use light neutral background, white surfaces, navy text, indigo actions, mint/amber/red semantic states, 8-12 px radii, low shadows, and no external product assets. Ensure verdict meaning is communicated by icon, text, and sentence—not color alone.

- [ ] **Step 8: Run component suite**

Run: `npm --prefix frontend test -- --run tests/components`

Expected: PASS.

- [ ] **Step 9: Commit Task 7**

```bash
git add frontend/src/components/cases frontend/src/components/case-detail.tsx frontend/src/components/navigation frontend/src/app/globals.css frontend/tests/components
git commit -m "feat: build Evidence Command Center UI"
```

---

### Task 8: Responsive, Accessibility, and End-to-End Workflow

**Files:**
- Modify: `frontend/e2e/responsive-accessibility.spec.ts`
- Modify: `frontend/e2e/happy-path.spec.ts`
- Modify: `frontend/e2e/recovery.spec.ts`
- Modify: `frontend/e2e/fixtures/workflow.ts`
- Modify: `frontend/e2e/fixtures/wallet.ts`
- Modify: `frontend/src/components/cases/case-detail.module.css`
- Modify: `frontend/src/components/navigation/navigation.module.css`

**Interfaces:**
- Consumes: UI and phase model from Tasks 6-7.
- Produces browser proof at desktop 1440×1000, tablet 834×1112, and mobile 390×844.

- [ ] **Step 1: Add failing responsive assertions**

At each viewport assert no horizontal document overflow. Desktop requires two visible evidence/review columns. Tablet requires stacked panels and rail navigation. Mobile requires bottom navigation, accordion evidence rows, wrapped hashes, 44 px controls, and a safe-area-aware sticky primary action.

- [ ] **Step 2: Add failing keyboard and accessibility assertions**

Test skip link, logical focus order, evidence accordion, wallet change, modal focus trap/escape, visible focus, reduced motion, `aria-live` transaction updates, and zero serious/critical axe violations.

- [ ] **Step 3: Add happy-path state progression**

Mock only contract-shaped RPC responses and require:

`EVIDENCE_OPEN → close wallet prompt → EVIDENCE_SEALED/context ready → review phases → finalized APPROVED → prepare payout → execute → DISPATCHED_FINALIZED`.

At every transition assert UI remains at the previous authoritative state until readback changes.

- [ ] **Step 4: Run E2E tests and prove RED**

Run: `npm --prefix frontend run test:e2e -- responsive-accessibility.spec.ts happy-path.spec.ts recovery.spec.ts`

Expected: FAIL on new Evidence Command Center selectors and phase expectations.

- [ ] **Step 5: Implement responsive and accessibility fixes**

Use CSS grid breakpoints at 1100 px and 768 px, preserve DOM reading order, avoid duplicated interactive controls across breakpoints, add `scroll-margin`, and use `env(safe-area-inset-bottom)` for the mobile action bar.

- [ ] **Step 6: Run E2E and frontend quality gates**

Run:

```bash
npm --prefix frontend run test:e2e -- responsive-accessibility.spec.ts happy-path.spec.ts recovery.spec.ts
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Task 8**

```bash
git add frontend/e2e frontend/src/components/cases/case-detail.module.css frontend/src/components/navigation/navigation.module.css
git commit -m "test: verify responsive V4 workflow"
```

---

### Task 9: Documentation, Full Verification, and Local Proof Package

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/threat-model.md`
- Modify: `docs/recovery-runbook.md`
- Modify: `docs/proof-matrix.md`
- Modify: `docs/deployment-manifest.example.json`
- Modify: `.env.example`

**Interfaces:**
- Produces complete user/developer instructions and a proof matrix with no unverified live claims.
- Produces a clean, reviewable branch ready for external-action preflight.

- [ ] **Step 1: Update documentation against actual implemented names**

Document V4 context schema, exact limits, independent equivalence fields, permissionless triggers, transaction/readback phases, frozen recovery, local testing, environment variable names, and known limitations. Label localnet and Bradbury value as simulated.

- [ ] **Step 2: Update threat and proof matrices**

Map each actor/action to exact contract method, direct/integration test, and live-evidence slot. Leave live transaction/address cells explicitly `Not yet executed` rather than inserting fake hashes.

- [ ] **Step 3: Run the complete fresh verification suite**

Run:

```bash
npm run contract:check
npm run lint
npm run typecheck
npm run test:direct
npm run test:integration
npm run test:scripts
npm --prefix frontend run test
npm --prefix frontend run test:e2e
npm run build
npm run evidence:verify
npm run audit:secrets
```

Expected: every command exits 0 with zero test failures, lint errors, type errors, build errors, stale artifact errors, evidence errors, or secret findings.

- [ ] **Step 4: Inspect repository hygiene**

Run:

```bash
git status --short --untracked-files=all
git diff --check
git ls-files | rg "(^|/)(node_modules|\.next|test-results|playwright-report|\.env$|\.superpowers)(/|$)"
```

Expected: only intended source/docs changes; final command returns no tracked forbidden paths.

- [ ] **Step 5: Commit Task 9**

```bash
git add README.md docs/architecture.md docs/threat-model.md docs/recovery-runbook.md docs/proof-matrix.md docs/deployment-manifest.example.json .env.example
git commit -m "docs: document V4 verification and recovery"
```

- [ ] **Step 6: Request code review before external actions**

Use `superpowers:requesting-code-review`, address only verified findings, rerun the affected tests, then rerun the complete suite before claiming readiness.

---

### Task 10: Confirmed Push, Bradbury Deployment, Vercel Deployment, and Live Happy Path

**Files:**
- Generated after confirmation: `work/deployments/testnet_bradbury/v4/<artifact-hash>/<address>.json`
- Generated after live verification: fixed evidence/proof records referenced by `docs/proof-matrix.md`
- Modify after real address exists: Vercel/public environment configuration through the deployment platform, not a committed secret file.

**Interfaces:**
- Consumes: clean, fully verified commit from Task 9.
- Produces: GitHub commit/PR, finalized V4 contract address and deployment transaction, Vercel production URL, and fixed live proof matrix.

- [ ] **Step 1: Perform read-only identity preflight**

Record:

```bash
git config user.name
git config user.email
gh auth status
git remote -v
git status --short
vercel whoami
vercel project ls
```

Read the connected deployment wallet from the wallet UI without sending a transaction. State the exact GitHub account/repository, deployment wallet, Bradbury chain ID 4221, Vercel team/project, commit, and proposed actions.

- [ ] **Step 2: Stop for GitHub push confirmation**

Obtain fresh user confirmation naming the checked GitHub identity and exact branch/PR action. Only then push and create/update the PR. Do not merge without a separate confirmed merge action if repository policy requires it.

- [ ] **Step 3: Stop for Bradbury deployment confirmation**

After the exact clean commit is on the intended branch, obtain fresh confirmation naming the checked wallet. Then deploy once with `GENLAYER_NETWORK=testnet_bradbury`, wait for `FINALIZED`, require `FINISHED_WITH_RETURN`, and run `npm run verify:deployment` against the generated manifest.

- [ ] **Step 4: Configure and verify the exact V4 address**

Update the Vercel project environment through Vercel using `NEXT_PUBLIC_GENLAYER_CONTRACT_ADDRESS=<real V4 address>`, Bradbury network, and official RPC. Never place `VERCEL_TOKEN` in a command that is committed or logged to a source file.

- [ ] **Step 5: Stop for Vercel production deployment confirmation**

State the checked Vercel team/project, commit, and V4 address. Obtain fresh confirmation, deploy production with the environment-provided token, and verify the returned deployment belongs to that project/team.

- [ ] **Step 6: Perform read-only production smoke tests**

Verify page load, public config, exact V4 address, no console errors, wallet selector, desktop/mobile accessibility, and contract readbacks without sending transactions.

- [ ] **Step 7: Execute the live case with action-time wallet confirmations**

For each create, accept, fund, evidence submission, close, review, prepare, and execute transaction: prepare the exact action, wallet, contract, case, amount, and method; stop immediately before MetaMask confirmation; continue only after the user confirms and reports submission.

Require six evidence transactions and authoritative `get_evidence` readback, then `reviewContextReady`, review parent/internal finality, authoritative `APPROVED`, payout intent, dispatch, recipient confirmation, and accounting conservation.

- [ ] **Step 8: Freeze the completion evidence package**

Record exact commit, readable/artifact hashes, schema hash, contract address, deployment transaction, explorer links, Vercel URL/deployment ID, six evidence hashes/transactions, review transaction/proof/finality, settlement transactions/readbacks, tests, limitations, and proof matrix.

- [ ] **Step 9: Final completion gate**

Do not call V4 complete unless the live path reaches:

```text
review FINALIZED
→ authoritative verdict APPROVED
→ prepare_payout FINALIZED + readback
→ execute_settlement FINALIZED + readback
→ lifecycle DISPATCHED_FINALIZED
→ recipient and conservation confirmed
```

If any item is missing, report that exact item as incomplete and preserve all funds/state behind the contract's safe path.

---

## Plan Self-Review Mapping

| Spec requirement | Implemented by |
|---|---|
| Full six-artifact seal and bounded context | Tasks 1, 4 |
| Independent one-call semantic consensus | Tasks 2, 3 |
| Fail-closed evidence and `UNRESOLVED` | Tasks 1-3 |
| Permissionless review/settlement proof | Tasks 2-3 |
| Custody, retry, refund, conservation | Tasks 2-3, 9 |
| Frozen deployment and recovery | Tasks 5, 9 |
| Authoritative frontend readback | Task 6 |
| Evidence Command Center UI | Task 7 |
| Responsive/accessibility/state handling | Tasks 6, 8 |
| Artifact, test, lint, build, secret gates | Tasks 5, 9 |
| Action-time confirmations and live proof | Task 10 |

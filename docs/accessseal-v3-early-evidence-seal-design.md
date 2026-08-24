# AccessSeal V3 Early Evidence Seal Design

## Goal

Allow a funded AccessSeal case to enter intelligent review immediately after its complete evidence profile is fixed on-chain, without waiting for the configured evidence cutoff. Preserve the cutoff as a liveness fallback when the buyer does not seal early.

V3 is a new `INTENTIONALLY_FROZEN` deployment. V2 storage and cases are not migrated and V2 remains available as immutable historical evidence.

## Decision and consequence

GenLayer decides whether the fixed release evidence proves that the submitted web release satisfies the case profile and has no blocking defects. An `APPROVED` and protocol-final review authorizes preparation and execution of the vendor payout; other verdicts follow the existing unresolved, retry, refund, and settlement rules.

Early sealing does not select a verdict. It only fixes the evidence set and makes the case eligible for review.

## Trust model

| Actor | Cannot trust | Can manipulate | Contract defense | Test or evidence |
|---|---|---|---|---|
| Buyer | Vendor | Evidence selection and release content | Exact required evidence profile, immutable seal, release-digest binding, buyer-only early seal | Missing, duplicate, mismatched, stale, and post-seal evidence tests |
| Vendor | Buyer | Early closure and payment timing | Buyer may seal only after the complete objective profile; deadline fallback prevents permanent blocking | Unauthorized seal and cutoff-fallback tests |
| Buyer and vendor | Frontend or backend | Displayed state, ordering, and transaction status | Contract is authoritative; UI distinguishes pending, finalized, successful, and readback-confirmed states | Contract-to-frontend and reconciliation tests |
| Validators | Evidence issuer | Malformed, replayed, stale, or cross-case evidence | Existing canonical envelope, issuer, chain, contract, case, epoch, nonce, timestamp, hash, and release-domain validation remains mandatory | Existing adversarial evidence suite plus V3 regression tests |
| Either party | Contract owner | Verdict, recipient, or upgrade path | No owner, verdict override, recipient redirect, or privileged upgrade method | Recovery and no-privileged-path tests |

## State and storage

Add lifecycle `EVIDENCE_SEALED` and per-case/epoch seal metadata:

- `evidence_sealed[case:epoch] -> bool`
- `evidence_sealed_at[case:epoch] -> u256`
- `evidence_sealed_by[case:epoch] -> Address`

The authoritative case readback exposes `evidenceSealed`, `evidenceSealedAt`, and `evidenceSealedBy` for the current epoch. Evidence readback remains the authoritative source for the fixed envelopes, hashes, and release digest.

## Required evidence profile

The early-seal profile requires exactly one fresh envelope of each type:

1. `RELEASE_MANIFEST`
2. `HTML_BUNDLE`
3. `SCREENSHOT`
4. `DOM_FACTS`
5. `SCANNER_REPORT`
6. `CRITICAL_FLOW_TRACE`

All six envelopes must already satisfy the existing provenance, subject origin, issuer, schema version, profile version, observation time, submission time, expiry, chain, contract, case, epoch, action, nonce, canonical hash, payload hash, media type, and release-digest checks. Duplicate evidence types are rejected during append so an apparently complete count cannot hide a missing type.

## Transitions

| From | Actor | Method | Preconditions | On-chain effect | To | Replay behavior |
|---|---|---|---|---|---|---|
| `FUNDED` | Vendor | `open_evidence` | Valid release manifest inside evidence window | Opens epoch and records manifest | `EVIDENCE_OPEN` | Duplicate or invalid opening rejected |
| `EVIDENCE_OPEN` | Vendor | `append_evidence` | Valid unique required type inside evidence window | Appends immutable envelope | `EVIDENCE_OPEN` | Hash, nonce, and type replay rejected |
| `EVIDENCE_OPEN` | Buyer | `close_evidence` | All six required fresh types exist and hard deadline has not expired | Records seal metadata and freezes evidence | `EVIDENCE_SEALED` | Second seal rejected without mutation |
| `EVIDENCE_SEALED` | Any permitted existing caller | `request_review` | Seal is authoritative and no review exists | Starts intelligent review immediately | Existing review-pending/decided flow | Duplicate request rejected |
| `EVIDENCE_OPEN` | Any permitted existing caller | `request_review` | Evidence cutoff has passed, minimum evidence rule holds, hard deadline has not expired | Starts intelligent review through fallback path | Existing review-pending/decided flow | Existing replay rules apply |

`append_evidence` and `open_evidence` reject `EVIDENCE_SEALED`. Cure/retry epochs reset the seal metadata for the new epoch and must satisfy the same profile before another early seal.

## Authorization and liveness

Only the case buyer can call `close_evidence`. This prevents the vendor, frontend, backend, or an unrelated account from unilaterally ending the evidence period. The original cutoff path remains available, so a buyer who disappears cannot permanently block review. Early closure cannot occur at or after the hard deadline.

## Review eligibility

`request_review` is eligible when either condition is true:

- the current epoch is `EVIDENCE_SEALED`; or
- the original evidence cutoff has passed.

The existing hard-deadline, evidence-count, review-replay, finality, retry, verdict, payout, accounting, and settlement guards remain unchanged. The intelligent review prompt receives the same fixed evidence facts and cannot observe who requested or sealed the evidence as a verdict signal.

## Frontend workflow

The case page derives all progress from authoritative contract reads:

- Vendor sees evidence completeness by required type.
- Buyer sees `Close evidence & enable review` only when six required types are present.
- The button displays wallet confirmation, submitted, consensus pending, finalized, execution success, readback success, and error states separately.
- After authoritative seal readback, the review action becomes available immediately.
- If the buyer does not seal, the existing cutoff countdown and fallback review action remain visible.
- Reload and wallet changes reconcile from contract state; local state never advances the lifecycle.

## Error behavior

The contract rejects wrong actor, incomplete profile, duplicate type, expired envelope, hard-deadline expiry, already-sealed epoch, post-seal append, and review before both seal and cutoff. Rejections leave lifecycle, evidence, escrow, and accounting unchanged. The frontend reports the contract reason and offers a readback retry without resending a transaction automatically.

## Test-first implementation

Before production changes, add failing direct tests for:

- buyer can seal exactly six valid required evidence types before cutoff;
- vendor and unrelated accounts cannot seal;
- every missing required type prevents sealing;
- duplicate type cannot substitute for a missing type;
- stale evidence prevents sealing;
- double seal and append after seal are rejected without mutation;
- review succeeds immediately after seal and fails before seal/cutoff;
- cutoff fallback still permits review without a seal;
- cure/retry epoch resets and re-applies seal requirements;
- escrow conservation and settlement behavior are unchanged;
- V3 remains free of privileged upgrade or verdict paths.

Add integration tests for the complete early-seal path and frontend tests for role gating, state labels, transaction stages, error recovery, reload reconciliation, and wallet changes. Run the complete direct, integration, frontend, lint, typecheck, build, secret-scan, and contract-size/deployability gates.

## Deployment and proof

V3 requires a new source hash, deployment manifest, Bradbury contract address, deployment transaction, and production frontend configuration. Deployment wallet, GitHub push/merge, and Vercel production actions each require fresh action-time user confirmation. A new case and new evidence envelopes must bind to the V3 address and case domain.

Completion evidence must include the six evidence transactions, `close_evidence`, immediate `request_review`, parent and internal review finality, authoritative verdict readback, and—only if `APPROVED`—payout preparation, settlement execution, `DISPATCHED_FINALIZED`, and accounting readback.

## Known limitation

Early sealing removes waiting but does not remove GenLayer consensus or protocol-finality time. A complete evidence profile can still produce `UNRESOLVED`, validator timeout, or a non-approved verdict; V3 must report those states accurately rather than treating sealing as approval.

# AccessSeal V4 Bounded Review Context and Evidence Command Center Design

**Date:** 2026-08-27
**Status:** Approved for implementation planning
**Contract classification:** `INTENTIONALLY_FROZEN`
**Target network:** GenLayer Bradbury, chain ID 4221

## 1. Objective

AccessSeal V4 must make a complete, hash-bound release review practically capable of reaching GenLayer protocol finality without weakening the semantic decision, safe `UNRESOLVED` behavior, custody controls, or settlement invariants.

The frontend will be redesigned as an original **Evidence Command Center**. It combines the evidence-inspection clarity associated with Persona, the multi-party workflow clarity associated with Ironclad, and the financial-action discipline associated with Stripe. It must not copy any source product's branding, assets, or screen composition.

V4 is a new frozen deployment. V3 state and cases are not migrated. Historical V1-V3 deployments remain immutable evidence of earlier versions.

## 2. Observed V3 Failure

The live V3 review path produced semantically valid `APPROVED` output but repeatedly failed to finalize on Bradbury. The observed validator rounds were dominated by `TIMEOUT`, with occasional `DETERMINISTIC_VIOLATION`. Increasing validator rotations did not repair the workload.

The failure is architectural: each validator refetches and reprocesses all six release artifacts, including the screenshot, then performs another semantic support evaluation. The production evidence bundle is approximately 59 KB. Repeating the full network and AI workload for every validator exceeds the practical execution window. More rotations add more expensive attempts rather than reducing the cost of one attempt.

The V4 fix therefore reduces the work performed inside `request_review` while preserving full evidence binding at the earlier seal boundary.

## 3. Considered Approaches

### 3.1 Selected: bounded review context with independent decision comparison

`close_evidence` verifies the complete six-artifact bundle and persists a canonical, bounded `reviewContext`. During review, the leader and validators independently evaluate that compact context and one optimized image. Consensus compares stable decision fields rather than rationale prose.

This preserves GenLayer semantic judgment while removing repeated six-artifact retrieval from every review node.

### 3.2 Rejected: compact context with validator support of leader output

This is a smaller change, but validators remain anchored to the leader candidate and require an additional support-evaluation path. The live V3 evidence shows that this shape can still be too expensive and can create brittle support-prompt differences.

### 3.3 Rejected: deterministic facts-only decision

This would be fastest, but it would reduce the Intelligent Contract to deterministic rule checking and weaken AccessSeal's core GenLayer use case: semantic evaluation of accessibility evidence.

## 4. Exact GenLayer Decision and Consequence

### Decision statement

For one exact AccessSeal case, epoch, release digest, fixed accessibility profile, and sealed evidence bundle, GenLayer establishes whether the release is:

- `APPROVED`: sufficient evidence demonstrates the fixed profile is satisfied and no material blocker exists;
- `REJECTED`: sufficient evidence demonstrates at least one fixed material blocker;
- `REQUEST_MORE_INFO`: required evidence is incomplete or insufficient but can be cured in a new bounded epoch; or
- `UNRESOLVED`: evidence, model output, or consensus is unavailable, contradictory, malformed, wrongly bound, or otherwise unreliable.

### Consequence statement

Only an authoritative `APPROVED` review with completed protocol finality may authorize preparation of the vendor payout. All other verdicts keep payout locked and activate only their explicitly defined cure, retry, expiry, or refund paths. No caller, frontend, backend, owner, or AI prose can directly select the transfer result.

## 5. Trust Matrix

| Actor | Cannot trust | Can manipulate | Contract defense | Required test/evidence |
|---|---|---|---|---|
| Buyer | Vendor and frontend | Case parameters, funding timing, evidence seal timing | Exact terms hash, role checks, complete-profile seal gate, immutable epoch binding | Unauthorized transitions, premature seal, accounting tests |
| Vendor | Buyer and evidence host | Submitted envelope, artifact content, URLs, timestamps | Vendor-only submission, manifest and payload hashes, origin/profile/release binding, freshness limits | Tamper, replay, stale and mismatched evidence tests |
| Evidence host | Submitter and network | Availability or returned bytes | SHA-256 verification at seal, bounded payloads, fail-closed context construction | Unavailable source, wrong bytes, oversize payload tests |
| Frontend | Wallet, RPC, cached state | Displayed status and suggested action | Contract readback is authoritative; UI never advances optimistically | Transaction/readback reconciliation and recovery tests |
| Review leader | Untrusted content and model output | Semantic interpretation and prose | Fixed rubric, bounded schema, exact bindings, independent validator decisions | Malformed, injected and unsupported candidate tests |
| Validator | Leader and other validators | Its own semantic interpretation or timeout | Independent evaluation of the same canonical context; exact stable-field comparison | Agreement, disagreement, timeout and deterministic-violation tests |
| Settlement caller | Buyer, vendor and UI | When to call eligible transition | Contract preconditions, idempotency and replay rejection | Third-party trigger, double execution and conservation tests |

## 6. Evidence Binding and Canonical Review Context

V4 preserves the six required evidence types:

1. `RELEASE_MANIFEST`
2. `HTML_BUNDLE`
3. `SCREENSHOT`
4. `DOM_FACTS`
5. `SCANNER_REPORT`
6. `CRITICAL_FLOW_TRACE`

Every envelope remains bound to schema version, case ID, chain ID, contract address, epoch, evidence type, submitter/issuer, media type, nonce, observed/submitted/expiry timestamps, profile version, profile hash, release digest, subject origin, payload URI, and payload SHA-256.

### Seal-time processing

`close_evidence` must:

1. require the authorized buyer and a complete current-epoch profile;
2. fetch all six exact artifacts;
3. enforce current byte, media-type, URI, origin, timestamp and manifest limits;
4. verify every payload SHA-256 and manifest entry;
5. derive a deterministic canonical `reviewContext` from contract-owned bindings and verified facts;
6. persist the context, its SHA-256, the optimized image URI/hash, and `reviewContextReady = true`; and
7. change lifecycle to `EVIDENCE_SEALED` only if all steps succeed.

Any unavailable, malformed, oversized, stale, contradictory, or hash-mismatched artifact aborts the seal transaction. The case remains `EVIDENCE_OPEN`; failure never becomes approval.

### Review context schema

The context must contain only decision-relevant, canonical fields:

- schema and rubric version;
- chain ID, contract address, case ID and epoch;
- buyer and vendor;
- subject origin, profile hash and release digest;
- ordered evidence type and payload-hash list;
- normalized DOM accessibility facts;
- normalized scanner findings;
- normalized critical-flow outcomes;
- screenshot hash, media type and optimized review URI;
- observation window and freshness result; and
- contract-derived completeness flags.

The serialized canonical context is limited to **16 KiB**. V4 tightens the required `SCREENSHOT` artifact to **16 KiB** and uses that exact manifest-bound screenshot as the optimized review image; there is no unbound alternate image. Bounds are measured as UTF-8 or raw byte length before storage/use. Unknown fields are not included.

The context is replay-bound to chain, contract, case, epoch, profile and release. It cannot be reused by another V4 deployment or case.

## 7. Intelligent Contract Architecture

### 7.1 Review execution

`request_review` is permissionless after eligibility is established. It requires `EVIDENCE_SEALED` and `reviewContextReady` for the current epoch and must not refetch the six source artifacts.

Each participating node:

1. reads the stored canonical context;
2. verifies its stored context hash;
3. fetches at most the single optimized review image;
4. verifies the image hash and byte limit;
5. executes one semantic AI evaluation using the fixed rubric; and
6. parses a bounded result.

The node result contains:

- `verdict`;
- sorted, unique `materialBlockers` from the fixed code set;
- sorted, unique `missingEvidence` from the fixed evidence-type set;
- exact profile and release bindings; and
- a bounded rationale used only for explanation.

Malformed or wrongly bound output becomes `UNRESOLVED`; it cannot throw into a favorable default.

### 7.2 Equivalence principle

Leader and validators independently reproduce the semantic decision. Consensus compares the stable decision fields exactly:

- verdict;
- sorted material blockers;
- sorted missing-evidence codes;
- profile hash;
- release digest; and
- evidence-reference/context hash.

Rationale text is excluded from equivalence because semantically equivalent nodes may explain the same decision differently. The finalized state stores a rationale hash and a bounded explanatory rationale from the accepted result, but prose cannot change consensus or settlement.

Any difference in stable decision fields is disagreement. Validator timeout or deterministic violation causes no review persistence and no value movement. A manual retry is offered only when the contract's cooldown and retry budget permit it.

### 7.3 Safe finality

The lifecycle becomes `DECIDED` only after the parent transaction and internal review finality complete and authoritative readback exposes the persisted attempt. A merely accepted or locally returned transaction is not a decision.

## 8. State Machine

| From | Actor | Method | Preconditions | On-chain effect | To | Replay behavior |
|---|---|---|---|---|---|---|
| `DRAFT` | Vendor | `accept_terms` | Exact case/terms binding | Records vendor acceptance | `DRAFT` | Duplicate rejected |
| `DRAFT` | Buyer | `fund_case` | Vendor accepted; exact value | Reserves simulated escrow | `EVIDENCE_OPEN` | Duplicate rejected |
| `EVIDENCE_OPEN` | Vendor | `submit_evidence` | Current epoch; valid envelope; unique type | Stores bound evidence record | `EVIDENCE_OPEN` | Duplicate/replay rejected |
| `EVIDENCE_OPEN` | Buyer | `close_evidence` | All six valid artifacts; context build succeeds | Stores context and seal | `EVIDENCE_SEALED` | Already sealed rejected |
| `EVIDENCE_SEALED` | Any caller | `request_review` | Context ready; retry rules satisfied | Starts semantic consensus | `DECIDED` only after finality | Failed/timeout attempt does not advance |
| `DECIDED` | Authorized actor | cure/retry/expire method | Verdict-specific condition | Opens bounded next epoch or terminal refund intent | Existing defined state | Replay rejected |
| `DECIDED` | Any eligible caller | `prepare_payout` | Finalized `APPROVED`; no existing intent | Reserves immutable payout intent | `SETTLEMENT_PENDING` | Duplicate rejected |
| `SETTLEMENT_PENDING` | Any eligible caller | `execute_settlement` | Exact pending intent | Dispatches once and records accounting | `DISPATCHED_FINALIZED` | Double execution rejected |

The existing hard-deadline, cure, unresolved-expiry, refund and appeal semantics remain unchanged unless an implementation incompatibility is discovered and separately approved.

## 9. Custody and Settlement

V4 preserves real contract custody on Bradbury and the existing separation of available, reserved, pending-dispatch, completed-payout, completed-refund and fee accounting. UI labels Bradbury GEN as simulated testnet value.

The conservation invariant remains:

`initial assets + inflows = available + reserved + completed payouts + completed refunds + fees`

No review-path optimization may change payout authorization, recipient binding, amount calculation, refund eligibility, replay protection or double-settlement rejection.

## 10. Frontend Design: Evidence Command Center

### 10.1 Visual direction

The application uses a light, enterprise evidence-workspace aesthetic:

- neutral slate page background;
- white, low-shadow operational surfaces;
- deep navy text;
- indigo primary actions;
- mint success, amber warning and red danger states;
- compact but readable typography;
- 8-12 px radii and disciplined spacing;
- original AccessSeal components and copy.

Persona influences the evidence/reasoning split, Ironclad influences workflow ownership and activity history, and Stripe influences financial confirmation. No brand assets or pixel-identical composition are reused.

### 10.2 App shell

Desktop uses a compact left navigation with Overview, Cases, Activity and Proofs. The header shows case context, active wallet, current role and `Change wallet`. Contract network/address identity remains visible without dominating the task.

The primary Case Detail order is:

1. case identity and authoritative lifecycle;
2. five-stage workflow stepper;
3. exactly one next authoritative action;
4. split Evidence Workspace and Intelligent Review;
5. simulated escrow/accounting; and
6. immutable activity timeline.

### 10.3 Evidence Workspace

The left pane lists all six evidence types and their sealed/fresh/invalid states. Selecting an item shows the artifact preview where safe, plus hash, media type, size, origin, uploader, observed/submitted timestamps, expiry and manifest relationship. Long hashes remain copyable and never force horizontal page overflow.

The right pane explains contract-owned context readiness, fixed rubric checks, finalized verdict, material blockers, missing evidence, consensus/finality and the rationale available from authoritative readback. Internal model chain-of-thought is never displayed or claimed. “Reasoning” means bounded decision rationale, rules, signals and evidence references.

### 10.4 Verdict and settlement

The verdict hero supports `APPROVED`, `REJECTED`, `REQUEST_MORE_INFO`, `UNRESOLVED` and not-yet-available states. Every state uses an icon, label and explanatory sentence in addition to color.

Settlement presents deposited, reserved, fee and recipient amounts separately. The two-step modal first summarizes the immutable intent, then confirms recipient, amount, network, contract and current wallet before opening MetaMask. The UI does not imply success until finalized execution and authoritative accounting/recipient readback agree.

### 10.5 Transaction state model

Every write displays these distinct phases:

1. waiting for wallet signature;
2. submitted/broadcast;
3. consensus accepted or pending;
4. protocol `FINALIZED`;
5. execution success; and
6. authoritative readback confirmed.

Errors distinguish wallet rejection, wrong wallet/role, RPC/network failure, validator timeout, deterministic violation, execution failure and readback mismatch. The UI never automatically resubmits a wallet transaction. A retry button appears only when readback and contract timing prove eligibility.

### 10.6 Responsive behavior

- **Desktop:** persistent sidebar and evidence/review split view.
- **Tablet:** navigation rail; Evidence Workspace above Intelligent Review; stepper horizontally scrollable with visible current stage.
- **Mobile:** bottom navigation, stacked cards, accordion evidence items, copyable wrapped identifiers, and one sticky next-action bar that respects safe-area insets.

All interactive targets are at least 44 px on mobile. Keyboard focus, reduced-motion preferences, semantic landmarks, labels, contrast and screen-reader status announcements remain mandatory.

## 11. Testing Strategy

Implementation follows TDD. Required regression and acceptance coverage includes:

### Contract direct tests

- V3 regression proving the old review path performs excessive artifact fetches.
- Complete seal builds one canonical, bounded context.
- Context and the exact manifest-bound `SCREENSHOT` enforce 16 KiB limits.
- Context hash, artifact hash, origin, profile, release, case, epoch, chain and contract mismatches fail closed.
- Unavailable, malformed, stale or contradictory evidence leaves the case open.
- `request_review` performs no six-artifact refetch.
- Each node performs at most one image fetch and one AI evaluation.
- Same stable decision with different rationale agrees.
- Any differing verdict, blocker, missing evidence or binding disagrees.
- Malformed output safely resolves to `UNRESOLVED` candidate semantics.
- Timeout/deterministic violation persists no review and moves no value.
- An unrelated third-party address can request an eligible review and trigger eligible settlement without changing the outcome or recipient.
- Cooldown, retry budget, cure and expiry remain replay-safe.
- Unauthorized actions and invalid transitions are rejected.
- Payout, refund, double execution and accounting conservation remain unchanged.
- No privileged upgrade path exists.

### Integration tests

- Five independent validators reach finality for a production-shaped `APPROVED` context.
- Validator callbacks and independent AI evaluations are proven by telemetry.
- Disagreement and timeout controls cannot pose as consensus.
- Parent finality, internal finality and authoritative review readback are all asserted.
- Happy-path payout reaches `DISPATCHED_FINALIZED` with recipient/accounting readback.
- Important non-approved terminal/recovery branches retain live-simulation coverage.

### Frontend tests

- Role and wallet selection never update until MetaMask account selection is returned.
- Action availability follows contract readback, not local assumptions.
- All six transaction phases and each error class render distinctly.
- Evidence metadata, verdicts, accounting and timeline use authoritative values.
- Desktop, tablet and mobile layouts meet accessibility and overflow requirements.
- Settlement requires the two-step confirmation and never reports success early.

### Verification commands

The implementation plan must include the repository's full Python direct/integration suites, frontend unit tests, Playwright responsive/accessibility tests, lint, typecheck, production build, deploy-artifact size/parity verification and secret scan.

## 12. Deployment and Recovery

V4 is `INTENTIONALLY_FROZEN`. Deployment creates a new address and does not mutate V3. The deployment manifest must bind source commit, readable source hash, deploy artifact hash, schema versions, chain ID, deployer and transaction.

Recovery consists of deploying a later frozen version and creating new cases. Existing V4 cases cannot be migrated or administratively rewritten. No owner/upgrader method may exist.

GitHub push, Bradbury deployment and Vercel production deployment each require a fresh action-time identity check and user confirmation. No token or private key may enter source, logs, committed configuration or evidence bundles.

## 13. Completion Criteria

V4 is not complete until all of the following are fixed evidence:

1. contract and frontend tests, lint, typecheck and build pass;
2. deploy artifact matches readable source and required byte limits;
3. contract deployment is `FINALIZED` with successful authoritative readback;
4. the production frontend uses the exact deployed V4 address;
5. a real case proves six bound evidence items and `reviewContextReady`;
6. review reaches `FINALIZED` with authoritative `APPROVED` readback;
7. payout preparation and execution reach `DISPATCHED_FINALIZED`;
8. recipient and conservation readbacks match;
9. repository commit, source/artifact hashes, transaction hashes, explorer links, Vercel URL, known limitations and proof matrix are recorded.

An `APPROVED` model return without protocol finality is not success. A finalized review without settlement readback is not the complete happy path.

## 14. Non-goals

- Migrating or repairing V3 cases.
- Increasing rotations as the primary reliability mechanism.
- Removing semantic GenLayer evaluation.
- Exposing hidden chain-of-thought.
- Auto-signing or auto-resubmitting wallet transactions.
- Changing custody, payout or refund economics.
- Copying Persona, Ironclad or Stripe assets and layouts.

# AccessSeal V4 live happy path — 12-hour design

## Objective

Produce one new Bradbury V4 case whose complete live path is independently provable from finalized transactions and authoritative readbacks: create, accept, fund, six evidence records, sealed review context, intelligent review, terminal verdict, prepared settlement, dispatched settlement, accounting conservation, and recipient-delivery proof when the protocol exposes it.

This design does not alter or redeploy the frozen V4 Intelligent Contract. It adds a transparent case-deadline preset to the frontend, publishes a new case-bound evidence bundle, and records only proof that can be independently re-read.

## Selected timing

- Evidence deadline: `14,400` seconds (4 hours after authoritative case creation).
- Hard deadline: `43,200` seconds (12 hours after authoritative case creation).
- Maximum unresolved retries: `2`.
- Simulated escrow: `100000000000000` Bradbury testnet base units (wei), unless the buyer changes it before generating the canonical preview.

The four-hour cutoff is the earliest time at which review may begin. It is not a four-hour delay between each transaction. All six evidence records and `close_evidence` must be finalized and authoritatively read back before the cutoff. Review and settlement then have the remaining eight-hour hard-deadline budget.

## Actors and authority

| Actor | Address | Authorized actions |
|---|---|---|
| Buyer | `0x21b45103dd05c43969daf3cbb4277391777e2ec7` | `create_case`, `fund`, `close_evidence` |
| Vendor | `0x35c9979d30992b13ef6df7036bc745e2e1cd76a2` | `accept_terms`, `open_evidence`, five `append_evidence` calls |
| Permissionless caller | Any Bradbury address selected at action time | `request_review`, settlement preparation, `execute_settlement`, and a permitted retry/recovery action |

Wallet account, network `testnet_bradbury`, chain ID `4221`, contract `0xa485edc97f5acd071a3dc793a790ac50d7a58df6`, exact method, arguments, and expected consequence must be shown immediately before every wallet confirmation. No wallet transaction is automatically signed, retried, or resubmitted.

## Frontend design

The case composer retains the existing 24-hour/7-day defaults. Its terms step gains an explicit deadline preset control with:

1. `Standard — 24 hours / 7 days` (default).
2. `Live proof — 4 hours / 12 hours`.

The review step displays both relative durations and the fact that absolute cutoff timestamps are established by the contract's authoritative `createdAt`. The canonical preview and `create_case` calldata must carry the selected `evidenceDeadline`, `hardDeadline`, and retry budget. Changing the wallet, network, contract, vendor, terms, amount, or preset invalidates the preview and requires regeneration.

The live-proof preset is not described as bypassing finality or as a production SLA. It is a shorter testnet case window with a visible warning that delayed consensus can still prevent completion.

## Evidence bundle

After `create_case` is finalized, the exact authoritative case ID and creation timestamp become inputs to a new immutable release ID. The bundle is generated from a fresh production capture and binds:

- contract, contract-domain chain ID, network chain ID, case ID, epoch, buyer, vendor;
- current production source commit and subject origin;
- profile hash, flows hash, case path, audited URLs, and critical-flow checkpoints;
- case creation time, 4-hour evidence deadline, 12-hour hard deadline;
- observation, submission, expiry, freshness, nonce, replay domain, media type, path, byte length, payload SHA-256, and review-image SHA-256.

The six public artifacts are `RELEASE_MANIFEST`, `HTML_BUNDLE`, `SCREENSHOT`, `DOM_FACTS`, `SCANNER_REPORT`, and `CRITICAL_FLOW_TRACE`. Publication occurs through a reviewed repository change and Vercel production deployment. Public HTTP bytes and hashes are rechecked before any evidence transaction.

## Transaction sequence and gates

| Order | Actor | Method | Advance condition |
|---:|---|---|---|
| 1 | Buyer | `create_case` | Parent transaction finalized/successful; `get_case` matches canonical preview |
| 2 | Vendor | `accept_terms` | Finalized/successful; locked terms and vendor acceptance read back |
| 3 | Buyer | `fund` | Finalized/successful; escrow/reserved accounting conserved |
| 4 | Vendor | `open_evidence` | Finalized/successful; record 1 is `RELEASE_MANIFEST` |
| 5–9 | Vendor | `append_evidence` | Each finalized/successful; ordered authoritative count increments to 6/6 |
| 10 | Buyer | `close_evidence` | Finalized/successful before cutoff; sealed context and all bindings revalidated |
| Wait | — | Protocol clock | Authoritative `readAt` is strictly after evidence cutoff |
| 11 | Permissionless caller | `request_review` | Parent and internal finality complete; terminal authoritative verdict exists |
| 12 | Permissionless caller | `prepare_payout` or `prepare_refund` | Method matches finalized verdict; settlement intent read back |
| 13 | Permissionless caller | `execute_settlement` | Parent/child finality and exact settlement/accounting readback verified |

No later transaction is prepared from an `ACCEPTED` status alone. Each step requires the prior step's finalized execution and authoritative readback. Failed, timed-out, or unresolved transactions do not count and are never represented as success.

## Verdict and recovery behavior

- `APPROVED` permits only payout preparation.
- `REJECTED` permits only refund preparation.
- `REQUEST_MORE_INFO` follows the existing cure epoch and cannot be presented as a completed happy path.
- `UNRESOLVED` may use only the contract's bounded retry flow after its cooldown/finality preconditions. If retries are exhausted, the safe refund path is documented rather than relabelled as approval.
- A validator timeout or consensus disagreement is a protocol outcome, not a frontend success. Resubmission requires fresh action-time user confirmation.

The target evidence is an approved payout, but the proof package must preserve the actual validator verdict. The project will never edit evidence, contract state, or documentation to claim `APPROVED` when authoritative readback differs.

## Settlement proof

`DISPATCHED_FINALIZED` alone proves parent dispatch, not recipient receipt. Completion requires:

1. finalized/successful prepare transaction and exact settlement intent;
2. finalized/successful `execute_settlement` parent;
3. authoritative terminal settlement and accounting conservation readbacks;
4. finalized/successful linked child transfer or an exact recipient balance delta when available.

If item 4 is unavailable on Bradbury, the package states “dispatch finalized; recipient delivery not independently proven” and does not claim full delivery.

## Testing and verification

Implementation follows TDD. The first failing tests cover preset selection, exact calldata, default preservation, invalidation after preset changes, visible timing/warning copy, and responsive/keyboard operation. Minimal production changes then make them pass.

Before push or production deployment, run contract parity, lint, typecheck, direct tests, integration tests, script tests, frontend unit tests, E2E tests, production build, evidence verification, and secret audit. Browser verification covers desktop and mobile, loading/error/success states, wallet role switching, canonical preview, and the exact live case without submitting unconfirmed transactions.

## Fixed completion package

The final package records repository and production commits, Vercel deployment, frozen contract hashes/address/deployment transaction, the new case and bundle IDs, all parent/internal/child transaction hashes, finality and execution results, authoritative readbacks, accounting conservation, public artifact hashes, tests, browser checks, and known limitations. Every promoted claim maps to the proof matrix; missing proof remains an explicit limitation.

## Abort conditions

Stop the live run rather than improvise if the wrong wallet or network is active, production artifacts do not match their hashes, the evidence cutoff cannot safely accommodate remaining evidence transactions, any readback contradicts the intended case binding, consensus repeatedly fails, or the hard deadline leaves insufficient recovery time. Starting a replacement case requires a new plan and fresh transaction confirmations.

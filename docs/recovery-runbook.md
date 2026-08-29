# AccessSeal V4 recovery runbook

Use this runbook whenever a wallet or UI result is not unambiguously finalized. A click, pending receipt, or optimistic UI is never proof. Do not record a secret, mnemonic, private key, or token while investigating.

## Always begin with authoritative readback

1. Record network, contract address, case ID, role, attempted method, and transaction hash if one actually exists.
2. Wait for final transaction status and successful execution. If status is unknown, label it undetermined; do not resubmit automatically.
3. At `latest-final`, read `get_case`, `get_evidence`, `get_review_context`, `get_review`, `get_review_attempt`, `get_review_finality`, `get_settlement`, and `get_accounting` as applicable.
4. Reconcile the UI to those reads. Verify `totalDeposits = reserved + pendingDispatch + dispatchedPayouts + dispatchedRefunds`.

The UI must never advance before this readback and never auto-sign or auto-resubmit a wallet transaction.

## Evidence close and review

- `close_evidence(caseId)` is buyer-only. Before signing, confirm the current epoch is `EVIDENCE_OPEN`, has exactly the six mandatory types, and all envelopes remain fresh.
- After a finalized successful close, require `get_case` to show `lifecycle: EVIDENCE_SEALED`, `evidenceSealed: true`, a nonzero `evidenceSealedAt`, and the buyer as `evidenceSealedBy`. Require `get_review_context` to return `ready: true` and a context hash that equals `get_case.reviewContextHash`.
- Verify the context JSON SHA-256, the independent binding fields (`chainId`, `contractAddress`, `caseId`, `epoch`, `profileHash`, `releaseDigest`, `subjectOrigin`), and screenshot URI/hash before requesting review. The canonical context cannot exceed 16,384 UTF-8 bytes; the manifest-bound PNG cannot exceed 16,384 raw bytes.
- `request_review` is permissionless after the authoritative sealed/context-ready readback. It cannot repair missing or invalid evidence. If it fails, retain the actual error and current readback; do not invent a verdict or transaction.

## Review outcomes

- For an accepted review transaction, wait for `get_review_finality` status `FINALIZED`, then read `get_review` and `get_review_attempt` for the exact case, epoch, and attempt.
- `APPROVED` authorizes `prepare_payout` only after that finality readback. `REJECTED` authorizes `prepare_refund` only after it. `REQUEST_MORE_INFO` and `UNRESOLVED` never authorize a payout.
- `REQUEST_MORE_INFO`: only the vendor can call `start_cure`; it creates a new epoch/replay domain. Submit a new complete V4 evidence set. Never copy old envelopes/nonces into the cure epoch.
- `UNRESOLVED`: anyone may call `retry_review` after the cooldown with a unique retry ID and remaining budget. After exhaustion, `expire_unresolved` prepares the buyer refund path. Never reinterpret unresolved evidence as rejection or approval.
- `timeout_refund` is permissionless only when the contract says the hard deadline is eligible. If it fails, keep the readback and wait; do not infer eligibility from a local clock.

## Prepared or dispatched settlement

- Before `execute_settlement`, read the exact prepared settlement ID, recipient, amount, epoch, reason, review proof, and `PREPARED` status from `get_settlement`.
- If dispatch fails before external emission, the same immutable `PREPARED` intent remains retryable. Re-read it and accounting; do not create a new intent or change recipient/amount.
- At `DISPATCHED_FINALIZED`, do not retry dispatch. The contract cannot correlate a child transfer success/failure. Prove recipient delivery separately with an official linked finalized/successful child transaction or exact recipient balance delta; otherwise retain “Recipient confirmation pending.”

## Frozen deployment defect

V4 is `INTENTIONALLY_FROZEN`. Stop new cases on an affected deployment, publish only non-secret facts, and use its encoded cure/retry/timeout/refund/settlement paths. V4 cannot be patched in place.

Any replacement is a new V4-or-later deployment at a new address. V1–V3 state does not migrate into V4, and V4 state does not migrate automatically into a replacement: never copy case IDs, evidence, nonces, review proofs, settlement IDs, custody, or balances. Users explicitly opt into a new case after independently verified deployment readback.

## Local boundary

Localnet and Bradbury GEN are simulated testnet value. GLSim can prove V4 contract transitions, consensus, and accounting, but it cannot prove external EOA child delivery. Local addresses and transaction hashes under `work/` are ephemeral and are not live deployment, payment, or recipient-receipt evidence.

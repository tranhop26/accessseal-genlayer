# AccessSeal recovery runbook

Use this runbook when the UI and wallet do not show an unambiguous finalized result. Never infer success from a button click, optimistic state, or an `ACCEPTED` transaction.

## First response for every incident

1. Record the network, contract address, case ID, wallet address/role, transaction hash if available, and the action attempted. Do not record secrets.
2. Confirm the wallet is connected to the configured exact network.
3. Query the transaction until it is final or the client reports an explicit undetermined/error state.
4. Read `get_case`, `get_review`/`get_review_finality`, `get_settlement`, and `get_accounting` at `latest-final` as applicable.
5. Treat contract readback as authoritative. Refresh/reconcile the UI before taking another write action.
6. Verify conservation: `totalDeposits = reserved + pendingDispatch + dispatchedPayouts + dispatchedRefunds`.

## Early evidence seal and immediate review

- Only the buyer may call `close_evidence(caseId)`. Before doing so, read `get_case` and `get_evidence(caseId, epoch)` at `latest-final`.
- The current epoch must be `EVIDENCE_OPEN`, before the hard deadline, and contain exactly the six fresh required types: `RELEASE_MANIFEST`, `HTML_BUNDLE`, `SCREENSHOT`, `DOM_FACTS`, `SCANNER_REPORT`, and `CRITICAL_FLOW_TRACE`. Every envelope must still be unexpired.
- A finalized successful seal must read back as `lifecycle=EVIDENCE_SEALED`, `evidenceSealed=true`, a nonzero `evidenceSealedAt`, and `evidenceSealedBy` equal to the buyer. Also retain the `epoch`, `evidenceDeadline`, and `hardDeadline` readback values.
- After that authoritative readback, an eligible reviewer may request review immediately. A seal is not an approval, protocol or review finality, payout/refund finality, or settlement; wait for the separate review and finality/readback steps.
- Treat `only the buyer can close evidence`, `evidence is not open`, `case hard deadline has expired`, `evidence profile is incomplete`, and `evidence profile contains expired evidence` as failed seal attempts. Do not infer a seal from the submitted transaction alone.
- If no early seal is available, use the cutoff fallback: wait until the evidence cutoff has passed, then request review if the hard deadline has not expired. Before then, `request_review` fails with `review is not eligible before the evidence cutoff`.

## Pending, accepted, or undetermined transaction

- `PENDING` and `ACCEPTED` are not final. Do not submit a dependent action or assume value moved.
- If polling times out, label the result `UNDETERMINED`; retain the transaction hash and reconcile later.
- After `FINALIZED`, require successful execution and then read the exact contract state. A finalized failed execution did not perform the requested transition.
- If the wallet lost its local transaction binding, import the case ID and inspect authoritative state. Do not fabricate a transaction hash.

## Review and protocol appeal

- Do not prepare settlement while the originating review transaction is accepted/appealable or an appeal is active.
- Protocol appeal calls require the original review transaction ID. The contract stores attempt proof/finality records but does **not** store the transaction hash or appeal transaction history.
- The frontend stores a structured local binding containing chain, network, contract, case, epoch, release/proof, and decoded method arguments. It removes stale or mismatched bindings and disables appeal when provenance cannot be proven.
- If the correct review transaction ID cannot be recovered from the wallet/explorer, fail closed. Do not use an unrelated transaction.
- After the appeal reaches finality, re-read the case, current review, finality, settlement, and accounting before enabling settlement.

## `REQUEST_MORE_INFO`

- Only the vendor may start the single bounded cure.
- Cure increments the epoch and creates a new evidence/replay domain. Never reuse old epoch envelopes or nonces.
- Submit a complete new manifest and mandatory artifacts, then request a new review.
- Historical attempt evidence remains available through `get_review_attempt`.

## `UNRESOLVED`

- No settlement is eligible and no value may move.
- Anyone may retry after the fixed cooldown while retry budget remains and no active finality is pending. Use a unique retry ID.
- If the retry budget/recovery period is exhausted, use `expire_unresolved` to prepare the deterministic buyer refund path.
- If sources are unstable, preserve the failure evidence; do not reinterpret it as rejection or approval.

## Hard timeout

- `timeout_refund` is permissionless only after the contract's hard deadline and only when no active review/finality blocks it.
- The contract does not expose case `createdAt`. The frontend therefore cannot independently calculate eligibility and intentionally fails closed; submit only when authoritative contract rules allow it.
- A successful timeout action prepares an immutable buyer refund intent. Read it back before dispatch.
- A replay after the first timeout transition must fail without changing the settlement or accounting.

## Deterministic failure before dispatch emission

- If `execute_settlement` fails before the external message is emitted, authoritative settlement remains the same `PREPARED` intent.
- Re-read recipient, amount, settlement ID, status, and accounting. If all are unchanged and the cause is corrected, anyone may retry the exact same intent.
- Never prepare a second intent and never alter recipient/amount. Reserve must not be debited twice.

## `DISPATCHED_FINALIZED` but recipient unconfirmed

- Do **not** retry `execute_settlement`: the contract terminal state prevents double dispatch.
- This state proves the finalized parent emitted a finality-only EOA transfer. It does not prove the child transaction succeeded or the recipient balance changed.
- Use an authoritative GenLayer client to bind the parent `execute_settlement(caseId, settlementId)` transaction to its exact external message and triggered child transaction. Require parent and child `FINALIZED`/successful status, correct contract/recipient/amount, or independently prove the exact recipient balance delta.
- If the network cannot expose a linked child or balance delta, keep the UI at “Recipient confirmation pending” and omit the final payout/refund proof row.
- GenVM v0.2.16 gives the contract no correlated child success/failure callback. There is no safe automatic child-failure retry. Escalate operationally and document the unresolved delivery; do not claim settlement receipt.

## Frozen-contract defect or migration

AccessSeal is `INTENTIONALLY_FROZEN`. There is no administrator, upgrade key, code replacement, verdict override, or rescue redirection.

1. Stop creating/funding new cases on the affected deployment.
2. Publish the exact affected network, address, source/schema hashes, and limitation without exposing secrets.
3. Allow existing cases to use only their encoded cure/retry/timeout/refund/settlement paths.
4. Build and review V3 as a new contract with a new address and manifest.
5. Require each user to opt into a new V3 case. Do not claim automatic storage/balance migration from V2.
6. Update the frontend only after exact V3 source/schema/deployment readback is proven.

### Frozen V2 to V3 recovery boundary

- The V2 address is immutable. Do not describe the V2 deployment as fixed, patched, upgraded, or repaired in place.
- A V2 case whose final review is `UNRESOLVED` may keep its remaining final retry available, or exhaust that retry under the encoded rules. After the recovery budget is exhausted, `expire_unresolved` prepares the deterministic buyer-refund path; it does not repair the review or move the case to V3.
- V3 is a separately deployed contract at a new address with a new evidence replay domain. New V3 evidence must be opened, bound, and reviewed under the V3 address/domain.
- Never copy V2 contract state, case IDs, proof IDs, settlement IDs, evidence nonces, or settlement records into V3. A user who opts in creates a new V3 case and receives only the recovery paths encoded by each deployment.

## Bradbury deployment rejected before wallet confirmation

- Read the Studio/browser RPC error before retrying. `BlockPubdataLimitReached` means the deployment payload exceeds the chain's block pubdata boundary; changing gas, wallet, or CLI does not bypass it.
- Run `npm run contract:check` and confirm the tracked artifact is at most 48,000 UTF-8 bytes. Never manually shorten the artifact or remove contract rules.
- Require GenVM lint, exact readable/artifact schema parity, and the complete direct suite against the artifact before one new deployment attempt.
- If Bradbury rejects a verified in-budget artifact, stop. Record the observed size/error and revisit packaging; do not repeatedly submit transactions or weaken the trust model.

## Local GLSim boundary

GLSim 0.29.2 can prove five-validator consensus, parent transaction finality, contract state, accounting, and replay rejection. It cannot execute/prove the pure EOA child delivery and may leave the simulator's terminal dispatch state visible after the missing host operation. Any address and transaction under `work/evidence` or `work/deployments/localnet.json` is local, ephemeral, and not Studionet/testnet evidence.

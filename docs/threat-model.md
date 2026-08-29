# AccessSeal V4 threat model

## Assets and guarantees

The protected assets are the case terms, six-item evidence epoch, canonical review context, verdict/finality records, escrow accounting, and immutable settlement intent. The Intelligent Contract—not a wallet, frontend, prompt, or operator—decides their state. V4 is `INTENTIONALLY_FROZEN`; V1–V3 state does not migrate.

| Threat actor / action | Contract boundary | V4 mitigation | Direct/integration proof |
|---|---|---|---|
| Vendor submits malformed, stale, replayed, cross-origin, or mismatched evidence | `open_evidence`, `append_evidence` | Canonical envelope, role/type allowlists, freshness, exact case/epoch/chain/contract/origin/profile/release bindings, manifest membership, media and SHA-256 checks | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` |
| Buyer seals incomplete or changed evidence | `close_evidence` | Buyer-only seal; complete fresh six-item profile; exact refetch/hash/schema validation; failure is atomic | `tests/direct/test_review_context.py`, `tests/direct/test_adjudication.py` |
| Origin injects instructions or changes content after seal | `close_evidence`, `request_review` | Canonical context is built before review; all origin data is untrusted; review refetches only the exact hash-bound PNG | `tests/direct/test_adjudication.py`, `tests/direct/test_prompt_parity.py` |
| Leader/validator disagrees or supplies prose-only variation | `request_review` | Independent evaluation and equality of verdict, sorted blockers, sorted missing evidence, profile/release/context hashes, and evidence refs; rationale excluded | `tests/direct/test_adjudication.py`, `tests/integration/test_consensus_flow.py` |
| Caller requests a phase-ineligible review or settlement | `request_review`, `prepare_payout`, `prepare_refund`, `execute_settlement` | Sealed/context-ready/current epoch, hard-deadline and finalized-review checks; immutable settlement ID and exact recipient/amount | `tests/direct/test_adjudication.py`, `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py` |
| Anyone tries to move funds from `UNRESOLVED`/RMI | `retry_review`, `expire_unresolved`, `start_cure` | No payout before final `APPROVED`; retry/cure budgets and deterministic refund exits | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py` |
| UI treats a submitted wallet transaction as success | Frontend reconciliation | UI waits for final transaction status and authoritative readback; it neither auto-signs nor auto-resubmits | `frontend/e2e/happy-path.spec.ts`, `frontend/e2e/recovery.spec.ts` |
| Deployment/operator supplies stale source, a fake address, or a mutable manifest | deployment/verification tools | Clean-head, deterministic artifact, exact schema/source/code/accounting verification; V4 manifest namespace and frozen classification | `tests/scripts/deploy.test.ts`, `tests/integration/test_deployment_scripts.py` |

## Bounded-context and model risks

The review context is limited to 16,384 UTF-8 bytes and the exact PNG to 16,384 raw bytes. The close step also enforces 16,384-byte manifest/JSON limits, 32,768-byte HTML, and 131,072 total artifact bytes. In `request_review`, each node makes zero manifest/HTML/DOM/scanner/flow fetches, at most one image fetch, and exactly one AI evaluation. This limits repeated-source races and prompt surface, but does not make AI accessibility evaluation universally reliable.

`APPROVED` requires complete, hash-bound evidence and no material blocker. `REQUEST_MORE_INFO` is for curable incompleteness. Unavailable, malformed, stale, contradictory, oversized, or mismatched proof, invalid output, and semantic disagreement fail safely as `UNRESOLVED` or a rejected operation; they never authorize payout.

## Residual risks and operating controls

- GenVM buffers web responses before the contract can enforce post-fetch limits and does not provide a contract-configurable timeout.
- Static artifacts cannot cover personalized, authenticated, CAPTCHA-protected, highly dynamic, or cross-origin-heavy releases.
- `DISPATCHED_FINALIZED` proves parent dispatch only. An operator must separately prove a linked finalized/successful child transfer or recipient balance delta before claiming receipt.
- Localnet and Bradbury value are simulated testnet value. Local GLSim addresses, transactions, and evidence are not live proof.
- Before a push, deployment, or Vercel production release, the operator must perform a fresh action-time identity check and obtain explicit user confirmation. Credentials remain process environment only and must never be committed.

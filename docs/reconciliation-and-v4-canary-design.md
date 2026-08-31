# AccessSeal reconciliation and V4 canary design

**Date:** 2026-08-31

**Status:** Approved for planning
**Contract:** V4, intentionally frozen, `0xa485edc97f5acd071a3dc793a790ac50d7a58df6` on Bradbury (`4221`)

## Problem and decision

The production case page can remain on `Reconciling…` and display zero evidence after the hard evidence cutoff even though finalized contract readback contains evidence. Browser diagnostics reproduced repeated GenLayer reads after cutoff. The deadline effect computes a one-second delay whenever `readAt` is already at or beyond `evidenceCutoff`, so a new refresh generation invalidates slower evidence reads before they can update the UI.

The fix will stop automatic deadline refreshes once authoritative `readAt >= evidenceCutoff`. Before the cutoff, the page will retain one condition-based refresh scheduled for the first second after the cutoff. Manual `Refresh readback` remains available. The contract, evidence schema, custody logic, and transaction methods will not change.

## Considered approaches

1. **Stop the deadline timer after authoritative cutoff (selected).** This is the smallest root-cause fix. It preserves the intended one-time cutoff reconciliation without continuous RPC load.
2. Add a fixed polling interval with request cancellation. This would mask the race but continue unnecessary reads and increase Bradbury/RPC dependency.
3. Split every case section into independent background queries. This could improve resilience later, but it is a larger architectural change than this regression requires.

## Trust and authority

| Actor | Cannot trust | Manipulation capability | Defense and proof |
|---|---|---|---|
| Buyer/vendor | Frontend timing and cached state | Reload, switch wallet, or act while a read is pending | Material state comes only from finalized contract readback; the timer cannot advance lifecycle state |
| Frontend | Local clock | Schedule early, late, or repeated refreshes | Scheduling uses authoritative `readAt` and `evidenceCutoff`; post-cutoff refresh is disabled |
| Reviewer | A locally displayed evidence count | UI may be stale or interrupted | Evidence count and envelopes come from `get_evidence`; regression and browser tests verify render after reconciliation |
| Any participant | Previous case evidence | Reuse URLs or envelopes across a new case | The new bundle binds chain, contract, case, epoch, release digest, timestamps, nonces, and hashes |

GenLayer continues to establish whether the bounded six-item release evidence satisfies the fixed accessibility rubric. A finalized verdict controls the contract's payout/refund eligibility. `REQUEST_MORE_INFO` and `UNRESOLVED` remain non-payout outcomes.

## Frontend behavior

- Initial page load performs one authoritative reconciliation.
- While the contract clock is before cutoff, one timer is scheduled for `cutoff - readAt + 1` seconds, capped at 60 seconds as today.
- Once authoritative `readAt` reaches or exceeds cutoff, no deadline timer is created.
- Evidence readback may complete without being invalidated by a one-second refresh loop.
- Loading, error, success, wallet-role, transaction-finality, and manual retry states remain distinct.
- No transaction is automatically signed, retried, or submitted.

## TDD and verification

The regression test must first fail against current production code and demonstrate that a post-cutoff `EVIDENCE_OPEN` readback does not schedule repeated reconciliation. The expected behavior is derived from literal cutoff/readback timestamps. The implementation will then make the smallest change needed to pass.

Verification includes the focused regression, complete frontend tests, direct tests, integration tests, script tests, lint, typecheck, production build, contract artifact check, evidence verification, and secret audit. Browser verification must confirm that the production case no longer stays in `Reconciling…` and renders the authoritative evidence count.

## New V4 canary workflow

After the frontend fix is merged and deployed with action-time confirmation:

1. Create a fresh V4 case using the existing verified contract.
2. Record finalized create readback before generating any case-bound evidence.
3. Generate and publish a new six-file release bundle bound to the exact case, epoch, chain, contract, origin, timestamps, hashes, and release digest.
4. Submit all six evidence envelopes and verify each finalized receipt and cumulative `get_evidence` readback.
5. Close evidence before the hard deadline and verify the authoritative seal/context readback.
6. Request intelligent review and wait for both parent and internal protocol finality.
7. If and only if the finalized verdict is `APPROVED`, prepare payout and execute settlement. Other verdicts remain truthful terminal/non-payout outcomes.
8. Verify `DISPATCHED_FINALIZED`, accounting conservation, and the final case lifecycle when payout is authorized.

Every GitHub push, Vercel production deployment, and wallet transaction requires a separate action-time identity check and user confirmation. A validator outcome is never predeclared or rewritten.

## Completion evidence

The submission package will record the exact source/merge commits, CI results, Vercel deployment ID, contract address, case ID, release digest, six evidence transactions, seal transaction, review/finality proof, settlement transactions when authorized, authoritative readbacks, and known limitations. A short demo video is useful but not a substitute for the proof matrix.

# AccessSeal proof status

This tracked document defines the required final evidence; it does not claim that external publication/deployment gates have run. The canonical completed matrix will be generated as an atomic two-file package at `work/evidence/final/proof-matrix.md` by `npm run proof:collect -- --network <network>` only after independent publication, chain, readback, and command verification succeeds.

## External identifiers

| Item | Current status |
|---|---|
| Public GitHub repository/commit | Not claimed — GitHub identity and push confirmation gate pending |
| External GenLayer contract/address | Not claimed — deployment wallet and action-time confirmation gate pending |
| Deployment transaction/explorer | Not claimed — external deployment/readback pending |
| Vercel URL | Not claimed — Vercel account/team/project and action-time confirmation gate pending |

Addresses and transactions in ignored `work/deployments/localnet.json` or `work/evidence/*` are ephemeral **local GLSim evidence only**. They are not external contract or recipient-delivery proof.

## Required final matrix

| Proof | Actor | Action | Contract method | Transaction hash | `FINALIZED` / execution | Authoritative readback | Transfer state | Recipient confirmation | Source/test |
|---|---|---|---|---|---|---|---|---|---|
| Payout | Unrelated public settler(s) | Prepare and dispatch approved vendor payout | `prepare_payout`, `execute_settlement` | Two pending external hashes | Pending | Exact case actors, executor, settlement/accounting | Must be `DISPATCHED_FINALIZED` | Separate linked child success required | `scripts/glsim_support.py`, `tests/integration/test_harness_controls.py` |
| Refund | Unrelated public settler(s) | Prepare and dispatch rejected buyer refund | `prepare_refund`, `execute_settlement` | Two pending external hashes | Pending | Exact case actors, executor, settlement/accounting | Must be `DISPATCHED_FINALIZED` | Separate linked child success required | `scripts/glsim_support.py`, `tests/integration/test_harness_controls.py` |
| RMI cure | Vendor, then public reviewer | Start new epoch and finalize cured review | `start_cure`, `request_review` | Pending external proof | Pending | Epoch increment, old attempt preserved, new verdict | `NO_TRANSFER` during RMI | Not applicable | `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` |
| Unresolved | Public reviewer | Unavailable/conflicting source produces safe result | `request_review` | Pending external proof | Pending | `UNRESOLVED`, accounting unchanged | `NO_TRANSFER` | Not applicable | `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` |
| Replay rejection | Unrelated caller | Repeat timeout/settlement/evidence domain | Relevant guarded method | Pending external proof | Finalized expected failure required | Exact before/after state unchanged | `NO_TRANSFER` | Not applicable | direct/integration/browser replay regressions |
| Frozen classification | Deployment verifier | Verify exact reviewed schema and no privilege | Deployment/readback | Pending external proof | Deployment must finalize successfully | Exact source/schema hash and frozen method surface | `NO_TRANSFER` | Not applicable | `deploy/999_verify_access_seal.ts`, `tests/scripts/deploy.test.ts` |

## Collector acceptance gate

The final collector requires:

- clean current `HEAD`, verified public GitHub commit, and identical published contract bytes;
- exact tracked contract byte hash, deployed/source-derived schema hash, and frozen interface;
- pinned-SDK network identity and official HTTPS RPC/explorer URL (Studionet explorer: `https://genlayer-explorer.vercel.app`), finalized successful deployment, and exact address/accounting readback;
- Vercel API production/commit/URL binding plus a reachable AccessSeal response;
- actual collector-run root lint (contract plus prompt), separate `genvm-lint schema --json` frozen-schema binding, root typecheck, direct, integration, root scripts, frontend lint/typecheck/unit/build, two E2E runs, and secret scan with exact suite counts/output hashes;
- typed row-specific evidence: two transactions for RMI cure; one successful review plus absence of settlement for unresolved; one finalized failed call plus preserved settlement for replay; deployment/source/schema readback for frozen classification;
- pinned-SDK decoded payout/refund parent calls, exact returned hashes and senders, authoritative buyer/vendor actor exclusion, settlement executor binding, one exact external message, official triggered-child linkage, child finality/success, recipient/lossless decimal-string amount binding, settlement readback, and accounting conservation;
- typed live-child/deployment-verifier provenance plus every fixed source/test reference contained in the repository and bound to its exact tracked `HEAD` blob;
- a final clean-HEAD/commit/contract/schema/blob recheck after commands and immediately before atomic installation;
- explicit simulated-value and `DISPATCHED_FINALIZED` limitations.

The input is locator-only. Caller-authored status, readback, balance, or `PASS` fields are rejected by the exact schema and cannot become evidence. Placeholders, failed/missing checks, dirty source, non-final transactions, wrong methods/arguments, publication or chain mismatches, non-conserving accounting, unlinked child delivery, symlink/untracked references, or partial output installation cause collection to fail while preserving the prior proof pair.

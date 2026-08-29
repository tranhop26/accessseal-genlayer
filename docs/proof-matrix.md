# AccessSeal V4 proof matrix

This is the required public/local proof plan. It does not claim any external action. The authoritative final package, if separately collected after confirmed publication/deployment, is ignored local output under `work/evidence/final/`.

## Live-evidence slots

| Evidence slot | Current value |
|---|---|
| V4 contract address | Not yet executed |
| V4 deployment transaction | Not yet executed |
| Vercel production URL | Not yet executed |
| Payout transaction(s) | Not yet executed |
| Refund transaction(s) | Not yet executed |
| Recipient child transaction / balance proof | Not yet executed |

Any localnet/Bradbury amount is simulated testnet value. Ignored `work/` artifacts are local GLSim evidence only and cannot fill a live-evidence slot.

## Required actor/action proof

| Actor | Action and exact method | Direct/integration proof | Required authoritative readback | Live evidence |
|---|---|---|---|---|
| Buyer | Create/fund: `create_case`, `fund` | `tests/direct/test_case_lifecycle.py`, `tests/integration/test_consensus_flow.py` | `get_case`, `get_accounting` | Not yet executed |
| Vendor | Accept locked terms: `accept_terms` | `tests/direct/test_case_lifecycle.py`, `tests/integration/test_consensus_flow.py` | `get_case` | Not yet executed |
| Vendor | Submit exact epoch: `open_evidence`, `append_evidence` | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` | `get_evidence` | Not yet executed |
| Buyer | Seal bounded context: `close_evidence` | `tests/direct/test_review_context.py`, `tests/direct/test_adjudication.py` | `get_case`, `get_review_context` | Not yet executed |
| Permissionless reviewer | Request bounded review: `request_review` | `tests/direct/test_adjudication.py`, `tests/integration/test_consensus_flow.py` | `get_review`, `get_review_attempt`, `get_review_finality` | Not yet executed |
| Vendor | Cure RMI: `start_cure` | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` | New epoch and preserved old attempt | Not yet executed |
| Permissionless reviewer | Review cured epoch: `request_review` | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` | Final review/finality for new epoch | Not yet executed |
| Permissionless reviewer | Retry/exhaust unresolved: `retry_review`, `expire_unresolved` | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py` | Finality/retry budget, refund preparation, accounting | Not yet executed |
| Permissionless settler | Approved payout: `prepare_payout`, `execute_settlement` | `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/happy-path.spec.ts` | Finalized approved review; `get_settlement`; `get_accounting` | Not yet executed |
| Permissionless settler | Rejected refund: `prepare_refund`, `execute_settlement` | `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/happy-path.spec.ts` | Finalized rejected review; `get_settlement`; `get_accounting` | Not yet executed |
| Permissionless caller | Timeout/replay boundary: `timeout_refund`, `prepare_payout`, `prepare_refund`, `execute_settlement`, `retry_review` | `tests/direct/test_recovery.py`, `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` | Exact pre/post case, review, settlement, accounting | Not yet executed |
| Deployment verifier | V4 frozen deployment: deployment and `verify:deployment` | `tests/scripts/deploy.test.ts`, `tests/integration/test_deployment_scripts.py` | Code, schema, accounting, finalized execution, V4 manifest | Not yet executed |

## Local verification record

The complete local suite is:

```powershell
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

The suite demonstrates local behavior and regression coverage; it is not a substitute for the explicit live slots above. A live proof package must bind an exact clean commit, V4 compact/readable source hashes, frozen schema, finalized successful deployment, Vercel production/commit response, decoded method calls, `latest-final` contract reads, accounting conservation, and (for a payout/refund) recipient delivery proof. No caller-authored “PASS”, placeholder, address, transaction, verdict, or balance field may become proof.

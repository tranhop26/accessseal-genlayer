# AccessSeal V4 proof matrix

This is the public claim-to-proof map for the verified V4 release. It links only to finalized receipts, authoritative `latest-final` readbacks, and public production artifacts. The copy-ready evidence record is [docs/submission-evidence.md](submission-evidence.md); ignored `work/` artifacts remain local-only and are not presented as public proof.

## Live-evidence slots

| Evidence slot | Current value |
|---|---|
| V4 contract address | `0xa485edc97f5acd071a3dc793a790ac50d7a58df6` on GenLayer Bradbury (`testnet_bradbury`, chain `4221`) |
| V4 deployment transaction | [`0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04`](https://explorer-bradbury.genlayer.com/tx/0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04) — `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` |
| Vercel production URL | [https://accessseal-genlayer.vercel.app](https://accessseal-genlayer.vercel.app), V4 config HTTP 200; merge commit `6998b1d6dfa8035430720d5b1813725e3fe272ab`; deployment `dpl_9RBfyNfVvXCYjxdXBkvpPeLj2Ko5` |
| Live V4 case | `0x9e75a4720ffd577aafbecbce47fd6f605659c3dbfc35fa31390bc9743eafbff7`; Buyer `0x21b45103dd05c43969daf3cbb4277391777e2ec7`; Vendor `0x35c9979d30992b13ef6df7036bc745e2e1cd76a2`; authoritative lifecycle `EVIDENCE_OPEN` |
| Evidence cutoff / authoritative count | `2026-08-30 20:19:20 +07:00`; exactly `4/6` (`RELEASE_MANIFEST`, `HTML_BUNDLE`, `SCREENSHOT`, `DOM_FACTS`) after cutoff |
| Payout transaction(s) | Not executed on the live V4 case |
| Refund transaction(s) | Not executed on the live V4 case |
| Recipient child transaction / balance proof | Not executed on the live V4 case |

Any localnet/Bradbury amount is simulated testnet value. Ignored `work/` artifacts are local GLSim evidence only and cannot fill a live-evidence slot.

## Required actor/action proof

| Actor | Action and exact method | Direct/integration proof | Required authoritative readback | Live evidence |
|---|---|---|---|---|
| Buyer | Create/fund: `create_case`, `fund` | `tests/direct/test_case_lifecycle.py`, `tests/integration/test_consensus_flow.py` | `get_case`, `get_accounting` | `create_case` [`0x0a72818263e7c80ded0f6a5b3addb72a179fb905c9f887c103f6ba22242c551d`](https://explorer-bradbury.genlayer.com/tx/0x0a72818263e7c80ded0f6a5b3addb72a179fb905c9f887c103f6ba22242c551d) and `fund` [`0x4e6b2d004df0ba3628114315bb149d49dea52dbe55e2a46be4b6505a79ab1bbb`](https://explorer-bradbury.genlayer.com/tx/0x4e6b2d004df0ba3628114315bb149d49dea52dbe55e2a46be4b6505a79ab1bbb), both `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; latest-final escrow/reserved `100000000000000` / `100000000000000` simulated GEN |
| Vendor | Accept locked terms: `accept_terms` | `tests/direct/test_case_lifecycle.py`, `tests/integration/test_consensus_flow.py` | `get_case` | [`0x1f0358b85ccdb4c071f77e67168b22c307aec65a5a723f4c5a009b167d89f96c`](https://explorer-bradbury.genlayer.com/tx/0x1f0358b85ccdb4c071f77e67168b22c307aec65a5a723f4c5a009b167d89f96c), `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; latest-final `vendorAccepted=true`, lifecycle `EVIDENCE_OPEN` |
| Vendor | Submit exact epoch: `open_evidence`, `append_evidence` | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` | `get_evidence` | Evidence 1–4 are listed below; all four receipts are `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; latest-final epoch `0` has exactly `4/6` records |
| Vendor | Evidence 1: `open_evidence` | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` | `get_evidence(caseId, 0)` | [`0x48557d4429256d6579fe9553c7143b13d5840ea4773bf4add36595bc64ad3f48`](https://explorer-bradbury.genlayer.com/tx/0x48557d4429256d6579fe9553c7143b13d5840ea4773bf4add36595bc64ad3f48), `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; `RELEASE_MANIFEST`, `sha256:6b4753f10a64937af4851d309f76a848d89ab629ffc890ff82f2db25f4b47fca` |
| Vendor | Evidence 2: `append_evidence` | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` | `get_evidence(caseId, 0)` | [`0x96528d58c18072498ff3899f135afce75b00427b99c23388183cc65968d2d692`](https://explorer-bradbury.genlayer.com/tx/0x96528d58c18072498ff3899f135afce75b00427b99c23388183cc65968d2d692), `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; `HTML_BUNDLE`, `sha256:8428325b4dc273654d72e70efc86be12a379dd40d77ec0555b337cbeb93a58f5` |
| Vendor | Evidence 3: `append_evidence` | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` | `get_evidence(caseId, 0)` | [`0x41b5082374220a1d29290409c4dd6280189265a801981ade38b6fbce93ecb234`](https://explorer-bradbury.genlayer.com/tx/0x41b5082374220a1d29290409c4dd6280189265a801981ade38b6fbce93ecb234), `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; `SCREENSHOT`, `sha256:3218856363c65a21b28f9e787a6ffb5490f246c4a74accec908d8ec8cd6be42d` |
| Vendor | Evidence 4: `append_evidence` | `tests/direct/test_evidence.py`, `tests/direct/test_review_context.py` | `get_evidence(caseId, 0)` | [`0x52c0351b322a4c66c513a8c9506bac9d6294e3fe00a812f08cf50fb806e60af1`](https://explorer-bradbury.genlayer.com/tx/0x52c0351b322a4c66c513a8c9506bac9d6294e3fe00a812f08cf50fb806e60af1), `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; `DOM_FACTS`, `sha256:c91ea3720280e1c5ccdeb433aa0a61493819f72f6b7fcafc4debbaddfd6f931c` |
| Buyer | Seal bounded context: `close_evidence` | `tests/direct/test_review_context.py`, `tests/direct/test_adjudication.py` | `get_case`, `get_review_context` | Not executed on the live V4 case: cutoff expired at authoritative `4/6`; direct/integration tests remain the proof |
| Permissionless reviewer | Request bounded review: `request_review` | `tests/direct/test_adjudication.py`, `tests/integration/test_consensus_flow.py` | `get_review`, `get_review_attempt`, `get_review_finality` | Not executed on the live V4 case: no close/review transaction exists |
| Vendor | Cure RMI: `start_cure` | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` | New epoch and preserved old attempt | Not executed on the live V4 case |
| Permissionless reviewer | Review cured epoch: `request_review` | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` | Final review/finality for new epoch | Not executed on the live V4 case |
| Permissionless reviewer | Retry/exhaust unresolved: `retry_review`, `expire_unresolved` | `tests/direct/test_recovery.py`, `tests/integration/test_recovery_flow.py` | Finality/retry budget, refund preparation, accounting | Not executed on the live V4 case |
| Permissionless settler | Approved payout: `prepare_payout`, `execute_settlement` | `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/happy-path.spec.ts` | Finalized approved review; `get_settlement`; `get_accounting` | Not executed on the live V4 case |
| Permissionless settler | Rejected refund: `prepare_refund`, `execute_settlement` | `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/happy-path.spec.ts` | Finalized rejected review; `get_settlement`; `get_accounting` | Not executed on the live V4 case |
| Permissionless caller | Timeout/replay boundary: `timeout_refund`, `prepare_payout`, `prepare_refund`, `execute_settlement`, `retry_review` | `tests/direct/test_recovery.py`, `tests/direct/test_settlement.py`, `tests/integration/test_recovery_flow.py`, `frontend/e2e/recovery.spec.ts` | Exact pre/post case, review, settlement, accounting | Not executed on the live V4 case |
| Deployment verifier | V4 frozen deployment: deployment and `verify:deployment` | `tests/scripts/deploy.test.ts`, `tests/integration/test_deployment_scripts.py` | Code, schema, accounting, finalized execution, V4 manifest | [`0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04`](https://explorer-bradbury.genlayer.com/tx/0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04), `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`; contract `0xa485edc97f5acd071a3dc793a790ac50d7a58df6`; artifact `3bd9a8713791ceb011e8bb6f557950aa54938cba76b2c37f31ae77044d8750f8`, readable `42d7d94983357af0eb818f31f76327cfef1f52fd71462e7178dbd5de637c0fcf`, schema `a979c17948f12d349c9e06d4e167881252931fe7459e1a805ae39c3176dd2da0` |

## Exact live-case limitation

Case `0x9e75a4720ffd577aafbecbce47fd6f605659c3dbfc35fa31390bc9743eafbff7` was created at `1788009560` with an `86400` second evidence deadline. Its authoritative cutoff was `1788095960`, or `2026-08-30 20:19:20 +07:00`; the latest observed chain time was `1788135006`. Because the cutoff expired after four finalized records, any later Evidence 5 or Evidence 6 append is rejected by the contract with `evidence submission deadline has expired`. The live case therefore has no close, review, payout, or settlement proof.

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

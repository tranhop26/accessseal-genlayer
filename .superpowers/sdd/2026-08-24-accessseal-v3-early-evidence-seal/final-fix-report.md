# AccessSeal V3 final-fix report

## Takeover context

This fix wave was taken over after the previous agent reached its model quota. The five existing RED test files were preserved, inspected, and used as the starting point; production code was then changed only after their failures were confirmed.

## Root causes and RED evidence

- Deployment metadata used a mutable network-only manifest path, could overwrite V2 evidence, and did not test the real deploy path's destination preflight. The focused deploy suite initially had 25 passing and 5 failing tests.
- `get_case` omitted authoritative creation/cutoff/readback times. Focused direct tests had 2 failures and focused integration had 1 failure.
- The frontend accepted only a current `EVIDENCE_SEALED` tuple and had no strict V3 clock schema or boundary behavior. Its library suite initially had 10 passing and 15 failing tests; the case-detail suite had 23 passing and 7 failing tests.
- The expired-evidence recovery copy implied that replacement was possible in the current epoch, although the contract's duplicate rules require a bounded cure/new epoch path or timeout.

## Changes

- V3 manifests are now version-, artifact-hash-, and deployed-address-qualified at `work/deployments/<network>/v3/<artifact-sha256>/<address>.json`. The deploy script validates inputs and preflights the V3 source-qualified destination directory before `deployContract`, retains V2 manifests unchanged, and has direct script regression coverage.
- The verifier and proof collector resolve V3 manifests by an explicit address across retained V3 source-hash directories, while the no-address path remains deterministic and fail-closed. README verification guidance documents the V3 path and address input.
- `get_case` now returns `createdAt`, absolute `evidenceCutoff`, and finalized-view `readAt`; the terms-hash domain was not changed. The generated deploy artifact was rebuilt only through the builder.
- Frontend parsing distinguishes exact legacy V2 from exact V3, rejects malformed V3 clock/seal fields, keeps a valid post-seal tuple authoritative for reconciliation/display, and limits immediate review action to `EVIDENCE_SEALED`.
- Review eligibility uses the finalized contract clock: unsealed evidence is disabled before and at cutoff, enabled only strictly after it, and never enabled at the hard deadline. The UI shows the contract-clock state/countdown and refreshes it. DECIDED/reload race coverage retains historical seal display without enabling stale review actions.
- Recovery copy now accurately describes duplicate rejection, the bounded cure/new-epoch path, and strict-after-deadline timeout availability.

## Artifact parity

- Artifact bytes: `46409` (under the 48 KB limit)
- Artifact SHA-256: `5a85e5b77793d54af8ca68529409e670f66ead6bce8c5f63c734db88a2e29113`
- Readable artifact SHA-256: `17e079c3a36d0a4dc1aa95adff8975d246ced7784a7665d8391b94348d01ae9d`
- `npm run contract:check` passed with these exact values.

## Verification

- Focused deploy and orchestration scripts: 34 passed.
- Full frontend suite: 16 files, 171 passed.
- Full direct contract suite: 271 passed.
- Full integration suite: 40 passed, 1 skipped because GLSim 0.29.2 lacks the required EthSend/ghost execution support for the Studionet proof case.
- Root lint, root/frontend typechecks, secret scan, artifact check, and safe-config production build all passed.
- `git diff --check` passed and the worktree was clean before this report was written.

## Commit

- `ba26d94 fix: harden AccessSeal V3 evidence seal readback`

## Self-review and remaining concern

The change preserves `INTENTIONALLY_FROZEN`, custody, trust, replay, finality, and recovery constraints; no push, deployment, wallet, or secret operation occurred. The client API supplies the final contract address only with the finalized deployment receipt, so the pre-mutation preflight validates the complete V3 source-qualified parent destination (including containment, type, and writeability) rather than an address file that cannot yet be known; the resulting address-specific manifest is still written atomically and collision-safe after finalization.

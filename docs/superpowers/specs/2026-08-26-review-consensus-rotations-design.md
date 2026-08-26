# AccessSeal Review Consensus Rotations Hotfix

## Context

AccessSeal V3 review transactions execute successfully and repeatedly produce validator outputs, often with an `APPROVED` verdict and no material blockers. The transactions nevertheless terminate at `VALIDATORS_TIMEOUT` after exhausting the GenLayer SDK default of three consensus rotations. The authoritative case therefore remains `EVIDENCE_SEALED` and no review record is written.

## Goal

Increase the chance that the expensive `request_review` intelligent-contract call reaches protocol acceptance without changing the deployed V3 contract, the sealed evidence, verdict semantics, custody rules, or any other write path.

## Design

Extend the frontend contract client write boundary with an optional write configuration containing `consensusMaxRotations`. The generic write helper forwards that option to `genlayer-js`. `requestReview` supplies `consensusMaxRotations: 7`; every other method omits the option and therefore retains the SDK/network default.

This is deliberately scoped to the review call because it performs validator-fetched evidence verification and semantic evaluation. Deterministic lifecycle, evidence, and settlement writes do not need the larger retry budget.

No UI change is required. Existing loading, rejected, timeout, and readback states remain authoritative. The frontend must continue to show the submitted GenLayer transaction hash and must not infer success from an EVM wrapper receipt or validator output alone.

## Data Flow

1. The connected Buyer requests intelligent review.
2. `AccessSealClient.requestReview(caseId)` invokes the internal write helper with `consensusMaxRotations: 7`.
3. The helper forwards the option to `genlayer-js.writeContract` together with the unchanged contract address, method, arguments, and value.
4. The existing transaction monitor follows the returned GenLayer transaction hash.
5. Completion still requires terminal protocol finality and authoritative contract readback.

## Error Handling

- Wallet rejection, wrapper revert, leader timeout, validator timeout, and undetermined receipt states keep their current UI behavior.
- A timeout does not trigger automatic resubmission.
- The user must confirm every new wallet transaction at action time.
- The frontend never treats an `APPROVED` validator payload from a non-final transaction as an on-chain review.

## Tests

Use TDD:

1. Add a failing unit test proving `requestReview` forwards `consensusMaxRotations: 7`.
2. Add or retain a regression assertion proving ordinary write methods do not set the override.
3. Implement the minimal client change.
4. Run contract direct tests, integration tests, frontend tests, lint, build, and secret scan.
5. After production deployment, verify the new wrapper encodes seven rotations and monitor the resulting GenLayer transaction through authoritative RPC/readback.

## Success Criteria

- Only `request_review` receives the seven-rotation override.
- All existing tests and quality gates pass.
- Production serves the hotfix without changing the configured V3 contract address.
- A newly submitted review reaches protocol acceptance/finality and `get_review`/`get_review_finality` return the expected authoritative record before settlement proceeds.

## Non-goals

- Redeploying or modifying the V3 Intelligent Contract.
- Replacing or reopening the sealed evidence set.
- Changing validator prompts, verdict rules, payout rules, or wallet roles.
- Automatically retrying wallet transactions.

# AccessSeal Contract V2 Semantic Review Design

## Objective

Make a valid, hash-bound AccessSeal release capable of reaching a reliable semantic verdict on Bradbury without weakening the safe `UNRESOLVED` default. The fix is limited to the Intelligent Contract review boundary, its validator strategy, deployment artifact generation, and regression coverage. Custody, settlement accounting, actors, evidence binding, and lifecycle semantics remain unchanged.

## Observed production failure

The deployed V1 contract produced the same `UNRESOLVED` rationale commitment for attempts 0 and 1:

`sha256:671a842ebbbf31785c03192b3e6e2d1452515b326e4ad1b913097d9b02fdc2a1`

This is the hash of `review result was malformed, incomplete, or wrongly bound`. All six evidence envelopes were present, fresh, fetched, and hash-bound; no missing evidence or material blockers were recorded. The failure therefore occurs at the model-output-to-contract boundary. Existing tests inject a perfect candidate and do not exercise production-shaped model variability.

## Approaches considered

### A. Retry V1 unchanged

Lowest effort, but it repeats the same prompt, parser, and validator behavior. It risks consuming the final retry budget without addressing the deterministic fallback pattern. Rejected.

### B. Loosen all validation

Accept arbitrary aliases or omit binding checks. This improves liveness but lets model-controlled fields influence replay binding and weakens the trust model. Rejected.

### C. Contract-owned bindings plus semantic validation

Recommended. The model decides only semantic fields. The contract owns all deterministic bindings and validates the semantic answer defensively. Validators assess whether the leader's semantic decision is supported by the exact bound evidence instead of independently regenerating an entire byte-sensitive response.

## Decision and consequence

GenLayer establishes whether the exact bound website release satisfies the fixed AccessSeal accessibility rubric. A finalized `APPROVED` verdict authorizes preparation of the vendor payout. `REJECTED` authorizes refund preparation. Missing proof yields `REQUEST_MORE_INFO`; unavailable, contradictory, malformed, or semantically unsupported proof yields `UNRESOLVED`.

## Trust and evidence invariants

- The vendor cannot select the verdict and may only submit replay-bound evidence envelopes.
- The buyer, frontend, backend, caller, and deployer cannot supply a verdict.
- The model cannot choose or alter `schemaVersion`, `releaseDigest`, `profileHash`, or `evidenceRefs`; the contract writes these fields from authoritative storage.
- Every artifact remains fetched and SHA-256 verified before semantic review.
- Unknown blocker codes, missing-evidence codes, invalid verdicts, empty/oversized rationale, and unsupported semantic claims fail closed.
- Existing freshness, issuer, subject, chain, contract, case, epoch, nonce, and release bindings remain unchanged.

## V2 model boundary

The leader model returns exactly the semantic payload:

```json
{
  "verdict": "APPROVED|REJECTED|REQUEST_MORE_INFO|UNRESOLVED",
  "materialBlockers": [],
  "missingEvidence": [],
  "rationale": "bounded explanation"
}
```

The parser may accept harmless representation differences that do not change meaning, such as normalized verdict casing and known blocker spelling. It must not accept unknown fields that could carry instructions or alternate bindings. The contract constructs the final stored review with contract-owned schema and binding fields.

Every fallback receives a stable diagnostic reason code in addition to the existing safe verdict behavior. The stored public review remains bounded and does not expose raw model prose or untrusted output.

## Validator strategy

Validators receive the leader's normalized final review and the same hash-verified evidence. They perform a semantic support check against the fixed rubric and return a boolean decision. They do not require their own model to regenerate identical rationale, references, or JSON.

Validation must still reject:

- favorable verdicts unsupported by the artifacts;
- omitted material blockers;
- invented blockers or missing-evidence claims;
- wrong release/profile/evidence bindings;
- malformed or non-final review structures.

If semantic support cannot be established, consensus must fail or produce safe `UNRESOLVED`; it must never silently approve.

## Production-shaped tests

TDD starts with failing regressions for:

1. A semantic-only model candidate becomes a fully bound `APPROVED` review.
2. Model attempts to control deterministic bindings are rejected or ignored safely.
3. A validator accepts semantically equivalent leader output despite different rationale wording.
4. A validator rejects an unsupported favorable verdict.
5. Production-shaped `pages[]`, `scans[]`, `flows[]`, and `materialBlockers` evidence is adjudicated correctly.
6. Malformed/unknown semantic fields remain `UNRESOLVED` with a diagnostic reason commitment.
7. Deployment artifact parity and the Bradbury byte budget remain enforced.

A gated Bradbury live-model canary is required before V2 is promoted as a proven happy path. Mock-only integration tests are not sufficient completion evidence.

## Migration and deployment

V2 remains `INTENTIONALLY_FROZEN`. V1 storage and cases are not migrated because there is no privileged upgrade path. Deploy V2 to a new address, point the frontend to that address, and create a new case with new evidence envelopes bound to the V2 address. Preserve the V1 case as an explicit known limitation/recovery proof.

Push, contract deployment, frontend configuration change, Vercel deployment, and wallet transactions each remain behind their existing action-time confirmation gates.

## Success criteria

- New regressions fail against V1 behavior and pass with V2.
- Full direct, integration, frontend, script, lint, typecheck, artifact, and build gates pass.
- V2 deployment artifact is deterministic and within the Bradbury byte limit.
- A real Bradbury review reaches `APPROVED`, then protocol `FINALIZED` with authoritative readback.
- Settlement reaches `DISPATCHED_FINALIZED` only after separate confirmed transactions and recipient/accounting verification.

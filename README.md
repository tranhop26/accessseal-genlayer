# AccessSeal

AccessSeal is a GenLayer application for evidence-bound accessibility acceptance. A buyer and a website vendor lock a review profile, critical user flows, deadlines, and simulated escrow terms. GenLayer validators then fetch the exact release artifacts, verify their hashes, and make a semantic accessibility decision. The frozen Intelligent Contract—not the frontend, buyer, vendor, or an administrator—owns the verdict, recovery eligibility, settlement recipient, amount, and terminal state.

> **Value warning:** all localnet and Studionet GEN shown by this project is simulated test value. AccessSeal is not a payment product, WCAG certification, legal advice, or a substitute for testing with disabled users and assistive technology.

## Current publication status

The repository currently contains complete local implementation and test tooling. A public GitHub repository, external GenLayer deployment, and Vercel production URL are **not claimed here** until their separate identity/confirmation gates have run. Any address under `work/` is an ephemeral **local GLSim address**, not a Studionet/testnet deployment and not reusable after the simulator stops.

## How it works

1. The buyer proposes a vendor, accessibility-profile hash, three critical-flow hashes, release origin, deadlines, retry limit, and simulated escrow amount.
2. The vendor accepts the exact canonical terms. The buyer funds the contract with the exact simulated amount.
3. The vendor opens an evidence epoch with a canonical release manifest and submits exactly six current items: the manifest, HTML, screenshot, DOM facts, scanner report, and critical-flow trace.
4. Before the hard deadline, the buyer may call `close_evidence` only while the epoch is `EVIDENCE_OPEN` and all six items are present and unexpired. The contract records `evidenceSealed`, `evidenceSealedAt`, and `evidenceSealedBy`, then moves the epoch to `EVIDENCE_SEALED`.
5. An eligible reviewer may request review immediately after authoritative sealed readback. Without a seal, review remains unavailable until the evidence cutoff has passed; the hard deadline remains a hard stop.
6. Each GenLayer validator independently fetches the manifest and artifacts, checks same-origin URI policy, byte limits, SHA-256 bindings, media/schema rules, then judges the real bounded content. Website text is untrusted data, not validator instruction.
7. Consensus stores one of `APPROVED`, `REJECTED`, `REQUEST_MORE_INFO`, or `UNRESOLVED`. Missing proof never becomes approval.
8. An authenticated finality-only self-message marks the exact review attempt `FINALIZED`.
9. Anyone may prepare and dispatch an eligible immutable payout/refund intent. Accounting remains conserved and replay-safe.

Early evidence sealing is an authorization to request review sooner; it is **not** approval, protocol finality, payout/refund finality, or settlement.

The contract is `INTENTIONALLY_FROZEN`: there is no owner override, verdict override, recipient redirect, or privileged upgrade method. See [architecture](docs/architecture.md), [threat model](docs/threat-model.md), and [recovery runbook](docs/recovery-runbook.md).

## Roles

- **Buyer:** creates the case, funds exact simulated escrow, may seal a complete fresh evidence epoch early, and receives rejection/timeout refunds.
- **Vendor:** accepts immutable terms, submits the release evidence, cures one `REQUEST_MORE_INFO` epoch, and receives approved payouts.
- **Reviewer/settler:** any unrelated wallet may request an eligible review, retry an unresolved review, prepare settlement, or dispatch an exact prepared intent.
- **GenLayer validators:** independently fetch, verify, and semantically judge the bound evidence.

No role can enumerate all cases from the contract. The dashboard keeps case IDs in that browser only and always reloads material state from `latest-final` contract reads.

## Requirements and setup

- Python 3.12+ (CI currently uses Python 3.14.2)
- Node.js 18+ (CI currently uses Node 24.17.0)
- WSL on Windows for the pinned direct-test loader
- GenLayer tooling pinned by `requirements.txt`
- Playwright Chromium (`npx --prefix frontend playwright install chromium` if absent)

```powershell
python -m pip install --require-hashes -r requirements.txt
npm ci
npm --prefix frontend ci
Copy-Item .env.example frontend/.env.local
```

Public frontend configuration:

```dotenv
GENLAYER_NETWORK=localnet
NEXT_PUBLIC_GENLAYER_NETWORK=localnet
NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS=<real deployed address>
NEXT_PUBLIC_EXPLORER_BASE_URL=
```

Do not put a private key, mnemonic, GitHub credential, or `VERCEL_TOKEN` in source, fixtures, committed environment files, or browser-visible variables. Deployment signers and Vercel credentials are environment-only. The frontend rejects private-key configuration.

## Local demo

The most reliable end-to-end local demo is the owned Playwright workflow. It starts a five-validator GLSim, deploys the exact contract, builds the frontend with that dynamic local address, runs a production Next.js server, signs with in-memory test wallets, exercises real contract writes/readbacks, and cleans up the runtime:

```powershell
npm --prefix frontend run test:e2e
```

It covers approved payout dispatch, rejected refund dispatch, `REQUEST_MORE_INFO` cure, `UNRESOLVED` no-transfer behavior, wallet rejection, provenance recovery, refresh reconciliation, responsive layouts, keyboard flow, and accessibility checks. GLSim cannot execute/prove the final EOA child transfer; the UI therefore ends at `DISPATCHED_FINALIZED` with recipient confirmation pending.

For manual UI work, first deploy the contract to your chosen local GenLayer runtime, set the real local address in `NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS`, then run:

```powershell
npm --prefix frontend run dev
```

Connect an injected wallet on chain `61127` (`localnet`), `61999` (`studionet`), or `4221` (`testnet_bradbury`). The UI refuses a wrong network, wallet rejection, missing address, zero/repeated placeholder address, and stale/mismatched transaction provenance.

## Verification commands

Run from the repository root unless stated otherwise:

```powershell
# Intelligent Contract
genvm-lint check contracts/access_seal.py
npm run test:direct
npm run test:integration

# Root scripts and frontend
npm run lint
npm run typecheck
npm --prefix frontend run typecheck
npm run test
npm run build

# Browser workflow; run twice for sequential wallet/runtime stability
npm --prefix frontend run test:e2e
npm --prefix frontend run test:e2e

# Repository hygiene
git diff --check
git status --short
npm run audit:secrets
```

`npm run build` requires a valid public network and a real non-placeholder deployed contract address. For an isolated local verification build only, tests may use the explicit safe test mode; never deploy that configuration:

```powershell
$env:NEXT_PUBLIC_GENLAYER_NETWORK="localnet"
$env:NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS="0x0000000000000000000000000000000000000001"
$env:NEXT_PUBLIC_ACCESSSEAL_SAFE_TEST_CONFIG="1"
npm run build
```

## Deployment and readback

External deployment is intentionally gated. Immediately before GitHub push, GenLayer deployment, or Vercel deployment, verify the exact Git author/account/remote, deployment wallet, and Vercel team/project, state the proposed action, and obtain fresh user confirmation. General approval from an earlier step is not sufficient.

`contracts/access_seal.py` is the readable reviewed source. Bradbury deployment uses the deterministic `contracts/access_seal_deploy.py` artifact because the readable 73 KB source exceeds the chain's block pubdata limit. Generate or verify the artifact with:

```powershell
npm run contract:build
npm run contract:check
```

The artifact is generated with pinned `python-minifier==3.2.0`, preserves the exact dependency header, annotations, public/global names, storage and ABI, and must remain at most 48,000 UTF-8 bytes. It must never be hand-edited. Root lint, tests, integration, and build reject a missing or stale artifact; GenVM lint/schema parity and the full direct suite run against the deployed artifact.

The production deployment entrypoint is `deploy/001_deploy_access_seal.ts`. Its GenLayer client must have an environment-provided signer and the requested exact chain identity. It refuses a dirty repository or stale artifact, preflights the V3 manifest destination before submitting a deployment, deploys only the compact artifact, waits for `FINALIZED` plus `FINISHED_WITH_RETURN`, and writes an ignored V3 record only after verifying the readable-source hash, deployed-artifact hash, schema, frozen interface, address, transaction, and finalized accounting.

On POSIX, deployment and manifest lookup additionally require `python3` with `fcntl`, `O_NOFOLLOW`, stable nonzero inode identities, same-filesystem hard links, and reliable local-filesystem `flock` semantics. Network or virtual filesystems that cannot provide those guarantees are unsupported and fail closed. The namespace lock and exact-directory preflight marker are persistent hidden files; complete manifest publication retains one hidden hard-link alias so the final pathname is never exposed with partial bytes. POSIX receipt removal is deliberately manual because pathname deletion cannot be bound safely to an already-verified inode.

AccessSeal V3 is a new frozen contract deployment: deploy it at a new address, record that address and its V3 source/schema readback in a new manifest, and configure clients only after that readback. V2 cases, evidence, review/settlement IDs, storage, and balances do not migrate into V3; each user must use the recovery path encoded by V2 or explicitly create a new V3 case.

V3 manifests are kept beside, never in place of, historical V2 records at `work/deployments/<network>/v3/<deployment-artifact-sha256>/<contract-address>.json`. Perform independent readback against the exact V3 address:

```powershell
npm run verify:deployment -- --network testnet_bradbury --contract-address <V3_CONTRACT_ADDRESS>
```

The verifier re-fetches the deployment transaction and requires exact clean `HEAD`, deterministic artifact regeneration, both tracked source hashes, deployed artifact bytes, schema hash, contract address, finality, execution, frozen schema, and `latest-final` accounting conservation. `sourceSha256` remains an exact alias of `deploymentArtifactSha256`; contradictory values are rejected.

Do not copy `docs/deployment-manifest.example.json` into production unchanged; its values are deliberately non-consumable placeholders.

## Settlement and recovery states

- `PENDING`/`ACCEPTED` is not final. Wait for `FINALIZED` and successful execution, then perform authoritative readback.
- `EVIDENCE_OPEN -> EVIDENCE_SEALED -> review` is available only when the buyer closes a current complete six-item epoch. Read `lifecycle`, `evidenceSealed`, `evidenceSealedAt`, and `evidenceSealedBy` from `get_case` before treating the seal as authoritative. A seal permits immediate review but is not a verdict, finality, or settlement.
- If the buyer does not seal, the cutoff fallback is unchanged: review becomes eligible only after the evidence cutoff has passed, subject to the hard deadline.
- `REQUEST_MORE_INFO` allows one vendor cure epoch with a new evidence/replay domain.
- `UNRESOLVED` never moves value. Anyone may retry after cooldown within the fixed budget; exhausted recovery produces a deterministic refund path.
- `APPROVED` can prepare only the immutable vendor payout; `REJECTED` can prepare only the immutable buyer refund, and only after the contract-derived finality proof.
- A deterministic failure before external emission leaves the same `PREPARED` intent retryable without debiting reserve twice.
- `DISPATCHED_FINALIZED` means the finalized parent execution emitted a finality-only EOA transfer. It is **not** recipient confirmation. The application must independently prove a finalized/successful linked child transaction or the exact recipient balance delta.
- The contract cannot observe a correlated child failure and cannot safely re-dispatch a terminal intent automatically.

Protocol appeal uses the originating review transaction ID. The frozen contract does not store that transaction hash or appeal transaction history; the frontend preserves its own signed review transaction binding and disables appeal when provenance is unavailable. The contract also has no `createdAt` field, so the frontend cannot independently calculate timeout eligibility and fails closed; contract execution remains authoritative.

See the [recovery runbook](docs/recovery-runbook.md) before operating any ambiguous or failed transaction.

## Fixed proof package

After the repository, contract, branch workflows, and frontend have been published through their separately confirmed gates, create the locator-only file `work/evidence/final/locators.json`, then run:

```powershell
npm run proof:collect -- --network studionet
```

The locator file contains no claimed status, verdict, readback, balance, or test result. It identifies the published GitHub repository/commit, Vercel deployment, official RPC/explorer, and exact workflow transaction/case/settlement/recipient/amount bindings. `scripts/collect-proof.ts` independently:

- verifies the GitHub commit and both published contract files/hashes;
- verifies the Vercel production deployment and its Git commit using the environment-only `VERCEL_TOKEN`, then fetches the live AccessSeal page;
- uses the official GenLayer client on the fixed network RPC to verify deployment source/schema/finality/accounting;
- decodes the exact pinned SDK Studio/testnet transaction shapes and checks each returned hash, sender, method, arguments, contract, case actor, finality, execution, and `latest-final` readback;
- binds each payout/refund prepare and execute write to its exact returned hash and unrelated sender, then binds the parent to one exact external message and one exact triggered finalized/successful child transaction with the expected recipient and amount;
- treats every contract `u256` value as a canonical decimal string so proof never rounds through JavaScript `number`;
- executes root lint (including both real contract/prompt lint signals), a separate machine-readable frozen-schema command, root typecheck, direct, integration, root-script, frontend lint/typecheck/unit/build, secret-scan, and two E2E commands itself and records parsed suite counts plus output hashes;
- binds typed live-child and deployment-verifier provenance to exact tracked `HEAD` blobs;
- immediately before installing the atomic package, rechecks clean `HEAD`, commit, contract bytes, schema, deployment binding, and every cited blob.

The collector refuses caller-authored result fields, placeholders, private/reserved hosts, dirty source, publication/commit/source/schema mismatch, missing SDK fields, wrong decoded calls, unlinked children, failed/count-mismatched checks, non-conserving accounting, or missing branch readback. It stages and flushes both outputs, then installs the pair with rollback so a failure cannot leave a new JSON beside an old matrix. It writes only:

- `work/evidence/final/proof.json`
- `work/evidence/final/proof-matrix.md`

Both are ignored local evidence until deliberately included in a submission package. The current external-proof status is documented in [docs/proof-matrix.md](docs/proof-matrix.md).

## Known limitations

1. Static bounded artifacts do not establish universal accessibility, legal compliance, or real assistive-technology experience.
2. Authenticated, personalized, CAPTCHA-protected, cross-origin-heavy, and highly dynamic releases are outside the MVP.
3. Submitter identity proves provenance, not truth. Validator refetching/recomputation reduces but does not eliminate manipulation or prompt-injection risk.
4. GenVM v0.2.16 fully buffers web responses and exposes no transport timeout/bounded-read control; the contract applies fixed request count and post-fetch byte caps.
5. Consensus can be slow, costly, unavailable, or disagree. The safe result is no payout.
6. Localnet/Studionet value is simulated.
7. `DISPATCHED_FINALIZED` does not prove child receipt or recipient balance; no automatic external-child retry is claimed.
8. There is no on-chain case enumeration, persisted review/appeal transaction history, or case `createdAt` view.
9. Frozen code removes upgrade-key risk but cannot be patched in place. V3 requires a new-address deployment; V2 does not migrate automatically and users act through the applicable recovery/new-case path.
10. V3 is not proven until a live Bradbury model canary reaches finalized authoritative readback.

## Repository map

- `contracts/` — deployable Intelligent Contract and auditable prompt parity source.
- `tests/direct/` — deterministic state, evidence, semantic, recovery, settlement, and frozen-contract tests.
- `tests/integration/` — five-validator GLSim consensus/deployment/recovery tests and opt-in live settlement verification.
- `deploy/` — fail-closed deployment and independent verification.
- `frontend/` — responsive Next.js wallet application, unit/component tests, and production-server E2E.
- `scripts/` — evidence canonicalization, GLSim harness, source hashing, and proof collection.
- `docs/` — architecture, threat model, recovery, deployment manifest example, and proof status.

License status has not yet been selected; do not assume permission beyond the repository owner's terms.

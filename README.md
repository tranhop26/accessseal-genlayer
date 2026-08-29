# AccessSeal V4

AccessSeal is a GenLayer application for evidence-bound accessibility acceptance. A buyer and website vendor lock an acceptance profile, critical-flow hash, deadlines, retry budget, and escrow amount. The frozen Intelligent Contract is authoritative for evidence, verdict, lifecycle, custody, and settlement; the frontend only presents authoritative readback and asks the user to sign a selected write.

> **Value warning:** Every localnet and Bradbury GEN value used by this repository is **simulated testnet value**. AccessSeal is not a payment product, WCAG certification, legal advice, or a substitute for testing with disabled people and assistive technology.

## Publication status

| Evidence item | Status |
|---|---|
| V4 contract address | Not yet executed |
| V4 deployment transaction | Not yet executed |
| Vercel production URL | Not yet executed |

The repository contains local implementation and verification. It does not claim a GitHub push, external GenLayer deployment, live transaction, recipient delivery, or Vercel production release. Addresses and transaction data produced under `work/` are ephemeral local GLSim output, never external evidence.

## V4 lifecycle

1. The buyer calls `create_case` with the vendor address, profile hash, one `flowsHash`, subject origin, evidence and hard deadlines, unresolved-retry budget, and exact simulated escrow amount. The vendor calls `accept_terms`; the buyer calls payable `fund` with exactly that amount.
2. The vendor calls `open_evidence` with `RELEASE_MANIFEST`, then `append_evidence` for exactly one each of `HTML_BUNDLE`, `SCREENSHOT`, `DOM_FACTS`, `SCANNER_REPORT`, and `CRITICAL_FLOW_TRACE`.
3. The buyer calls `close_evidence` while the epoch is open and the complete evidence profile is fresh. Closing fetches, validates, and canonically stores the review context. After the transaction is finalized, read `get_case` and `get_review_context` at `latest-final` before treating that context as ready.
4. Any eligible caller can call `request_review` after the authoritative sealed/context-ready readback. It never refetches the manifest, HTML, DOM, scanner, or flow trace: each participating node receives the stored canonical context, fetches at most the exact bound screenshot once, and performs exactly one AI evaluation. Validators independently compare verdict, sorted material blockers, sorted missing evidence, profile hash, release digest, context hash, and evidence references; rationale prose is excluded.
5. Read `get_review`, `get_review_attempt`, and `get_review_finality`. Only a protocol-finalized `APPROVED` readback permits `prepare_payout`; only finalized `REJECTED` permits `prepare_refund`. Any caller may then call `execute_settlement` for the exact prepared settlement ID.

The UI never advances before authoritative readback and never auto-signs or auto-resubmits a wallet transaction.

## V4 bounded review context

`close_evidence` stores a canonical `accessseal-review-context/1` document. It is at most **16,384 UTF-8 bytes**. Its exact top-level fields are `binding`, `criticalFlows`, `dom`, `evidence`, `expiresAt`, `observedAt`, `scanner`, `schemaVersion`, and `screenshot`.

`binding` independently carries `chainId`, `contractAddress`, `caseId`, `epoch`, `profileHash`, `releaseDigest`, and `subjectOrigin`. The context's `evidence` entries bind each evidence type to its SHA-256. `screenshot` independently provides `uri`, `sha256`, `mediaType: image/png`, and `byteLength`; the exact manifest-bound `SCREENSHOT` PNG is at most **16,384 raw bytes**. `get_review_context(caseId, epoch)` returns `caseId`, `epoch`, `schemaVersion`, `ready`, `contextJson`, `contextHash`, `imageUri`, and `imageSha256`; clients recompute the SHA-256 of `contextJson`, compare case bindings against `get_case`, compare `releaseDigest` and evidence hashes against `get_evidence`, and only then enable review.

Other enforced limits include 16,384 bytes for the manifest and JSON artifacts, 32,768 bytes for HTML, 131,072 bytes total for all fetched artifacts, and at most 16 manifest entries. Missing, unavailable, malformed, stale, contradictory, oversized, or mismatched evidence never becomes approval or payout.

## Local setup and test workflow

Requirements: Python 3.12+, Node 18+, pinned dependencies, and Playwright Chromium for browser tests.

```powershell
python -m pip install --require-hashes -r requirements.txt
npm ci
npm --prefix frontend ci
Copy-Item .env.example frontend/.env.local
npx --prefix frontend playwright install chromium
```

For local test builds, set process-scoped values only; do not commit a populated environment file:

```powershell
$env:NEXT_PUBLIC_GENLAYER_NETWORK="localnet"
$env:NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS="0x0000000000000000000000000000000000000001"
$env:NEXT_PUBLIC_ACCESSSEAL_SAFE_TEST_CONFIG="1"
npm run build
```

The explicit safe-test address is accepted only in test mode. A normal frontend build rejects missing, zero, repeated, or placeholder contract addresses. `NEXT_PUBLIC_GENLAYER_NETWORK` accepts `localnet`, `studionet`, or `testnet_bradbury`; Bradbury remains simulated testnet value. The UI never accepts a private-key configuration.

Run the complete local proof suite from the repository root:

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

## Deployment and recovery boundary

V4 is `INTENTIONALLY_FROZEN`: there is no administrator, upgrade key, verdict override, recipient redirect, or privileged code replacement. V4 is a new deployment. V1–V3 cases, evidence, review/settlement IDs, storage, and balances do not migrate. Existing users use the recovery path encoded by their original deployment; a V4 user creates a new V4 case.

`contracts/access_seal.py` is the readable source and `contracts/access_seal_deploy.py` is the deterministic compact deployment artifact. `npm run contract:check` verifies parity and the 48,000-byte artifact budget. A deployment record, after its own finalized successful readback, belongs at `work/deployments/<network>/v4/<deployment-artifact-sha256>/<contract-address>.json` and has `contractVersion: "V4"`.

Before any push, contract deployment, or Vercel production deployment, perform a fresh action-time identity check and obtain explicit user confirmation. Do not use this documentation as authority to perform those external actions. See [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [recovery runbook](docs/recovery-runbook.md), and [proof matrix](docs/proof-matrix.md).

## Known limitations

- Static bounded evidence and AI review cannot establish universal accessibility, legal compliance, or real assistive-technology experience.
- Authenticated, personalized, CAPTCHA-protected, cross-origin-heavy, and highly dynamic releases are outside the MVP.
- GenVM buffers web responses before byte caps; it offers no contract-configurable network timeout or streaming bound.
- Consensus can be slow, unavailable, or disagree; the safe result is no payout.
- `DISPATCHED_FINALIZED` proves only parent dispatch. It does not prove a recipient received funds; a linked finalized/successful child transaction or exact recipient balance delta is still required.
- Local GLSim verifies contract behavior but cannot prove external EOA child delivery. No live Bradbury canary has been claimed.

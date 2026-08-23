# AccessSeal Live Evidence Bundle Design

## Purpose

Produce a validator-fetchable, immutable happy-path evidence bundle for the live AccessSeal case whose subject is `https://accessseal-genlayer.vercel.app`. The bundle must support an `APPROVED` accessibility decision without claiming that a scanner score alone proves accessibility.

This design covers artifact production, same-origin hosting, envelope generation, validation, and the six vendor submissions for epoch `0`. It does not change the Intelligent Contract, case terms, escrow amount, review rubric, or settlement behavior.

## Fixed Live Binding

- Case ID: `0x2e82b92517f29f02e86ea5f761ce8a62dc470fad4c92625133ab407f25091959`
- Contract: `0x42b2eda04e762f50915f17143adbe73038e36b27`
- Evidence chain domain: `1`, matching the immutable case record
- Epoch: `0`
- Subject origin: `https://accessseal-genlayer.vercel.app`
- Buyer: `0x21b45103dd05c43969daf3cbb4277391777e2ec7`
- Vendor issuer: `0x35c9979d30992b13ef6df7036bc745e2e1cd76a2`
- Profile version: `accessseal-static/1`
- Profile hash: `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- Flows hash: `0xd8b711d3ceb59343cd7822e5fcf3aba42c11de287bd6dcf53bfe838d753f6001`
- Audited production source: Git commit `23ab41fb5a6c982d259d7d441da8ab5c85b8aa44`
- Artifact release ID: `2026-08-23-live-v2`
- Finalized create-case transaction: `0x7ef90047f5e94cfb838eb176bcb243bce4c3153f293cc660f3919cdb2c60dd74`
- Fund transaction: `0xf701ff00b9818da5cd4ebafb0b5252e9402cf0cc47e3ddf5352c09a727138c05`; require `FINALIZED / AGREE / FINISHED_WITH_RETURN` before capture or any evidence operation.
- Authoritative case creation timestamp: `1787492373`; evidence cutoff: `1787578773`; hard deadline: `1788097173`.

`caseCreatedAt` is the V2 final create receipt/readback's execution timestamp, not a client clock or an `ACCEPTED` transaction timestamp. The public `get_case` readback does not expose it. All envelope timestamps are generated immediately before preview and submission. `observedAt <= submittedAt < expiresAt`; observations and submissions must remain within the absolute case evidence window, and expiry cannot exceed the absolute hard deadline. Nonces are unique per generation as well as per case, epoch, action, and evidence type so a same-second retry cannot reuse a nonce.

## Critical Flows

The happy-path audit exercises three keyboard-operable, same-origin flows:

1. Open the workspace, use the skip link, and navigate Overview and Cases from the sidebar.
2. Complete the Create Case form through validation and deterministic preview without sending an on-chain transaction.
3. Open the authoritative case detail and navigate Terms, Evidence, AI decision, and Settlement while preserving visible focus and readable status.

Wallet-extension dialogs are outside the subject origin and are not represented as audited same-origin UI. The case's immutable `flowsHash` is recorded in the critical-flow artifact so the evidence cannot silently claim a different case domain.

## Artifact Architecture

The frontend serves five versioned payloads and one well-known manifest:

| Evidence type | Public path | Media type | Maximum bytes |
|---|---|---:|---:|
| `HTML_BUNDLE` | `/evidence/releases/2026-08-23-live-v2/release.html` | `text/html` | 32,768 |
| `SCREENSHOT` | `/evidence/releases/2026-08-23-live-v2/screenshot.png` | `image/png` | 65,536 |
| `DOM_FACTS` | `/evidence/releases/2026-08-23-live-v2/dom-facts.json` | `application/json` | 16,384 |
| `SCANNER_REPORT` | `/evidence/releases/2026-08-23-live-v2/scanner-report.json` | `application/json` | 16,384 |
| `CRITICAL_FLOW_TRACE` | `/evidence/releases/2026-08-23-live-v2/critical-flow-trace.json` | `application/json` | 16,384 |
| `RELEASE_MANIFEST` | `/evidence/releases/2026-08-23-live-v2/release-manifest.json` | `application/json` | 16,384 |

The five payloads together must keep the total validator download below 131,072 bytes. The manifest uses schema `accessseal-release-manifest/1`, binds the case ID, epoch, subject origin, profile hash, and exact relative path, media type, and lowercase SHA-256 digest of every payload. V2's versioned manifest avoids mutating the V1 `/.well-known/accessseal/release-manifest.json`; all V1 public assets remain historical evidence.

The manifest bytes are canonical JSON with sorted keys and compact separators. The manifest SHA-256 is the release digest and is also the manifest envelope's `payloadSha256`. Payload URLs are normalized HTTPS URLs with no query, fragment, credentials, percent escapes, dot segments, or cross-origin redirects.

## Artifact Contents

### HTML bundle

A sanitized, deterministic snapshot of the rendered AccessSeal release. It preserves semantic landmarks, headings, labels, links, controls, and status copy needed for accessibility review while omitting scripts, wallet state, tokens, private data, volatile timestamps, and extension content.

### Screenshot

A production screenshot of the light-theme case workspace at a desktop viewport. It must remain under 65,536 bytes and must not contain wallet balances, account names, browser chrome, notifications, or secrets.

### DOM facts

A compact report of observed landmarks, heading order, accessible names, form labels, image alternatives, skip-link target, focusable control order, disabled states, and page URLs. Facts are observations, not a verdict.

The `pages` array is closed and ordered: `/cases`, `/cases/new`, then the fixed case-detail URL. Every page record contains exactly `url`, `landmarks`, `headings`, `accessibleNames`, `formLabels`, `imageAlternatives`, `skipLinkTarget`, `focusableControlOrder`, and `disabledStates`; omitted fields or a substituted/reordered page fail validation.

### Scanner report

An `@axe-core/playwright` report for the three audited pages. It records tool version, audited URLs, rule counts, violations, incomplete checks, and the exact scan timestamp. A zero-violation result remains corroborative and cannot override semantic evidence.

### Critical-flow trace

A step-by-step keyboard trace for the three flows. Each step records the page, input action, expected focus/visible result, actual result, and pass state. The report records the immutable case `flowsHash` and explicitly reports the five material blocker codes as absent only when the trace supports that conclusion.

The three flow IDs and their order are fixed as `workspace-navigation`, `create-case-preview`, and `case-section-navigation`. Their ordered checkpoints respectively cover skip/main plus Overview/Cases navigation; vendor/profile/three-flow/escrow entry plus preview-without-send; and authoritative lifecycle plus Terms/Evidence/AI decision/Settlement navigation and focus escape. A one-step or renamed flow cannot satisfy the schema.

The HTML validator requires a semantic `main` and heading and rejects scripts, inline event handlers, JavaScript URLs, cookie/storage/provider access, extension/account/private-key/seed/mnemonic/session text, and wallet-state markers. Public case, profile, flow, and contract identifiers remain allowed.

## Generation and Validation

A dedicated generator consumes captured live audit results and writes only the six allowlisted V2 release paths. It calculates every payload digest, builds the canonical manifest last, and refuses to overwrite an existing release ID with different bytes.

Validation is fail-closed:

- Reject missing, extra, or incorrectly typed manifest fields.
- Reject wrong case, epoch, origin, profile hash, path, media type, or digest.
- Reject non-canonical JSON, unsafe paths, redirects, unavailable payloads, or wrong response content types.
- Reject individual and aggregate size-limit violations.
- Reject scanner or flow artifacts that omit audited URLs, timestamps, results, or material-blocker coverage.
- Reject a claimed happy path if Axe reports a serious/critical violation or the keyboard trace reports a failed step or material blocker.

## Envelope and On-Chain Sequence

After the V2 create transaction has finalized, its authoritative receipt timestamp and `get_case` fields have been recorded, the vendor has accepted the exact terms, the buyer has funded the exact readback escrow, and the V2 artifact deployment is live and read back byte-for-byte:

1. Generate a `RELEASE_MANIFEST` envelope with action `OPEN_RELEASE` and submit `open_evidence` from the vendor.
2. Generate five envelopes with action `APPEND_EVIDENCE`, one for each supporting evidence type, and submit `append_evidence` sequentially from the same vendor.
3. For every transaction, wait for `FINALIZED`, require execution `FINISHED_WITH_RETURN`, and read `get_evidence(caseId, 0)` before advancing.
4. Confirm exactly six unique evidence hashes, one release digest, correct media types, fresh expiry, and lifecycle `EVIDENCE_OPEN`.
5. Do not request review until every mandatory artifact is live, finalized, and read back, and the chain time is strictly after the evidence cutoff. The contract rejects review at or before `createdAt + evidenceDeadline`; all evidence writes must complete before their applicable evidence/hard deadline.

Each on-chain write requires a fresh action-time user confirmation and a final MetaMask confirmation. Retrying reuses neither a nonce nor a transaction when the prior transaction already exists.

## UI Behavior

The existing envelope textbox and canonical preview remain the signing boundary. The operator pastes one generated envelope at a time, validates the preview, verifies case/origin/type/digest/timestamps, and only then enables signing. The UI must keep Submitted, Accepted, Finalized, and Readback Confirmed distinct and show errors without advancing local workflow state.

No private key, token, wallet credential, or browser session data enters an artifact, envelope fixture, repository file, or build log.

## Testing Strategy

Tests are written before production changes and cover:

- Deterministic manifest generation and release digest.
- Exact route content types and immutable payload bytes.
- Same-origin URL normalization and redirect rejection.
- Manifest membership, lowercase digest, canonical JSON, and all size limits.
- Axe report and critical-flow happy-path acceptance criteria.
- Rejection of missing flow steps, blocker coverage, serious/critical violations, stale timestamps, duplicate nonces, and mutated payload bytes.
- Production build, lint, typecheck, focused artifact tests, complete frontend tests, root direct tests, integration tests, and secret scanning.
- Live post-deploy HTTP readback of all six URLs plus local recomputation of every SHA-256 digest.

## Deployment and Proof Gates

Local implementation and verification do not authorize external actions. Before push and Vercel production deployment, verify Git author, GitHub account, repository owner/remote, Vercel project/team, exact commit, and staged-file hygiene, then obtain the user's action-time confirmation.

The production build must set `NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS=0x42b2eda04e762f50915f17143adbe73038e36b27` before the V2 capture. The public config route is static, so read back `/.well-known/accessseal/config.json` after deployment and require the V2 address before opening the V2 case detail in the capture flow.

The final evidence package records the artifact commit, Vercel deployment ID, six public URLs, release digest, six envelope hashes, six transaction hashes, finality/execution results, and `get_evidence` readback. `APPROVED` remains a target, not a guaranteed claim; validators may return `REQUEST_MORE_INFO`, `REJECTED`, or `UNRESOLVED`, and the application must preserve those outcomes.

## Known Constraint

The case stores only `flowsHash`, not the original three flow strings. The critical-flow artifact therefore binds the observed three flows to the immutable hash but cannot independently reconstruct the original plaintext labels from chain state. This limitation is disclosed in the final proof package rather than hidden.

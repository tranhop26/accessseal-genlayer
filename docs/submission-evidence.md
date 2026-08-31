# AccessSeal V4 submission evidence

**Evidence date:** 2026-08-31 (Asia/Bangkok)
**Network:** `testnet_bradbury` — GenLayer Bradbury Testnet (simulated)
**Chain ID:** `4221`

This is a copy-ready record of the verified V4 submission evidence. All GEN values, balances, and transactions in this record are simulated Bradbury testnet values, not monetary assets outside the testnet.

## Repository and release

- Repository: [tranhop26/accessseal-genlayer](https://github.com/tranhop26/accessseal-genlayer)
- Repository release: `v4-live-20260830`
- Source/deployment commit: `b2beb1434d42e79412d1083ed8b4517dcc22659a`
- Production merge commit: `6998b1d6dfa8035430720d5b1813725e3fe272ab`
- Release digest: `sha256:b6b118453742c45c08cc9766351fb7b5ba52e781f0da5d0893fe5577d97d3f05`
- Readable contract source SHA-256: `42d7d94983357af0eb818f31f76327cfef1f52fd71462e7178dbd5de637c0fcf`
- Deployment artifact/source SHA-256: `3bd9a8713791ceb011e8bb6f557950aa54938cba76b2c37f31ae77044d8750f8`
- Schema SHA-256: `a979c17948f12d349c9e06d4e167881252931fe7459e1a805ae39c3176dd2da0`

The verified V4 deployment metadata is schema `accessseal-deployment-manifest/2`, contract version `V4`, and classification `INTENTIONALLY_FROZEN`, bound to the source/deployment commit above. No ignored local deployment artifact is presented as a public repository file.

## Contract deployment

- Contract: `0xa485edc97f5acd071a3dc793a790ac50d7a58df6`
- Deployment transaction: [`0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04`](https://explorer-bradbury.genlayer.com/tx/0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04)
- Deployer: `0x21b45103dd05c43969daF3CbB4277391777e2eC7`
- Deployment recipient: `0xA485edC97f5acD071A3DC793a790ac50D7A58df6`
- Receipt execution: `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`
- Vercel deployment ID: `dpl_9RBfyNfVvXCYjxdXBkvpPeLj2Ko5`

## Tests and repository verification

Last fresh results, recorded 2026-08-31:

| Check | Result |
|---|---|
| Script tests | `174 passed` |
| Frontend tests | `226 passed` |
| Direct tests | `244 passed` |
| Integration tests | `46 passed, 1 skipped` |
| Lint | pass |
| Typecheck | pass |
| Production build | pass |
| Secret audit | pass |

The one integration skip is the documented GLSim limitation. It is not live proof.

## Production publication

Production origin: [https://accessseal-genlayer.vercel.app](https://accessseal-genlayer.vercel.app)

Vercel deployment ID: `dpl_9RBfyNfVvXCYjxdXBkvpPeLj2Ko5`; production was merged from commit `6998b1d6dfa8035430720d5b1813725e3fe272ab`.

The public configuration endpoint returned HTTP 200 with the V4 Bradbury configuration: [config.json](https://accessseal-genlayer.vercel.app/.well-known/accessseal/config.json).

```json
{"schemaVersion":"accessseal-public-config/1","network":"testnet_bradbury","chainId":4221,"contractAddress":"0xa485edc97f5acd071a3dc793a790ac50d7a58df6","safeTestConfig":false}
```

| Public artifact | HTTP | Bytes | SHA-256 |
|---|---:|---:|---|
| [release-manifest.json](https://accessseal-genlayer.vercel.app/evidence/releases/v4-live-20260830/release-manifest.json) | 200 | 1319 | `b6b118453742c45c08cc9766351fb7b5ba52e781f0da5d0893fe5577d97d3f05` |
| [release.html](https://accessseal-genlayer.vercel.app/evidence/releases/v4-live-20260830/release.html) | 200 | 6136 | `07a22134a80ff550e0c509f82c0df5579e24b8d85e1e5b8a8ef4008d8ae75f20` |
| [screenshot.png](https://accessseal-genlayer.vercel.app/evidence/releases/v4-live-20260830/screenshot.png) | 200 | 3867 | `4e355b19b754e6688e3d516865f2c83ea3176f175284e937e124800364bdc400` |
| [dom-facts.json](https://accessseal-genlayer.vercel.app/evidence/releases/v4-live-20260830/dom-facts.json) | 200 | 6743 | `5acc0417de26b4631eff8892348a69040341890e6def3a9fc93d2aac6c21f741` |
| [scanner-report.json](https://accessseal-genlayer.vercel.app/evidence/releases/v4-live-20260830/scanner-report.json) | 200 | 3740 | `87fbf65825b70c8b0ef7b3f814c01ea74e855250210fb0f53ba531aa7a0a5100` |
| [critical-flow-trace.json](https://accessseal-genlayer.vercel.app/evidence/releases/v4-live-20260830/critical-flow-trace.json) | 200 | 5503 | `769a3a8f0790f91d890aa9f16a7f0ee5e707f5f5678b5bb06df0434f78d09dd9` |

The repository secret audit passed. A content-level scan of these six published files found no private-key, mnemonic, password, secret, token, or authorization-marker matches. Representative ignored/local-only paths were requested from production and returned HTTP 404: `/work/evidence/live-envelopes/summary.json`, `/work/evidence/live-capture/release.html`, `/.superpowers/sdd/2026-08-31-accessseal-submission-proof/task-1-report.md`, and `/work/deployments/testnet_bradbury/v4/3bd9a8713791ceb011e8bb6f557950aa54938cba76b2c37f31ae77044d8750f8/0xa485edc97f5acd071a3dc793a790ac50d7a58df6.json`.

## Live case

- Case ID: `0x9e75a4720ffd577aafbecbce47fd6f605659c3dbfc35fa31390bc9743eafbff7`
- Buyer: `0x21b45103dd05c43969daf3cbb4277391777e2ec7`
- Vendor: `0x35c9979d30992b13ef6df7036bc745e2e1cd76a2`
- Authoritative lifecycle: `EVIDENCE_OPEN`; epoch: `0`
- Created at: `1788009560`; evidence deadline: `86400` seconds; cutoff: `1788095960` (`2026-08-30 20:19:20 +07:00`)
- Latest observed chain time: `1788135006`, after the cutoff
- Escrow / reserved: `100000000000000` / `100000000000000` simulated GEN units
- Profile hash: `0x28643fd34cf95b5cdeee540fed5b6af58bc4e65ff0fb49ab9416cfa168c051bb`
- Flows hash: `0xdfc23ff1a6164490f9170abdc1ee522febe70f21283050698a51e6146de51eb4`
- Subject origin: [https://accessseal-genlayer.vercel.app](https://accessseal-genlayer.vercel.app)

## Finalized transactions

Every row below was independently receipt-verified on `testnet_bradbury` and returned `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN`.

All `Readback` cells are authoritative `latest-final` views captured at the verification read, not reconstructed historical intermediate states. The evidence ordinal identifies its position in the current ordered on-chain array; the cumulative count is the current authoritative total (`4/6`).

| Actor | Action | Method | Transaction | Protocol | Execution | Readback |
|---|---|---|---|---|---|---|
| Deployer (`0x21b45103dd05c43969daF3CbB4277391777e2eC7`) | Deploy V4 | deployment (no decoded method) | [`0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04`](https://explorer-bradbury.genlayer.com/tx/0x3a12f9a9c8886cb10a3946201f742e9c5fe25e2f8d598adb4cb457deb4930a04) | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final deployment recipient/contract `0xa485edc97f5acd071a3dc793a790ac50d7a58df6` |
| Buyer (`0x21b45103dd05c43969daF3CbB4277391777e2eC7`) | Create | `create_case` | `0x0a72818263e7c80ded0f6a5b3addb72a179fb905c9f887c103f6ba22242c551d` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final case `0x9e75a4720ffd577aafbecbce47fd6f605659c3dbfc35fa31390bc9743eafbff7`; buyer `0x21b45103dd05c43969daf3cbb4277391777e2ec7`; vendor `0x35c9979d30992b13ef6df7036bc745e2e1cd76a2` |
| Vendor (`0x35C9979d30992b13EF6dF7036bC745E2e1cD76a2`) | Accept | `accept_terms` | `0x1f0358b85ccdb4c071f77e67168b22c307aec65a5a723f4c5a009b167d89f96c` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final `vendorAccepted=true`; `termsHash=0x6f77825acc5d5e2fca597449e73dad5d7ae6067424cdf6ba1768ae05fd9824e3`; lifecycle `EVIDENCE_OPEN` |
| Buyer (`0x21b45103dd05c43969daF3CbB4277391777e2eC7`) | Fund | `fund` | `0x4e6b2d004df0ba3628114315bb149d49dea52dbe55e2a46be4b6505a79ab1bbb` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final `escrowAmount=100000000000000`; `reserved=100000000000000`; accounting `totalDeposits=100000000000000` |
| Vendor (`0x35C9979d30992b13EF6dF7036bC745E2e1cD76a2`) | Evidence 1 | `open_evidence` | `0x48557d4429256d6579fe9553c7143b13d5840ea4773bf4add36595bc64ad3f48` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final epoch 0, ordinal 1: `RELEASE_MANIFEST` / `sha256:6b4753f10a64937af4851d309f76a848d89ab629ffc890ff82f2db25f4b47fca`; cumulative `4/6` |
| Vendor (`0x35C9979d30992b13EF6dF7036bC745E2e1cD76a2`) | Evidence 2 | `append_evidence` | `0x96528d58c18072498ff3899f135afce75b00427b99c23388183cc65968d2d692` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final epoch 0, ordinal 2: `HTML_BUNDLE` / `sha256:8428325b4dc273654d72e70efc86be12a379dd40d77ec0555b337cbeb93a58f5`; cumulative `4/6` |
| Vendor (`0x35C9979d30992b13EF6dF7036bC745E2e1cD76a2`) | Evidence 3 | `append_evidence` | `0x41b5082374220a1d29290409c4dd6280189265a801981ade38b6fbce93ecb234` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final epoch 0, ordinal 3: `SCREENSHOT` / `sha256:3218856363c65a21b28f9e787a6ffb5490f246c4a74accec908d8ec8cd6be42d`; cumulative `4/6` |
| Vendor (`0x35C9979d30992b13EF6dF7036bC745E2e1cD76a2`) | Evidence 4 | `append_evidence` | `0x52c0351b322a4c66c513a8c9506bac9d6294e3fe00a812f08cf50fb806e60af1` | `testnet_bradbury` / `4221` | `FINALIZED` / `AGREE` / `FINISHED_WITH_RETURN` | Latest-final epoch 0, ordinal 4: `DOM_FACTS` / `sha256:c91ea3720280e1c5ccdeb433aa0a61493819f72f6b7fcafc4debbaddfd6f931c`; cumulative `4/6` |

## Authoritative readback

`get_case(caseId)` was read with `transactionHashVariant: "latest-final"` at `readAt=1788136808`. It reports the case facts above, `vendorAccepted=true`, and the locked `termsHash=0x6f77825acc5d5e2fca597449e73dad5d7ae6067424cdf6ba1768ae05fd9824e3`; its contract-domain `chainId` is `1`, while the Bradbury network chain ID is `4221`.

`get_evidence(caseId, 0)` returns exactly four on-chain evidence envelopes, in this order:

1. `RELEASE_MANIFEST` — `sha256:6b4753f10a64937af4851d309f76a848d89ab629ffc890ff82f2db25f4b47fca`
2. `HTML_BUNDLE` — `sha256:8428325b4dc273654d72e70efc86be12a379dd40d77ec0555b337cbeb93a58f5`
3. `SCREENSHOT` — `sha256:3218856363c65a21b28f9e787a6ffb5490f246c4a74accec908d8ec8cd6be42d`
4. `DOM_FACTS` — `sha256:c91ea3720280e1c5ccdeb433aa0a61493819f72f6b7fcafc4debbaddfd6f931c`

## Known limitation

The evidence cutoff has expired. The authoritative epoch is exactly **4/6** mandatory evidence types on-chain: `RELEASE_MANIFEST`, `HTML_BUNDLE`, `SCREENSHOT`, and `DOM_FACTS`. `SCANNER_REPORT` and `CRITICAL_FLOW_TRACE` are published and hash-verified, but were not submitted on-chain. This is not a complete six-of-six on-chain evidence submission.

Evidence 5 and Evidence 6 were not executed. No closure, review, payout, or settlement has been completed or is claimed by this record.

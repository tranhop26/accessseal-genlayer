# AccessSeal Review Consensus Rotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Configure only AccessSeal intelligent review submissions to allow seven GenLayer consensus rotations, then verify and deploy the frontend without changing the V3 contract or sealed evidence.

**Architecture:** Add an optional write-options boundary to AccessSealClient and forward it to genlayer-js.writeContract. requestReview opts into consensusMaxRotations: 7; every other write retains the SDK/network default. Existing transaction monitoring and authoritative readback remain the only completion gates.

**Tech Stack:** TypeScript 5.9, Next.js 16, React 19, Vitest 4, genlayer-js 1.1.8, GenLayer Bradbury chain ID 4221, Vercel, GitHub Actions.

## Global Constraints

- Keep V3 contract 0x08a1969dd75265a58022fb50bbbdd87f9a726265 unchanged.
- Keep case 0xd3f684621674542957dbacb152e08616a3d315722091cc27dc3b5a9938cb6dd0 and its six evidence records unchanged.
- Apply consensusMaxRotations: 7 only to request_review.
- Do not add automatic wallet resubmission.
- Require action-time confirmation before every new wallet transaction.
- Require terminal finality plus authoritative get_review and get_review_finality readback.
- Never write VERCEL_TOKEN, private keys, or wallet secrets to source or logs.

---

## File Structure

- Modify frontend/src/lib/access-seal.ts: add optional write configuration and use it only for requestReview.
- Modify frontend/tests/lib/access-seal.test.ts: prove the review override and prove an ordinary write omits it.
- Do not modify contracts, evidence, UI components, public configuration, or dependencies.

### Task 1: Add the Review-Only Consensus Override with TDD

**Files:**
- Modify: frontend/tests/lib/access-seal.test.ts:416-442
- Modify: frontend/src/lib/access-seal.ts:82-98
- Modify: frontend/src/lib/access-seal.ts:328-343
- Modify: frontend/src/lib/access-seal.ts:595-597

**Interfaces:**
- Consumes: SdkClient.writeContract(args) and AccessSealClient.requestReview(caseId: string).
- Produces: WriteOptions with optional consensusMaxRotations; requestReview forwards value 7.

- [ ] **Step 1: Write the failing test**

Replace the existing value-routing test with:

~~~ts
it("uses seven consensus rotations only for intelligent review", async () => {
  const connect = vi.fn();
  const writeContract = vi.fn().mockResolvedValue(`0x${"d".repeat(64)}`);
  const client = new AccessSealClient(
    { connect, writeContract } as never,
    "0x1234567890abcdef1234567890abcdef12345678",
    "studionet",
  );

  await client.fund("case-1", 42n);
  await client.requestReview("case-1");

  expect(connect).toHaveBeenCalledWith("studionet");
  expect(writeContract).toHaveBeenNthCalledWith(1, {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    functionName: "fund",
    args: ["case-1"],
    value: 42n,
  });
  expect(writeContract).toHaveBeenNthCalledWith(2, {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    functionName: "request_review",
    args: ["case-1"],
    value: 0n,
    consensusMaxRotations: 7,
  });
  expect(writeContract.mock.calls[0]?.[0]).not.toHaveProperty(
    "consensusMaxRotations",
  );
});
~~~

- [ ] **Step 2: Verify RED**

Run:

~~~powershell
npm --prefix frontend run test -- tests/lib/access-seal.test.ts
~~~

Expected: FAIL because request_review does not contain consensusMaxRotations: 7.

- [ ] **Step 3: Implement the minimal adapter change**

Add the optional SDK field and local options type:

~~~ts
type WriteOptions = {
  consensusMaxRotations?: number;
};

writeContract(args: {
  address: `0x${string}`;
  functionName: string;
  args: unknown[];
  value: bigint;
  consensusMaxRotations?: number;
}): Promise<Hash>;
~~~

Update the private helper:

~~~ts
private async write(
  functionName: string,
  args: unknown[],
  value = 0n,
  options: WriteOptions = {},
): Promise<Hash> {
  if (!this.network)
    throw new Error("A wallet network is required for writes.");
  await this.sdk.connect(this.network);
  return this.sdk.writeContract({
    address: this.address,
    functionName,
    args,
    value,
    ...options,
  });
}
~~~

Update only requestReview:

~~~ts
requestReview(caseId: string) {
  return this.write("request_review", [caseId], 0n, {
    consensusMaxRotations: 7,
  });
}
~~~

- [ ] **Step 4: Verify GREEN and types**

~~~powershell
npm --prefix frontend run test -- tests/lib/access-seal.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend exec prettier -- --check src/lib/access-seal.ts tests/lib/access-seal.test.ts
~~~

Expected: all commands PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add -- frontend/src/lib/access-seal.ts frontend/tests/lib/access-seal.test.ts
git commit -m "fix: extend review consensus rotations"
~~~

### Task 2: Run Complete Quality and Trust Gates

**Files:** Verify only; no planned source changes.

**Interfaces:**
- Consumes: Task 1 implementation.
- Produces: fresh evidence for frontend, contract, integration, lint, build, artifact, evidence, and secret gates.

- [ ] **Step 1: Run tests**

~~~powershell
npm test
npm run test:direct
npm run test:integration
~~~

Expected: all script, frontend, direct contract, and integration tests PASS.

- [ ] **Step 2: Run quality gates**

~~~powershell
npm run lint
npm run typecheck
npm run build
npm run contract:check
npm run evidence:verify
npm run audit:secrets
~~~

Expected: all commands exit 0; contract artifact and evidence remain unchanged.

- [ ] **Step 3: Confirm narrow scope**

~~~powershell
git status --short
git diff HEAD^ -- frontend/src/lib/access-seal.ts frontend/tests/lib/access-seal.test.ts
git diff --exit-code HEAD^ -- contracts frontend/public/evidence frontend/src/components frontend/src/lib/config.ts
~~~

Expected: only the adapter and its test changed.

### Task 3: Review, Publish, and Merge

**Files:** Review the Task 1 commit plus the committed design and plan documents.

**Interfaces:**
- Consumes: clean branch with Task 2 gates passing.
- Produces: reviewed PR merged to main with green checks.

- [ ] **Step 1: Review invariants**

Confirm:
- request_review maps to consensusMaxRotations: 7.
- fund, evidence, and settlement writes have no override.
- contract, evidence, wallet roles, and resubmission behavior are unchanged.
- no unresolved high- or medium-severity findings.

- [ ] **Step 2: Push and create PR**

~~~powershell
git push origin codex/accessseal-v3-early-seal
gh pr create --base main --head codex/accessseal-v3-early-seal --title "Fix AccessSeal review consensus rotations" --body "Scopes consensusMaxRotations=7 to request_review only. Contract V3, sealed evidence, UI, custody, and all other writes remain unchanged. Includes TDD and full verification."
~~~

Expected: a new PR URL; no force push.

- [ ] **Step 3: Wait for checks and merge**

~~~powershell
gh pr checks --watch
gh pr merge --merge
~~~

Expected: all required checks PASS and the PR merges without bypassing protection.

### Task 4: Deploy and Verify Production

**Files:** No planned source changes.

**Interfaces:**
- Consumes: merged main, existing Vercel project, and VERCEL_TOKEN from the environment.
- Produces: production hotfix and authoritative on-chain proof.

- [ ] **Step 1: Deploy production without exposing the token**

~~~powershell
if (-not $env:VERCEL_TOKEN) { throw "VERCEL_TOKEN is not set" }
vercel --prod --yes --token $env:VERCEL_TOKEN
~~~

Expected: successful deployment for accessseal-genlayer.vercel.app.

- [ ] **Step 2: Verify public configuration**

~~~powershell
$config = Invoke-RestMethod "https://accessseal-genlayer.vercel.app/config.json"
if ($config.chainId -ne 4221) { throw "Unexpected chain ID" }
if ($config.contractAddress.ToLowerInvariant() -ne "0x08a1969dd75265a58022fb50bbbdd87f9a726265") { throw "Unexpected contract" }
(Invoke-WebRequest "https://accessseal-genlayer.vercel.app").StatusCode
~~~

Expected: chain ID 4221, exact V3 contract, HTTP 200.

- [ ] **Step 3: Submit one production review with action-time confirmation**

Open the exact V3 case URL. Verify Buyer 0x21b45103dd05c43969daf3cbb4277391777e2ec7, lifecycle EVIDENCE_SEALED, and an enabled Request intelligent review button. Stop for confirmation before clicking and stop again for MetaMask approval.

- [ ] **Step 4: Verify the live wrapper encodes seven rotations**

Find the recent Buyer transaction to consensus contract 0x0112bf6e83497965a5fdd6dad1e447a6e004271d and decode the fourth ABI word:

~~~powershell
$raw = $transaction.input.Substring(2)
$rotationWord = $raw.Substring(8 + (3 * 64), 64)
$rotations = [Convert]::ToUInt64($rotationWord, 16)
if ($rotations -ne 7) { throw "Expected 7 rotations, got $rotations" }
~~~

Expected: rotations equals 7.

- [ ] **Step 5: Verify protocol finality and readback**

Poll gen_getTransactionStatus with params containing a txId object. Do not resubmit automatically. Once terminal, require a finalized successful receipt and latest-final reads of get_review, get_review_attempt, and get_review_finality.

Expected: review exists; release digest is sha256:24f0658e502f96bd71786015a8d84fdafdf8f0debad2291da196511bde116b3d; UI matches authoritative readback.

- [ ] **Step 6: Continue settlement through separate confirmations**

Only if the finalized verdict is APPROVED, prepare payout, obtain a fresh confirmation, submit and verify finality/readback, then repeat the confirmation gate for execute settlement. Final success requires DISPATCHED_FINALIZED and conservation readback with reserved and pending cleared and dispatched payout equal to escrow.

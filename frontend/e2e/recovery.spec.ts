import { test, expect } from "./fixtures/wallet";
import { createFundedCase, expectCurrentStage, review, submitRelease, writeAndConfirm } from "./fixtures/workflow";

async function readAccounting(page: import("@playwright/test").Page) {
  const region = page.getByRole("heading", { name: "Conservation readback" }).locator("..");
  const values = await Promise.all(
    ["Total deposits", "Reserved", "Pending", "Dispatched"].map(async (label) =>
      BigInt(
        (
          await region
            .getByText(label, { exact: true })
            .locator("..")
            .locator("strong")
            .textContent()
        )!.trim(),
      ),
    ),
  );
  return values as [bigint, bigint, bigint, bigint];
}

const reviewDecision = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Review decision" });

const settlementRegion = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Settlement" });

async function settlementField(
  page: import("@playwright/test").Page,
  label: "Recipient" | "Intent ID" | "Reason",
) {
  return settlementRegion(page)
    .getByText(label, { exact: true })
    .locator("..")
    .locator("dd")
    .textContent();
}

test("unrelated actor dispatches an immutable rejected refund with conserved accounting", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const [, , , dispatchedBefore] = await readAccounting(page);
  const release = await submitRelease(page, app, caseId, { keyboardTrap: true });
  await review(page, app, release, "REJECTED");
  await expect(reviewDecision(page).getByText("REJECTED", { exact: true })).toBeVisible();
  await writeAndConfirm(page, "Prepare settlement", "SETTLEMENT_PENDING", async () =>
    page.getByText(/REFUND/).isVisible(),
  );
  await expect(page.getByText(/REFUND · 50000 wei/)).toBeVisible();
  await expect(settlementRegion(page)).toContainText(app.addresses.buyer);
  const preparedRecipient = await settlementField(page, "Recipient");
  const preparedIntent = await settlementField(page, "Intent ID");
  const preparedReason = await settlementField(page, "Reason");
  await app.selectRole(page, "outsider");
  await app.connect(page, "outsider");
  await writeAndConfirm(page, "Execute prepared settlement", "DISPATCHED_FINALIZED");
  await expect(page.getByText("DISPATCHED_FINALIZED", { exact: true })).toBeVisible();
  await expect(page.getByText("Recipient confirmation pending")).toBeVisible();
  expect(await settlementField(page, "Recipient")).toBe(preparedRecipient);
  expect(await settlementField(page, "Intent ID")).toBe(preparedIntent);
  expect(await settlementField(page, "Reason")).toBe(preparedReason);
  await expect(settlementRegion(page)).toContainText("REFUND · 50000 wei");
  await expect(settlementRegion(page)).toContainText(app.addresses.buyer);
  const [total, reserved, pending, dispatched] = await readAccounting(page);
  expect(dispatched).toBe(dispatchedBefore + 50_000n);
  expect(total).toBe(reserved + pending + dispatched);
  await page.reload();
  await expect(page.getByText("DISPATCHED_FINALIZED", { exact: true })).toBeVisible();
  expect((await readAccounting(page))[3]).toBe(dispatched);
});

test("prepared hard-timeout refund remains executable without a review verdict and conserves value", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const [, , , dispatchedBefore] = await readAccounting(page);
  await app.prepareHardTimeout(page, caseId);
  await page.reload();

  await expect(settlementRegion(page)).toContainText("HARD_TIMEOUT");
  await expect(settlementRegion(page)).toContainText("PREPARED");
  await app.selectRole(page, "outsider");
  await app.connect(page, "outsider");
  await expect(
    settlementRegion(page).getByRole("button", {
      name: "Execute prepared settlement",
    }),
  ).toBeEnabled();
  await writeAndConfirm(page, "Execute prepared settlement", "DISPATCHED_FINALIZED");

  await expect(settlementRegion(page)).toContainText("DISPATCHED_FINALIZED");
  await expect(settlementRegion(page)).toContainText(app.addresses.buyer);
  const [total, reserved, pending, dispatched] = await readAccounting(page);
  expect(reserved).toBe(0n);
  expect(pending).toBe(0n);
  expect(dispatched).toBe(dispatchedBefore + 50_000n);
  expect(total).toBe(reserved + pending + dispatched);
  await expect(
    settlementRegion(page).getByRole("button", {
      name: "Execute prepared settlement",
    }),
  ).toBeDisabled();
});

test("request-more-info supports a vendor cure epoch", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const incomplete = await submitRelease(page, app, caseId, { supporting: ["HTML_BUNDLE"] });
  await review(page, app, incomplete, "APPROVED", { expectValidatorCallbacks: false });
  await expect(reviewDecision(page).getByText("REQUEST MORE INFO", { exact: true })).toBeVisible();
  await app.selectRole(page, "vendor");
  await app.connect(page, "vendor");
  await writeAndConfirm(page, "Vendor: start cure", "EVIDENCE_OPEN", async () =>
    page.getByText(/Epoch 1/).isVisible(),
  );
  const cure = await submitRelease(page, app, caseId, { epoch: 1 });
  await review(page, app, cure, "APPROVED");
  await expect(reviewDecision(page).getByText("APPROVED", { exact: true })).toBeVisible();
});

test("unavailable evidence overrides an approved LLM candidate and authorizes no payout", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const release = await submitRelease(page, app, caseId);
  const dispatchedBefore = (await readAccounting(page))[3];
  await review(page, app, release, "APPROVED", { unavailableManifest: true });
  await expect(reviewDecision(page).getByText("UNRESOLVED", { exact: true })).toBeVisible();
  await expect(page.getByText("No payout or refund is authorized.")).toBeVisible();
  await expect(
    settlementRegion(page).getByRole("button", { name: "Prepare settlement" }),
  ).toBeDisabled();
  expect((await readAccounting(page))[3]).toBe(dispatchedBefore);
});

test("refresh removes parseable stale and wrong-calldata review provenance", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const release = await submitRelease(page, app, caseId);
  await review(page, app, release, "APPROVED");
  const bindingKey = `accessseal.review-tx.v1:${caseId}`;
  const proofId = (await page.getByText("Proof ID", { exact: true }).locator("..").locator("code").textContent())!.trim();
  const createTx = JSON.parse((await page.evaluate((id) => localStorage.getItem(`accessseal.create-tx.v1:${id}`), caseId))!);
  const liveBinding = {
    txId: createTx.txId,
    chainId: 61127,
    network: "localnet",
    contract: app.contractAddress,
    method: "request_review",
    caseId,
    epoch: 0,
    releaseDigest: release.releaseDigest,
    proofId,
  };
  await page.evaluate(({ key, binding }) => {
    localStorage.setItem(key, JSON.stringify({ ...binding, epoch: binding.epoch + 1 }));
  }, { key: bindingKey, binding: liveBinding });
  await page.reload();
  await expectCurrentStage(page, "DECIDED");
  await expect(reviewDecision(page).getByText("APPROVED", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh readback" }).click();
  await expect(page.getByRole("button", { name: "Reconciling…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh readback" })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), bindingKey)).toBeNull();

  await page.evaluate(({ key, binding, txId }) => {
    localStorage.setItem(key, JSON.stringify({ ...binding, txId }));
  }, { key: bindingKey, binding: liveBinding, txId: createTx.txId });
  await page.getByRole("button", { name: "Refresh readback" }).click();
  await expect(page.getByRole("button", { name: "Reconciling…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh readback" })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), bindingKey)).toBeNull();
});

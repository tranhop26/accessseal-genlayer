import { test, expect } from "./fixtures/wallet";
import type { Route } from "@playwright/test";
import { createFundedCase, expectCurrentStage, review, submitRelease, writeAndConfirm } from "./fixtures/workflow";

async function readAccounting(page: import("@playwright/test").Page) {
  const region = page.getByRole("region", { name: "Simulated escrow" });
  const values = await Promise.all(
    ["Total deposits", "Reserved", "Pending dispatch", "Dispatched"].map(async (label) =>
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
  page.getByRole("region", { name: "Intelligent review" });

const settlementRegion = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Simulated escrow" });

const primaryAction = (page: import("@playwright/test").Page, name: string) =>
  page
    .getByRole("region", { name: "Case summary" })
    .getByRole("button", { name });

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
    settlementRegion(page)
      .getByText("REFUND · 50000 wei", { exact: true })
      .isVisible(),
  );
  await expect(
    settlementRegion(page).getByText("REFUND · 50000 wei", { exact: true }),
  ).toBeVisible();
  await expect(settlementRegion(page)).toContainText(app.addresses.buyer);
  const preparedRecipient = await settlementField(page, "Recipient");
  const preparedIntent = await settlementField(page, "Intent ID");
  const preparedReason = await settlementField(page, "Reason");
  await app.selectRole(page, "outsider");
  await app.connect(page, "outsider");
  await writeAndConfirm(page, "Execute prepared settlement", "DISPATCHED_FINALIZED");
  await expect(settlementRegion(page).getByText("DISPATCHED FINALIZED", { exact: true })).toBeVisible();
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
  await expect(settlementRegion(page).getByText("DISPATCHED FINALIZED", { exact: true })).toBeVisible();
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
    primaryAction(page, "Execute prepared settlement"),
  ).toBeEnabled();
  await writeAndConfirm(page, "Execute prepared settlement", "DISPATCHED_FINALIZED");

  await expect(settlementRegion(page)).toContainText("DISPATCHED FINALIZED");
  await expect(settlementRegion(page)).toContainText(app.addresses.buyer);
  const [total, reserved, pending, dispatched] = await readAccounting(page);
  expect(reserved).toBe(0n);
  expect(pending).toBe(0n);
  expect(dispatched).toBe(dispatchedBefore + 50_000n);
  expect(total).toBe(reserved + pending + dispatched);
  await expect(
    primaryAction(page, "Settlement finalized"),
  ).toBeDisabled();
});

test("request-more-info supports a vendor cure epoch", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const incomplete = await submitRelease(page, app, caseId);
  await review(page, app, incomplete, "REQUEST_MORE_INFO");
  await expect(reviewDecision(page).getByText("REQUEST MORE INFO", { exact: true })).toBeVisible();
  await app.selectRole(page, "vendor");
  await app.connect(page, "vendor");
  await writeAndConfirm(page, "Start bounded cure", "EVIDENCE_OPEN", async () =>
    page.getByText(/Epoch 1/).isVisible(),
  );
  const cure = await submitRelease(page, app, caseId, { epoch: 1 });
  await review(page, app, cure, "APPROVED");
  await expect(reviewDecision(page).getByText("APPROVED", { exact: true })).toBeVisible();
});

test("post-seal unavailable screenshot rejects review atomically and authorizes no payout", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  const release = await submitRelease(page, app, caseId);
  const dispatchedBefore = (await readAccounting(page))[3];
  await expect(
    review(page, app, release, "APPROVED", { unavailableScreenshot: true }),
  ).rejects.toThrow(/review screenshot returned an unavailable response/i);
  await expectCurrentStage(page, "EVIDENCE_SEALED");
  await expect(reviewDecision(page).getByText("Verdict withheld", { exact: true })).toBeVisible();
  await expect(
    primaryAction(page, "Request intelligent review"),
  ).toBeVisible();
  await expect(primaryAction(page, "Prepare settlement")).toHaveCount(0);
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

test("close-evidence recovery fails closed on readback and rechecks the original receipt without resending", async ({ page, accessSeal: app }) => {
  const caseId = await createFundedCase(page, app);
  await submitRelease(page, app, caseId);
  await app.selectRole(page, "buyer");
  await app.connect(page, "buyer");
  await page.evaluate(() =>
    (window as unknown as {
      __accessSealWallet: { takeWalletRequestMethods(): string[] };
    }).__accessSealWallet.takeWalletRequestMethods(),
  );

  let receiptObserved = false;
  let failedReadbacks = 0;
  const routeHandler = async (route: Route) => {
    const payload = route.request().postDataJSON() as { method?: string };
    if (payload.method === "eth_getTransactionByHash") receiptObserved = true;
    if (receiptObserved && payload.method === "gen_call") {
      failedReadbacks += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  };
  await page.route("http://127.0.0.1:4000/api", routeHandler);
  await page
    .getByRole("region", { name: "Case summary" })
    .getByRole("button", { name: "Close evidence & enable review" })
    .click();
  await expect(page.getByRole("button", { name: "Retry transaction status" })).toBeVisible();
  expect(failedReadbacks).toBeGreaterThan(0);
  await expectCurrentStage(page, "EVIDENCE_OPEN");
  const firstAttemptMethods = await page.evaluate(() =>
    (window as unknown as {
      __accessSealWallet: { takeWalletRequestMethods(): string[] };
    }).__accessSealWallet.takeWalletRequestMethods(),
  );
  expect(firstAttemptMethods.filter((method) => method === "eth_sendTransaction")).toHaveLength(1);

  await page.unroute("http://127.0.0.1:4000/api", routeHandler);
  await page.getByRole("button", { name: "Retry transaction status" }).click();
  await expectCurrentStage(page, "EVIDENCE_SEALED");
  const recoveryMethods = await page.evaluate(() =>
    (window as unknown as {
      __accessSealWallet: { takeWalletRequestMethods(): string[] };
    }).__accessSealWallet.takeWalletRequestMethods(),
  );
  expect(recoveryMethods).not.toContain("eth_sendTransaction");
  await expect(
    page
      .getByRole("region", { name: "Intelligent review" })
      .getByText("Exact context and case binding verified", { exact: true }),
  ).toBeVisible();
});

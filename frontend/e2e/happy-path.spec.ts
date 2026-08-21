import { test, expect } from "./fixtures/wallet";
import { createFundedCase, review, submitRelease, writeAndConfirm } from "./fixtures/workflow";

test("buyer, vendor and third party complete a real approved GLSim workflow", async ({ page, accessSeal: app }) => {
  const configResponse = await page.request.get(
    `${app.baseURL}/.well-known/accessseal/config.json`,
  );
  expect(configResponse.ok()).toBe(true);
  expect(configResponse.headers()["content-type"]).toMatch(/^application\/json/);
  expect(await configResponse.json()).toEqual({
    schemaVersion: "accessseal-public-config/1",
    network: "localnet",
    chainId: 61127,
    contractAddress: app.contractAddress,
    safeTestConfig: false,
  });
  const caseId = await createFundedCase(page, app, {
    proveFailedFundCannotAdvance: true,
  });
  const release = await submitRelease(page, app, caseId);
  await review(page, app, release, "APPROVED");
  await expect(
    page
      .getByRole("region", { name: "Review decision" })
      .getByText("APPROVED", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Review decision" })
      .getByText("APPROVED", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("FINALIZED", { exact: true })).toBeVisible();
  await app.selectRole(page, "outsider");
  await app.connect(page, "outsider");
  await writeAndConfirm(page, "Prepare settlement", "SETTLEMENT_PENDING", async () =>
    page.getByText(/PAYOUT/).isVisible(),
  );
  await expect(page.getByText(/PAYOUT · 50000 wei/)).toBeVisible();
  await writeAndConfirm(page, "Execute prepared settlement", "DISPATCHED_FINALIZED");
  await expect(page.getByText("DISPATCHED_FINALIZED", { exact: true })).toBeVisible();
  await expect(page.getByText("Recipient confirmation pending")).toBeVisible();
  await expect(page.getByText(/Child receipt or recipient balance has not yet been confirmed/)).toBeVisible();
});

test("wallet rejection and wrong network remain distinct", async ({ page, accessSeal: app }) => {
  await page.goto(`${app.baseURL}/cases/new`);
  await app.setWalletMode(page, "reject");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    page.getByText("Wallet connection was rejected. No transaction was sent.", {
      exact: true,
    }),
  ).toBeVisible();

  await app.setWalletMode(page, "wrong-network");
  await page.getByRole("button", { name: /connect wallet|switch network/i }).click();
  await expect(
    page.getByText(
      "Wallet is on the wrong network. Switch to the configured GenLayer network.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch network" })).toBeVisible();

  await app.setWalletMode(page, "ready");
  await page.getByRole("button", { name: /connect wallet|switch network/i }).click();
  await expect(page.getByRole("button", { name: new RegExp(`disconnect wallet ${app.addresses.buyer}`, "i") })).toBeVisible();
});

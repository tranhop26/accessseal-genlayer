import { test, expect } from "./fixtures/wallet";
import {
  createFundedCase,
  expectCurrentStage,
  review,
  submitRelease,
  writeAndConfirm,
} from "./fixtures/workflow";

async function beginTransactionPhaseCapture(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const observed: string[] = [];
    const capture = () => {
      for (const status of document.querySelectorAll('[role="status"][aria-live="polite"]')) {
        const value = status.textContent?.replace(/\s+/g, " ").trim();
        if (value && observed.at(-1) !== value) observed.push(value);
      }
    };
    capture();
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    Object.assign(window, { __accessSealPhaseCapture: { observed, observer } });
  });
}

async function finishTransactionPhaseCapture(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const capture = (window as unknown as {
      __accessSealPhaseCapture: { observed: string[]; observer: MutationObserver };
    }).__accessSealPhaseCapture;
    capture.observer.disconnect();
    return capture.observed;
  });
}

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
    gateAuthoritativeReadback: true,
  });
  await expectCurrentStage(page, "FUNDED");
  const release = await submitRelease(page, app, caseId, {
    gateAuthoritativeReadback: true,
  });
  await expectCurrentStage(page, "EVIDENCE_OPEN");

  await app.selectRole(page, "buyer");
  await app.connect(page, "buyer");
  await app.holdNextTransaction(page);
  const closeEvidenceReadbackProof = {
    gateAuthoritativeReadback: true,
    afterActionClick: async () => {
      await expect(page.getByRole("dialog", { name: "Confirm evidence seal" })).toBeVisible();
      await expectCurrentStage(page, "EVIDENCE_OPEN");
      await app.releaseHeldTransaction(page);
    },
  };
  await writeAndConfirm(
    page,
    "Close evidence & enable review",
    "EVIDENCE_SEALED",
    async () =>
      page
        .getByRole("region", { name: "Intelligent review" })
        .getByText("Context ready")
        .isVisible(),
    closeEvidenceReadbackProof,
  );

  await beginTransactionPhaseCapture(page);
  await review(page, app, release, "APPROVED", {
    gateAuthoritativeReadback: true,
    holdWalletConfirmation: true,
  });
  const observedReviewPhases = (await finishTransactionPhaseCapture(page)).join(" | ");
  for (const phase of [
    "Waiting for wallet confirmation",
    "Transaction submitted",
    "Finalized execution succeeded",
    "Readback confirmed",
  ]) expect(observedReviewPhases).toContain(phase);
  await expectCurrentStage(page, "DECIDED");
  await expect(
    page
      .getByRole("region", { name: "Intelligent review" })
      .getByText("APPROVED", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Intelligent review" })
      .getByText("APPROVED", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("FINALIZED", { exact: true })).toBeVisible();
  await app.selectRole(page, "outsider");
  await app.connect(page, "outsider");
  await writeAndConfirm(page, "Prepare settlement", "SETTLEMENT_PENDING", async () =>
    page
      .getByRole("region", { name: "Simulated escrow" })
      .getByText("PAYOUT · 50000 wei", { exact: true })
      .isVisible(),
    { gateAuthoritativeReadback: true },
  );
  await expect(
    page
      .getByRole("region", { name: "Simulated escrow" })
      .getByText("PAYOUT · 50000 wei", { exact: true }),
  ).toBeVisible();
  await writeAndConfirm(
    page,
    "Execute prepared settlement",
    "DISPATCHED_FINALIZED",
    async () => true,
    { gateAuthoritativeReadback: true },
  );
  await expect(
    page
      .getByRole("region", { name: "Simulated escrow" })
      .getByText("DISPATCHED FINALIZED", { exact: true }),
  ).toBeVisible();
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

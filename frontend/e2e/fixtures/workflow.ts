import { expect, type Page } from "@playwright/test";
import { requireValidatorTelemetry, type AccessSealRuntime, type ReleaseFixture } from "./wallet";

type Stage =
  | "DRAFT"
  | "FUNDED"
  | "EVIDENCE_OPEN"
  | "REVIEW_PENDING"
  | "DECIDED"
  | "SETTLEMENT_PENDING"
  | "DISPATCHED_FINALIZED";

async function failOnVisibleError(page: Page): Promise<void> {
  const alerts = page.getByRole("alert");
  for (let index = 0; index < (await alerts.count()); index += 1) {
    const alert = alerts.nth(index);
    if (await alert.isVisible()) {
      const message = (await alert.textContent())?.trim();
      if (message) throw new Error(`wallet write failed before authoritative transition: ${message}`);
    }
  }
}

export async function expectCurrentStage(page: Page, stage: Stage): Promise<void> {
  await expect
    .poll(async () => {
      await failOnVisibleError(page);
      return (await page.getByRole("list", { name: "Case lifecycle" })
        .locator('[aria-current="step"]')
        .textContent())?.trim();
    })
    .toBe(stage.replaceAll("_", " ").toLowerCase());
}

async function transactionHash(page: Page): Promise<string> {
  const code = page.getByRole("status").locator("code");
  return (await code.isVisible() ? await code.textContent() : "")?.trim() ?? "";
}

export async function writeAndConfirm(
  page: Page,
  buttonName: string,
  stage: Stage,
  authoritativeReadback: () => Promise<boolean> = async () => true,
): Promise<void> {
  await failOnVisibleError(page);
  const previousHash = await transactionHash(page);
  const summaryAction = page
    .getByRole("region", { name: "Case summary" })
    .getByRole("button", { name: buttonName, exact: true });
  const action = (await summaryAction.count()) > 0
    ? summaryAction
    : page.getByRole("button", { name: buttonName, exact: true });
  await action.click();
  const handle = await page.waitForFunction(
    ({ expectedStage, priorHash }) => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const alert = [...document.querySelectorAll('[role="alert"]')].find(
        (element) => visible(element) && element.textContent?.trim(),
      );
      if (alert) return { error: alert.textContent!.trim() };
      const current = document.querySelector('[aria-label="Case lifecycle"] [aria-current="step"]')
        ?.textContent?.trim();
      const status = [...document.querySelectorAll('[role="status"]')].find(
        (element) =>
          element.querySelector('[aria-current="step"]')?.textContent?.trim() ===
          "Readback confirmed",
      );
      const nextHash = status?.querySelector("code")?.textContent?.trim() ?? "";
      if (current === expectedStage && nextHash && nextHash !== priorHash)
        return { success: true };
      return null;
    },
    {
      expectedStage: stage.replaceAll("_", " ").toLowerCase(),
      priorHash: previousHash,
    },
  );
  const result = (await handle.jsonValue()) as { error?: string; success?: boolean };
  if (result.error)
    throw new Error(`wallet write failed before authoritative transition: ${result.error}`);
  await expect.poll(authoritativeReadback).toBe(true);
  await failOnVisibleError(page);
}

export async function createFundedCase(
  page: Page,
  app: AccessSealRuntime,
  options: { proveFailedFundCannotAdvance?: boolean } = {},
): Promise<string> {
  await page.goto(`${app.baseURL}/cases/new`);
  await app.connect(page, "buyer");
  await page.getByLabel("Vendor wallet").fill(app.addresses.vendor);
  await page.getByRole("button", { name: "Continue to terms" }).click();
  await page.getByLabel("Website origin").fill(app.subjectOrigin);
  await page.getByLabel("Accessibility profile hash").fill(app.profileHash);
  await page.getByLabel("Critical flow 1").fill("Keyboard checkout");
  await page.getByLabel("Critical flow 2").fill("Labeled account creation");
  await page.getByLabel("Critical flow 3").fill("Order status announcement");
  await page.getByLabel("Simulated escrow (wei)").fill(app.escrow);
  await page.getByRole("button", { name: "Review locked terms" }).click();
  await expect(page.getByRole("heading", { name: "Verify immutable bindings" })).toBeVisible();
  await expect(page.getByText("Ready for wallet signature", { exact: true })).toBeVisible();
  const caseId = (await page.locator("details code").first().textContent())!.trim();
  await page.getByRole("button", { name: "Create case on GenLayer" }).click();
  await page.waitForURL(new RegExp(`/cases/${caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expectCurrentStage(page, "DRAFT");

  await app.selectRole(page, "vendor");
  await app.connect(page, "vendor");
  await writeAndConfirm(page, "Accept exact terms", "DRAFT", async () =>
    page.getByRole("button", { name: "Accept exact terms" }).isHidden(),
  );

  await app.selectRole(page, "buyer");
  await app.connect(page, "buyer");
  if (options.proveFailedFundCannotAdvance) {
    await app.setWalletMode(page, "reject");
    await expect(writeAndConfirm(page, "Fund simulated escrow", "FUNDED")).rejects.toThrow(
      /wallet write failed.*rejected/i,
    );
    await expect(
      page.getByRole("list", { name: "Case lifecycle" }).locator('[aria-current="step"]'),
    ).toHaveText("draft");
    await page.reload();
    await app.setWalletMode(page, "ready");
    await app.connect(page, "buyer");
  }
  await writeAndConfirm(page, "Fund simulated escrow", "FUNDED", async () => {
    const reserved = await page
      .getByRole("region", { name: "Terms" })
      .getByText(`${app.escrow} wei`, { exact: true })
      .count();
    return reserved >= 2;
  });
  return caseId;
}

export async function submitRelease(page: Page, app: AccessSealRuntime, caseId: string, options: Parameters<AccessSealRuntime["buildRelease"]>[1] = {}): Promise<ReleaseFixture> {
  await app.selectRole(page, "vendor");
  await app.connect(page, "vendor");
  const release = app.buildRelease(caseId, options);
  for (const [index, envelope] of release.envelopes.entries()) {
    const input = page.getByLabel("Evidence envelope JSON");
    await input.fill(JSON.stringify(envelope));
    await page.getByRole("button", { name: "Validate canonical preview" }).click();
    await expect(
      page.getByRole("button", { name: "Sign and submit evidence" }),
    ).toBeEnabled();
    await writeAndConfirm(
      page,
      "Sign and submit evidence",
      "EVIDENCE_OPEN",
      async () =>
        (await page
          .getByRole("region", { name: "Evidence trail" })
          .getByRole("article")
          .count()) === index + 1,
    );
  }
  await expect(page.getByRole("heading", { name: "Request validator consensus" })).toBeVisible();
  return release;
}

export async function review(page: Page, app: AccessSealRuntime, release: ReleaseFixture, verdict: "APPROVED" | "REJECTED" | "UNRESOLVED", options: { unavailableManifest?: boolean; expectValidatorCallbacks?: boolean } = {}): Promise<void> {
  await app.setReviewTime(page);
  await app.installReview(release, verdict, options);
  await app.resetValidatorTelemetry();
  const negativeControl = await app.readValidatorTelemetry();
  expect(() => requireValidatorTelemetry(negativeControl)).toThrow(/validator callbacks/i);
  await app.selectRole(page, "reviewer");
  await app.connect(page, "reviewer");
  await writeAndConfirm(page, "Request intelligent review", "DECIDED", async () =>
    page.getByRole("heading", { name: "Review decision" }).isVisible(),
  );
  await expect(page.getByRole("heading", { name: "Review decision" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("FINALIZED", { exact: true })).toBeVisible();
  expect(await app.readValidatorTelemetry()).toEqual(
    options.expectValidatorCallbacks === false
      ? { callbackInvocations: 0, capturedValidatorSessions: 0, consensusSessions: 1 }
      : { callbackInvocations: 5, capturedValidatorSessions: 1, consensusSessions: 1 },
  );
}

import { expect, type Page, type Route } from "@playwright/test";
import { requireValidatorTelemetry, type AccessSealRuntime, type ReleaseFixture } from "./wallet";

type Stage =
  | "DRAFT"
  | "FUNDED"
  | "EVIDENCE_OPEN"
  | "EVIDENCE_SEALED"
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
      return (await page
        .getByRole("region", { name: "Case summary" })
        .getByText("Lifecycle", { exact: true })
        .locator("..")
        .locator("dd")
        .textContent())?.trim();
    })
    .toBe(stage.replaceAll("_", " "));
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
  options: { gateAuthoritativeReadback?: boolean } = {},
): Promise<void> {
  await failOnVisibleError(page);
  const previousHash = await transactionHash(page);
  const previousLifecycle = (await page
    .getByRole("region", { name: "Case summary" })
    .getByText("Lifecycle", { exact: true })
    .locator("..")
    .locator("dd")
    .textContent())?.trim();
  const summaryAction = page
    .getByRole("region", { name: "Case summary" })
    .getByRole("button", { name: buttonName, exact: true });
  const action = (await summaryAction.count()) > 0
    ? summaryAction
    : page.getByRole("button", { name: buttonName, exact: true });
  let releaseReadback: (() => void) | undefined;
  let observedAuthoritativeRead: Promise<void> | undefined;
  let resolveAuthoritativeRead: (() => void) | undefined;
  let readbackGate: Promise<void> | undefined;
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  if (options.gateAuthoritativeReadback) {
    observedAuthoritativeRead = new Promise<void>((resolve) => {
      resolveAuthoritativeRead = resolve;
    });
    readbackGate = new Promise<void>((resolve) => {
      releaseReadback = resolve;
    });
    let receiptObserved = false;
    routeHandler = async (route) => {
      const payload = route.request().postDataJSON() as { method?: string };
      if (payload.method === "eth_getTransactionByHash")
        receiptObserved = true;
      if (receiptObserved && payload.method === "gen_call") {
        resolveAuthoritativeRead?.();
        await readbackGate;
      }
      await route.continue();
    };
    await page.route("http://127.0.0.1:4000/api", routeHandler);
  }
  await action.click();
  if (observedAuthoritativeRead) {
    await observedAuthoritativeRead;
    await expect(
      page.locator('section[role="status"][aria-live="polite"]'),
    ).toContainText("Finalized execution succeeded");
    expect(previousLifecycle).toBeTruthy();
    await expectCurrentStage(page, previousLifecycle!.replaceAll(" ", "_") as Stage);
    releaseReadback?.();
  }
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
      const current = [...document.querySelectorAll("dt")]
        .find((element) => element.textContent?.trim() === "Lifecycle")
        ?.parentElement?.querySelector("dd")?.textContent?.trim();
      const status = [...document.querySelectorAll('[role="status"]')].find(
        (element) =>
          element.querySelector('[aria-current="step"]')?.textContent?.trim() ===
          "Readback confirmed",
      );
      const nextHash = status?.querySelector("code")?.textContent?.trim() ?? "";
      if (current === expectedStage && nextHash && nextHash !== priorHash)
        return { success: true };
      const transactionStatus = document.querySelector('section[role="status"][aria-live="polite"]');
      const phase = transactionStatus?.querySelector("h2")?.textContent?.trim() ?? "";
      const failedHash = transactionStatus?.querySelector("code")?.textContent?.trim() ?? "";
      if (
        failedHash &&
        failedHash !== priorHash &&
        /rpc error|execution error|rejected|timeout|deterministic violation|readback mismatch/i.test(phase)
      ) return { error: `${phase}: ${transactionStatus?.querySelector("p")?.textContent?.trim() ?? "transaction failed"} (${failedHash})` };
      return null;
    },
    {
      expectedStage: stage.replaceAll("_", " "),
      priorHash: previousHash,
    },
  );
  const result = (await handle.jsonValue()) as { error?: string; success?: boolean };
  if (result.error)
    throw new Error(`wallet write failed before authoritative transition: ${result.error}`);
  await expect.poll(authoritativeReadback).toBe(true);
  await failOnVisibleError(page);
  if (routeHandler)
    await page.unroute("http://127.0.0.1:4000/api", routeHandler);
}

export async function createFundedCase(
  page: Page,
  app: AccessSealRuntime,
  options: {
    proveFailedFundCannotAdvance?: boolean;
    gateAuthoritativeReadback?: boolean;
  } = {},
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
    { gateAuthoritativeReadback: options.gateAuthoritativeReadback },
  );

  await app.selectRole(page, "buyer");
  await app.connect(page, "buyer");
  const reservedValue = page
    .getByRole("region", { name: "Simulated escrow" })
    .getByText("Reserved", { exact: true })
    .locator("..")
    .locator("strong");
  const reservedBefore = BigInt((await reservedValue.textContent())!.trim());
  if (options.proveFailedFundCannotAdvance) {
    await app.setWalletMode(page, "reject");
    await expect(writeAndConfirm(page, "Fund simulated escrow", "FUNDED")).rejects.toThrow(
      /wallet write failed.*rejected/i,
    );
    await expect(
      page
        .getByRole("region", { name: "Case summary" })
        .getByText("Lifecycle", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("DRAFT");
    await page.reload();
    await app.setWalletMode(page, "ready");
    await app.connect(page, "buyer");
  }
  await writeAndConfirm(page, "Fund simulated escrow", "FUNDED", async () => {
    const reservedAfter = BigInt((await reservedValue.textContent())!.trim());
    return reservedAfter === reservedBefore + BigInt(app.escrow);
  }, { gateAuthoritativeReadback: options.gateAuthoritativeReadback });
  return caseId;
}

export async function submitRelease(
  page: Page,
  app: AccessSealRuntime,
  caseId: string,
  options: (Parameters<AccessSealRuntime["buildRelease"]>[1] & {
    gateAuthoritativeReadback?: boolean;
  }) = {},
): Promise<ReleaseFixture> {
  await app.selectRole(page, "vendor");
  await app.connect(page, "vendor");
  const { gateAuthoritativeReadback, ...releaseOptions } = options;
  const release = app.buildRelease(caseId, releaseOptions);
  await app.installEvidence(release);
  for (const [index, envelope] of release.envelopes.entries()) {
    const input = page.getByLabel("Evidence envelope JSON");
    await input.fill(JSON.stringify(envelope));
    await page.getByRole("button", { name: "Validate canonical preview" }).click();
    await expect(
      page.getByRole("button", { name: "Submit evidence" }),
    ).toBeEnabled();
    await writeAndConfirm(
      page,
      "Submit evidence",
      "EVIDENCE_OPEN",
      async () =>
        (await page
          .getByRole("region", { name: "Evidence workspace" })
          .getByRole("article")
          .count()) === index + 1,
      { gateAuthoritativeReadback },
    );
  }
  await expectCurrentStage(page, "EVIDENCE_OPEN");
  await expect(
    page
      .getByRole("region", { name: "Case summary" })
      .getByRole("button", { name: "Close evidence & enable review" }),
  ).toBeVisible();
  return release;
}

export async function closeEvidence(
  page: Page,
  app: AccessSealRuntime,
  options: { gateAuthoritativeReadback?: boolean } = {},
): Promise<void> {
  await app.selectRole(page, "buyer");
  await app.connect(page, "buyer");
  await writeAndConfirm(
    page,
    "Close evidence & enable review",
    "EVIDENCE_SEALED",
    async () =>
      page
        .getByRole("region", { name: "Intelligent review" })
        .getByText("Exact context and case binding verified", { exact: true })
        .isVisible(),
    options,
  );
  await expect(
    page
      .getByRole("region", { name: "Intelligent review" })
      .getByText("Exact context and case binding verified", { exact: true }),
  ).toBeVisible();
}

export async function review(
  page: Page,
  app: AccessSealRuntime,
  release: ReleaseFixture,
  verdict: "APPROVED" | "REJECTED" | "REQUEST_MORE_INFO" | "UNRESOLVED",
  options: {
    unavailableScreenshot?: boolean;
    expectValidatorCallbacks?: boolean;
    gateAuthoritativeReadback?: boolean;
    holdWalletConfirmation?: boolean;
  } = {},
): Promise<void> {
  const closeAction = page
    .getByRole("region", { name: "Case summary" })
    .getByRole("button", { name: "Close evidence & enable review" });
  if (await closeAction.isVisible())
    await closeEvidence(page, app, {
      gateAuthoritativeReadback: options.gateAuthoritativeReadback,
    });
  await app.setReviewTime(page);
  await app.installReview(release, verdict, options);
  await app.resetValidatorTelemetry();
  const negativeControl = await app.readValidatorTelemetry();
  expect(() => requireValidatorTelemetry(negativeControl)).toThrow(/validator callbacks/i);
  await app.selectRole(page, "reviewer");
  await app.connect(page, "reviewer");
  try {
    if (options.holdWalletConfirmation) await app.holdNextTransaction(page);
    const reviewWrite = writeAndConfirm(page, "Request intelligent review", "DECIDED", async () =>
        page
          .getByRole("region", { name: "Intelligent review" })
          .getByText("Finalized verdict", { exact: true })
          .isVisible(),
        { gateAuthoritativeReadback: options.gateAuthoritativeReadback },
      );
    if (options.holdWalletConfirmation) {
      await expect(
        page.locator('[role="status"][aria-live="polite"]').filter({
          hasText: "Waiting for wallet confirmation",
        }),
      ).toBeVisible();
      await expectCurrentStage(page, "EVIDENCE_SEALED");
      await app.releaseHeldTransaction(page);
    }
    await reviewWrite;
  } catch (error) {
    const hash = await transactionHash(page);
    const receipt = hash ? await app.readTransaction(hash) : null;
    const caseId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const readback = caseId ? await app.diagnoseCase(caseId) : "case ID unavailable";
    throw new Error(`${error instanceof Error ? error.message : String(error)}; authoritative receipt: ${JSON.stringify(receipt)}; ${readback}`);
  }
  await expect(
    page
      .getByRole("region", { name: "Intelligent review" })
      .getByText("Finalized verdict", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByRole("region", { name: "Intelligent review" })
      .getByText("FINALIZED", { exact: true }),
  ).toBeVisible();
  expect(await app.readValidatorTelemetry()).toMatchObject(
    options.expectValidatorCallbacks === false
      ? { callbackInvocations: 0, capturedValidatorSessions: 0, consensusSessions: 1 }
      : { callbackInvocations: 5, capturedValidatorSessions: 1, consensusSessions: 1 },
  );
}

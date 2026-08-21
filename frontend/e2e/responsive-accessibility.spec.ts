import AxeBuilder from "@axe-core/playwright";
import { test, expect, type AccessSealRuntime } from "./fixtures/wallet";
import { expectCurrentStage } from "./fixtures/workflow";
import type { Page, Route } from "@playwright/test";

async function expectVisibleFocus(page: Page, name: string | RegExp) {
  const focused = page.locator(":focus");
  await expect(focused).toHaveAccessibleName(name);
  expect(await focused.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
}

async function assertHeadingOrder(page: Page) {
  const levels = await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((nodes) =>
    nodes.map((node) => Number(node.tagName.slice(1))),
  );
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  for (let index = 1; index < levels.length; index += 1)
    expect(levels[index]).toBeLessThanOrEqual(levels[index - 1]! + 1);
}

async function assertPageAccessibility(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await assertHeadingOrder(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
}

async function moveToReview(page: Page, app: AccessSealRuntime) {
  await app.connect(page, "buyer");
  await page.getByLabel("Vendor wallet").fill(app.addresses.vendor);
  await page.getByRole("button", { name: "Continue to terms" }).click();
  await page.getByLabel("Website origin").fill(app.subjectOrigin);
  await page.getByLabel("Accessibility profile hash").fill(app.profileHash);
  await page.getByLabel("Critical flow 1").fill("Browse catalog");
  await page.getByLabel("Critical flow 2").fill("Complete checkout");
  await page.getByLabel("Critical flow 3").fill("Track delivery");
  await page.getByLabel("Simulated escrow (wei)").fill(app.escrow);
  await page.getByRole("button", { name: "Review locked terms" }).click();
  await expect(page.getByRole("button", { name: "Create case on GenLayer" })).toBeFocused();
}

async function createCase(page: Page, app: AccessSealRuntime): Promise<string> {
  await moveToReview(page, app);
  const caseId = (await page.locator("details code").first().textContent())!.trim();
  await page.getByRole("button", { name: "Create case on GenLayer" }).press("Enter");
  await page.waitForURL(new RegExp(`/cases/${caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  return caseId;
}

async function takeWalletRequestMethods(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as {
      __accessSealWallet: { takeWalletRequestMethods(): string[] };
    }).__accessSealWallet.takeWalletRequestMethods(),
  );
}

test("changes wallet account and invalidates the stale case preview", async ({ page, accessSeal: app }) => {
  const browserErrors: string[] = [];
  const submittedTransactions: unknown[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url() !== app.walletBridgeURL) return;
    const payload = request.postDataJSON() as { method?: string };
    if (payload.method === "eth_sendTransaction") submittedTransactions.push(payload);
  });

  await page.goto(`${app.baseURL}/cases/new`);
  await moveToReview(page, app);
  await expect(page.getByText("Ready for wallet signature", { exact: true })).toBeVisible();

  await takeWalletRequestMethods(page);
  await app.selectNextRole(page, "vendor");
  await page.getByRole("button", { name: "Change wallet" }).click();

  const alternateWallet = page.getByRole("button", {
    name: new RegExp(`disconnect wallet ${app.addresses.vendor}`, "i"),
  });
  await expect(alternateWallet).toBeVisible();
  await expect(alternateWallet).toHaveAttribute("data-wallet-address", app.addresses.vendor);
  await app.connect(page, "vendor");
  const switchMethods = await takeWalletRequestMethods(page);
  expect(switchMethods.slice(0, 2)).toEqual(["wallet_requestPermissions", "eth_accounts"]);
  expect(switchMethods).not.toContain("eth_requestAccounts");
  await expect(page.getByText("Ready for wallet signature", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Create case on GenLayer" })).toBeHidden();
  expect(submittedTransactions).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("audits landing, empty dashboard, review, and readback errors at desktop and mobile sizes", async ({ page, accessSeal: app }) => {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);

    await page.goto(app.baseURL);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await assertPageAccessibility(page);

    await page.goto(`${app.baseURL}/cases`);
    await expect(page.getByText("No locally known cases")).toBeVisible();
    await assertPageAccessibility(page);

    await page.goto(`${app.baseURL}/cases/new`);
    await moveToReview(page, app);
    await expect(page.getByRole("heading", { name: "Verify immutable bindings" })).toBeVisible();
    await assertPageAccessibility(page);

    await page.goto(`${app.baseURL}/cases/sha256:${"0".repeat(64)}`);
    await expect(page.getByRole("heading", { name: "Case readback" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Readback unavailable" })).toBeVisible();
    await assertPageAccessibility(page);
  }
});

test("keeps the responsive workspace shell, structured dashboard, and case detail semantic", async ({ page, accessSeal: app }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${app.baseURL}/cases/new`);
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);

  const caseId = await createCase(page, app);
  await page.goto(`${app.baseURL}/cases`);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Case ID" })).toBeVisible();
  await assertPageAccessibility(page);

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.getByRole("navigation", { name: "Workspace shortcuts" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Mobile workspace" })).toBeVisible();
  await expect(page.getByLabel("Mobile case rows")).toBeVisible();
  await expect(page.getByLabel("Mobile case rows")).toContainText("Case ID");
  await expect(page.getByRole("table")).toBeHidden();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
  await assertPageAccessibility(page);

  await page.goto(`${app.baseURL}/cases/${caseId}`);
  await expect(page.getByRole("navigation", { name: "Case sections" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const priorityAction = page.getByText("Priority action", { exact: true }).locator("..");
  await expect(priorityAction).toBeVisible();
  expect(await priorityAction.evaluate((element) => element.closest("dl"))).toBeNull();
  await assertHeadingOrder(page);
  await assertPageAccessibility(page);
});

test("audits the real pending transaction state at desktop and mobile sizes", async ({ page, accessSeal: app }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${app.baseURL}/cases/new`);
    await app.selectRole(page, "buyer");
    await createCase(page, app);
    await app.selectRole(page, "vendor");
    await app.connect(page, "vendor");
    const acceptTerms = page
      .getByRole("region", { name: "Case summary" })
      .getByRole("button", { name: "Accept exact terms" });
    await expect(acceptTerms).toBeEnabled();

    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const rpcUrl = "http://127.0.0.1:4000/api";
    const activeRoutes = new Set<Promise<void>>();
    const routeHandler = async (route: Route) => {
      const task = (async () => {
        const payload = route.request().postDataJSON() as { method?: string };
        if (payload.method === "eth_getTransactionByHash") await receiptGate;
        await route.continue();
      })();
      activeRoutes.add(task);
      try {
        await task;
      } finally {
        activeRoutes.delete(task);
      }
    };
    await page.route(rpcUrl, routeHandler);
    try {
      await acceptTerms.click();
      await expect(page.getByRole("status")).toHaveAttribute("data-tone", "pending");
      await expect(page.getByRole("status")).toContainText("Transaction submitted");
      await expect(page.getByText(/waiting for validator acceptance/i)).toBeVisible();
      await assertPageAccessibility(page);
    } finally {
      releaseReceipt();
    }
    await expect(page.getByText("Readback confirmed", { exact: true })).toBeVisible();
    await Promise.all(activeRoutes);
    await page.unroute(rpcUrl, routeHandler);
  }
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1000, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} completes a write by keyboard and keeps populated state accessible`, async ({ page, accessSeal: app }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${app.baseURL}/cases/new`);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("navigation", {
      name: viewport.name === "desktop"
        ? "Workspace"
        : viewport.name === "tablet"
          ? "Workspace shortcuts"
          : "Mobile workspace",
    })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await assertPageAccessibility(page);

    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Skip to content");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await page.getByRole("button", { name: "Connect wallet" }).focus();
    await page.keyboard.press("Enter");
    const disconnectName = new RegExp(`disconnect wallet ${app.addresses.buyer}`, "i");
    await expect(page.getByRole("button", { name: disconnectName })).toBeVisible();
    await page.getByLabel("Vendor wallet").focus();
    await expectVisibleFocus(page, "Vendor wallet");
    await page.keyboard.press("Shift+Tab");
    await expectVisibleFocus(page, "Change wallet");
    await page.keyboard.press("Shift+Tab");
    await expectVisibleFocus(page, disconnectName);
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Change wallet");
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Vendor wallet");
    await page.keyboard.insertText(app.addresses.vendor);
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Continue to terms");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Website origin")).toBeFocused();
    for (const [label, value] of [
      ["Website origin", app.subjectOrigin],
      ["Accessibility profile hash", app.profileHash],
      ["Critical flow 1", "Browse catalog"],
      ["Critical flow 2", "Complete checkout"],
      ["Critical flow 3", "Track delivery"],
      ["Simulated escrow (wei)", app.escrow],
    ] as const) {
      await page.getByLabel(label).focus();
      await page.keyboard.insertText(value);
    }
    await page.getByRole("button", { name: "Review locked terms" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Create case on GenLayer" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expectCurrentStage(page, "DRAFT");
    // Finalization routes directly to the authoritative detail readback.
    await expect(page.getByText("Authoritative case readback", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Case summary", exact: true })).toBeVisible();
    await assertPageAccessibility(page);
  });
}

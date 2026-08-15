import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures/wallet";
import { expectCurrentStage } from "./fixtures/workflow";
import type { Page } from "@playwright/test";

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

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} completes a write by keyboard and keeps populated state accessible`, async ({ page, accessSeal: app }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${app.baseURL}/cases/new`);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await assertPageAccessibility(page);

    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Skip to content");
    for (const name of ["AccessSeal home", "Cases", "Create case", "Connect wallet"]) {
      await page.keyboard.press("Tab");
      await expectVisibleFocus(page, name);
    }
    await page.keyboard.press("Shift+Tab");
    await expectVisibleFocus(page, "Create case");
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Connect wallet");
    const motion = await page.locator(".preview-placeholder").evaluate((element) => getComputedStyle(element).animationDuration);
    const durationSeconds = motion.endsWith("ms") ? Number.parseFloat(motion) / 1000 : Number.parseFloat(motion);
    expect(durationSeconds).toBeLessThanOrEqual(0.001);

    await page.keyboard.press("Enter");
    const disconnectName = new RegExp(`disconnect wallet ${app.addresses.buyer}`, "i");
    await expect(page.getByRole("button", { name: disconnectName })).toBeVisible();
    await expectVisibleFocus(page, disconnectName);
    for (const [label, value] of [
      ["Vendor wallet", app.addresses.vendor],
      ["Website origin", app.subjectOrigin],
      ["Accessibility profile hash", app.profileHash],
      ["Critical flow 1", "Browse catalog"],
      ["Critical flow 2", "Complete checkout"],
      ["Critical flow 3", "Track delivery"],
      ["Simulated escrow (wei)", app.escrow],
    ] as const) {
      await page.keyboard.press("Tab");
      await expectVisibleFocus(page, label);
      await page.keyboard.insertText(value);
    }
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Preview locked terms");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Ready for wallet signature" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page, "Create case on GenLayer");
    await page.keyboard.press("Enter");
    await expectCurrentStage(page, "DRAFT");
    await expect(page.getByText("Finalized contract readback")).toBeVisible();
    await assertPageAccessibility(page);
  });
}

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LIVE_EVIDENCE_BINDING,
  type LiveCapture,
  validateLiveCapture,
} from "../../scripts/live-evidence-schema";

const captureDirectory = resolve("../work/evidence/live-capture");
const outputNames = [
  "release.html",
  "screenshot.png",
  "dom-facts.json",
  "scanner-report.json",
  "critical-flow-trace.json",
] as const;

type FlowStep = {
  action: string;
  expected: string;
  actual: string;
  passed: true;
};

async function visibleFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) throw new Error("document has no active element");
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0 &&
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > 0 &&
      box.right > 0 &&
      box.top < innerHeight &&
      box.left < innerWidth;
    if (!visible) throw new Error("focused element is hidden or obscured");
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (hit && !element.contains(hit) && !hit.contains(element))
      throw new Error("focused element is obscured by another element");
    const identity =
      element.getAttribute("aria-label") ||
      element.id ||
      element.getAttribute("name") ||
      element.getAttribute("role") ||
      (element.children.length === 0 ? element.textContent?.trim() : "") ||
      element.tagName.toLowerCase();
    return identity.replace(/\s+/g, " ").slice(0, 120);
  });
}

async function assertNoMeaninglessAltText(page: Page): Promise<void> {
  const invalidAlt = await page.locator("img").evaluateAll((images) =>
    images
      .filter((image) => !image.hasAttribute("alt") || image.getAttribute("alt")?.trim() === "")
      .filter((image) => image.getAttribute("role") !== "presentation" && !image.getAttribute("aria-hidden"))
      .map((image) => image.getAttribute("src") || "missing src"),
  );
  expect(invalidAlt).toEqual([]);
}

async function domFacts(page: Page, url: string) {
  return page.locator("main").evaluate((main, pageUrl) => {
    const landmarks = [...document.querySelectorAll("header, main, nav, footer, [role]")]
      .map((element) => element.getAttribute("role") || element.tagName.toLowerCase())
      .filter((landmark, index, all) => all.indexOf(landmark) === index);
    const labelledControls = [...main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")].every((control) =>
      Boolean(
        control.getAttribute("aria-label") ||
          control.getAttribute("aria-labelledby") ||
          control.labels?.length ||
          (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)),
      ),
    );
    return { url: pageUrl, landmarks, labelledControls };
  }, url);
}

async function sanitizedCaseMain(page: Page): Promise<string> {
  return page.locator("main").evaluate((main) => {
    const clone = main.cloneNode(true) as HTMLElement;
    const sensitiveTerms = /^(buyer|vendor|amount|reserved|pending|dispatched|wallet|account|simulated escrow|total deposits|pending dispatch)$/i;
    const comments: Comment[] = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) comments.push(walker.currentNode as Comment);
    comments.forEach((comment) => comment.remove());
    clone.querySelectorAll("script, [role=status], [data-tone=pending]").forEach((element) => element.remove());
    clone.querySelectorAll("button").forEach((button) => {
      if (/reconciling|transaction|waiting/i.test(button.textContent || "")) button.remove();
    });
    clone.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (attribute.name.toLowerCase().startsWith("on") || attribute.name === "data-wallet-address")
          element.removeAttribute(attribute.name);
      });
    });
    clone.querySelectorAll("dt, small, span").forEach((term) => {
      if (sensitiveTerms.test(term.textContent?.trim() || "")) term.parentElement?.remove();
    });
    clone.querySelectorAll("code").forEach((code) => {
      if (/^0x[0-9a-f]{40}$/i.test(code.textContent?.trim() || "")) code.remove();
    });
    return clone.outerHTML;
  });
}

async function scan(page: Page, url: string) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? "")),
  ).toEqual([]);
  await assertNoMeaninglessAltText(page);
  return {
    url,
    violations: results.violations,
    incomplete: results.incomplete,
    passes: results.passes.length,
  };
}

test("captures the approved production accessibility evidence without wallet writes", async ({ page }, testInfo) => {
  const origin = process.env.LIVE_EVIDENCE_BASE_URL;
  expect(origin).toBe("https://accessseal-genlayer.vercel.app");
  const urls = {
    cases: `${origin}/cases`,
    create: `${origin}/cases/new`,
    detail: `${origin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`,
  };
  const workspaceSteps: FlowStep[] = [];
  const createSteps: FlowStep[] = [];
  const detailSteps: FlowStep[] = [];

  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(urls.cases);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  workspaceSteps.push({ action: "Tab", expected: "Skip to content receives focus", actual: await visibleFocus(page), passed: true });
  await page.getByRole("link", { name: "Skip to content" }).press("Enter");
  await expect(page.locator("main")).toBeFocused();
  workspaceSteps.push({ action: "Enter", expected: "main receives focus", actual: await visibleFocus(page), passed: true });
  const casesScan = await scan(page, urls.cases);
  const casesFacts = await domFacts(page, urls.cases);
  expect(casesFacts.labelledControls).toBe(true);

  await page.goto(urls.create);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  createSteps.push({ action: "Tab", expected: "Skip link receives focus", actual: await visibleFocus(page), passed: true });
  await page.getByRole("link", { name: "Skip to content" }).press("Enter");
  await expect(page.locator("main")).toBeFocused();
  createSteps.push({ action: "Enter", expected: "main receives focus", actual: await visibleFocus(page), passed: true });
  const vendor = page.getByLabel("Vendor wallet");
  await vendor.focus();
  await page.keyboard.insertText(LIVE_EVIDENCE_BINDING.vendor);
  createSteps.push({ action: "Type", expected: "labelled Vendor wallet accepts keyboard input", actual: await visibleFocus(page), passed: true });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Continue to terms" })).toBeFocused();
  createSteps.push({ action: "Tab", expected: "focus advances without a keyboard trap", actual: await visibleFocus(page), passed: true });
  await page.keyboard.press("Shift+Tab");
  await expect(vendor).toBeFocused();
  createSteps.push({ action: "Shift+Tab", expected: "focus can leave and return to the labelled field", actual: await visibleFocus(page), passed: true });
  await page.getByRole("button", { name: "Continue to terms" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Website origin")).toBeFocused();
  createSteps.push({ action: "Enter", expected: "terms form receives focus", actual: await visibleFocus(page), passed: true });
  for (const [label, value] of [
    ["Website origin", LIVE_EVIDENCE_BINDING.subjectOrigin],
    ["Accessibility profile hash", LIVE_EVIDENCE_BINDING.profileHash],
    ["Critical flow 1", "Navigate the workspace"],
    ["Critical flow 2", "Preview immutable terms"],
    ["Critical flow 3", "Review case sections"],
    ["Simulated escrow (wei)", "1"],
  ] as const) {
    await page.getByLabel(label).focus();
    await page.keyboard.insertText(value);
    createSteps.push({ action: "Type", expected: `${label} has a meaningful label`, actual: await visibleFocus(page), passed: true });
  }
  await page.getByRole("button", { name: "Review locked terms" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Connect the signing buyer wallet before creating a canonical preview.")).toBeVisible();
  createSteps.push({ action: "Enter", expected: "preview requires a wallet and does not send a transaction", actual: "wallet requirement shown", passed: true });
  const createScan = await scan(page, urls.create);
  const createFacts = await domFacts(page, urls.create);
  expect(createFacts.labelledControls).toBe(true);

  await page.goto(urls.detail);
  await expect(page.getByText("FUNDED", { exact: true })).toBeVisible();
  detailSteps.push({ action: "Read", expected: "authoritative lifecycle is FUNDED", actual: "FUNDED", passed: true });
  const sections = page.getByRole("navigation", { name: "Case sections" });
  for (const name of ["Terms", "Evidence", "AI decision", "Settlement"] as const) {
    const link = sections.getByRole("link", { name });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#${name === "AI decision" ? "decision" : name.toLowerCase()}$`));
    detailSteps.push({ action: "Enter", expected: `${name} section link updates the document location`, actual: `${name} section location updated; focus is ${await visibleFocus(page)}`, passed: true });
  }
  const detailScan = await scan(page, urls.detail);
  const detailFacts = await domFacts(page, urls.detail);
  expect(detailFacts.labelledControls).toBe(true);

  const observedAt = Math.floor(Date.now() / 1000);
  const capture: LiveCapture = {
    observedAt,
    domFacts: {
      schemaVersion: "accessseal-dom-facts/1",
      observedAt,
      pages: [
        casesFacts,
        createFacts,
        detailFacts,
      ],
    },
    scannerReport: { schemaVersion: "accessseal-scanner-report/1", tool: { name: "axe-core", version: "4.13.0" }, observedAt, scans: [casesScan, createScan, detailScan] },
    criticalFlowTrace: {
      schemaVersion: "accessseal-critical-flow-trace/1",
      caseId: LIVE_EVIDENCE_BINDING.caseId,
      flowsHash: LIVE_EVIDENCE_BINDING.flowsHash,
      observedAt,
      flows: [
        { id: "workspace-navigation", steps: workspaceSteps, passed: true },
        { id: "create-case-preview", steps: createSteps, passed: true },
        { id: "case-section-navigation", steps: detailSteps, passed: true },
      ],
      materialBlockers: { "focus-obscured": false, "inoperable-critical-flow": false, "keyboard-trap": false, "meaningless-alt-text": false, "missing-form-label": false },
    },
  };
  validateLiveCapture(capture);
  const domFactsJson = JSON.stringify(capture.domFacts);
  const scannerReportJson = JSON.stringify(capture.scannerReport);
  const criticalFlowTraceJson = JSON.stringify(capture.criticalFlowTrace);
  expect(Buffer.byteLength(domFactsJson)).toBeLessThan(16_384);
  expect(Buffer.byteLength(scannerReportJson)).toBeLessThan(16_384);
  expect(Buffer.byteLength(criticalFlowTraceJson)).toBeLessThan(16_384);

  await page.goto(`${urls.detail}#evidence`);
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  const releaseHtml = await sanitizedCaseMain(page);
  expect(releaseHtml).not.toMatch(/reconciling|simulated escrow|total deposits|<small>reserved|<small>pending dispatch|<small>dispatched/i);
  const transientScreenshot = testInfo.outputPath("sanitized-case-evidence.png");
  await page.screenshot({ path: transientScreenshot });
  expect(Buffer.byteLength(releaseHtml)).toBeLessThan(32_768);
  expect(statSync(transientScreenshot).size).toBeLessThan(65_536);
  expect(
    Buffer.byteLength(domFactsJson) +
      Buffer.byteLength(scannerReportJson) +
      Buffer.byteLength(criticalFlowTraceJson) +
      Buffer.byteLength(releaseHtml) +
      statSync(transientScreenshot).size,
  ).toBeLessThan(131_072);

  mkdirSync(captureDirectory, { recursive: true });
  for (const name of readdirSync(captureDirectory)) {
    if (!outputNames.includes(name as (typeof outputNames)[number]))
      rmSync(resolve(captureDirectory, name), { force: true, recursive: true });
  }
  writeFileSync(resolve(captureDirectory, "release.html"), releaseHtml, "utf8");
  copyFileSync(transientScreenshot, resolve(captureDirectory, "screenshot.png"));
  writeFileSync(resolve(captureDirectory, "dom-facts.json"), domFactsJson, "utf8");
  writeFileSync(resolve(captureDirectory, "scanner-report.json"), scannerReportJson, "utf8");
  writeFileSync(resolve(captureDirectory, "critical-flow-trace.json"), criticalFlowTraceJson, "utf8");

  for (const name of outputNames) {
    expect(existsSync(resolve(captureDirectory, name))).toBe(true);
  }
  expect(readdirSync(captureDirectory).sort()).toEqual([...outputNames].sort());
  expect(statSync(resolve(captureDirectory, "release.html")).size).toBeLessThan(32_768);
  expect(statSync(resolve(captureDirectory, "screenshot.png")).size).toBeLessThan(65_536);
  for (const name of outputNames.slice(2))
    expect(statSync(resolve(captureDirectory, name)).size).toBeLessThan(16_384);
  expect(outputNames.reduce((total, name) => total + statSync(resolve(captureDirectory, name)).size, 0)).toBeLessThan(131_072);
});

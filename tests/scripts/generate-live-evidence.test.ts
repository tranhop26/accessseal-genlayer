import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { afterEach } from "node:test";

import { LIVE_EVIDENCE_BINDING, PAYLOAD_SPECS } from "../../scripts/live-evidence-schema.ts";

const roots: string[] = [];
const observedAt = LIVE_EVIDENCE_BINDING.caseCreatedAt + 1;
const HISTORICAL_PUBLIC_PATHS = [
  ".well-known/accessseal/release-manifest.json",
  "evidence/releases/2026-08-22-live-v1/critical-flow-trace.json",
  "evidence/releases/2026-08-22-live-v1/dom-facts.json",
  "evidence/releases/2026-08-22-live-v1/release.html",
  "evidence/releases/2026-08-22-live-v1/scanner-report.json",
  "evidence/releases/2026-08-22-live-v1/screenshot.png",
  "evidence/releases/2026-08-23-live-v2/critical-flow-trace.json",
  "evidence/releases/2026-08-23-live-v2/dom-facts.json",
  "evidence/releases/2026-08-23-live-v2/release-manifest.json",
  "evidence/releases/2026-08-23-live-v2/release.html",
  "evidence/releases/2026-08-23-live-v2/scanner-report.json",
  "evidence/releases/2026-08-23-live-v2/screenshot.png",
] as const;
const urls = [
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases`,
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/new`,
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`,
];
const flowCheckpoints = {
  "workspace-navigation": ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"],
  "create-case-preview": ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"],
  "case-section-navigation": ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"],
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fixture(): Promise<{ root: string; input: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "accessseal-live-generator-"));
  roots.push(root);
  const input = join(root, "capture");
  const output = join(root, "public");
  await mkdir(input, { recursive: true });
  const domFacts = {
    schemaVersion: "accessseal-dom-facts/1",
    observedAt,
    pages: urls.map((url) => ({
      url,
      landmarks: ["navigation:Workspace", "main"],
      headings: [{ level: 1, name: "AccessSeal" }],
      accessibleNames: [{ role: "link", name: "Skip to content" }],
      formLabels: url.endsWith("/cases/new") ? [
        "Vendor wallet", "Website origin", "Accessibility profile hash", "Critical flow 1", "Critical flow 2", "Critical flow 3", "Simulated escrow (wei)",
      ].map((label) => ({ control: "input", label })) : [],
      imageAlternatives: [],
      skipLinkTarget: "#main-content",
      focusableControlOrder: ["link:Skip to content"],
      disabledStates: [{ name: "New case", disabled: false }],
    })),
  };
  const scannerReport = {
    schemaVersion: "accessseal-scanner-report/1",
    tool: { name: "axe-core", version: "4.13.0" },
    observedAt,
    scans: urls.map((url) => ({ url, violations: [], incomplete: [], passes: 40 })),
  };
  const criticalFlowTrace = {
    schemaVersion: "accessseal-critical-flow-trace/1",
    caseId: LIVE_EVIDENCE_BINDING.caseId,
    flowsHash: LIVE_EVIDENCE_BINDING.flowsHash,
    observedAt,
    flows: Object.entries(flowCheckpoints).map(([id, checkpoints], flowIndex) => ({
      id,
      steps: checkpoints.map((checkpoint) => ({ checkpoint, page: urls[flowIndex], action: "Keyboard", expected: `${checkpoint} expected`, actual: `${checkpoint} observed`, passed: true })),
      passed: true,
    })),
    materialBlockers: {
      "focus-obscured": false,
      "inoperable-critical-flow": false,
      "keyboard-trap": false,
      "meaningless-alt-text": false,
      "missing-form-label": false,
    },
  };
  await Promise.all([
    writeFile(join(input, "release.html"), "<main><h1>AccessSeal case</h1></main>"),
    writeFile(join(input, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    writeFile(join(input, "dom-facts.json"), canonical(domFacts)),
    writeFile(join(input, "scanner-report.json"), canonical(scannerReport)),
    writeFile(join(input, "critical-flow-trace.json"), canonical(criticalFlowTrace)),
  ]);
  return { root, input, output };
}

function run(input: string, output: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/generate-live-evidence.ts", "--input", input, "--public", output], {
    cwd: resolve("."),
    encoding: "utf8",
  });
}

function runVerify(output: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/generate-live-evidence.ts", "--verify", "--public", output], {
    cwd: resolve("."),
    encoding: "utf8",
  });
}

async function listedFiles(root: string, relative = ""): Promise<string[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? listedFiles(root, join(relative, entry.name))
    : Promise.resolve([join(relative, entry.name).replaceAll("\\", "/")])));
  return files.flat().sort();
}

test("publishes only the five immutable payload routes and canonical manifest", async () => {
  const { input, output } = await fixture();
  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await listedFiles(output), [
    "evidence/releases/2026-08-26-live-v3/critical-flow-trace.json",
    "evidence/releases/2026-08-26-live-v3/dom-facts.json",
    "evidence/releases/2026-08-26-live-v3/release-manifest.json",
    "evidence/releases/2026-08-26-live-v3/release.html",
    "evidence/releases/2026-08-26-live-v3/scanner-report.json",
    "evidence/releases/2026-08-26-live-v3/screenshot.png",
  ]);

  const manifestBytes = await readFile(join(output, "evidence/releases/2026-08-26-live-v3/release-manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { files: Array<{ evidenceType: keyof typeof PAYLOAD_SPECS; path: string; sha256: string }> };
  assert.equal(manifestBytes.toString("utf8"), canonical(manifest));
  for (const file of manifest.files) {
    const published = await readFile(join(output, file.path.slice(1)));
    const captured = await readFile(join(input, file.path.split("/").at(-1)!));
    assert.deepEqual(published, captured);
    assert.equal(file.sha256, `sha256:${createHash("sha256").update(published).digest("hex")}`);
  }
  const summary = JSON.parse(result.stdout) as { releaseDigest: string; sourceCommit: string };
  assert.equal(summary.releaseDigest, `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`);
  assert.equal(summary.sourceCommit, "9401a53adb1a9eb361eed5359c7a04428452dcde");
});

test("adds V3 without changing any committed V1 or V2 evidence byte", async () => {
  const { input, output } = await fixture();
  const before = new Map<string, Buffer>();
  for (const relativePath of HISTORICAL_PUBLIC_PATHS) {
    const bytes = await readFile(resolve("frontend/public", relativePath));
    before.set(relativePath, bytes);
    const destination = join(output, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }

  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  for (const [relativePath, bytes] of before) {
    assert.deepEqual(await readFile(join(output, relativePath)), bytes, relativePath);
  }
  assert.deepEqual((await listedFiles(output)).filter((path) => path.includes("2026-08-26-live-v3")), [
    "evidence/releases/2026-08-26-live-v3/critical-flow-trace.json",
    "evidence/releases/2026-08-26-live-v3/dom-facts.json",
    "evidence/releases/2026-08-26-live-v3/release-manifest.json",
    "evidence/releases/2026-08-26-live-v3/release.html",
    "evidence/releases/2026-08-26-live-v3/scanner-report.json",
    "evidence/releases/2026-08-26-live-v3/screenshot.png",
  ]);
});

test("is idempotent for identical bytes", async () => {
  const { input, output } = await fixture();
  assert.equal(run(input, output).status, 0);
  const first = await readFile(join(output, "evidence/releases/2026-08-26-live-v3/release-manifest.json"));
  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(join(output, "evidence/releases/2026-08-26-live-v3/release-manifest.json")), first);
});

test("verification CLI reports only a compact release summary", async () => {
  const { input, output } = await fixture();
  assert.equal(run(input, output).status, 0);
  const result = runVerify(output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(summary).sort(), ["fileCount", "releaseDigest"]);
  assert.equal(summary.fileCount, 5);
  assert.match(String(summary.releaseDigest), /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.stdout.length < 256);
});

test("verification rejects a symbolic link or junction in an ancestor of the public root", async () => {
  const { root, input } = await fixture();
  const outside = join(root, "outside-verify");
  const publicRoot = join(outside, "public");
  assert.equal(run(input, publicRoot).status, 0);
  const redirect = join(root, "verify-redirect");
  await symlink(outside, redirect, process.platform === "win32" ? "junction" : "dir");
  const result = runVerify(join(redirect, "public"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ancestor|symbolic|symlink|junction/i);
});

test("rejects a conflicting release before writing any other output", async () => {
  const { input, output } = await fixture();
  const conflict = join(output, PAYLOAD_SPECS.HTML_BUNDLE.path.slice(1));
  await mkdir(dirname(conflict), { recursive: true });
  await writeFile(conflict, "different immutable release");

  const result = run(input, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refus|overwrite|different|immutable/i);
  assert.deepEqual(await listedFiles(output), ["evidence/releases/2026-08-26-live-v3/release.html"]);
  assert.equal(await readFile(conflict, "utf8"), "different immutable release");
});

test("V4 evidence refuses to overwrite a historical release with different bytes", async () => {
  const { input, output } = await fixture();
  const historicalPath = join(output, PAYLOAD_SPECS.SCREENSHOT.path.slice(1));
  await mkdir(dirname(historicalPath), { recursive: true });
  await writeFile(historicalPath, Buffer.from("historical screenshot"));

  const result = run(input, output);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refus|overwrite|different|immutable/i);
  assert.deepEqual(await readFile(historicalPath), Buffer.from("historical screenshot"));
});

test("rejects a missing capture member without creating the public tree", async () => {
  const { input, output } = await fixture();
  await rm(join(input, "scanner-report.json"));
  const result = run(input, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scanner-report|missing|ENOENT/i);
  await assert.rejects(readdir(output), /ENOENT/);
});

test("rejects a redirected output parent without writing outside the public root", async () => {
  const { root, input, output } = await fixture();
  const outside = join(root, "outside");
  await mkdir(output, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(output, "evidence"), process.platform === "win32" ? "junction" : "dir");

  const result = run(input, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic|symlink|junction|redirect|unsafe/i);
  assert.deepEqual(await listedFiles(outside), []);
});

test("rejects a public root that is itself a symbolic link or junction", async () => {
  const { root, input, output } = await fixture();
  const outside = join(root, "outside-root");
  await mkdir(outside, { recursive: true });
  await symlink(outside, output, process.platform === "win32" ? "junction" : "dir");
  const result = run(input, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public root|symbolic|symlink|junction/i);
  assert.deepEqual(await listedFiles(outside), []);
});

test("rejects a symbolic link or junction in an ancestor of the requested public root", async () => {
  const { root, input } = await fixture();
  const outside = join(root, "outside-ancestor");
  const redirect = join(root, "redirect");
  await mkdir(outside, { recursive: true });
  await symlink(outside, redirect, process.platform === "win32" ? "junction" : "dir");
  const result = run(input, join(redirect, "nested-public"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ancestor|symbolic|symlink|junction|unsafe/i);
  assert.deepEqual(await listedFiles(outside), []);
});

test("rejects an existing final destination hard-linked outside the public root", async () => {
  const { root, input, output } = await fixture();
  const outside = join(root, "outside-release.html");
  const destination = join(output, PAYLOAD_SPECS.HTML_BUNDLE.path.slice(1));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(outside, await readFile(join(input, "release.html")));
  await link(outside, destination);
  const result = run(input, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hard link|multiple links|unsafe|immutable/i);
  assert.deepEqual(await readFile(outside), await readFile(join(input, "release.html")));
});

test("recovers an abandoned atomic staging file without publishing partial bytes", async () => {
  const { input, output } = await fixture();
  const releaseDirectory = dirname(join(output, PAYLOAD_SPECS.HTML_BUNDLE.path.slice(1)));
  const abandoned = join(releaseDirectory, ".release.html.999999999.00000000-0000-4000-8000-000000000000.tmp");
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(abandoned, "truncated staged bytes");

  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await listedFiles(output), [
    "evidence/releases/2026-08-26-live-v3/critical-flow-trace.json",
    "evidence/releases/2026-08-26-live-v3/dom-facts.json",
    "evidence/releases/2026-08-26-live-v3/release-manifest.json",
    "evidence/releases/2026-08-26-live-v3/release.html",
    "evidence/releases/2026-08-26-live-v3/scanner-report.json",
    "evidence/releases/2026-08-26-live-v3/screenshot.png",
  ]);
  assert.deepEqual(await readFile(join(output, PAYLOAD_SPECS.HTML_BUNDLE.path.slice(1))), await readFile(join(input, "release.html")));
});

test("recovers a crash after the final hard link was installed but before staging cleanup", async () => {
  const { input, output } = await fixture();
  const destination = join(output, PAYLOAD_SPECS.HTML_BUNDLE.path.slice(1));
  const abandoned = join(dirname(destination), ".release.html.999999999.00000000-0000-4000-8000-000000000000.tmp");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(abandoned, await readFile(join(input, "release.html")));
  await link(abandoned, destination);

  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await listedFiles(output), [
    "evidence/releases/2026-08-26-live-v3/critical-flow-trace.json",
    "evidence/releases/2026-08-26-live-v3/dom-facts.json",
    "evidence/releases/2026-08-26-live-v3/release-manifest.json",
    "evidence/releases/2026-08-26-live-v3/release.html",
    "evidence/releases/2026-08-26-live-v3/scanner-report.json",
    "evidence/releases/2026-08-26-live-v3/screenshot.png",
  ]);
  assert.deepEqual(await readFile(destination), await readFile(join(input, "release.html")));
});

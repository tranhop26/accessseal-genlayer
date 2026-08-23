import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { MEDIA_TYPES, canonicalizeEvidence, hashEvidence } from "../../scripts/generate-evidence.ts";
import {
  buildLiveEnvelopeSet,
  validateLiveEnvelopeSet,
  writeLiveEnvelopeSet,
  type BuiltEnvelope,
} from "../../scripts/generate-live-envelopes.ts";
import { generateLiveEvidenceBundle, verifyPublicEvidence } from "../../scripts/generate-live-evidence.ts";
import { LIVE_EVIDENCE_BINDING, PAYLOAD_SPECS, RELEASE_MANIFEST_PATH } from "../../scripts/live-evidence-schema.ts";

const roots: string[] = [];
let publicDir = "";
const observedAt = LIVE_EVIDENCE_BINDING.caseCreatedAt + 1;
const submittedAt = observedAt + 1;
const expiresAt = submittedAt + 518_400;
const generationId = "00112233445566778899aabbccddeeff";
const evidenceOrder = [
  "RELEASE_MANIFEST",
  "HTML_BUNDLE",
  "SCREENSHOT",
  "DOM_FACTS",
  "SCANNER_REPORT",
  "CRITICAL_FLOW_TRACE",
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "accessseal-live-envelopes-fixture-"));
  roots.push(root);
  const capture = join(root, "capture");
  publicDir = join(root, "public");
  await mkdir(capture, { recursive: true });
  const urls = [
    `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases`,
    `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/new`,
    `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`,
  ];
  const checkpoints = [
    ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"],
    ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"],
    ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"],
  ] as const;
  const domFacts = {
    schemaVersion: "accessseal-dom-facts/1",
    observedAt,
    pages: urls.map((url) => ({
      url,
      landmarks: ["nav:Workspace", "main"],
      headings: [{ level: 1, name: "AccessSeal" }],
      accessibleNames: [{ role: "link", name: "Skip to content" }],
      formLabels: url.endsWith("/cases/new")
        ? ["Vendor wallet", "Website origin", "Accessibility profile hash", "Critical flow 1", "Critical flow 2", "Critical flow 3", "Simulated escrow (wei)"].map((label) => ({ control: "input", label }))
        : [],
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
    scans: urls.map((url) => ({ url, violations: [], incomplete: [], passes: 1 })),
  };
  const criticalFlowTrace = {
    schemaVersion: "accessseal-critical-flow-trace/1",
    caseId: LIVE_EVIDENCE_BINDING.caseId,
    flowsHash: LIVE_EVIDENCE_BINDING.flowsHash,
    observedAt,
    flows: ["workspace-navigation", "create-case-preview", "case-section-navigation"].map((id, index) => ({
      id,
      steps: checkpoints[index]!.map((checkpoint) => ({ checkpoint, page: urls[index], action: "Keyboard", expected: `${checkpoint} expected`, actual: `${checkpoint} observed`, passed: true })),
      passed: true,
    })),
    materialBlockers: { "focus-obscured": false, "inoperable-critical-flow": false, "keyboard-trap": false, "meaningless-alt-text": false, "missing-form-label": false },
  };
  await Promise.all([
    writeFile(join(capture, "release.html"), "<main><h1>AccessSeal case</h1></main>"),
    writeFile(join(capture, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    writeFile(join(capture, "dom-facts.json"), JSON.stringify(domFacts)),
    writeFile(join(capture, "scanner-report.json"), JSON.stringify(scannerReport)),
    writeFile(join(capture, "critical-flow-trace.json"), JSON.stringify(criticalFlowTrace)),
  ]);
  await generateLiveEvidenceBundle(capture, publicDir);
});

async function copiedPublicDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "accessseal-live-envelopes-"));
  roots.push(root);
  const copy = join(root, "public");
  await cp(publicDir, copy, { recursive: true });
  return copy;
}

async function built(): Promise<BuiltEnvelope[]> {
  return buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt, generationId });
}

test("verifies a V2 versioned-manifest bundle without trusting cached metadata", async () => {
  const verified = await verifyPublicEvidence(publicDir);
  assert.equal(verified.manifest.files.length, 5);
  assert.equal(Buffer.from(verified.payloads.DOM_FACTS).equals(await readFile(join(publicDir, PAYLOAD_SPECS.DOM_FACTS.path.slice(1)))), true);

  const copy = await copiedPublicDir();
  const payloadPath = join(copy, PAYLOAD_SPECS.DOM_FACTS.path.slice(1));
  const bytes = await readFile(payloadPath);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(payloadPath, bytes);
  await assert.rejects(verifyPublicEvidence(copy), /digest/i);
});

test("builds one OPEN_RELEASE and five canonical APPEND_EVIDENCE envelopes", async () => {
  const set = await built();
  assert.equal(set.length, 6);
  assert.deepEqual(set.map((item) => item.envelope.evidenceType), evidenceOrder);
  assert.equal(set[0]?.envelope.action, "OPEN_RELEASE");
  assert.deepEqual(set.slice(1).map((item) => item.envelope.action), Array(5).fill("APPEND_EVIDENCE"));
  assert.equal(new Set(set.map((item) => item.envelope.nonce)).size, 6);

  for (const item of set) {
    const envelope = item.envelope;
    assert.deepEqual(Object.keys(envelope).sort(), [
      "action", "caseId", "chainId", "contract", "epoch", "evidenceType", "expiresAt", "issuer", "mediaType",
      "nonce", "observedAt", "payloadSha256", "payloadUri", "profileVersion", "releaseDigest", "schemaVersion",
      "subjectOrigin", "submittedAt",
    ]);
    assert.equal(envelope.caseId, LIVE_EVIDENCE_BINDING.caseId);
    assert.equal(envelope.chainId, "1");
    assert.equal(envelope.contract, LIVE_EVIDENCE_BINDING.contract);
    assert.equal(envelope.issuer, LIVE_EVIDENCE_BINDING.vendor);
    assert.equal(envelope.epoch, 0);
    assert.equal(envelope.mediaType, MEDIA_TYPES[envelope.evidenceType]);
    assert.equal(envelope.submittedAt, submittedAt);
    assert.equal(envelope.expiresAt, expiresAt);
    assert.equal(envelope.nonce, `${LIVE_EVIDENCE_BINDING.releaseId}-${envelope.evidenceType.toLowerCase()}-${submittedAt}-${generationId}`);
    assert.equal(item.canonicalJson, canonicalizeEvidence(envelope));
    assert.equal(item.evidenceHash, hashEvidence(envelope));
    assert.ok(Buffer.byteLength(item.canonicalJson, "utf8") <= 4_096);
  }

  const verified = await verifyPublicEvidence(publicDir);
  const manifest = set[0]!.envelope;
  assert.equal(manifest.payloadUri, `${LIVE_EVIDENCE_BINDING.subjectOrigin}${RELEASE_MANIFEST_PATH}`);
  assert.equal(manifest.payloadSha256, verified.releaseDigest);
  assert.equal(manifest.releaseDigest, verified.releaseDigest);
  for (const [index, file] of verified.manifest.files.entries()) {
    const envelope = set[index + 1]!.envelope;
    assert.equal(envelope.payloadUri, `${LIVE_EVIDENCE_BINDING.subjectOrigin}${file.path}`);
    assert.equal(envelope.payloadSha256, file.sha256);
    assert.equal(envelope.releaseDigest, verified.releaseDigest);
  }
});

test("rejects invalid freshness and expiry domains", async () => {
  const domFacts = JSON.parse(await readFile(join(publicDir, PAYLOAD_SPECS.DOM_FACTS.path.slice(1)), "utf8")) as { observedAt: number };
  await assert.rejects(
    buildLiveEnvelopeSet({ publicDir, submittedAt: observedAt - 1, expiresAt, generationId }),
    /submitted.*observed/i,
  );
  await assert.rejects(
    buildLiveEnvelopeSet({ publicDir, submittedAt: domFacts.observedAt + 86_401, expiresAt, generationId }),
    /86.?400|stale/i,
  );
  await assert.rejects(
    buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt: submittedAt, generationId }),
    /expires.*submitted/i,
  );
  await assert.rejects(
    buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt: submittedAt + 518_401, generationId }),
    /hard.deadline|518.?400|expiry/i,
  );
  const evidenceCutoff = LIVE_EVIDENCE_BINDING.caseCreatedAt + LIVE_EVIDENCE_BINDING.evidenceDeadlineSeconds;
  await assert.rejects(
    buildLiveEnvelopeSet({ publicDir, submittedAt: evidenceCutoff + 1, expiresAt, generationId }),
    /evidence cutoff/i,
  );
  const hardDeadline = LIVE_EVIDENCE_BINDING.caseCreatedAt + LIVE_EVIDENCE_BINDING.hardDeadlineSeconds;
  await assert.rejects(
    buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt: hardDeadline + 1, generationId }),
    /absolute hard deadline/i,
  );
});

test("rejects timestamp drift inside an otherwise canonical envelope set", async () => {
  const set = await built();
  const verified = await verifyPublicEvidence(publicDir);
  set[2]!.envelope.observedAt += 1;
  set[2]!.canonicalJson = canonicalizeEvidence(set[2]!.envelope);
  set[2]!.evidenceHash = hashEvidence(set[2]!.envelope);
  assert.throws(() => validateLiveEnvelopeSet(set, verified), /timestamps must match/i);
});

test("rejects an observation from before the fixed case existed", async () => {
  const set = await built();
  const verified = await verifyPublicEvidence(publicDir);
  for (const item of set) {
    item.envelope.observedAt = LIVE_EVIDENCE_BINDING.caseCreatedAt - 1;
    item.canonicalJson = canonicalizeEvidence(item.envelope);
    item.evidenceHash = hashEvidence(item.envelope);
  }
  assert.throws(() => validateLiveEnvelopeSet(set, verified), /before the fixed case creation/i);
});

test("rejects a canonical set whose timestamp is not the verified public observation", async () => {
  const set = await built();
  const verified = await verifyPublicEvidence(publicDir);
  for (const item of set) {
    item.envelope.observedAt += 1;
    item.canonicalJson = canonicalizeEvidence(item.envelope);
    item.evidenceHash = hashEvidence(item.envelope);
  }
  assert.throws(() => validateLiveEnvelopeSet(set, verified), /verified public evidence timestamp/i);
});

test("uses a caller-supplied generation id so retries in the same second never reuse nonces", async () => {
  const first = await buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt, generationId });
  const second = await buildLiveEnvelopeSet({
    publicDir,
    submittedAt,
    expiresAt,
    generationId: "ffeeddccbbaa99887766554433221100",
  });
  assert.equal(new Set([...first, ...second].map((item) => item.envelope.nonce)).size, 12);
  assert.notEqual(first[0]!.evidenceHash, second[0]!.evidenceHash);
});

test("rejects duplicate nonces, release-digest drift, domain drift, and oversized envelopes", async () => {
  const set = await built();
  const verified = await verifyPublicEvidence(publicDir);

  const duplicate = structuredClone(set);
  duplicate[1]!.envelope.nonce = duplicate[0]!.envelope.nonce;
  assert.throws(() => validateLiveEnvelopeSet(duplicate, verified), /duplicate nonce/i);

  const wrongDigest = structuredClone(set);
  wrongDigest[2]!.envelope.releaseDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateLiveEnvelopeSet(wrongDigest, verified), /release digest/i);

  const wrongPayload = structuredClone(set);
  wrongPayload[1]!.envelope.payloadSha256 = `sha256:${"0".repeat(64)}`;
  wrongPayload[1]!.canonicalJson = canonicalizeEvidence(wrongPayload[1]!.envelope);
  wrongPayload[1]!.evidenceHash = hashEvidence(wrongPayload[1]!.envelope);
  assert.throws(() => validateLiveEnvelopeSet(wrongPayload, verified), /payload digest/i);

  const wrongDomain = structuredClone(set);
  wrongDomain[3]!.envelope.chainId = "4221";
  assert.throws(() => validateLiveEnvelopeSet(wrongDomain, verified), /chain|domain/i);

  const oversized = structuredClone(set);
  oversized[4]!.envelope.nonce = "x".repeat(4_097);
  assert.throws(() => validateLiveEnvelopeSet(oversized, verified), /exceeds 4096 bytes/i);
});

test("writer rejects caller-selected roots and malicious evidence filenames before writing", async () => {
  const set = await built();
  const root = await mkdtemp(join(tmpdir(), "accessseal-live-envelope-output-"));
  roots.push(root);
  const arbitrary = join(root, "arbitrary");
  await assert.rejects(writeLiveEnvelopeSet(set, publicDir, arbitrary), /approved ignored output directory/i);

  const malicious = structuredClone(set);
  malicious[1]!.envelope.evidenceType = "../../../escape";
  await assert.rejects(
    writeLiveEnvelopeSet(malicious, publicDir, resolve("work/evidence/live-envelopes")),
    /order|type|invalid/i,
  );
  await assert.rejects(readFile(resolve("escape")), /ENOENT/);
});

test("writer rejects a junction at the fixed approved output root", async () => {
  const set = await built();
  const approved = resolve("work/evidence/live-envelopes");
  const backup = `${approved}.test-backup`;
  const root = await mkdtemp(join(tmpdir(), "accessseal-live-envelope-junction-"));
  roots.push(root);
  await rm(backup, { recursive: true, force: true });
  let hadExisting = false;
  try {
    await rename(approved, backup);
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(join(approved, ".."), { recursive: true });
  await symlink(root, approved, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(
      writeLiveEnvelopeSet(set, publicDir, approved),
      /symbolic|junction|real directory/i,
    );
    assert.deepEqual(await readFile(join(root, "sentinel"), "utf8").catch(() => "untouched"), "untouched");
  } finally {
    await rm(approved, { recursive: true, force: true });
    if (hadExisting) await rename(backup, approved);
  }
});

test("writer recovers an interrupted directory swap without retaining mixed generations", async () => {
  const approved = resolve("work/evidence/live-envelopes");
  const parent = resolve("work/evidence");
  const saved = join(parent, ".live-envelopes.test-saved");
  const backup = join(parent, ".live-envelopes.backup");
  const staging = join(parent, ".live-envelopes.staging");
  const oldSet = await built();
  const newSet = await buildLiveEnvelopeSet({
    publicDir,
    submittedAt,
    expiresAt,
    generationId: "ffeeddccbbaa99887766554433221100",
  });
  await rm(saved, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  let hadExisting = false;
  try {
    await rename(approved, saved);
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeLiveEnvelopeSet(oldSet, publicDir, approved);
    await rename(approved, backup);
    await mkdir(staging);
    await writeFile(join(staging, "01-release_manifest.json"), newSet[0]!.canonicalJson);

    await writeLiveEnvelopeSet(newSet, publicDir, approved);

    const names = (await readdir(approved)).sort();
    assert.deepEqual(names, [
      "01-release_manifest.json",
      "02-html_bundle.json",
      "03-screenshot.json",
      "04-dom_facts.json",
      "05-scanner_report.json",
      "06-critical_flow_trace.json",
      "summary.json",
    ]);
    const envelopes = await Promise.all(names.slice(0, 6).map(async (name) => JSON.parse(await readFile(join(approved, name), "utf8"))));
    assert.equal(new Set(envelopes.map((envelope) => envelope.nonce.slice(-32))).size, 1);
    assert.equal(envelopes[0]!.nonce.slice(-32), "ffeeddccbbaa99887766554433221100");
    await assert.rejects(readdir(backup), /ENOENT/);
    await assert.rejects(readdir(staging), /ENOENT/);
  } finally {
    await rm(approved, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    if (hadExisting) await rename(saved, approved);
  }
});

test("writer fails closed on an unsafe abandoned stage and preserves the complete installed set", async () => {
  const approved = resolve("work/evidence/live-envelopes");
  const parent = resolve("work/evidence");
  const saved = join(parent, ".live-envelopes.test-saved");
  const staging = join(parent, ".live-envelopes.staging");
  const outside = await mkdtemp(join(tmpdir(), "accessseal-live-envelope-stage-"));
  roots.push(outside);
  const oldSet = await built();
  const newSet = await buildLiveEnvelopeSet({
    publicDir,
    submittedAt,
    expiresAt,
    generationId: "ffeeddccbbaa99887766554433221100",
  });
  await rm(saved, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  let hadExisting = false;
  try {
    await rename(approved, saved);
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeLiveEnvelopeSet(oldSet, publicDir, approved);
    const before = await Promise.all((await readdir(approved)).sort().map((name) => readFile(join(approved, name))));
    await symlink(outside, staging, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(writeLiveEnvelopeSet(newSet, publicDir, approved), /staging|symbolic|junction|real directory/i);

    const names = (await readdir(approved)).sort();
    const after = await Promise.all(names.map((name) => readFile(join(approved, name))));
    assert.equal(after.length, before.length);
    after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(approved, { recursive: true, force: true });
    if (hadExisting) await rename(saved, approved);
  }
});

test("writer recovers when interruption leaves a complete output beside a partially removed backup", async () => {
  const approved = resolve("work/evidence/live-envelopes");
  const parent = resolve("work/evidence");
  const saved = join(parent, ".live-envelopes.test-saved");
  const backup = join(parent, ".live-envelopes.backup");
  const set = await built();
  await rm(saved, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  let hadExisting = false;
  try {
    await rename(approved, saved);
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeLiveEnvelopeSet(set, publicDir, approved);
    await mkdir(backup);
    await writeFile(join(backup, "01-release_manifest.json"), set[0]!.canonicalJson);

    await writeLiveEnvelopeSet(set, publicDir, approved);

    assert.deepEqual((await readdir(approved)).sort(), [
      "01-release_manifest.json",
      "02-html_bundle.json",
      "03-screenshot.json",
      "04-dom_facts.json",
      "05-scanner_report.json",
      "06-critical_flow_trace.json",
      "summary.json",
    ]);
    await assert.rejects(readdir(backup), /ENOENT/);
  } finally {
    await rm(approved, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    if (hadExisting) await rename(saved, approved);
  }
});

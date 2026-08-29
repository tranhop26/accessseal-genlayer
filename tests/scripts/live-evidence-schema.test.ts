import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import test from "node:test";
import * as schema from "../../scripts/live-evidence-schema.ts";
import {
  LIVE_EVIDENCE_BINDING,
  PAYLOAD_SPECS,
  RELEASE_MANIFEST_PATH,
  buildReleaseManifest,
  canonicalJson,
  sha256,
  validateLiveEvidenceBinding,
  validateLiveCapture,
  verifyPayload,
  verifyEvidenceBundle,
  type EvidencePayloads,
  type LiveCapture,
} from "../../scripts/live-evidence-schema.ts";

const observedAt = LIVE_EVIDENCE_BINDING.caseCreatedAt + 1;
const urls = [
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases`,
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/new`,
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`,
];
const blockerCodes = [
  "focus-obscured",
  "inoperable-critical-flow",
  "keyboard-trap",
  "meaningless-alt-text",
  "missing-form-label",
] as const;

const flowCheckpoints = {
  "workspace-navigation": ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"],
  "create-case-preview": ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"],
  "case-section-navigation": ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"],
} as const;

test("pins the exact authoritative V3 live binding", () => {
  assert.deepEqual(LIVE_EVIDENCE_BINDING, {
    caseId: "0xd3f684621674542957dbacb152e08616a3d315722091cc27dc3b5a9938cb6dd0",
    contract: "0x08a1969dd75265a58022fb50bbbdd87f9a726265",
    chainId: "1",
    epoch: 0,
    subjectOrigin: "https://accessseal-genlayer.vercel.app",
    vendor: "0x35c9979d30992b13ef6df7036bc745e2e1cd76a2",
    profileVersion: "accessseal-static/1",
    profileHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    flowsHash: "0x5db2cd16b7b3fe77d49f1361d1f8dac4a50ca421000008427eddff440d03fc87",
    releaseId: "2026-08-26-live-v3",
    releaseManifestPath: "/evidence/releases/2026-08-26-live-v3/release-manifest.json",
    sourceCommit: "9401a53adb1a9eb361eed5359c7a04428452dcde",
    createCaseTransactionHash: "0x3ff5cc28cbde1e89fed7abd5c46c8bd600ac5f339209f32ce06f12045af70c26",
    caseCreatedAt: 1_787_738_360,
    evidenceDeadlineSeconds: 86_400,
    hardDeadlineSeconds: 604_800,
  });
  assert.equal(RELEASE_MANIFEST_PATH, "/evidence/releases/2026-08-26-live-v3/release-manifest.json");
});

function pageFacts(url: string) {
  return {
    url,
    landmarks: ["navigation:Workspace", "main"],
    headings: [{ level: 1, name: "Acceptance cases" }],
    accessibleNames: [{ role: "link", name: "Skip to content" }],
    formLabels: url.endsWith("/cases/new") ? [
      "Vendor wallet", "Website origin", "Accessibility profile hash", "Critical flow 1", "Critical flow 2", "Critical flow 3", "Simulated escrow (wei)",
    ].map((label) => ({ control: "input", label })) : [],
    imageAlternatives: [],
    skipLinkTarget: "#main-content",
    focusableControlOrder: ["link:Skip to content"],
    disabledStates: [{ name: "New case", disabled: false }],
  };
}

function flows() {
  return Object.entries(flowCheckpoints).map(([id, checkpoints], flowIndex) => ({
    id,
    steps: checkpoints.map((checkpoint, stepIndex) => ({
      checkpoint,
      page: urls[Math.min(flowIndex, urls.length - 1)],
      action: stepIndex === 0 ? "Tab" : "Enter",
      expected: `${checkpoint} expected result`,
      actual: `${checkpoint} observed result`,
      passed: true,
    })),
    passed: true,
  }));
}

function json(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}

function makeCapture(overrides: Partial<LiveCapture> = {}): LiveCapture {
  return {
    observedAt,
    domFacts: {
      schemaVersion: "accessseal-dom-facts/1",
      observedAt,
      pages: urls.map(pageFacts),
    },
    scannerReport: {
      schemaVersion: "accessseal-scanner-report/1",
      tool: { name: "axe-core", version: "4.13.0" },
      observedAt,
      scans: urls.map((url) => ({ url, violations: [], incomplete: [], passes: 1 })),
    },
    criticalFlowTrace: {
      schemaVersion: "accessseal-critical-flow-trace/1",
      caseId: LIVE_EVIDENCE_BINDING.caseId,
      flowsHash: LIVE_EVIDENCE_BINDING.flowsHash,
      observedAt,
      flows: flows(),
      materialBlockers: Object.fromEntries(blockerCodes.map((code) => [code, false])),
    },
    ...overrides,
  };
}

function payloadsFromCapture(capture: LiveCapture = makeCapture()): EvidencePayloads {
  return {
    HTML_BUNDLE: Buffer.from("<main tabindex=\"-1\"><h1>Case summary</h1></main>"),
    SCREENSHOT: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    DOM_FACTS: json(capture.domFacts),
    SCANNER_REPORT: json(capture.scannerReport),
    CRITICAL_FLOW_TRACE: json(capture.criticalFlowTrace),
  };
}

function pngBytes(byteLength: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(byteLength - 8, 0),
  ]);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let index = 0; index < 8; index += 1) value = (value >>> 1) ^ (-(value & 1) & 0xedb88320);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(type, 4, "ascii");
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function validPng(byteLength?: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(320, 0);
  header.writeUInt32BE(180, 4);
  header[8] = 8;
  header[9] = 0;
  const pixels = Buffer.alloc((320 + 1) * 180);
  const base = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (byteLength === undefined) return base;
  return Buffer.concat([
    base.subarray(0, -12),
    pngChunk("tEXt", Buffer.alloc(byteLength - base.byteLength - 12, 0x61)),
    base.subarray(-12),
  ]);
}

function v4Options(screenshot: Uint8Array) {
  const { caseId, caseCreatedAt, chainId, contract, epoch, evidenceDeadlineSeconds, flowsHash, hardDeadlineSeconds, profileVersion, sourceCommit, subjectOrigin, vendor } = LIVE_EVIDENCE_BINDING;
  return {
    binding: {
      caseId,
      caseCreatedAt,
      chainId,
      contract,
      epoch,
      evidenceDeadlineSeconds,
      flowsHash,
      hardDeadlineSeconds,
      profileVersion,
      sourceCommit,
      subjectOrigin,
      vendor,
      casePath: `/cases/${caseId}`,
      auditedPageUrls: [`${subjectOrigin}/cases`, `${subjectOrigin}/cases/new`, `${subjectOrigin}/cases/${caseId}`],
      criticalFlows: [
        { id: "workspace-navigation", pageUrl: `${subjectOrigin}/cases`, checkpoints: ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"] },
        { id: "create-case-preview", pageUrl: `${subjectOrigin}/cases/new`, checkpoints: ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"] },
        { id: "case-section-navigation", pageUrl: `${subjectOrigin}/cases/${caseId}`, checkpoints: ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"] },
      ],
      maxObservationAgeSeconds: 86_400,
      maxEnvelopeLifetimeSeconds: 518_400,
      replayDomain: "v4-candidate-replay",
      profileHash: `0x${"0123456789abcdef".repeat(4)}`,
      releaseId: "v4-candidate-20260828",
    },
    reviewImageSha256: `sha256:${sha256(screenshot)}`,
  };
}

test("V4 semantic validation accepts only a capture bound to its distinct origin, case, flows, and timing", () => {
  const screenshot = validPng();
  const binding = {
    ...v4Options(screenshot).binding,
    caseId: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    subjectOrigin: "https://v4-audited.example",
    flowsHash: "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    caseCreatedAt: 1_900_000_000,
    evidenceDeadlineSeconds: 7_200,
    hardDeadlineSeconds: 14_400,
    casePath: "/cases/0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    auditedPageUrls: [
      "https://v4-audited.example/cases",
      "https://v4-audited.example/cases/new",
      "https://v4-audited.example/cases/0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
    criticalFlows: (v4Options(screenshot).binding.criticalFlows as Array<any>).map((flow, index) => ({
      ...flow,
      id: ["v4-workspace-run", "v4-create-run", "v4-case-run"][index],
      pageUrl: [
        "https://v4-audited.example/cases",
        "https://v4-audited.example/cases/new",
        "https://v4-audited.example/cases/0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ][index],
    })),
  };
  const payloads = payloadsFromCapture();
  const domFacts = JSON.parse(Buffer.from(payloads.DOM_FACTS).toString("utf8")) as Record<string, unknown>;
  const pages = domFacts.pages as Array<Record<string, unknown>>;
  const urls = [
    `${binding.subjectOrigin}/cases`,
    `${binding.subjectOrigin}/cases/new`,
    `${binding.subjectOrigin}/cases/${binding.caseId}`,
  ];
  domFacts.observedAt = binding.caseCreatedAt + 1;
  domFacts.pages = pages.map((page, index) => ({ ...page, url: urls[index] }));
  const scanner = JSON.parse(Buffer.from(payloads.SCANNER_REPORT).toString("utf8")) as Record<string, unknown>;
  scanner.observedAt = binding.caseCreatedAt + 1;
  scanner.scans = (scanner.scans as Array<Record<string, unknown>>).map((scan, index) => ({ ...scan, url: urls[index] }));
  const trace = JSON.parse(Buffer.from(payloads.CRITICAL_FLOW_TRACE).toString("utf8")) as Record<string, unknown>;
  trace.caseId = binding.caseId;
  trace.flowsHash = binding.flowsHash;
  trace.observedAt = binding.caseCreatedAt + 1;
  trace.flows = (trace.flows as Array<Record<string, unknown>>).map((flow, flowIndex) => ({
    ...flow,
    id: ["v4-workspace-run", "v4-create-run", "v4-case-run"][flowIndex],
    steps: (flow.steps as Array<Record<string, unknown>>).map((step) => ({ ...step, page: urls[flowIndex] })),
  }));
  const v4Payloads = {
    ...payloads,
    SCREENSHOT: screenshot,
    DOM_FACTS: Buffer.from(canonicalJson(domFacts)),
    SCANNER_REPORT: Buffer.from(canonicalJson(scanner)),
    CRITICAL_FLOW_TRACE: Buffer.from(canonicalJson(trace)),
  };
  const options = {
    binding,
    reviewImageSha256: `sha256:${sha256(screenshot)}`,
  };
  assert.doesNotThrow(() => (schema as any).buildV4ReleaseManifest(v4Payloads, options));
  assert.throws(() => (schema as any).buildV4ReleaseManifest({ ...v4Payloads, DOM_FACTS: payloads.DOM_FACTS }, options), /origin|URL/i);
  assert.throws(() => (schema as any).buildV4ReleaseManifest({ ...v4Payloads, CRITICAL_FLOW_TRACE: payloads.CRITICAL_FLOW_TRACE }, options), /case|hash|flow/i);
  assert.throws(() => (schema as any).buildV4ReleaseManifest({ ...payloads, SCREENSHOT: screenshot }, options), /origin|case|hash|flow/i);
});

test("canonicalJson sorts object keys recursively while preserving array order", () => {
  assert.equal(canonicalJson({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }, 0] }), '{"a":[{"c":3,"d":4},0],"z":{"a":1,"b":2}}');
});

test("builds a canonical five-member release manifest bound to the live case", () => {
  const built = buildReleaseManifest(payloadsFromCapture());
  assert.equal(built.manifest.caseId, LIVE_EVIDENCE_BINDING.caseId);
  assert.equal(built.manifest.files.length, 5);
  assert.equal(built.releaseDigest, `sha256:${sha256(built.bytes)}`);
  assert.equal(Buffer.from(canonicalJson(built.manifest)).compare(built.bytes), 0);
  assert.doesNotThrow(() => verifyEvidenceBundle(built.bytes, payloadsFromCapture()));
});

test("rejects one mutated payload byte", () => {
  const payloads = payloadsFromCapture();
  const built = buildReleaseManifest(payloads);
  const changed = { ...payloads, DOM_FACTS: Buffer.from("{}") };
  assert.throws(() => verifyEvidenceBundle(built.bytes, changed), /digest/i);
});

test("rejects manifest fields that are missing or extra", () => {
  const payloads = payloadsFromCapture();
  const built = buildReleaseManifest(payloads);
  const missing = { ...built.manifest } as Record<string, unknown>;
  delete missing.profileHash;
  const extra = { ...built.manifest, unexpected: true };
  assert.throws(() => verifyEvidenceBundle(Buffer.from(canonicalJson(missing)), payloads), /field/i);
  assert.throws(() => verifyEvidenceBundle(Buffer.from(canonicalJson(extra)), payloads), /field/i);
});

test("rejects wrong paths, media types, and uppercase payload digests", () => {
  const payloads = payloadsFromCapture();
  const built = buildReleaseManifest(payloads);
  for (const mutation of [
    (file: Record<string, unknown>) => ({ ...file, path: "/unsafe.json" }),
    (file: Record<string, unknown>) => ({ ...file, mediaType: "text/plain" }),
    (file: Record<string, unknown>) => ({ ...file, sha256: String(file.sha256).toUpperCase() }),
  ]) {
    const manifest = { ...built.manifest, files: built.manifest.files.map((file) => mutation(file)) };
    assert.throws(() => verifyEvidenceBundle(Buffer.from(canonicalJson(manifest)), payloads), /path|media|digest/i);
  }
});

test("rejects non-canonical JSON and wrong binding values", () => {
  const payloads = payloadsFromCapture();
  const built = buildReleaseManifest(payloads);
  const parsed = JSON.parse(built.bytes.toString("utf8")) as Record<string, unknown>;
  const nonCanonical = Buffer.from(JSON.stringify(parsed, null, 2));
  assert.throws(() => verifyEvidenceBundle(nonCanonical, payloads), /canonical/i);
  for (const field of ["caseId", "subjectOrigin", "profileHash"] as const) {
    const manifest = { ...built.manifest, [field]: "wrong" };
    assert.throws(() => verifyEvidenceBundle(Buffer.from(canonicalJson(manifest)), payloads), /binding|case|origin|profile/i);
  }
  const epoch = { ...built.manifest, epoch: 1 };
  assert.throws(() => verifyEvidenceBundle(Buffer.from(canonicalJson(epoch)), payloads), /epoch/i);
});

test("rejects individual and aggregate payload size overflow", () => {
  const payloads = payloadsFromCapture();
  const oversizedHtml = { ...payloads, HTML_BUNDLE: Buffer.alloc(PAYLOAD_SPECS.HTML_BUNDLE.maxBytes + 1, 0x61) };
  assert.throws(() => buildReleaseManifest(oversizedHtml), /size|bytes/i);
  const oversizedAggregate = {
    ...payloads,
    HTML_BUNDLE: Buffer.alloc(30_000, 0x61),
    SCREENSHOT: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(65_000, 0x61)]),
    DOM_FACTS: Buffer.alloc(16_000, 0x61),
    SCANNER_REPORT: Buffer.alloc(16_000, 0x61),
    CRITICAL_FLOW_TRACE: Buffer.alloc(16_000, 0x61),
  };
  assert.throws(() => buildReleaseManifest(oversizedAggregate), /aggregate|total|size|bytes/i);
});

test("V4 accepts a structurally valid exact 16384-byte PNG and rejects 16385 bytes", () => {
  const exact = validPng(16_384);
  const overflow = validPng(16_385);
  assert.equal(exact.byteLength, 16_384);
  assert.equal(overflow.byteLength, 16_385);
  assert.doesNotThrow(() => (schema as any).verifyV4Payload("SCREENSHOT", exact, v4Options(exact).binding));
  assert.throws(
    () => (schema as any).verifyV4Payload("SCREENSHOT", overflow, v4Options(overflow).binding),
    /SCREENSHOT exceeds 16384 bytes/,
  );
});

test("V4 production capture applies the configured screenshot limit to transient and staged outputs", () => {
  const captureSource = readFileSync(new URL("../../frontend/e2e/live-evidence.capture.spec.ts", import.meta.url), "utf8");
  assert.equal(schema.MAX_SCREENSHOT_BYTES, 16_384);
  assert.match(captureSource, /statSync\(transientScreenshot\)\.size\)\.toBeLessThanOrEqual\(MAX_SCREENSHOT_BYTES\)/);
  assert.match(captureSource, /statSync\(resolve\(stagingDirectory, "screenshot\.png"\)\)\.size\)\.toBeLessThanOrEqual\(MAX_SCREENSHOT_BYTES\)/);
  assert.doesNotMatch(captureSource, /statSync\([^\n]+screenshot[^\n]+\)\.toBeLessThan\(MAX_SCREENSHOT_BYTES\)/);
  assert.doesNotMatch(captureSource, /screenshot(?:\.png|Screenshot)?[^\n]*65_536/);
});

test("V4 rejects signature-only, truncated, and non-legible PNG screenshots", () => {
  const actual = validPng();
  for (const screenshot of [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    actual.subarray(0, -1),
  ]) {
    assert.throws(() => (schema as any).verifyV4Payload("SCREENSHOT", screenshot, v4Options(screenshot).binding), /PNG|truncated|incomplete/i);
  }
});

test("V4 rejects CRC-valid PNGs whose IDAT stream is empty or corrupt", () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(320, 0);
  header.writeUInt32BE(180, 4);
  header[8] = 8;
  const emptyIdat = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", Buffer.alloc(0)), pngChunk("IEND", Buffer.alloc(0))]);
  const corruptIdat = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", Buffer.from("not-deflate")), pngChunk("IEND", Buffer.alloc(0))]);
  for (const screenshot of [emptyIdat, corruptIdat]) {
    assert.throws(() => (schema as any).verifyV4Payload("SCREENSHOT", screenshot, v4Options(screenshot).binding), /IDAT|PNG|decode/i);
  }
});

test("V4 manifest records the exact review-image path, hash, media type, and dimensions", () => {
  const screenshot = validPng();
  const payloads = { ...payloadsFromCapture(), SCREENSHOT: screenshot };
  const built = (schema as any).buildV4ReleaseManifest(payloads, v4Options(screenshot));
  assert.equal(built.manifest.schemaVersion, "accessseal-release-manifest/2");
  assert.deepEqual(built.manifest.reviewImage, {
    path: "/evidence/releases/v4-candidate-20260828/screenshot.png",
    mediaType: "image/png",
    sha256: `sha256:${sha256(screenshot)}`,
    width: 320,
    height: 180,
  });
  assert.doesNotThrow(() => (schema as any).verifyV4EvidenceBundle(built.bytes, payloads, v4Options(screenshot)));
});

test("rejects empty and repeated-hex V4 evidence binding identifiers", () => {
  assert.doesNotThrow(() => validateLiveEvidenceBinding());
  for (const binding of [
    { ...LIVE_EVIDENCE_BINDING, caseId: "" },
    { ...LIVE_EVIDENCE_BINDING, caseId: `0x${"a".repeat(64)}` },
    { ...LIVE_EVIDENCE_BINDING, contract: `0x${"b".repeat(40)}` },
    { ...LIVE_EVIDENCE_BINDING, sourceCommit: "c".repeat(40) },
  ]) {
    assert.throws(() => validateLiveEvidenceBinding(binding), /non-empty|canonical|repeated hexadecimal/i);
  }
});

test("rejects an aggregate exactly at the exclusive 131072-byte boundary", () => {
  const exactBoundary = {
    ...payloadsFromCapture(),
    HTML_BUNDLE: Buffer.alloc(32768, 0x61),
    SCREENSHOT: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(65528, 0x61)]),
    DOM_FACTS: Buffer.alloc(16384, 0x61),
    SCANNER_REPORT: Buffer.alloc(8192, 0x61),
    CRITICAL_FLOW_TRACE: Buffer.alloc(8192, 0x61),
  };
  assert.equal(Object.values(exactBoundary).reduce((total, payload) => total + payload.byteLength, 0), 131072);
  assert.throws(() => buildReleaseManifest(exactBoundary), /aggregate|total|size|bytes/i);
});

test("rejects a screenshot without the PNG signature", () => {
  const payloads = payloadsFromCapture();
  const changed = { ...payloads, SCREENSHOT: Buffer.from("not-a-png") };
  assert.throws(() => buildReleaseManifest(changed), /PNG|signature/i);
});

test("accepts a complete live capture and rejects missing Axe URL coverage", () => {
  assert.doesNotThrow(() => validateLiveCapture(makeCapture()));
  const scannerReport = makeCapture().scannerReport as Record<string, unknown>;
  const scans = (scannerReport.scans as unknown[]).slice(1);
  assert.throws(() => validateLiveCapture(makeCapture({ scannerReport: { ...scannerReport, scans } })), /URL|coverage/i);
});

test("requires the exact three audited pages and complete useful DOM facts", () => {
  const capture = makeCapture();
  const domFacts = capture.domFacts as Record<string, unknown>;
  const pages = domFacts.pages as Array<Record<string, unknown>>;
  assert.throws(() => validateLiveCapture(makeCapture({ domFacts: { ...domFacts, pages: pages.slice(0, 2) } })), /three|page|URL/i);
  assert.throws(() => validateLiveCapture(makeCapture({ domFacts: { ...domFacts, pages: [pages[1], pages[0], pages[2]] } })), /order|page|URL/i);
  assert.throws(() => validateLiveCapture(makeCapture({ domFacts: { ...domFacts, pages: [{ ...pages[0], landmarks: [] }, ...pages.slice(1)] } })), /landmark/i);
  assert.throws(() => validateLiveCapture(makeCapture({ domFacts: { ...domFacts, pages: [pages[0], { ...pages[1], formLabels: [] }, pages[2]] } })), /form.?label/i);
  const createLabels = pages[1].formLabels as Array<Record<string, unknown>>;
  assert.throws(() => validateLiveCapture(makeCapture({ domFacts: { ...domFacts, pages: [pages[0], { ...pages[1], formLabels: createLabels.slice(1) }, pages[2]] } })), /form.?label|Vendor/i);
  for (const field of ["headings", "accessibleNames", "formLabels", "imageAlternatives", "skipLinkTarget", "focusableControlOrder", "disabledStates"]) {
    const incomplete = { ...pages[0] };
    delete incomplete[field];
    assert.throws(
      () => validateLiveCapture(makeCapture({ domFacts: { ...domFacts, pages: [incomplete, ...pages.slice(1)] } })),
      new RegExp(`${field}|field`, "i"),
      `accepted DOM facts without ${field}`,
    );
  }
});

test("requires exact critical flow IDs, order, checkpoints, and page-bound steps", () => {
  const capture = makeCapture();
  const trace = capture.criticalFlowTrace as Record<string, unknown>;
  const currentFlows = trace.flows as Array<Record<string, unknown>>;
  assert.throws(() => validateLiveCapture(makeCapture({ criticalFlowTrace: { ...trace, flows: currentFlows.slice(0, 2) } })), /three|flow|order/i);
  assert.throws(() => validateLiveCapture(makeCapture({ criticalFlowTrace: { ...trace, flows: [currentFlows[1], currentFlows[0], currentFlows[2]] } })), /flow|order/i);
  const firstSteps = currentFlows[0].steps as Array<Record<string, unknown>>;
  const incompleteFirst = { ...currentFlows[0], steps: firstSteps.slice(0, -1) };
  assert.throws(() => validateLiveCapture(makeCapture({ criticalFlowTrace: { ...trace, flows: [incompleteFirst, ...currentFlows.slice(1)] } })), /checkpoint|coverage|step/i);
  const wrongPageFirst = { ...currentFlows[0], steps: firstSteps.map((step, index) => index === 0 ? { ...step, page: urls[2] } : step) };
  assert.throws(() => validateLiveCapture(makeCapture({ criticalFlowTrace: { ...trace, flows: [wrongPageFirst, ...currentFlows.slice(1)] } })), /page|URL/i);
});

test("rejects unsafe or semantically empty HTML snapshots", () => {
  const base = payloadsFromCapture();
  for (const html of [
    "<div><h1>Missing main</h1></div>",
    "<main><p>Missing heading</p></main>",
    "<main><h1>   </h1></main>",
    "<h1>Outside</h1><main><p>Heading is not in main</p></main>",
    "<main><h1>Case</h1><script>alert(1)</script></main>",
    "<main><h1>Case</h1><button onclick=\"alert(1)\">Go</button></main>",
    "<main><h1>Case</h1><a href=\"javascript:alert(1)\">Go</a></main>",
    "<main><h1>Case</h1><a href=\"java&#x73;cript:alert(1)\">Go</a></main>",
    "<main><h1>Case</h1><a href=\"java&Tab;script:alert(1)\">Go</a></main>",
    "<main><h1>Case</h1><a href=\"java&NewLine;script:alert(1)\">Go</a></main>",
    "<main><h1>Case</h1><p>document.cookie</p></main>",
    "<main><h1>Case</h1><p>localStorage</p></main>",
    "<main><h1>Case</h1><p>sessionStorage</p></main>",
    "<main><h1>Case</h1><p>window.ethereum</p></main>",
    "<main><h1>Case</h1><p>document&period;cookie</p></main>",
    "<main><h1>Case</h1><p>window&period;ethereum</p></main>",
    "<main><h1>Case</h1><p>MetaMask</p></main>",
    "<main><h1>Case</h1><p>Imported Account</p></main>",
    "<main><h1>Case</h1><p>private key</p></main>",
    "<main><h1>Case</h1><p>seed phrase</p></main>",
    "<main><h1>Case</h1><p>mnemonic</p></main>",
    "<main><h1>Case</h1><p>browser session</p></main>",
    "<main><h1>Case</h1><p>Connected wallet</p></main>",
    "<main><h1>Case</h1><p>Connected <span>wal</span><span>let</span></p></main>",
  ]) {
    assert.throws(() => buildReleaseManifest({ ...base, HTML_BUNDLE: Buffer.from(html) }), /HTML|semantic|unsafe|sensitive|main|heading/i, `accepted ${html}`);
  }
  assert.doesNotThrow(() => buildReleaseManifest({ ...base, HTML_BUNDLE: Buffer.from(`<main tabindex="-1"><h1>Case summary</h1><code>${LIVE_EVIDENCE_BINDING.contract}</code></main>`) }));
});

test("rejects same-origin URLs whose literal path is not normalized", () => {
  for (const path of ["//cases", "/cases/../admin", "/café"]) {
    const capture = makeCapture();
    const domFacts = capture.domFacts as Record<string, unknown>;
    const pages = domFacts.pages as Array<Record<string, unknown>>;
    const url = `${LIVE_EVIDENCE_BINDING.subjectOrigin}${path}`;
    const changedPages = [{ ...pages[0], url }, ...pages.slice(1)];
    const scannerReport = capture.scannerReport as Record<string, unknown>;
    const scans = scannerReport.scans as Array<Record<string, unknown>>;
    const changedScans = [{ ...scans[0], url }, ...scans.slice(1)];
    assert.throws(
      () => validateLiveCapture(makeCapture({
        domFacts: { ...domFacts, pages: changedPages },
        scannerReport: { ...scannerReport, scans: changedScans },
      })),
      /normalized|URL/i,
      `accepted unnormalized URL ${url}`,
    );
  }
});

test("rejects a failed critical-flow step and every material blocker code", () => {
  const capture = makeCapture();
  const trace = capture.criticalFlowTrace as Record<string, unknown>;
  const flows = trace.flows as Array<Record<string, unknown>>;
  const failed = { ...trace, flows: [{ ...flows[0], passed: false, steps: [{ action: "Tab", expected: "visible focus", actual: "blocked", passed: false }] }, ...flows.slice(1)] };
  assert.throws(() => validateLiveCapture(makeCapture({ criticalFlowTrace: failed })), /flow|step|pass/i);
  for (const code of blockerCodes) {
    const blockers = Object.fromEntries(blockerCodes.map((candidate) => [candidate, candidate === code]));
    assert.throws(() => validateLiveCapture(makeCapture({ criticalFlowTrace: { ...trace, materialBlockers: blockers } })), new RegExp(code));
  }
});

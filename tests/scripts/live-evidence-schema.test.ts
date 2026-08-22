import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_EVIDENCE_BINDING,
  PAYLOAD_SPECS,
  buildReleaseManifest,
  canonicalJson,
  sha256,
  validateLiveCapture,
  verifyEvidenceBundle,
  type EvidencePayloads,
  type LiveCapture,
} from "../../scripts/live-evidence-schema.ts";

const observedAt = 1_787_400_000;
const urls = [
  "https://accessseal-genlayer.vercel.app/cases",
  "https://accessseal-genlayer.vercel.app/cases/new",
  "https://accessseal-genlayer.vercel.app/cases/0xecb00a111f3cab8224989ed65f06ebbaa65f31161ace4981f41310747e6f6977",
];
const blockerCodes = [
  "focus-obscured",
  "inoperable-critical-flow",
  "keyboard-trap",
  "meaningless-alt-text",
  "missing-form-label",
] as const;

function json(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}

function makeCapture(overrides: Partial<LiveCapture> = {}): LiveCapture {
  return {
    observedAt,
    domFacts: {
      schemaVersion: "accessseal-dom-facts/1",
      observedAt,
      pages: urls.map((url) => ({ url, landmarks: ["main", "navigation"], labelledControls: true })),
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
      flows: ["workspace-navigation", "create-case-preview", "case-section-navigation"].map((id) => ({
        id,
        steps: [{ action: "Tab", expected: "visible focus", actual: "visible focus", passed: true }],
        passed: true,
      })),
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

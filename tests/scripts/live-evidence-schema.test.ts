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

const flowCheckpoints = {
  "workspace-navigation": ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"],
  "create-case-preview": ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"],
  "case-section-navigation": ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"],
} as const;

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

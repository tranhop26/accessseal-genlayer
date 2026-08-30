import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const LIVE_EVIDENCE_BINDING = Object.freeze({
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

export const MAX_SCREENSHOT_BYTES = 16_384;

export const PAYLOAD_SPECS = Object.freeze({
  HTML_BUNDLE: Object.freeze({ path: "/evidence/releases/2026-08-26-live-v3/release.html", mediaType: "text/html", maxBytes: 32768 }),
  SCREENSHOT: Object.freeze({ path: "/evidence/releases/2026-08-26-live-v3/screenshot.png", mediaType: "image/png", maxBytes: 65536 }),
  DOM_FACTS: Object.freeze({ path: "/evidence/releases/2026-08-26-live-v3/dom-facts.json", mediaType: "application/json", maxBytes: 16384 }),
  SCANNER_REPORT: Object.freeze({ path: "/evidence/releases/2026-08-26-live-v3/scanner-report.json", mediaType: "application/json", maxBytes: 16384 }),
  CRITICAL_FLOW_TRACE: Object.freeze({ path: "/evidence/releases/2026-08-26-live-v3/critical-flow-trace.json", mediaType: "application/json", maxBytes: 16384 }),
});

export const RELEASE_MANIFEST_PATH = LIVE_EVIDENCE_BINDING.releaseManifestPath;

export type EvidenceType = keyof typeof PAYLOAD_SPECS;
export type EvidencePayloads = { [K in EvidenceType]: Uint8Array };
export type JsonRecord = Record<string, unknown>;

export type LiveCapture = {
  observedAt: number;
  domFacts: JsonRecord;
  scannerReport: JsonRecord;
  criticalFlowTrace: JsonRecord;
};

export type ReleaseManifestFileV1 = {
  evidenceType: EvidenceType;
  mediaType: string;
  path: string;
  sha256: `sha256:${string}`;
};

export type ReleaseManifestV1 = {
  caseId: string;
  epoch: number;
  files: ReleaseManifestFileV1[];
  profileHash: string;
  schemaVersion: "accessseal-release-manifest/1";
  subjectOrigin: string;
};

const EVIDENCE_TYPES = Object.keys(PAYLOAD_SPECS) as EvidenceType[];
const BLOCKER_CODES = [
  "focus-obscured",
  "inoperable-critical-flow",
  "keyboard-trap",
  "meaningless-alt-text",
  "missing-form-label",
] as const;
const MANIFEST_KEYS = ["caseId", "epoch", "files", "profileHash", "schemaVersion", "subjectOrigin"];
const FILE_KEYS = ["evidenceType", "mediaType", "path", "sha256"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TOTAL_BYTES = 131072;
const DOM_PAGE_KEYS = [
  "accessibleNames", "disabledStates", "focusableControlOrder", "formLabels", "headings",
  "imageAlternatives", "landmarks", "skipLinkTarget", "url",
] as const;
const CREATE_FORM_LABELS = [
  "Vendor wallet", "Website origin", "Accessibility profile hash", "Critical flow 1", "Critical flow 2", "Critical flow 3", "Simulated escrow (wei)",
] as const;
const FLOW_CHECKPOINTS = Object.freeze({
  "workspace-navigation": ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"],
  "create-case-preview": ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"],
  "case-section-navigation": ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"],
});

type SemanticFlow = { id: string; pageUrl: string; checkpoints: readonly string[] };
type SemanticBinding = { caseId: string; flowsHash: string; subjectOrigin: string; auditedPageUrls: readonly string[]; criticalFlows: readonly SemanticFlow[] };
const LEGACY_SEMANTIC_BINDING: SemanticBinding = Object.freeze({
  caseId: LIVE_EVIDENCE_BINDING.caseId,
  flowsHash: LIVE_EVIDENCE_BINDING.flowsHash,
  subjectOrigin: LIVE_EVIDENCE_BINDING.subjectOrigin,
  auditedPageUrls: Object.freeze([
    `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases`,
    `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/new`,
    `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`,
  ]),
  criticalFlows: Object.freeze([
    { id: "workspace-navigation", pageUrl: `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases`, checkpoints: FLOW_CHECKPOINTS["workspace-navigation"] },
    { id: "create-case-preview", pageUrl: `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/new`, checkpoints: FLOW_CHECKPOINTS["create-case-preview"] },
    { id: "case-section-navigation", pageUrl: `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`, checkpoints: FLOW_CHECKPOINTS["case-section-navigation"] },
  ]),
});

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match schema`);
  }
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a safe nonnegative integer`);
  }
  return value as number;
}

function sameString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} does not match live binding`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireBoundHex(value: unknown, label: string, pattern: RegExp): void {
  if (typeof value !== "string" || !pattern.test(value) || /^(?:0x)?([0-9a-f])\1*$/i.test(value)) {
    throw new Error(`${label} must be non-empty, canonical, and not repeated hexadecimal`);
  }
}

type LiveEvidenceBindingIdentifiers = {
  caseId: string;
  caseCreatedAt: number;
  contract: string;
  sourceCommit: string;
};

export function validateLiveEvidenceBinding(binding: LiveEvidenceBindingIdentifiers = LIVE_EVIDENCE_BINDING): void {
  requireBoundHex(binding.caseId, "live binding caseId", /^0x[0-9a-f]{64}$/);
  requireBoundHex(binding.contract, "live binding contract", /^0x[0-9a-f]{40}$/);
  requireBoundHex(binding.sourceCommit, "live binding sourceCommit", /^[0-9a-f]{40}$/);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function objectArray(value: unknown, label: string, keys: readonly string[]): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    const parsed = record(item, `${label}[${index}]`);
    exactKeys(parsed, keys, `${label}[${index}]`);
    return parsed;
  });
}

function validateNormalizedPageUrl(value: unknown, binding: SemanticBinding): string {
  if (typeof value !== "string" || !value.startsWith(`${binding.subjectOrigin}/`)) {
    throw new Error("DOM facts page URL is outside the normalized live origin");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DOM facts page URL is not normalized");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== binding.subjectOrigin ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname.includes("//") ||
    value.includes("%") ||
    parsed.href !== value
  ) {
    throw new Error("DOM facts page URL is not normalized");
  }
  return value;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be bytes`);
  return value;
}

function jsonPayload(payload: Uint8Array, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  return record(parsed, label);
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("cannot canonicalize cyclic JSON");
    seen.add(value);
    const result = value.map((item) => canonicalValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) throw new Error("cannot canonicalize cyclic JSON");
    seen.add(value);
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) result[key] = canonicalValue(object[key], seen);
    seen.delete(value);
    return result;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("value is not canonical JSON");
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("value is not canonical JSON");
  return value;
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value, new Set()));
  if (encoded === undefined) throw new Error("value is not canonical JSON");
  return encoded;
}

export function sha256(input: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(input)).digest("hex");
}

function validateDomFacts(value: unknown, observedAt: number, binding: SemanticBinding): string[] {
  const facts = record(value, "DOM facts");
  sameString(facts.schemaVersion, "accessseal-dom-facts/1", "DOM facts schema version");
  integer(facts.observedAt, "DOM facts observedAt");
  if (facts.observedAt !== observedAt) throw new Error("DOM facts timestamp does not match capture");
  if (!Array.isArray(facts.pages) || facts.pages.length !== binding.auditedPageUrls.length) throw new Error("DOM facts must contain exactly three audited pages");
  const urls: string[] = [];
  for (const [index, pageValue] of facts.pages.entries()) {
    const page = record(pageValue, "DOM facts page");
    exactKeys(page, DOM_PAGE_KEYS, "DOM facts page");
    const url = validateNormalizedPageUrl(page.url, binding);
    sameString(url, binding.auditedPageUrls[index]!, "DOM facts page URL/order");
    if (stringArray(page.landmarks, "DOM facts landmarks").length === 0) throw new Error("DOM facts landmarks are required");
    const headings = objectArray(page.headings, "DOM facts headings", ["level", "name"]);
    if (headings.length === 0) throw new Error("DOM facts headings are required");
    for (const heading of headings) {
      const level = integer(heading.level, "DOM facts heading level");
      if (level < 1 || level > 6) throw new Error("DOM facts heading level is invalid");
      nonEmptyString(heading.name, "DOM facts heading name");
    }
    const accessibleNames = objectArray(page.accessibleNames, "DOM facts accessibleNames", ["name", "role"]);
    if (accessibleNames.length === 0) throw new Error("DOM facts accessibleNames are required");
    for (const named of accessibleNames) {
      nonEmptyString(named.role, "DOM facts accessible role");
      nonEmptyString(named.name, "DOM facts accessible name");
    }
    const formLabels = objectArray(page.formLabels, "DOM facts formLabels", ["control", "label"]);
    for (const labelled of formLabels) {
      nonEmptyString(labelled.control, "DOM facts labelled control");
      nonEmptyString(labelled.label, "DOM facts form label");
    }
    if (url === binding.auditedPageUrls[1]) {
      const observedLabels = new Set(formLabels.map((item) => item.label));
      if (CREATE_FORM_LABELS.some((label) => !observedLabels.has(label))) throw new Error("DOM facts formLabels omit a required Create Case label");
    }
    for (const image of objectArray(page.imageAlternatives, "DOM facts imageAlternatives", ["alt", "decorative", "src"])) {
      nonEmptyString(image.src, "DOM facts image source");
      if (typeof image.alt !== "string" || typeof image.decorative !== "boolean") throw new Error("DOM facts image alternative is invalid");
      if (!image.decorative && image.alt.trim().length === 0) throw new Error("DOM facts image alternative is missing");
    }
    sameString(page.skipLinkTarget, "#main-content", "DOM facts skipLinkTarget");
    if (stringArray(page.focusableControlOrder, "DOM facts focusableControlOrder").length === 0) throw new Error("DOM facts focusableControlOrder is required");
    const disabledStates = objectArray(page.disabledStates, "DOM facts disabledStates", ["disabled", "name"]);
    if (disabledStates.length === 0) throw new Error("DOM facts disabledStates are required");
    for (const state of disabledStates) {
      nonEmptyString(state.name, "DOM facts disabled control name");
      if (typeof state.disabled !== "boolean") throw new Error("DOM facts disabled state is invalid");
    }
    urls.push(url);
  }
  return urls;
}

function validateScannerReport(value: unknown, observedAt: number, urls: string[]): void {
  const report = record(value, "scanner report");
  sameString(report.schemaVersion, "accessseal-scanner-report/1", "scanner report schema version");
  integer(report.observedAt, "scanner report observedAt");
  if (report.observedAt !== observedAt) throw new Error("scanner report timestamp does not match capture");
  const tool = record(report.tool, "scanner tool");
  sameString(tool.name, "axe-core", "scanner tool");
  if (typeof tool.version !== "string" || tool.version.length === 0) throw new Error("scanner tool version is required");
  if (!Array.isArray(report.scans)) throw new Error("scanner report scans are required");
  const scanned = new Set<string>();
  for (const scanValue of report.scans) {
    const scan = record(scanValue, "scanner scan");
    if (typeof scan.url !== "string" || !urls.includes(scan.url)) throw new Error("scanner report contains an unexpected URL");
    if (scanned.has(scan.url)) throw new Error("scanner report URLs must be unique");
    scanned.add(scan.url);
    if (!Array.isArray(scan.violations) || !Array.isArray(scan.incomplete)) throw new Error("scanner results are invalid");
    integer(scan.passes, "scanner passes");
    for (const violationValue of scan.violations) {
      const violation = record(violationValue, "scanner violation");
      if (violation.impact === "serious" || violation.impact === "critical") throw new Error("scanner report contains a serious or critical violation");
    }
  }
  if (scanned.size !== urls.length || urls.some((url) => !scanned.has(url))) throw new Error("scanner report is missing Axe URL coverage");
}

function validateFlowTrace(value: unknown, observedAt: number, binding: SemanticBinding): void {
  const trace = record(value, "critical-flow trace");
  sameString(trace.schemaVersion, "accessseal-critical-flow-trace/1", "critical-flow schema version");
  sameString(trace.caseId, binding.caseId, "critical-flow case");
  sameString(trace.flowsHash, binding.flowsHash, "critical-flow hash");
  integer(trace.observedAt, "critical-flow observedAt");
  if (trace.observedAt !== observedAt) throw new Error("critical-flow timestamp does not match capture");
  if (!Array.isArray(trace.flows) || trace.flows.length !== binding.criticalFlows.length) throw new Error("critical-flow trace must contain exactly three flows");
  for (const [flowIndex, flowValue] of trace.flows.entries()) {
    const flow = record(flowValue, "critical flow");
    const expectedFlow = binding.criticalFlows[flowIndex]!;
    sameString(flow.id, expectedFlow.id, "critical-flow ID/order");
    const expectedCheckpoints = expectedFlow.checkpoints;
    if (!Array.isArray(flow.steps) || flow.steps.length !== expectedCheckpoints.length || flow.passed !== true) throw new Error("critical-flow checkpoint coverage is incomplete");
    for (const [stepIndex, stepValue] of flow.steps.entries()) {
      const step = record(stepValue, "critical-flow step");
      sameString(step.checkpoint, expectedCheckpoints[stepIndex]!, "critical-flow checkpoint/order");
      const stepUrl = validateNormalizedPageUrl(step.page, binding);
      sameString(stepUrl, expectedFlow.pageUrl, "critical-flow page URL");
      nonEmptyString(step.action, "critical-flow action");
      nonEmptyString(step.expected, "critical-flow expected result");
      nonEmptyString(step.actual, "critical-flow actual result");
      if (step.passed !== true) throw new Error("critical-flow failed step");
    }
  }
  const blockers = record(trace.materialBlockers, "material blockers");
  exactKeys(blockers, BLOCKER_CODES, "material blockers");
  for (const code of BLOCKER_CODES) if (blockers[code] !== false) throw new Error(`material blocker: ${code}`);
}

function validateHtmlSnapshot(payload: Uint8Array): void {
  const html = Buffer.from(payload).toString("utf8");
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main\s*>/i);
  if (!main) throw new Error("HTML snapshot requires a semantic main element");
  const heading = main[1]!.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i);
  if (!heading || heading[1]!.replace(/<[^>]*>/g, "").trim().length === 0) throw new Error("HTML snapshot requires a named semantic heading inside main");
  const safetyText = html
    .replace(/&#(\d+);?/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hexadecimal: string) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&(colon|period|tab|newline);/gi, (_match, name: string) => ({ colon: ":", period: ".", tab: "\t", newline: "\n" })[name.toLowerCase()]!);
  const renderedText = safetyText.replace(/<[^>]*>/g, "");
  const hasJavascriptUrl = [...safetyText.matchAll(/\b(?:href|src|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .some((match) => (match[1] ?? match[2] ?? match[3] ?? "").replace(/[\t\n\f\r]/g, "").trimStart().toLowerCase().startsWith("javascript:"));
  const unsafe = [
    /<script\b/i,
    /\son[a-z]+\s*=/i,
    /\b(?:href|src)\s*=\s*["']?\s*javascript:/i,
    /\bdocument\.cookie\b/i,
    /\b(?:localStorage|sessionStorage)\b/i,
    /\bwindow\.ethereum\b/i,
    /\bMetaMask\b/i,
    /\bImported Account\b/i,
    /\bprivate[- ]key\b/i,
    /\bseed(?: phrase)?\b/i,
    /\bmnemonic\b/i,
    /\bwallet\b/i,
    /\baccount\b/i,
    /\bsession\b/i,
    /\bdata-wallet(?:-[a-z0-9_-]+)?\s*=/i,
  ];
  if (hasJavascriptUrl || unsafe.some((pattern) => pattern.test(safetyText) || pattern.test(renderedText))) throw new Error("HTML snapshot contains unsafe or sensitive state");
}

export function validateLiveCapture(capture: LiveCapture, binding: SemanticBinding = LEGACY_SEMANTIC_BINDING): void {
  const value = record(capture, "live capture");
  integer(value.observedAt, "capture observedAt");
  const urls = validateDomFacts(value.domFacts, value.observedAt as number, binding);
  validateScannerReport(value.scannerReport, value.observedAt as number, urls);
  validateFlowTrace(value.criticalFlowTrace, value.observedAt as number, binding);
}

export function verifyPayload(evidenceType: EvidenceType, payload: Uint8Array): void {
  const spec = PAYLOAD_SPECS[evidenceType];
  const value = bytes(payload, evidenceType);
  if (value.byteLength > spec.maxBytes) throw new Error(`${evidenceType} exceeds ${spec.maxBytes} bytes`);
  if (evidenceType === "HTML_BUNDLE" && value.byteLength === 0) throw new Error("HTML_BUNDLE is empty");
  if (evidenceType === "SCREENSHOT" && !Buffer.from(value).subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("SCREENSHOT has an invalid PNG signature");
  }
}

function validatePayloadBytes(payloads: EvidencePayloads): void {
  const value = record(payloads, "evidence payloads");
  exactKeys(value, EVIDENCE_TYPES, "evidence payloads");
  let total = 0;
  for (const evidenceType of EVIDENCE_TYPES) {
    const payload = bytes(value[evidenceType], evidenceType);
    verifyPayload(evidenceType, payload);
    total += payload.byteLength;
  }
  if (total >= MAX_TOTAL_BYTES) throw new Error("evidence payload aggregate exceeds size limit");
}

function validatePayloadSemantics(payloads: EvidencePayloads, binding: SemanticBinding = LEGACY_SEMANTIC_BINDING): void {
  const value = payloads as unknown as Record<string, Uint8Array>;
  validateHtmlSnapshot(value.HTML_BUNDLE);
  const domFacts = jsonPayload(value.DOM_FACTS, "DOM facts");
  const scannerReport = jsonPayload(value.SCANNER_REPORT, "scanner report");
  const criticalFlowTrace = jsonPayload(value.CRITICAL_FLOW_TRACE, "critical-flow trace");
  const observedAt = integer(domFacts.observedAt, "DOM facts observedAt");
  validateLiveCapture({ observedAt, domFacts, scannerReport, criticalFlowTrace }, binding);
}

export function buildReleaseManifest(payloads: EvidencePayloads): { manifest: ReleaseManifestV1; bytes: Buffer; releaseDigest: `sha256:${string}` } {
  validateLiveEvidenceBinding();
  validatePayloadBytes(payloads);
  validatePayloadSemantics(payloads);
  const manifest: ReleaseManifestV1 = {
    schemaVersion: "accessseal-release-manifest/1",
    caseId: LIVE_EVIDENCE_BINDING.caseId,
    epoch: LIVE_EVIDENCE_BINDING.epoch,
    subjectOrigin: LIVE_EVIDENCE_BINDING.subjectOrigin,
    profileHash: LIVE_EVIDENCE_BINDING.profileHash,
    files: EVIDENCE_TYPES.map((evidenceType) => ({
      evidenceType,
      mediaType: PAYLOAD_SPECS[evidenceType].mediaType,
      path: PAYLOAD_SPECS[evidenceType].path,
      sha256: `sha256:${sha256(payloads[evidenceType])}`,
    })),
  };
  const bytes = Buffer.from(canonicalJson(manifest));
  return { manifest, bytes, releaseDigest: `sha256:${sha256(bytes)}` };
}

function parseManifest(manifestBytes: Uint8Array): ReleaseManifestV1 {
  const bytes = Buffer.from(manifestBytes);
  if (bytes.byteLength > 16384) throw new Error("release manifest exceeds size limit");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("release manifest must contain valid JSON"); }
  const manifest = record(parsed, "release manifest");
  exactKeys(manifest, MANIFEST_KEYS, "release manifest");
  if (canonicalJson(manifest) !== bytes.toString("utf8")) throw new Error("release manifest is not canonical JSON");
  sameString(manifest.schemaVersion, "accessseal-release-manifest/1", "release manifest schema version");
  sameString(manifest.caseId, LIVE_EVIDENCE_BINDING.caseId, "release manifest case");
  sameString(manifest.subjectOrigin, LIVE_EVIDENCE_BINDING.subjectOrigin, "release manifest origin");
  sameString(manifest.profileHash, LIVE_EVIDENCE_BINDING.profileHash, "release manifest profile");
  if (manifest.epoch !== LIVE_EVIDENCE_BINDING.epoch) throw new Error("release manifest epoch does not match live binding");
  if (!Array.isArray(manifest.files) || manifest.files.length !== EVIDENCE_TYPES.length) throw new Error("release manifest files do not match schema");
  const seen = new Set<string>();
  for (const fileValue of manifest.files) {
    const file = record(fileValue, "release manifest file");
    exactKeys(file, FILE_KEYS, "release manifest file");
    if (!EVIDENCE_TYPES.includes(file.evidenceType as EvidenceType) || seen.has(file.evidenceType as string)) throw new Error("release manifest evidence membership is invalid");
    const evidenceType = file.evidenceType as EvidenceType;
    const spec = PAYLOAD_SPECS[evidenceType];
    sameString(file.path, spec.path, "release manifest path");
    sameString(file.mediaType, spec.mediaType, "release manifest media type");
    if (typeof file.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(file.sha256)) throw new Error("release manifest digest must be lowercase");
    seen.add(evidenceType);
  }
  if (seen.size !== EVIDENCE_TYPES.length) throw new Error("release manifest is missing an evidence member");
  return manifest as unknown as ReleaseManifestV1;
}

export function verifyEvidenceBundle(manifestBytes: Uint8Array, payloads: EvidencePayloads): ReleaseManifestV1 {
  validateLiveEvidenceBinding();
  const manifest = parseManifest(manifestBytes);
  validatePayloadBytes(payloads);
  const value = payloads as unknown as Record<string, Uint8Array>;
  let total = 0;
  for (const file of manifest.files) {
    const payload = bytes(value[file.evidenceType], file.evidenceType);
    total += payload.byteLength;
    if (file.sha256 !== `sha256:${sha256(payload)}`) throw new Error(`payload digest mismatch for ${file.evidenceType}`);
  }
  if (total >= MAX_TOTAL_BYTES) throw new Error("evidence payload aggregate exceeds size limit");
  validatePayloadSemantics(payloads);
  return manifest;
}

export type V4EvidenceBinding = {
  auditedPageUrls: readonly [string, string, string];
  casePath: string;
  caseCreatedAt: number;
  caseId: string;
  chainId: string;
  contract: string;
  criticalFlows: readonly [SemanticFlow, SemanticFlow, SemanticFlow];
  epoch: number;
  evidenceDeadlineSeconds: number;
  flowsHash: string;
  hardDeadlineSeconds: number;
  maxEnvelopeLifetimeSeconds: number;
  maxObservationAgeSeconds: number;
  profileHash: string;
  profileVersion: "accessseal-static/1";
  releaseId: string;
  replayDomain: string;
  sourceCommit: string;
  subjectOrigin: string;
  vendor: string;
};

export type V4EvidenceOptions = { binding: V4EvidenceBinding; reviewImageSha256: `sha256:${string}` };
export type ReleaseManifestV4 = {
  caseId: string;
  epoch: number;
  files: ReleaseManifestFileV1[];
  profileHash: string;
  schemaVersion: "accessseal-release-manifest/1";
  subjectOrigin: string;
};

export const V4_RELEASE_MANIFEST_SCHEMA = "accessseal-release-manifest/1" as const;
const V4_BINDING_KEYS = ["auditedPageUrls", "caseCreatedAt", "caseId", "casePath", "chainId", "contract", "criticalFlows", "epoch", "evidenceDeadlineSeconds", "flowsHash", "hardDeadlineSeconds", "maxEnvelopeLifetimeSeconds", "maxObservationAgeSeconds", "profileHash", "profileVersion", "releaseId", "replayDomain", "sourceCommit", "subjectOrigin", "vendor"];
const MIN_LEGIBLE_SCREENSHOT_WIDTH = 320;
const MIN_LEGIBLE_SCREENSHOT_HEIGHT = 180;
const MAX_SCREENSHOT_DIMENSION = 4096;

export function v4ReleaseManifestPath(binding: V4EvidenceBinding): string {
  return `/evidence/releases/${binding.releaseId}/release-manifest.json`;
}

export function v4PayloadSpecs(binding: V4EvidenceBinding) {
  const base = `/evidence/releases/${binding.releaseId}`;
  return Object.freeze({
    HTML_BUNDLE: Object.freeze({ path: `${base}/release.html`, mediaType: "text/html", maxBytes: 32768 }),
    SCREENSHOT: Object.freeze({ path: `${base}/screenshot.png`, mediaType: "image/png", maxBytes: MAX_SCREENSHOT_BYTES }),
    DOM_FACTS: Object.freeze({ path: `${base}/dom-facts.json`, mediaType: "application/json", maxBytes: 16384 }),
    SCANNER_REPORT: Object.freeze({ path: `${base}/scanner-report.json`, mediaType: "application/json", maxBytes: 16384 }),
    CRITICAL_FLOW_TRACE: Object.freeze({ path: `${base}/critical-flow-trace.json`, mediaType: "application/json", maxBytes: 16384 }),
  });
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let shift = 0; shift < 8; shift += 1) value = (value >>> 1) ^ (-(value & 1) & 0xedb88320);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function pngDimensions(payload: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(payload);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("SCREENSHOT has an invalid PNG signature");
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  const idat: Buffer[] = [];
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("SCREENSHOT PNG is truncated");
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("SCREENSHOT PNG chunk is truncated");
    const type = bytes.toString("ascii", offset + 4, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) throw new Error("SCREENSHOT PNG chunk is invalid");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("SCREENSHOT PNG requires IHDR first");
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      interlace = bytes[dataStart + 12]!;
      const allowed: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (width === 0 || height === 0 || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || ![0, 1].includes(bytes[dataStart + 12]!) || !allowed[colorType]?.includes(bitDepth)) throw new Error("SCREENSHOT PNG IHDR is invalid");
      sawHeader = true;
    } else if (type === "IHDR") throw new Error("SCREENSHOT PNG contains multiple IHDR chunks");
    if (type === "IDAT") { sawImageData = true; idat.push(bytes.subarray(dataStart, dataEnd)); }
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || dataEnd + 4 !== bytes.length) throw new Error("SCREENSHOT PNG IEND is invalid");
      if (interlace !== 0 || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) throw new Error("SCREENSHOT PNG format is unsupported");
      let decoded: Buffer;
      try { decoded = inflateSync(Buffer.concat(idat)); } catch { throw new Error("SCREENSHOT PNG IDAT cannot be decoded"); }
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType]!;
      const rowBytes = width * channels;
      if (decoded.byteLength !== height * (rowBytes + 1)) throw new Error("SCREENSHOT PNG IDAT scanlines are invalid");
      for (let row = 0; row < height; row += 1) if (decoded[row * (rowBytes + 1)]! > 4) throw new Error("SCREENSHOT PNG filter is invalid");
      return { width, height };
    }
    offset = dataEnd + 4;
  }
  throw new Error("SCREENSHOT PNG is incomplete");
}

function validateV4Binding(binding: V4EvidenceBinding): void {
  exactKeys(binding as unknown as JsonRecord, V4_BINDING_KEYS, "V4 evidence binding");
  requireBoundHex(binding.caseId, "V4 caseId", /^0x[0-9a-f]{64}$/);
  requireBoundHex(binding.contract, "V4 contract", /^0x[0-9a-f]{40}$/);
  requireBoundHex(binding.sourceCommit, "V4 sourceCommit", /^[0-9a-f]{40}$/);
  requireBoundHex(binding.profileHash, "V4 profileHash", /^0x[0-9a-f]{64}$/);
  requireBoundHex(binding.flowsHash, "V4 flowsHash", /^0x[0-9a-f]{64}$/);
  if (!/^v4-[a-z0-9][a-z0-9-]{1,61}$/.test(binding.releaseId) || binding.profileVersion !== "accessseal-static/1" || !/^https:\/\/[a-z0-9.-]+$/.test(binding.subjectOrigin) || !/^0x[0-9a-f]{40}$/.test(binding.vendor) || !/^[0-9]+$/.test(binding.chainId) || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0 || !Number.isSafeInteger(binding.caseCreatedAt) || binding.caseCreatedAt < 0 || !Number.isSafeInteger(binding.evidenceDeadlineSeconds) || binding.evidenceDeadlineSeconds < 1 || !Number.isSafeInteger(binding.hardDeadlineSeconds) || binding.hardDeadlineSeconds < binding.evidenceDeadlineSeconds || !Number.isSafeInteger(binding.maxObservationAgeSeconds) || binding.maxObservationAgeSeconds < 1 || !Number.isSafeInteger(binding.maxEnvelopeLifetimeSeconds) || binding.maxEnvelopeLifetimeSeconds < 1 || !/^[a-z0-9][a-z0-9-]{2,61}$/.test(binding.replayDomain) || binding.casePath !== `/cases/${binding.caseId}` || !Array.isArray(binding.auditedPageUrls) || binding.auditedPageUrls.length !== 3 || binding.auditedPageUrls[0] !== `${binding.subjectOrigin}/cases` || binding.auditedPageUrls[1] !== `${binding.subjectOrigin}/cases/new` || binding.auditedPageUrls[2] !== `${binding.subjectOrigin}${binding.casePath}` || !Array.isArray(binding.criticalFlows) || binding.criticalFlows.length !== 3 || new Set(binding.criticalFlows.map((flow) => flow?.id)).size !== 3 || binding.criticalFlows.some((flow, index) => typeof flow?.id !== "string" || flow.id.length === 0 || flow.pageUrl !== binding.auditedPageUrls[index] || !Array.isArray(flow.checkpoints) || flow.checkpoints.length === 0 || flow.checkpoints.some((checkpoint) => typeof checkpoint !== "string" || checkpoint.length === 0))) throw new Error("V4 evidence binding is invalid");
}

function semanticBindingForV4(binding: V4EvidenceBinding): SemanticBinding {
  return { caseId: binding.caseId, flowsHash: binding.flowsHash, subjectOrigin: binding.subjectOrigin, auditedPageUrls: binding.auditedPageUrls, criticalFlows: binding.criticalFlows };
}

export function verifyV4Payload(evidenceType: EvidenceType, payload: Uint8Array, binding: V4EvidenceBinding): { width: number; height: number } | undefined {
  validateV4Binding(binding);
  const spec = v4PayloadSpecs(binding)[evidenceType];
  if (payload.byteLength > spec.maxBytes) throw new Error(`${evidenceType} exceeds ${spec.maxBytes} bytes`);
  if (evidenceType === "HTML_BUNDLE" && payload.byteLength === 0) throw new Error("HTML_BUNDLE is empty");
  if (evidenceType !== "SCREENSHOT") return undefined;
  const dimensions = pngDimensions(payload);
  if (dimensions.width < MIN_LEGIBLE_SCREENSHOT_WIDTH || dimensions.height < MIN_LEGIBLE_SCREENSHOT_HEIGHT || dimensions.width > MAX_SCREENSHOT_DIMENSION || dimensions.height > MAX_SCREENSHOT_DIMENSION) throw new Error("SCREENSHOT dimensions are not legible");
  return dimensions;
}

function validateV4Payloads(payloads: EvidencePayloads, options: V4EvidenceOptions): { width: number; height: number } {
  const value = record(payloads, "evidence payloads");
  exactKeys(value, EVIDENCE_TYPES, "evidence payloads");
  let total = 0;
  let screenshot: { width: number; height: number } | undefined;
  for (const evidenceType of EVIDENCE_TYPES) {
    const payload = bytes(value[evidenceType], evidenceType);
    const dimensions = verifyV4Payload(evidenceType, payload, options.binding);
    if (dimensions !== undefined) screenshot = dimensions;
    total += payload.byteLength;
  }
  if (total >= MAX_TOTAL_BYTES) throw new Error("evidence payload aggregate exceeds size limit");
  if (screenshot === undefined) throw new Error("V4 screenshot is missing");
  return screenshot;
}

export function buildV4ReleaseManifest(payloads: EvidencePayloads, options: V4EvidenceOptions): { manifest: ReleaseManifestV4; bytes: Buffer; releaseDigest: `sha256:${string}` } {
  validateV4Binding(options.binding);
  validateV4Payloads(payloads, options);
  validatePayloadSemantics(payloads, semanticBindingForV4(options.binding));
  const specs = v4PayloadSpecs(options.binding);
  const screenshotSha256 = `sha256:${sha256(payloads.SCREENSHOT)}` as `sha256:${string}`;
  if (options.reviewImageSha256 !== screenshotSha256) throw new Error("V4 review-image hash does not match the screenshot");
  const manifest: ReleaseManifestV4 = {
    schemaVersion: V4_RELEASE_MANIFEST_SCHEMA,
    caseId: options.binding.caseId,
    epoch: options.binding.epoch,
    subjectOrigin: options.binding.subjectOrigin,
    profileHash: options.binding.profileHash,
    files: EVIDENCE_TYPES.map((evidenceType) => ({ evidenceType, mediaType: specs[evidenceType].mediaType, path: specs[evidenceType].path, sha256: `sha256:${sha256(payloads[evidenceType])}` })),
  };
  const bytes = Buffer.from(canonicalJson(manifest));
  return { manifest, bytes, releaseDigest: `sha256:${sha256(bytes)}` };
}

export function verifyV4EvidenceBundle(manifestBytes: Uint8Array, payloads: EvidencePayloads, options: V4EvidenceOptions): ReleaseManifestV4 {
  const built = buildV4ReleaseManifest(payloads, options);
  if (!Buffer.from(manifestBytes).equals(built.bytes)) throw new Error("V4 release manifest does not match its exact bound evidence");
  return built.manifest;
}

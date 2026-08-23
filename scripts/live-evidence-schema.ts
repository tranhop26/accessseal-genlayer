import { createHash } from "node:crypto";

export const LIVE_EVIDENCE_BINDING = Object.freeze({
  caseId: "0x2e82b92517f29f02e86ea5f761ce8a62dc470fad4c92625133ab407f25091959",
  contract: "0x42b2eda04e762f50915f17143adbe73038e36b27",
  chainId: "1",
  epoch: 0,
  subjectOrigin: "https://accessseal-genlayer.vercel.app",
  vendor: "0x35c9979d30992b13ef6df7036bc745e2e1cd76a2",
  profileVersion: "accessseal-static/1",
  profileHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  flowsHash: "0xd8b711d3ceb59343cd7822e5fcf3aba42c11de287bd6dcf53bfe838d753f6001",
  releaseId: "2026-08-23-live-v2",
  releaseManifestPath: "/evidence/releases/2026-08-23-live-v2/release-manifest.json",
  sourceCommit: "23ab41fb5a6c982d259d7d441da8ab5c85b8aa44",
  createCaseTransactionHash: "0x7ef90047f5e94cfb838eb176bcb243bce4c3153f293cc660f3919cdb2c60dd74",
  caseCreatedAt: 1_787_492_373,
  evidenceDeadlineSeconds: 86_400,
  hardDeadlineSeconds: 604_800,
});

export const PAYLOAD_SPECS = Object.freeze({
  HTML_BUNDLE: Object.freeze({ path: "/evidence/releases/2026-08-23-live-v2/release.html", mediaType: "text/html", maxBytes: 32768 }),
  SCREENSHOT: Object.freeze({ path: "/evidence/releases/2026-08-23-live-v2/screenshot.png", mediaType: "image/png", maxBytes: 65536 }),
  DOM_FACTS: Object.freeze({ path: "/evidence/releases/2026-08-23-live-v2/dom-facts.json", mediaType: "application/json", maxBytes: 16384 }),
  SCANNER_REPORT: Object.freeze({ path: "/evidence/releases/2026-08-23-live-v2/scanner-report.json", mediaType: "application/json", maxBytes: 16384 }),
  CRITICAL_FLOW_TRACE: Object.freeze({ path: "/evidence/releases/2026-08-23-live-v2/critical-flow-trace.json", mediaType: "application/json", maxBytes: 16384 }),
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
const AUDITED_PAGE_URLS = [
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases`,
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/new`,
  `${LIVE_EVIDENCE_BINDING.subjectOrigin}/cases/${LIVE_EVIDENCE_BINDING.caseId}`,
] as const;
const DOM_PAGE_KEYS = [
  "accessibleNames", "disabledStates", "focusableControlOrder", "formLabels", "headings",
  "imageAlternatives", "landmarks", "skipLinkTarget", "url",
] as const;
const FLOW_IDS = ["workspace-navigation", "create-case-preview", "case-section-navigation"] as const;
const CREATE_FORM_LABELS = [
  "Vendor wallet", "Website origin", "Accessibility profile hash", "Critical flow 1", "Critical flow 2", "Critical flow 3", "Simulated escrow (wei)",
] as const;
const FLOW_CHECKPOINTS = Object.freeze({
  "workspace-navigation": ["skip-focused", "main-focused", "overview-navigation", "cases-navigation"],
  "create-case-preview": ["skip-focused", "main-focused", "vendor-input", "no-keyboard-trap", "terms-step", "subject-origin", "profile-hash", "critical-flow-1", "critical-flow-2", "critical-flow-3", "escrow", "preview-no-send"],
  "case-section-navigation": ["lifecycle-readback", "skip-focused", "main-focused", "terms-navigation", "terms-escape", "evidence-navigation", "evidence-escape", "decision-navigation", "decision-escape", "settlement-navigation", "settlement-escape"],
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

function validateNormalizedPageUrl(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(`${LIVE_EVIDENCE_BINDING.subjectOrigin}/`)) {
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
    parsed.origin !== LIVE_EVIDENCE_BINDING.subjectOrigin ||
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

function validateDomFacts(value: unknown, observedAt: number): string[] {
  const facts = record(value, "DOM facts");
  sameString(facts.schemaVersion, "accessseal-dom-facts/1", "DOM facts schema version");
  integer(facts.observedAt, "DOM facts observedAt");
  if (facts.observedAt !== observedAt) throw new Error("DOM facts timestamp does not match capture");
  if (!Array.isArray(facts.pages) || facts.pages.length !== AUDITED_PAGE_URLS.length) throw new Error("DOM facts must contain exactly three audited pages");
  const urls: string[] = [];
  for (const [index, pageValue] of facts.pages.entries()) {
    const page = record(pageValue, "DOM facts page");
    exactKeys(page, DOM_PAGE_KEYS, "DOM facts page");
    const url = validateNormalizedPageUrl(page.url);
    sameString(url, AUDITED_PAGE_URLS[index]!, "DOM facts page URL/order");
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
    if (url === AUDITED_PAGE_URLS[1]) {
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

function validateFlowTrace(value: unknown, observedAt: number): void {
  const trace = record(value, "critical-flow trace");
  sameString(trace.schemaVersion, "accessseal-critical-flow-trace/1", "critical-flow schema version");
  sameString(trace.caseId, LIVE_EVIDENCE_BINDING.caseId, "critical-flow case");
  sameString(trace.flowsHash, LIVE_EVIDENCE_BINDING.flowsHash, "critical-flow hash");
  integer(trace.observedAt, "critical-flow observedAt");
  if (trace.observedAt !== observedAt) throw new Error("critical-flow timestamp does not match capture");
  if (!Array.isArray(trace.flows) || trace.flows.length !== FLOW_IDS.length) throw new Error("critical-flow trace must contain exactly three flows");
  for (const [flowIndex, flowValue] of trace.flows.entries()) {
    const flow = record(flowValue, "critical flow");
    const flowId = FLOW_IDS[flowIndex]!;
    sameString(flow.id, flowId, "critical-flow ID/order");
    const expectedCheckpoints = FLOW_CHECKPOINTS[flowId];
    if (!Array.isArray(flow.steps) || flow.steps.length !== expectedCheckpoints.length || flow.passed !== true) throw new Error("critical-flow checkpoint coverage is incomplete");
    for (const [stepIndex, stepValue] of flow.steps.entries()) {
      const step = record(stepValue, "critical-flow step");
      sameString(step.checkpoint, expectedCheckpoints[stepIndex]!, "critical-flow checkpoint/order");
      const stepUrl = validateNormalizedPageUrl(step.page);
      sameString(stepUrl, AUDITED_PAGE_URLS[flowIndex]!, "critical-flow page URL");
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

export function validateLiveCapture(capture: LiveCapture): void {
  const value = record(capture, "live capture");
  integer(value.observedAt, "capture observedAt");
  const urls = validateDomFacts(value.domFacts, value.observedAt as number);
  validateScannerReport(value.scannerReport, value.observedAt as number, urls);
  validateFlowTrace(value.criticalFlowTrace, value.observedAt as number);
}

function validatePayloadBytes(payloads: EvidencePayloads): void {
  const value = record(payloads, "evidence payloads");
  exactKeys(value, EVIDENCE_TYPES, "evidence payloads");
  let total = 0;
  for (const evidenceType of EVIDENCE_TYPES) {
    const payload = bytes(value[evidenceType], evidenceType);
    const spec = PAYLOAD_SPECS[evidenceType];
    if (payload.byteLength > spec.maxBytes) throw new Error(`${evidenceType} exceeds its size limit`);
    total += payload.byteLength;
    if (evidenceType === "HTML_BUNDLE" && payload.byteLength === 0) throw new Error("HTML_BUNDLE is empty");
    if (evidenceType === "SCREENSHOT" && !Buffer.from(payload).subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("SCREENSHOT has an invalid PNG signature");
  }
  if (total >= MAX_TOTAL_BYTES) throw new Error("evidence payload aggregate exceeds size limit");
}

function validatePayloadSemantics(payloads: EvidencePayloads): void {
  const value = payloads as unknown as Record<string, Uint8Array>;
  validateHtmlSnapshot(value.HTML_BUNDLE);
  const domFacts = jsonPayload(value.DOM_FACTS, "DOM facts");
  const scannerReport = jsonPayload(value.SCANNER_REPORT, "scanner report");
  const criticalFlowTrace = jsonPayload(value.CRITICAL_FLOW_TRACE, "critical-flow trace");
  const observedAt = integer(domFacts.observedAt, "DOM facts observedAt");
  validateLiveCapture({ observedAt, domFacts, scannerReport, criticalFlowTrace });
}

export function buildReleaseManifest(payloads: EvidencePayloads): { manifest: ReleaseManifestV1; bytes: Buffer; releaseDigest: `sha256:${string}` } {
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

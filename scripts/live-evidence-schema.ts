import { createHash } from "node:crypto";

export const LIVE_EVIDENCE_BINDING = Object.freeze({
  caseId: "0xecb00a111f3cab8224989ed65f06ebbaa65f31161ace4981f41310747e6f6977",
  contract: "0x1aa0bf5a38bb150bef15ec2899f62fd62660360b",
  chainId: "1",
  epoch: 0,
  subjectOrigin: "https://accessseal-genlayer.vercel.app",
  vendor: "0x35c9979d30992b13ef6df7036bc745e2e1cd76a2",
  profileVersion: "accessseal-static/1",
  profileHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  flowsHash: "0xda495da7b1f1f3f0881882ba88190021186496bde65a56fed260393152481e6e",
  releaseId: "2026-08-22-live-v1",
  sourceCommit: "6d3c933e05e1747d7f9b3b3e1d1ac41212165a61",
  createCaseTransactionHash: "0xcb160381a10aef9864c849524c59507d6c7c94b4a9612ef1ed0dfde83f4a07ac",
  caseCreatedAt: 1_787_332_650,
  evidenceDeadlineSeconds: 86_400,
  hardDeadlineSeconds: 604_800,
});

export const PAYLOAD_SPECS = Object.freeze({
  HTML_BUNDLE: Object.freeze({ path: "/evidence/releases/2026-08-22-live-v1/release.html", mediaType: "text/html", maxBytes: 32768 }),
  SCREENSHOT: Object.freeze({ path: "/evidence/releases/2026-08-22-live-v1/screenshot.png", mediaType: "image/png", maxBytes: 65536 }),
  DOM_FACTS: Object.freeze({ path: "/evidence/releases/2026-08-22-live-v1/dom-facts.json", mediaType: "application/json", maxBytes: 16384 }),
  SCANNER_REPORT: Object.freeze({ path: "/evidence/releases/2026-08-22-live-v1/scanner-report.json", mediaType: "application/json", maxBytes: 16384 }),
  CRITICAL_FLOW_TRACE: Object.freeze({ path: "/evidence/releases/2026-08-22-live-v1/critical-flow-trace.json", mediaType: "application/json", maxBytes: 16384 }),
});

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
  if (!Array.isArray(facts.pages) || facts.pages.length === 0) throw new Error("DOM facts pages are required");
  const urls: string[] = [];
  for (const pageValue of facts.pages) {
    const page = record(pageValue, "DOM facts page");
    const url = validateNormalizedPageUrl(page.url);
    if (!Array.isArray(page.landmarks) || page.landmarks.some((item) => typeof item !== "string")) throw new Error("DOM facts landmarks are invalid");
    if (typeof page.labelledControls !== "boolean") throw new Error("DOM facts labelledControls is invalid");
    if (urls.includes(url)) throw new Error("DOM facts page URLs must be unique");
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
  if (!Array.isArray(trace.flows) || trace.flows.length === 0) throw new Error("critical-flow flows are required");
  for (const flowValue of trace.flows) {
    const flow = record(flowValue, "critical flow");
    if (typeof flow.id !== "string" || flow.id.length === 0 || !Array.isArray(flow.steps) || flow.steps.length === 0 || flow.passed !== true) throw new Error("critical-flow failed flow");
    for (const stepValue of flow.steps) {
      const step = record(stepValue, "critical-flow step");
      if (typeof step.action !== "string" || typeof step.expected !== "string" || typeof step.actual !== "string" || step.passed !== true) throw new Error("critical-flow failed step");
    }
  }
  const blockers = record(trace.materialBlockers, "material blockers");
  exactKeys(blockers, BLOCKER_CODES, "material blockers");
  for (const code of BLOCKER_CODES) if (blockers[code] !== false) throw new Error(`material blocker: ${code}`);
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

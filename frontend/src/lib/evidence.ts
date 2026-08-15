export type EvidenceType =
  | "RELEASE_MANIFEST"
  | "HTML_BUNDLE"
  | "SCREENSHOT"
  | "DOM_FACTS"
  | "SCANNER_REPORT"
  | "CRITICAL_FLOW_TRACE";

export type EvidenceEnvelopeV1 = {
  schemaVersion: "accessseal-evidence/1";
  chainId: string;
  contract: string;
  caseId: string;
  epoch: number;
  action: string;
  subjectOrigin: string;
  profileVersion: "accessseal-static/1";
  releaseDigest: `sha256:${string}`;
  evidenceType: EvidenceType;
  issuer: string;
  payloadUri: string;
  payloadSha256: `sha256:${string}`;
  mediaType: string;
  observedAt: number;
  submittedAt: number;
  expiresAt: number;
  nonce: string;
};

const FIELDS = [
  "action",
  "caseId",
  "chainId",
  "contract",
  "epoch",
  "evidenceType",
  "expiresAt",
  "issuer",
  "mediaType",
  "nonce",
  "observedAt",
  "payloadSha256",
  "payloadUri",
  "profileVersion",
  "releaseDigest",
  "schemaVersion",
  "subjectOrigin",
  "submittedAt",
] as const;
const STRING_FIELDS = FIELDS.filter(
  (field) =>
    !["epoch", "expiresAt", "observedAt", "submittedAt"].includes(field),
) as readonly (keyof EvidenceEnvelopeV1)[];
const INTEGER_FIELDS = [
  "epoch",
  "expiresAt",
  "observedAt",
  "submittedAt",
] as const;
const MEDIA_TYPES: Record<EvidenceType, string> = {
  RELEASE_MANIFEST: "application/json",
  HTML_BUNDLE: "text/html",
  SCREENSHOT: "image/png",
  DOM_FACTS: "application/json",
  SCANNER_REPORT: "application/json",
  CRITICAL_FLOW_TRACE: "application/json",
};

export function restrictedOrigin(uri: string): string {
  if ([...uri].some((character) => character.charCodeAt(0) > 127))
    throw new Error("payload URI must use the restricted ASCII profile");
  const bytes = new TextEncoder().encode(uri).byteLength;
  if (bytes === 0 || bytes > 2048)
    throw new Error("payload URI must contain 1 to 2048 UTF-8 bytes");
  if (!uri.startsWith("https://"))
    throw new Error("payload URI must use HTTPS");
  if (/[#?%]/.test(uri))
    throw new Error(
      "payload URI must not contain fragments, queries, or percent escapes",
    );
  const remainder = uri.slice(8);
  const pathStart = remainder.indexOf("/");
  if (pathStart <= 0) throw new Error("payload URI must be normalized");
  const authority = remainder.slice(0, pathStart);
  const path = remainder.slice(pathStart);
  if (authority.includes("@"))
    throw new Error("payload URI must not contain credentials");
  const parts = authority.split(":");
  if (parts.length > 2)
    throw new Error("payload URI host must use lowercase DNS labels");
  const hostname = parts[0] ?? "";
  const portText = parts[1];
  if (
    portText !== undefined &&
    (!/^[0-9]+$/.test(portText) ||
      (portText.length > 1 && portText.startsWith("0")) ||
      Number(portText) === 0 ||
      Number(portText) > 65535 ||
      Number(portText) === 443)
  )
    throw new Error("payload URI must be normalized");
  if (hostname !== hostname.toLowerCase())
    throw new Error("payload URI must be normalized");
  const labels = hostname.split(".");
  const tld = labels.at(-1) ?? "";
  if (
    !hostname ||
    hostname.length > 253 ||
    labels.length < 2 ||
    tld.length < 2 ||
    !/^[a-z]+$/.test(tld)
  )
    throw new Error("payload URI host must use lowercase DNS labels");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        label.startsWith("xn--") ||
        !/^[a-z0-9-]+$/.test(label),
    )
  )
    throw new Error("payload URI host must use lowercase DNS labels");
  const segments = path.split("/");
  if (
    path.includes("\\") ||
    path.includes("//") ||
    segments.includes(".") ||
    segments.includes("..") ||
    !/^[A-Za-z0-9/._-]+$/.test(path)
  )
    throw new Error("payload URI must be normalized");
  return `https://${hostname}${portText ? `:${portText}` : ""}`;
}

function validateScalarNonce(nonce: string): void {
  for (let i = 0; i < nonce.length; i += 1) {
    const code = nonce.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = nonce.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(
          "evidence nonce must contain only Unicode scalar values",
        );
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new Error("evidence nonce must contain only Unicode scalar values");
  }
  const bytes = new TextEncoder().encode(nonce).byteLength;
  if (bytes === 0 || bytes > 128)
    throw new Error("evidence nonce must contain 1 to 128 UTF-8 bytes");
}

export function canonicalizeEvidence(value: EvidenceEnvelopeV1): string {
  const record = value as unknown as Record<string, unknown>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(FIELDS)
  )
    throw new Error("evidence envelope fields do not match schema");
  for (const field of STRING_FIELDS)
    if (typeof record[field] !== "string")
      throw new Error("evidence envelope field types are invalid");
    else validateUnicodeScalar(String(record[field]), `evidence ${field}`);
  for (const field of INTEGER_FIELDS)
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0)
      throw new Error(
        "evidence integer fields must be safe nonnegative integers",
      );
  if (
    value.schemaVersion !== "accessseal-evidence/1" ||
    value.profileVersion !== "accessseal-static/1"
  )
    throw new Error("evidence schema or profile version is not allowed");
  if (
    !/^sha256:[0-9a-fA-F]{64}$/.test(value.releaseDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.payloadSha256)
  )
    throw new Error("evidence digest is invalid");
  if (
    !(value.evidenceType in MEDIA_TYPES) ||
    value.mediaType !== MEDIA_TYPES[value.evidenceType]
  )
    throw new Error("evidence media type does not match evidence type");
  if (
    value.evidenceType === "RELEASE_MANIFEST" &&
    value.payloadSha256 !== value.releaseDigest
  )
    throw new Error("release manifest payload hash must equal release digest");
  if (restrictedOrigin(value.payloadUri) !== value.subjectOrigin)
    throw new Error("payload URI origin does not match case");
  validateScalarNonce(value.nonce);
  const canonical = JSON.stringify(
    Object.fromEntries(FIELDS.map((field) => [field, record[field]])),
  );
  if (new TextEncoder().encode(canonical).byteLength > 4096)
    throw new Error("evidence envelope exceeds size limit");
  return canonical;
}

function validateUnicodeScalar(value: string, label: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`${label} must contain only Unicode scalar values`);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new Error(`${label} must contain only Unicode scalar values`);
  }
}

export async function hashEvidence(
  value: EvidenceEnvelopeV1,
): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalizeEvidence(value)),
  );
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function validateEvidenceForCase(
  value: EvidenceEnvelopeV1,
  expected: {
    caseId: string;
    epoch: number;
    subjectOrigin: string;
    profileHash: string;
    currentTimestamp: number;
    chainId: number;
    contract: string;
    issuer: string;
    action: "OPEN_RELEASE" | "APPEND_EVIDENCE";
    releaseDigest: `sha256:${string}`;
    evidenceWindow: number;
  },
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  try {
    canonicalizeEvidence(value);
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "Evidence is malformed.",
    );
  }
  if (value.caseId !== expected.caseId)
    issues.push("Case binding does not match.");
  if (value.epoch !== expected.epoch)
    issues.push("Evidence epoch does not match.");
  if (value.subjectOrigin !== expected.subjectOrigin)
    issues.push("Subject origin does not match.");
  if (value.chainId !== String(expected.chainId))
    issues.push("Numeric chain binding does not match.");
  if (value.contract !== expected.contract)
    issues.push("Contract binding does not match.");
  if (value.issuer !== expected.issuer)
    issues.push("Issuer binding does not match vendor.");
  if (value.action !== expected.action)
    issues.push("Evidence action does not match lifecycle.");
  if (value.releaseDigest !== expected.releaseDigest)
    issues.push("Release digest does not match current epoch.");
  if (
    value.observedAt > value.submittedAt ||
    value.submittedAt >= value.expiresAt
  )
    issues.push("Evidence timestamps are not ordered.");
  if (value.submittedAt > expected.currentTimestamp)
    issues.push("Evidence submission is in the future.");
  if (
    expected.action === "OPEN_RELEASE" &&
    value.evidenceType !== "RELEASE_MANIFEST"
  )
    issues.push("Open evidence must be a release manifest.");
  if (
    expected.action === "APPEND_EVIDENCE" &&
    !(
      [
        "CRITICAL_FLOW_TRACE",
        "DOM_FACTS",
        "HTML_BUNDLE",
        "SCANNER_REPORT",
        "SCREENSHOT",
      ] as EvidenceType[]
    ).includes(value.evidenceType)
  )
    issues.push("Evidence type is not vendor-submission allowlisted.");
  if (
    value.observedAt > expected.currentTimestamp ||
    expected.currentTimestamp - value.observedAt > expected.evidenceWindow
  )
    issues.push(
      "Evidence observation is outside the allowed freshness window.",
    );
  if (value.expiresAt <= expected.currentTimestamp)
    issues.push("Evidence has expired.");
  return { ok: issues.length === 0, issues };
}

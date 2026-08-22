import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  evidenceType: string;
  issuer: string;
  payloadUri: string;
  payloadSha256: `sha256:${string}`;
  mediaType: string;
  observedAt: number;
  submittedAt: number;
  expiresAt: number;
  nonce: string;
};

const FIELD_NAMES = [
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
] as const satisfies readonly (keyof EvidenceEnvelopeV1)[];

const INTEGER_FIELDS = [
  "epoch",
  "expiresAt",
  "observedAt",
  "submittedAt",
] as const satisfies readonly (keyof EvidenceEnvelopeV1)[];

const STRING_FIELDS = [
  "action",
  "caseId",
  "chainId",
  "contract",
  "evidenceType",
  "issuer",
  "mediaType",
  "nonce",
  "payloadSha256",
  "payloadUri",
  "profileVersion",
  "releaseDigest",
  "schemaVersion",
  "subjectOrigin",
] as const satisfies readonly (keyof EvidenceEnvelopeV1)[];

export const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  RELEASE_MANIFEST: "application/json",
  HTML_BUNDLE: "text/html",
  SCREENSHOT: "image/png",
  DOM_FACTS: "application/json",
  SCANNER_REPORT: "application/json",
  CRITICAL_FLOW_TRACE: "application/json",
});

function validateNonce(nonce: string): void {
  for (let index = 0; index < nonce.length; index += 1) {
    const codeUnit = nonce.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= nonce.length) {
        throw new Error("evidence nonce must contain only Unicode scalar values");
      }
      const nextCodeUnit = nonce.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new Error("evidence nonce must contain only Unicode scalar values");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("evidence nonce must contain only Unicode scalar values");
    }
  }
  const nonceBytes = Buffer.byteLength(nonce, "utf8");
  if (nonceBytes === 0 || nonceBytes > 128) {
    throw new Error("evidence nonce must contain 1 to 128 UTF-8 bytes");
  }
}

function restrictedPayloadOrigin(payloadUri: string): string {
  for (const character of payloadUri) {
    if (character.charCodeAt(0) > 127) {
      throw new Error("payload URI must use the restricted ASCII profile");
    }
  }
  const payloadUriBytes = Buffer.byteLength(payloadUri, "utf8");
  if (payloadUriBytes === 0 || payloadUriBytes > 2_048) {
    throw new Error("payload URI must contain 1 to 2048 UTF-8 bytes");
  }
  if (!payloadUri.startsWith("https://")) {
    throw new Error("payload URI must use HTTPS");
  }
  if (payloadUri.includes("#")) {
    throw new Error("payload URI must not contain a fragment");
  }
  if (payloadUri.includes("?")) {
    throw new Error("payload URI must not contain a query");
  }
  if (payloadUri.includes("%")) {
    throw new Error("payload URI must not contain percent escapes");
  }
  const remainder = payloadUri.slice("https://".length);
  const pathStart = remainder.indexOf("/");
  if (pathStart <= 0) {
    throw new Error("payload URI must be normalized");
  }
  const authority = remainder.slice(0, pathStart);
  const path = remainder.slice(pathStart);
  if (authority.includes("@")) {
    throw new Error("payload URI must not contain credentials");
  }
  const colonCount = [...authority].filter((character) => character === ":").length;
  if (colonCount > 1) {
    throw new Error("payload URI host must use lowercase DNS labels");
  }
  let hostname = authority;
  let portText = "";
  if (colonCount === 1) {
    const separator = authority.lastIndexOf(":");
    hostname = authority.slice(0, separator);
    portText = authority.slice(separator + 1);
    if (
      !/^[0-9]+$/.test(portText) ||
      (portText.length > 1 && portText.startsWith("0"))
    ) {
      throw new Error("payload URI must be normalized");
    }
    const port = Number(portText);
    if (port === 0 || port > 65_535 || port === 443) {
      throw new Error("payload URI must be normalized");
    }
  }
  if (hostname !== hostname.toLowerCase()) {
    throw new Error("payload URI must be normalized");
  }
  const labels = hostname.split(".");
  const finalLabel = labels[labels.length - 1] ?? "";
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    labels.length < 2 ||
    finalLabel.length < 2 ||
    !/^[a-z]+$/.test(finalLabel)
  ) {
    throw new Error("payload URI host must use lowercase DNS labels");
  }
  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-") ||
      label.startsWith("xn--") ||
      !/^[a-z0-9-]+$/.test(label)
    ) {
      throw new Error("payload URI host must use lowercase DNS labels");
    }
  }
  const pathSegments = path.split("/");
  if (
    path.includes("\\") ||
    path.includes("//") ||
    pathSegments.includes(".") ||
    pathSegments.includes("..") ||
    !/^[A-Za-z0-9/._-]+$/.test(path)
  ) {
    throw new Error("payload URI must be normalized");
  }
  return `https://${hostname}${portText.length > 0 ? `:${portText}` : ""}`;
}

export function canonicalizeEvidence(value: EvidenceEnvelopeV1): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evidence envelope fields do not match schema");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(FIELD_NAMES)) {
    throw new Error("evidence envelope fields do not match schema");
  }
  const record = value as unknown as Record<string, unknown>;
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== "string") {
      throw new Error("evidence envelope field types are invalid");
    }
  }
  for (const field of INTEGER_FIELDS) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) {
      throw new Error(
        "evidence integer fields must be safe nonnegative integers",
      );
    }
  }
  if (value.schemaVersion !== "accessseal-evidence/1") {
    throw new Error("evidence schema version is not allowed");
  }
  if (value.profileVersion !== "accessseal-static/1") {
    throw new Error("evidence profile version is not allowed");
  }
  if (!/^sha256:[0-9a-fA-F]{64}$/.test(value.releaseDigest)) {
    throw new Error("release digest must be a sha256 digest");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.payloadSha256)) {
    throw new Error("payload SHA-256 must be a lowercase sha256 digest");
  }
  const payloadOrigin = restrictedPayloadOrigin(value.payloadUri);
  if (payloadOrigin !== value.subjectOrigin) {
    throw new Error("payload URI origin does not match case");
  }
  const expectedMediaType = MEDIA_TYPES[value.evidenceType];
  if (expectedMediaType === undefined || value.mediaType !== expectedMediaType) {
    throw new Error("evidence media type does not match evidence type");
  }
  if (
    value.evidenceType === "RELEASE_MANIFEST" &&
    value.payloadSha256 !== value.releaseDigest
  ) {
    throw new Error("release manifest payload hash must equal release digest");
  }
  validateNonce(value.nonce);
  const canonical = JSON.stringify(
    Object.fromEntries(FIELD_NAMES.map((field) => [field, record[field]])),
  );
  if (Buffer.byteLength(canonical, "utf8") > 4_096) {
    throw new Error("evidence envelope exceeds size limit");
  }
  return canonical;
}

export function hashEvidence(
  value: EvidenceEnvelopeV1,
): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(canonicalizeEvidence(value))
    .digest("hex");
  return `sha256:${digest}`;
}

const EXPECTED_HASH =
  "sha256:13be58c176c1258e5e708362c3c8b0b97750ccf4552632b95b4fe2a0f2840913";
const EXPECTED_UTF8_HASH =
  "sha256:f57d8fb896c7b8a67c6afaaa3eb086ab73e6ffcfc9a2d6272d1ff808de77c496";
const EXPECTED_EMOJI_HASH =
  "sha256:34e76021986d578b2b87ba04a5dd20dd72dace32c71d0d3529fc1507ac070b9d";

if (process.argv.includes("--verify")) {
  const fixtureUrl = new URL("../fixtures/evidence/pass-release.json", import.meta.url);
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(fixtureUrl), "utf8"),
  ) as EvidenceEnvelopeV1;
  const actualHash = hashEvidence(fixture);
  if (actualHash !== EXPECTED_HASH) {
    throw new Error(`fixture digest mismatch: ${actualHash}`);
  }
  const utf8FixtureUrl = new URL(
    "../fixtures/evidence/pass-release-utf8.json",
    import.meta.url,
  );
  const utf8Fixture = JSON.parse(
    readFileSync(fileURLToPath(utf8FixtureUrl), "utf8"),
  ) as EvidenceEnvelopeV1;
  const actualUtf8Hash = hashEvidence(utf8Fixture);
  if (actualUtf8Hash !== EXPECTED_UTF8_HASH) {
    throw new Error(`UTF-8 fixture digest mismatch: ${actualUtf8Hash}`);
  }
  const emojiFixtureUrl = new URL(
    "../fixtures/evidence/pass-release-emoji.json",
    import.meta.url,
  );
  const emojiFixture = JSON.parse(
    readFileSync(fileURLToPath(emojiFixtureUrl), "utf8"),
  ) as EvidenceEnvelopeV1;
  const actualEmojiHash = hashEvidence(emojiFixture);
  if (actualEmojiHash !== EXPECTED_EMOJI_HASH) {
    throw new Error(`emoji fixture digest mismatch: ${actualEmojiHash}`);
  }
  const invalidFixtures = [
    ["non-string issuer", { ...fixture, issuer: 2 }],
    ["wrong schema", { ...fixture, schemaVersion: "accessseal-evidence/2" }],
    ["wrong profile", { ...fixture, profileVersion: "accessseal-static/2" }],
    ["empty nonce", { ...fixture, nonce: "" }],
    ["long nonce", { ...fixture, nonce: "x".repeat(129) }],
    ["UTF-8 byte-long nonce", { ...fixture, nonce: "😀".repeat(33) }],
    ["lone high surrogate", { ...fixture, nonce: JSON.parse('"\\ud800"') }],
    ["lone low surrogate", { ...fixture, nonce: JSON.parse('"\\udc00"') }],
    ["malformed surrogate pair", { ...fixture, nonce: JSON.parse('"\\ud800x"') }],
    [
      "cross-origin payload",
      { ...fixture, payloadUri: "https://wrong.example/payload.json" },
    ],
    [
      "uppercase payload hash",
      { ...fixture, payloadSha256: `sha256:${"A".repeat(64)}` },
    ],
    ["wrong payload media", { ...fixture, mediaType: "text/html" }],
    [
      "manifest payload mismatch",
      { ...fixture, payloadSha256: `sha256:${"b".repeat(64)}` },
    ],
    [
      "encoded dot segment",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence/%2e%2e/release.json",
      },
    ],
    [
      "quoted query",
      {
        ...fixture,
        payloadUri:
          'https://fixture.accessseal.local/evidence/release.json?name="proof"',
      },
    ],
    [
      "query",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence/release.json?version=1",
      },
    ],
    [
      "IPv4 literal",
      {
        ...fixture,
        subjectOrigin: "https://127.0.0.1",
        payloadUri: "https://127.0.0.1/evidence/release.json",
      },
    ],
    [
      "IPv6 literal",
      {
        ...fixture,
        subjectOrigin: "https://[::1]",
        payloadUri: "https://[::1]/evidence/release.json",
      },
    ],
    [
      "Unicode IDN",
      {
        ...fixture,
        subjectOrigin: "https://tést.example",
        payloadUri: "https://tést.example/evidence/release.json",
      },
    ],
    [
      "punycode IDN",
      {
        ...fixture,
        subjectOrigin: "https://xn--tst-bma.example",
        payloadUri: "https://xn--tst-bma.example/evidence/release.json",
      },
    ],
    [
      "credentials",
      {
        ...fixture,
        payloadUri:
          "https://user:password@fixture.accessseal.local/evidence/release.json",
      },
    ],
    [
      "default port",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local:443/evidence/release.json",
      },
    ],
    [
      "nondefault port origin mismatch",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local:8443/evidence/release.json",
      },
    ],
    [
      "host case",
      {
        ...fixture,
        payloadUri:
          "https://FIXTURE.accessseal.local/evidence/release.json",
      },
    ],
    [
      "backslash",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence\\release.json",
      },
    ],
    [
      "percent escape",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence/release%20file.json",
      },
    ],
    [
      "repeated slash",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence//release.json",
      },
    ],
    [
      "dot segment",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence/./release.json",
      },
    ],
    [
      "dot-dot segment",
      {
        ...fixture,
        payloadUri:
          "https://fixture.accessseal.local/evidence/../release.json",
      },
    ],
  ] as const;
  for (const [label, invalidFixture] of invalidFixtures) {
    let rejected = false;
    try {
      hashEvidence(invalidFixture as EvidenceEnvelopeV1);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`runtime validation accepted ${label}`);
    }
  }
  const invalidDnsProfiles = [
    ["legacy hexadecimal integer IPv4", "0x7f000001"],
    ["legacy dotted hexadecimal IPv4", "0x7f.0.0.1"],
    ["legacy decimal integer IPv4", "2130706433"],
    ["legacy shortened IPv4", "127.1"],
    ["legacy dotted octal IPv4", "0177.0.0.1"],
    ["numeric TLD", "example.123"],
    ["mixed numeric TLD", "example.c0m"],
    ["single-label host", "localhost"],
    ["one-character TLD", "example.c"],
  ] as const;
  for (const [label, hostname] of invalidDnsProfiles) {
    const origin = `https://${hostname}`;
    let received = "accepted";
    try {
      hashEvidence({
        ...fixture,
        subjectOrigin: origin,
        payloadUri: `${origin}/evidence/release.json`,
      });
    } catch (error) {
      received = error instanceof Error ? error.message : String(error);
    }
    const expected = "payload URI host must use lowercase DNS labels";
    if (received !== expected) {
      throw new Error(
        `runtime validation ${label}: expected ${expected}, received ${received}`,
      );
    }
  }
  const loneSurrogatePayloadUri = JSON.parse(
    '"https://fixture.\\ud800/evidence/release.json"',
  ) as string;
  let loneSurrogateError = "accepted";
  try {
    hashEvidence({ ...fixture, payloadUri: loneSurrogatePayloadUri });
  } catch (error) {
    loneSurrogateError = error instanceof Error ? error.message : String(error);
  }
  if (loneSurrogateError !== "payload URI must use the restricted ASCII profile") {
    throw new Error(
      "runtime validation did not reject an escaped lone-surrogate payload URI " +
        `with the ASCII-profile error: ${loneSurrogateError}`,
    );
  }
  const validRestrictedProfiles = [
    { ...fixture, payloadUri: "https://fixture.accessseal.local/" },
    {
      ...fixture,
      payloadUri:
        "https://fixture.accessseal.local/Evidence/path_1-file.json",
    },
    {
      ...fixture,
      subjectOrigin: "https://fixture.accessseal.local:8443",
      payloadUri:
        "https://fixture.accessseal.local:8443/evidence/release.json",
    },
    {
      ...fixture,
      subjectOrigin: "https://proof.co",
      payloadUri: "https://proof.co/evidence/release.json",
    },
  ];
  for (const validFixture of validRestrictedProfiles) {
    hashEvidence(validFixture);
  }
  console.log(`Evidence fixture verified: ${actualHash}`);
  console.log(`UTF-8 evidence fixture verified: ${actualUtf8Hash}`);
  console.log(`Emoji evidence fixture verified: ${actualEmojiHash}`);
}

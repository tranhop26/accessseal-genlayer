import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, join, parse, resolve, sep } from "node:path";

import {
  MEDIA_TYPES,
  canonicalizeEvidence,
  hashEvidence,
  type EvidenceEnvelopeV1,
} from "./generate-evidence.ts";
import { verifyPublicEvidence, type VerifiedPublicEvidence } from "./generate-live-evidence.ts";
import {
  LIVE_EVIDENCE_BINDING,
  PAYLOAD_SPECS,
  canonicalJson,
  type EvidenceType,
} from "./live-evidence-schema.ts";

const MANIFEST_PATH = "/.well-known/accessseal/release-manifest.json";
const MAX_OBSERVATION_AGE_SECONDS = 86_400;
const MAX_ENVELOPE_LIFETIME_SECONDS = 518_400;
const EVIDENCE_ORDER = [
  "RELEASE_MANIFEST",
  ...Object.keys(PAYLOAD_SPECS),
] as const satisfies readonly string[];

export type BuiltEnvelope = {
  envelope: EvidenceEnvelopeV1;
  canonicalJson: string;
  evidenceHash: `sha256:${string}`;
};

type BuildLiveEnvelopeOptions = {
  publicDir: string;
  submittedAt: number;
  expiresAt: number;
  generationId: string;
};

const EVIDENCE_CUTOFF = LIVE_EVIDENCE_BINDING.caseCreatedAt + LIVE_EVIDENCE_BINDING.evidenceDeadlineSeconds;
const ABSOLUTE_HARD_DEADLINE = LIVE_EVIDENCE_BINDING.caseCreatedAt + LIVE_EVIDENCE_BINDING.hardDeadlineSeconds;
const GENERATION_ID = /^[0-9a-f]{32}$/;

function requireSafeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a safe nonnegative integer`);
  }
}

function requireGenerationId(value: string): void {
  if (!GENERATION_ID.test(value)) {
    throw new Error("generationId must contain exactly 32 lowercase hexadecimal characters");
  }
}

function validateTimestampDomain(observedAt: number, submittedAt: number, expiresAt: number): void {
  requireSafeTimestamp(observedAt, "observedAt");
  requireSafeTimestamp(submittedAt, "submittedAt");
  requireSafeTimestamp(expiresAt, "expiresAt");
  if (observedAt < LIVE_EVIDENCE_BINDING.caseCreatedAt) {
    throw new Error("observedAt is before the fixed case creation timestamp");
  }
  if (submittedAt < observedAt) throw new Error("submittedAt must not be earlier than observedAt");
  if (submittedAt - observedAt > MAX_OBSERVATION_AGE_SECONDS) throw new Error("observation is stale by more than 86400 seconds");
  if (submittedAt > EVIDENCE_CUTOFF) throw new Error("submittedAt is after the fixed case evidence cutoff");
  if (expiresAt <= submittedAt) throw new Error("expiresAt must be later than submittedAt");
  if (expiresAt > ABSOLUTE_HARD_DEADLINE) throw new Error("expiresAt exceeds the fixed case absolute hard deadline");
  if (expiresAt - submittedAt > MAX_ENVELOPE_LIFETIME_SECONDS) {
    throw new Error("expiry exceeds the 518400-second case hard-deadline budget");
  }
}

function reportObservedAt(bytes: Uint8Array, evidenceType: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${evidenceType} report must contain JSON`);
  }
  const observedAt = (parsed as { observedAt?: unknown })?.observedAt;
  if (!Number.isSafeInteger(observedAt) || Number(observedAt) < 0) {
    throw new Error(`${evidenceType} observedAt must be a safe nonnegative integer`);
  }
  return Number(observedAt);
}

function sharedObservedAt(verified: VerifiedPublicEvidence): number {
  const values = [
    reportObservedAt(verified.payloads.DOM_FACTS, "DOM_FACTS"),
    reportObservedAt(verified.payloads.SCANNER_REPORT, "SCANNER_REPORT"),
    reportObservedAt(verified.payloads.CRITICAL_FLOW_TRACE, "CRITICAL_FLOW_TRACE"),
  ];
  if (new Set(values).size !== 1) {
    throw new Error("evidence report observedAt timestamps must match");
  }
  return values[0]!;
}

function expectedPayloadUri(evidenceType: string): string {
  if (evidenceType === "RELEASE_MANIFEST") {
    return `${LIVE_EVIDENCE_BINDING.subjectOrigin}${MANIFEST_PATH}`;
  }
  const spec = PAYLOAD_SPECS[evidenceType as EvidenceType];
  if (spec === undefined) throw new Error(`unsupported live evidence type: ${evidenceType}`);
  return `${LIVE_EVIDENCE_BINDING.subjectOrigin}${spec.path}`;
}

export function validateLiveEnvelopeSet(
  set: readonly BuiltEnvelope[],
  verified: VerifiedPublicEvidence,
): void {
  if (set.length !== EVIDENCE_ORDER.length) throw new Error("live envelope set must contain exactly six items");
  const verifiedDigests = new Map(verified.manifest.files.map((file) => [file.evidenceType, file.sha256]));
  const nonces = new Set<string>();
  let releaseDigest: string | undefined;
  let observedAt: number | undefined;
  let submittedAt: number | undefined;
  let expiresAt: number | undefined;
  let generationId: string | undefined;

  for (const [index, item] of set.entries()) {
    const envelope = item.envelope;
    if (Buffer.byteLength(canonicalJson(envelope), "utf8") > 4_096) {
      throw new Error("live envelope exceeds 4096 bytes");
    }
    const evidenceType = EVIDENCE_ORDER[index]!;
    if (envelope.evidenceType !== evidenceType) throw new Error("live envelope evidence order or type is invalid");
    if (envelope.chainId !== LIVE_EVIDENCE_BINDING.chainId) throw new Error("live envelope chain domain is invalid");
    if (envelope.contract !== LIVE_EVIDENCE_BINDING.contract) throw new Error("live envelope contract domain is invalid");
    if (envelope.caseId !== LIVE_EVIDENCE_BINDING.caseId) throw new Error("live envelope case domain is invalid");
    if (envelope.epoch !== LIVE_EVIDENCE_BINDING.epoch) throw new Error("live envelope epoch domain is invalid");
    if (envelope.subjectOrigin !== LIVE_EVIDENCE_BINDING.subjectOrigin) throw new Error("live envelope subject origin is invalid");
    if (envelope.issuer !== LIVE_EVIDENCE_BINDING.vendor) throw new Error("live envelope issuer is invalid");
    if (envelope.profileVersion !== LIVE_EVIDENCE_BINDING.profileVersion) throw new Error("live envelope profile version is invalid");
    if (envelope.action !== (index === 0 ? "OPEN_RELEASE" : "APPEND_EVIDENCE")) throw new Error("live envelope action is invalid");
    if (envelope.mediaType !== MEDIA_TYPES[evidenceType]) throw new Error("live envelope media type is invalid");
    if (envelope.payloadUri !== expectedPayloadUri(evidenceType)) throw new Error("live envelope payload URL is invalid");
    if (nonces.has(envelope.nonce)) throw new Error("live envelope set contains a duplicate nonce");
    nonces.add(envelope.nonce);
    const noncePrefix = `${LIVE_EVIDENCE_BINDING.releaseId}-${evidenceType.toLowerCase()}-${envelope.submittedAt}-`;
    if (!envelope.nonce.startsWith(noncePrefix)) throw new Error("live envelope nonce does not match its replay domain");
    const currentGenerationId = envelope.nonce.slice(noncePrefix.length);
    requireGenerationId(currentGenerationId);
    generationId ??= currentGenerationId;
    if (currentGenerationId !== generationId) throw new Error("live envelope generation IDs must match across the set");

    releaseDigest ??= envelope.releaseDigest;
    if (envelope.releaseDigest !== releaseDigest) throw new Error("live envelope release digest does not match the set");
    if (envelope.releaseDigest !== verified.releaseDigest) throw new Error("live envelope release digest does not match public evidence");
    const expectedPayloadDigest = index === 0
      ? verified.releaseDigest
      : verifiedDigests.get(evidenceType as EvidenceType);
    if (expectedPayloadDigest === undefined || envelope.payloadSha256 !== expectedPayloadDigest) {
      throw new Error("live envelope payload digest does not match public evidence");
    }
    observedAt ??= envelope.observedAt;
    submittedAt ??= envelope.submittedAt;
    expiresAt ??= envelope.expiresAt;
    if (envelope.observedAt !== observedAt || envelope.submittedAt !== submittedAt || envelope.expiresAt !== expiresAt) {
      throw new Error("live envelope timestamps must match across the set");
    }

    const canonical = canonicalizeEvidence(envelope);
    if (item.canonicalJson !== canonical) throw new Error("live envelope canonical JSON does not match");
    if (item.evidenceHash !== hashEvidence(envelope)) throw new Error("live envelope evidence hash does not match");
  }

  if (set[0]!.envelope.payloadSha256 !== releaseDigest) {
    throw new Error("release manifest payload digest does not match the release digest");
  }
  validateTimestampDomain(observedAt!, submittedAt!, expiresAt!);
  if (observedAt !== sharedObservedAt(verified)) {
    throw new Error("live envelope observedAt does not match the verified public evidence timestamp");
  }
}

export async function buildLiveEnvelopeSet(options: BuildLiveEnvelopeOptions): Promise<BuiltEnvelope[]> {
  requireSafeTimestamp(options.submittedAt, "submittedAt");
  requireSafeTimestamp(options.expiresAt, "expiresAt");
  requireGenerationId(options.generationId);
  const verified = await verifyPublicEvidence(options.publicDir);
  const observedAt = sharedObservedAt(verified);
  validateTimestampDomain(observedAt, options.submittedAt, options.expiresAt);

  const manifestFiles = new Map(verified.manifest.files.map((file) => [file.evidenceType, file]));
  const set = EVIDENCE_ORDER.map((evidenceType, index): BuiltEnvelope => {
    const manifestFile = index === 0 ? undefined : manifestFiles.get(evidenceType as EvidenceType);
    if (index > 0 && manifestFile === undefined) throw new Error(`manifest is missing ${evidenceType}`);
    const envelope: EvidenceEnvelopeV1 = {
      schemaVersion: "accessseal-evidence/1",
      chainId: LIVE_EVIDENCE_BINDING.chainId,
      contract: LIVE_EVIDENCE_BINDING.contract,
      caseId: LIVE_EVIDENCE_BINDING.caseId,
      epoch: LIVE_EVIDENCE_BINDING.epoch,
      action: index === 0 ? "OPEN_RELEASE" : "APPEND_EVIDENCE",
      subjectOrigin: LIVE_EVIDENCE_BINDING.subjectOrigin,
      profileVersion: LIVE_EVIDENCE_BINDING.profileVersion,
      releaseDigest: verified.releaseDigest,
      evidenceType,
      issuer: LIVE_EVIDENCE_BINDING.vendor,
      payloadUri: expectedPayloadUri(evidenceType),
      payloadSha256: index === 0 ? verified.releaseDigest : manifestFile!.sha256,
      mediaType: MEDIA_TYPES[evidenceType]!,
      observedAt,
      submittedAt: options.submittedAt,
      expiresAt: options.expiresAt,
      nonce: `${LIVE_EVIDENCE_BINDING.releaseId}-${evidenceType.toLowerCase()}-${options.submittedAt}-${options.generationId}`,
    };
    const canonical = canonicalizeEvidence(envelope);
    return { envelope, canonicalJson: canonical, evidenceHash: hashEvidence(envelope) };
  });
  validateLiveEnvelopeSet(set, verified);
  return set;
}

function envelopeFilename(index: number, evidenceType: string): string {
  return `${String(index + 1).padStart(2, "0")}-${evidenceType.toLowerCase()}.json`;
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await stat(current)) === undefined) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`live envelope output ancestor must be a real directory, not a symbolic link or junction: ${current}`);
    }
  }
  return realpath(absolute);
}

export async function writeLiveEnvelopeSet(
  set: readonly BuiltEnvelope[],
  publicDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const requestedOutput = resolve(outputDirectory);
  if (requestedOutput !== resolve("work/evidence/live-envelopes")) {
    throw new Error("live envelopes may only be written under the approved ignored output directory");
  }
  validateLiveEnvelopeSet(set, await verifyPublicEvidence(publicDirectory));
  const outputRoot = await ensureRealDirectory(requestedOutput);
  const summary = set.map((item) => ({
    evidenceType: item.envelope.evidenceType,
    action: item.envelope.action,
    evidenceHash: item.evidenceHash,
    payloadUri: item.envelope.payloadUri,
    releaseDigest: item.envelope.releaseDigest,
  }));
  const writes = [
    ...set.map((item, index) => ({
      path: join(outputRoot, envelopeFilename(index, item.envelope.evidenceType)),
      bytes: Buffer.from(item.canonicalJson),
    })),
    { path: join(outputRoot, "summary.json"), bytes: Buffer.from(canonicalJson(summary)) },
  ];

  for (const write of writes) {
    const child = resolve(write.path).slice(outputRoot.length);
    if (!child.startsWith(sep) || child.slice(1).includes(sep)) {
      throw new Error("live envelope output path escapes the approved directory");
    }
  }

  for (const write of writes) {
    const current = await stat(write.path);
    if (current === undefined) continue;
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error(`live envelope output must be a regular file, not a symbolic link: ${write.path}`);
    }
    if (current.nlink !== 1) throw new Error(`live envelope output has multiple hard links: ${write.path}`);
  }

  const staged: Array<{ temporary: string; destination: string }> = [];
  try {
    for (const write of writes) {
      const temporary = join(outputRoot, `.${basename(write.path)}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(write.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ temporary, destination: write.path });
    }
    for (const item of staged) {
      await unlink(item.destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(item.temporary, item.destination);
    }
  } finally {
    await Promise.all(staged.map((item) => unlink(item.temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    })));
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith("--")) throw new Error(`missing required argument ${name}`);
  return value;
}

async function main(): Promise<void> {
  const publicDir = argument("--public-dir");
  const outputDir = resolve(argument("--output-dir"));
  const submittedAt = Math.floor(Date.now() / 1_000);
  const generationId = randomUUID().replaceAll("-", "");
  const expiresAt = Math.min(submittedAt + MAX_ENVELOPE_LIFETIME_SECONDS, ABSOLUTE_HARD_DEADLINE);
  const set = await buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt, generationId });
  await writeLiveEnvelopeSet(set, publicDir, outputDir);
  const summary = set.map((item) => ({
    evidenceType: item.envelope.evidenceType,
    action: item.envelope.action,
    evidenceHash: item.evidenceHash,
    payloadUri: item.envelope.payloadUri,
    releaseDigest: item.envelope.releaseDigest,
  }));
  process.stdout.write(`${canonicalJson(summary)}\n`);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/generate-live-envelopes.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

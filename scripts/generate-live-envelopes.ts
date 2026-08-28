import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

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
  RELEASE_MANIFEST_PATH,
  canonicalJson,
  v4PayloadSpecs,
  v4ReleaseManifestPath,
  type EvidenceType,
  type V4EvidenceOptions,
} from "./live-evidence-schema.ts";

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

export type BuildLiveEnvelopeOptions = {
  publicDir: string;
  submittedAt: number;
  expiresAt: number;
  generationId: string;
  v4?: V4EvidenceOptions;
};
type EnvelopeModeOptions = Pick<BuildLiveEnvelopeOptions, "v4">;

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

function validateTimestampDomain(observedAt: number, submittedAt: number, expiresAt: number, v4?: V4EvidenceOptions): void {
  const createdAt = v4?.binding.caseCreatedAt ?? LIVE_EVIDENCE_BINDING.caseCreatedAt;
  const evidenceDeadlineSeconds = v4?.binding.evidenceDeadlineSeconds ?? LIVE_EVIDENCE_BINDING.evidenceDeadlineSeconds;
  const hardDeadlineSeconds = v4?.binding.hardDeadlineSeconds ?? LIVE_EVIDENCE_BINDING.hardDeadlineSeconds;
  requireSafeTimestamp(observedAt, "observedAt");
  requireSafeTimestamp(submittedAt, "submittedAt");
  requireSafeTimestamp(expiresAt, "expiresAt");
  if (observedAt < createdAt) {
    throw new Error("observedAt is before the fixed case creation timestamp");
  }
  if (submittedAt < observedAt) throw new Error("submittedAt must not be earlier than observedAt");
  if (submittedAt - observedAt > MAX_OBSERVATION_AGE_SECONDS) throw new Error("observation is stale by more than 86400 seconds");
  if (submittedAt > createdAt + evidenceDeadlineSeconds) throw new Error("submittedAt is after the fixed case evidence cutoff");
  if (expiresAt <= submittedAt) throw new Error("expiresAt must be later than submittedAt");
  if (expiresAt > createdAt + hardDeadlineSeconds) throw new Error("expiresAt exceeds the fixed case absolute hard deadline");
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

function envelopeBinding(options?: EnvelopeModeOptions) {
  return options?.v4?.binding ?? LIVE_EVIDENCE_BINDING;
}

function expectedPayloadUri(evidenceType: string, options?: EnvelopeModeOptions): string {
  const binding = envelopeBinding(options);
  if (evidenceType === "RELEASE_MANIFEST") {
    return `${binding.subjectOrigin}${options?.v4 === undefined ? RELEASE_MANIFEST_PATH : v4ReleaseManifestPath(options.v4.binding)}`;
  }
  const spec = (options?.v4 === undefined ? PAYLOAD_SPECS : v4PayloadSpecs(options.v4.binding))[evidenceType as EvidenceType];
  if (spec === undefined) throw new Error(`unsupported live evidence type: ${evidenceType}`);
  return `${binding.subjectOrigin}${spec.path}`;
}

export function validateLiveEnvelopeSet(
  set: readonly BuiltEnvelope[],
  verified: VerifiedPublicEvidence,
  options?: EnvelopeModeOptions,
): void {
  if (set.length !== EVIDENCE_ORDER.length) throw new Error("live envelope set must contain exactly six items");
  const verifiedDigests = new Map(verified.manifest.files.map((file) => [file.evidenceType, file.sha256]));
  const nonces = new Set<string>();
  let releaseDigest: string | undefined;
  let observedAt: number | undefined;
  let submittedAt: number | undefined;
  let expiresAt: number | undefined;
  let generationId: string | undefined;
  const binding = envelopeBinding(options);

  for (const [index, item] of set.entries()) {
    const envelope = item.envelope;
    if (Buffer.byteLength(canonicalJson(envelope), "utf8") > 4_096) {
      throw new Error("live envelope exceeds 4096 bytes");
    }
    const evidenceType = EVIDENCE_ORDER[index]!;
    if (envelope.evidenceType !== evidenceType) throw new Error("live envelope evidence order or type is invalid");
    if (envelope.chainId !== binding.chainId) throw new Error("live envelope chain domain is invalid");
    if (envelope.contract !== binding.contract) throw new Error("live envelope contract domain is invalid");
    if (envelope.caseId !== binding.caseId) throw new Error("live envelope case domain is invalid");
    if (envelope.epoch !== binding.epoch) throw new Error("live envelope epoch domain is invalid");
    if (envelope.subjectOrigin !== binding.subjectOrigin) throw new Error("live envelope subject origin is invalid");
    if (envelope.issuer !== binding.vendor) throw new Error("live envelope issuer is invalid");
    if (envelope.profileVersion !== binding.profileVersion) throw new Error("live envelope profile version is invalid");
    if (envelope.action !== (index === 0 ? "OPEN_RELEASE" : "APPEND_EVIDENCE")) throw new Error("live envelope action is invalid");
    if (envelope.mediaType !== MEDIA_TYPES[evidenceType]) throw new Error("live envelope media type is invalid");
    if (envelope.payloadUri !== expectedPayloadUri(evidenceType, options)) throw new Error("live envelope payload URL is invalid");
    if (nonces.has(envelope.nonce)) throw new Error("live envelope set contains a duplicate nonce");
    nonces.add(envelope.nonce);
    const noncePrefix = `${binding.releaseId}-${evidenceType.toLowerCase()}-${envelope.submittedAt}-`;
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
  if (options?.v4 !== undefined) {
    const screenshot = set.find((item) => item.envelope.evidenceType === "SCREENSHOT");
    const reviewImage = (verified.manifest as { reviewImage?: { sha256?: string } }).reviewImage;
    if (screenshot?.envelope.payloadSha256 !== options.v4.reviewImageSha256 || reviewImage?.sha256 !== options.v4.reviewImageSha256) {
      throw new Error("V4 review-image hash does not match the screenshot envelope");
    }
  }
  validateTimestampDomain(observedAt!, submittedAt!, expiresAt!, options?.v4);
  if (observedAt !== sharedObservedAt(verified)) {
    throw new Error("live envelope observedAt does not match the verified public evidence timestamp");
  }
}

export async function buildLiveEnvelopeSet(options: BuildLiveEnvelopeOptions): Promise<BuiltEnvelope[]> {
  requireSafeTimestamp(options.submittedAt, "submittedAt");
  requireSafeTimestamp(options.expiresAt, "expiresAt");
  requireGenerationId(options.generationId);
  const verified = await verifyPublicEvidence(options.publicDir, { v4: options.v4 });
  const observedAt = sharedObservedAt(verified);
  validateTimestampDomain(observedAt, options.submittedAt, options.expiresAt, options.v4);

  const manifestFiles = new Map(verified.manifest.files.map((file) => [file.evidenceType, file]));
  const set = EVIDENCE_ORDER.map((evidenceType, index): BuiltEnvelope => {
    const manifestFile = index === 0 ? undefined : manifestFiles.get(evidenceType as EvidenceType);
    if (index > 0 && manifestFile === undefined) throw new Error(`manifest is missing ${evidenceType}`);
    const envelope: EvidenceEnvelopeV1 = {
      schemaVersion: "accessseal-evidence/1",
      chainId: envelopeBinding(options).chainId,
      contract: envelopeBinding(options).contract,
      caseId: envelopeBinding(options).caseId,
      epoch: envelopeBinding(options).epoch,
      action: index === 0 ? "OPEN_RELEASE" : "APPEND_EVIDENCE",
      subjectOrigin: envelopeBinding(options).subjectOrigin,
      profileVersion: envelopeBinding(options).profileVersion,
      releaseDigest: verified.releaseDigest,
      evidenceType,
      issuer: envelopeBinding(options).vendor,
      payloadUri: expectedPayloadUri(evidenceType, options),
      payloadSha256: index === 0 ? verified.releaseDigest : manifestFile!.sha256,
      mediaType: MEDIA_TYPES[evidenceType]!,
      observedAt,
      submittedAt: options.submittedAt,
      expiresAt: options.expiresAt,
      nonce: `${envelopeBinding(options).releaseId}-${evidenceType.toLowerCase()}-${options.submittedAt}-${options.generationId}`,
    };
    const canonical = canonicalizeEvidence(envelope);
    return { envelope, canonicalJson: canonical, evidenceHash: hashEvidence(envelope) };
  });
  validateLiveEnvelopeSet(set, verified, options);
  return set;
}

function envelopeFilename(index: number, evidenceType: string): string {
  return `${String(index + 1).padStart(2, "0")}-${evidenceType.toLowerCase()}.json`;
}

const OUTPUT_FILENAMES = [
  ...EVIDENCE_ORDER.map((evidenceType, index) => envelopeFilename(index, evidenceType)),
  "summary.json",
] as const;
const OUTPUT_FILENAME_SET = new Set<string>(OUTPUT_FILENAMES);

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

async function inspectSafeOutputDirectory(path: string, requireComplete: boolean): Promise<boolean> {
  const rootStat = await stat(path);
  if (rootStat === undefined) return false;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`live envelope staging and output roots must be real directories, not symbolic links or junctions: ${path}`);
  }
  const names = await readdir(path);
  for (const name of names) {
    if (!OUTPUT_FILENAME_SET.has(name)) {
      throw new Error(`live envelope directory contains a path outside the fixed output allowlist: ${name}`);
    }
    const entry = await lstat(join(path, name));
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`live envelope output must be a regular file, not a symbolic link: ${join(path, name)}`);
    }
    if (entry.nlink !== 1) throw new Error(`live envelope output has multiple hard links: ${join(path, name)}`);
  }
  if (requireComplete) {
    const sortedNames = [...names].sort();
    const expectedNames = [...OUTPUT_FILENAMES].sort();
    if (canonicalJson(sortedNames) !== canonicalJson(expectedNames)) {
      throw new Error("live envelope directory is not a complete fixed output set");
    }
  }
  return true;
}

async function removeSafeOutputDirectory(path: string): Promise<void> {
  if (!await inspectSafeOutputDirectory(path, false)) return;
  for (const name of await readdir(path)) await unlink(join(path, name));
  await rmdir(path);
}

function envelopeSummary(set: readonly BuiltEnvelope[]) {
  return set.map((item) => ({
    evidenceType: item.envelope.evidenceType,
    action: item.envelope.action,
    evidenceHash: item.evidenceHash,
    payloadUri: item.envelope.payloadUri,
    releaseDigest: item.envelope.releaseDigest,
  }));
}

async function validateInstalledEnvelopeDirectory(
  path: string,
  verified: VerifiedPublicEvidence,
  options?: { v4?: V4EvidenceOptions },
): Promise<void> {
  if (!await inspectSafeOutputDirectory(path, true)) {
    throw new Error("live envelope directory is missing");
  }
  const set: BuiltEnvelope[] = [];
  for (const [index, evidenceType] of EVIDENCE_ORDER.entries()) {
    const bytes = await readFile(join(path, envelopeFilename(index, evidenceType)));
    const canonical = bytes.toString("utf8");
    let envelope: EvidenceEnvelopeV1;
    try {
      envelope = JSON.parse(canonical) as EvidenceEnvelopeV1;
    } catch {
      throw new Error("installed live envelope must contain JSON");
    }
    if (canonicalJson(envelope) !== canonical) {
      throw new Error("installed live envelope is not canonical JSON");
    }
    set.push({ envelope, canonicalJson: canonical, evidenceHash: hashEvidence(envelope) });
  }
  validateLiveEnvelopeSet(set, verified, options);
  const expectedSummary = canonicalJson(envelopeSummary(set));
  if ((await readFile(join(path, "summary.json"), "utf8")) !== expectedSummary) {
    throw new Error("installed live envelope summary does not match its envelope set");
  }
}

async function recoverEnvelopeSwap(
  outputRoot: string,
  stagingRoot: string,
  backupRoot: string,
  verified: VerifiedPublicEvidence,
  options?: { v4?: V4EvidenceOptions },
): Promise<void> {
  const hasOutput = await inspectSafeOutputDirectory(outputRoot, false);
  if (hasOutput) await validateInstalledEnvelopeDirectory(outputRoot, verified, options);
  const hasBackup = await inspectSafeOutputDirectory(backupRoot, false);
  if (hasBackup) {
    if (!hasOutput) {
      await validateInstalledEnvelopeDirectory(backupRoot, verified, options);
      await rename(backupRoot, outputRoot);
    } else {
      await removeSafeOutputDirectory(backupRoot);
    }
  }

  if (await inspectSafeOutputDirectory(stagingRoot, false)) {
    await removeSafeOutputDirectory(stagingRoot);
  }
}

export async function writeLiveEnvelopeSet(
  set: readonly BuiltEnvelope[],
  publicDirectory: string,
  outputDirectory: string,
  options?: { v4?: V4EvidenceOptions },
): Promise<void> {
  const requestedOutput = resolve(outputDirectory);
  if (requestedOutput !== resolve("work/evidence/live-envelopes")) {
    throw new Error("live envelopes may only be written under the approved ignored output directory");
  }
  const verified = await verifyPublicEvidence(publicDirectory, options);
  validateLiveEnvelopeSet(set, verified, options);
  const outputParent = await ensureRealDirectory(dirname(requestedOutput));
  const outputRoot = join(outputParent, "live-envelopes");
  const stagingRoot = join(outputParent, ".live-envelopes.staging");
  const backupRoot = join(outputParent, ".live-envelopes.backup");
  await recoverEnvelopeSwap(outputRoot, stagingRoot, backupRoot, verified, options);
  const summary = envelopeSummary(set);
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

  await mkdir(stagingRoot);
  try {
    for (const write of writes) {
      const destination = join(stagingRoot, write.path.slice(outputRoot.length + 1));
      const handle = await open(destination, "wx", 0o600);
      try {
        await handle.writeFile(write.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await validateInstalledEnvelopeDirectory(stagingRoot, verified, options);
    if (await stat(outputRoot) !== undefined) {
      await rename(outputRoot, backupRoot);
    }
    try {
      await rename(stagingRoot, outputRoot);
    } catch (error) {
      if (await stat(outputRoot) === undefined && await stat(backupRoot) !== undefined) {
        await rename(backupRoot, outputRoot);
      }
      throw error;
    }
    await removeSafeOutputDirectory(backupRoot);
  } catch (error) {
    if (await stat(outputRoot) === undefined && await stat(backupRoot) !== undefined) {
      await rename(backupRoot, outputRoot);
    }
    await removeSafeOutputDirectory(stagingRoot);
    throw error;
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith("--")) throw new Error(`missing required argument ${name}`);
  return value;
}

async function v4OptionsFromArguments(): Promise<{ v4?: V4EvidenceOptions }> {
  const index = process.argv.indexOf("--v4-binding");
  if (index < 0) return {};
  const filename = process.argv[index + 1];
  if (filename === undefined || filename.startsWith("--")) throw new Error("missing required argument --v4-binding");
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(filename, "utf8")); } catch { throw new Error("V4 binding file must contain valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("V4 binding file must contain an object");
  return { v4: parsed as V4EvidenceOptions };
}

async function main(): Promise<void> {
  const publicDir = argument("--public-dir");
  const outputDir = resolve(argument("--output-dir"));
  const options = await v4OptionsFromArguments();
  const submittedAt = Math.floor(Date.now() / 1_000);
  const generationId = randomUUID().replaceAll("-", "");
  const expiresAt = Math.min(submittedAt + MAX_ENVELOPE_LIFETIME_SECONDS, ABSOLUTE_HARD_DEADLINE);
  const set = await buildLiveEnvelopeSet({ publicDir, submittedAt, expiresAt, generationId, ...options });
  await writeLiveEnvelopeSet(set, publicDir, outputDir, options);
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

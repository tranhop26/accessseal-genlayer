import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertRealDirectory,
  assertSafeRegularFile,
  canonicalJsonHash,
  sourceHash,
  withV3ManifestNamespaceLease,
} from "../scripts/source-hash.ts";
import { canonicalU256, parseLosslessJsonObject } from "../scripts/u256.ts";

export const NETWORK_CHAIN_IDS = {
  localnet: 61127,
  studionet: 61999,
  testnet_asimov: 4221,
  testnet_bradbury: 4221,
} as const;

export type NetworkName = keyof typeof NETWORK_CHAIN_IDS;
export const NETWORK_CHAIN_NAMES: Record<NetworkName, string> = {
  localnet: "Genlayer Localnet",
  studionet: "Genlayer Studio Network",
  testnet_asimov: "Genlayer Asimov Testnet",
  testnet_bradbury: "Genlayer Bradbury Testnet",
};

export function identifyClientNetwork(
  chain: { id: number; name: string },
  requested?: string,
): NetworkName {
  const observed = (Object.keys(NETWORK_CHAIN_IDS) as NetworkName[]).find(
    (network) =>
      NETWORK_CHAIN_IDS[network] === chain.id &&
      NETWORK_CHAIN_NAMES[network] === chain.name,
  );
  if (!observed || (requested !== undefined && requested !== observed)) {
    throw new Error("configured client network identity is invalid");
  }
  return observed;
}

export type DeploymentManifest = {
  schemaVersion: "accessseal-deployment-manifest/2";
  network: NetworkName;
  chainId: number;
  contractAddress: string;
  deploymentTransaction: string;
  readableSourceSha256: string;
  deploymentArtifactSha256: string;
  sourceSha256: string;
  schemaSha256: string;
  gitCommit: string;
  deployedAt: string;
  contractClassification: "INTENTIONALLY_FROZEN";
};

export type VerificationClient = {
  chain: { id: number; name: string };
  getContractCode(address: string): Promise<unknown>;
  getContractSchema(address: string): Promise<unknown>;
  getContractSchemaForCode(code: Uint8Array): Promise<unknown>;
  getTransaction(args: { hash: string }): Promise<unknown>;
  readContract(args: {
    address: string;
    functionName: string;
    args: unknown[];
    transactionHashVariant: "latest-final";
  }): Promise<unknown>;
};

export type RepositoryGitState = { commit: string; clean: boolean };
export type VerificationOptions = { repoRoot?: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40,64}$/;
export const ACCESSSEAL_FROZEN_SCHEMA_SHA256 =
  "e6417d8be197f2ad760a3a44ddc6dcfb3b6011ceb9d462270b190ee8e85033b2";
const ACCOUNTING_KEYS = [
  "dispatchedPayouts",
  "dispatchedRefunds",
  "pendingDispatch",
  "reserved",
  "totalDeposits",
] as const;

export function validateDeploymentManifest(value: DeploymentManifest): DeploymentManifest {
  if (!value || typeof value !== "object") throw new Error("deployment manifest is missing");
  if (value.schemaVersion !== "accessseal-deployment-manifest/2") {
    throw new Error("deployment manifest schema version is invalid");
  }
  if (!(value.network in NETWORK_CHAIN_IDS)) throw new Error("deployment network is invalid");
  if (value.chainId !== NETWORK_CHAIN_IDS[value.network]) {
    throw new Error("deployment network chain ID is invalid");
  }
  if (
    !ADDRESS.test(value.contractAddress) ||
    isRepeatedHex(value.contractAddress.slice(2))
  ) {
    throw new Error("deployment contract address is missing or invalid");
  }
  if (!TX_HASH.test(value.deploymentTransaction) || isRepeatedHex(value.deploymentTransaction.slice(2))) {
    throw new Error("deployment transaction hash is invalid");
  }
  if (
    !HASH.test(value.readableSourceSha256) ||
    !HASH.test(value.deploymentArtifactSha256) ||
    !HASH.test(value.sourceSha256) ||
    !HASH.test(value.schemaSha256) ||
    isRepeatedHex(value.readableSourceSha256) ||
    isRepeatedHex(value.deploymentArtifactSha256) ||
    isRepeatedHex(value.sourceSha256) ||
    isRepeatedHex(value.schemaSha256)
  ) {
    throw new Error("deployment source or schema hash is invalid");
  }
  if (value.sourceSha256 !== value.deploymentArtifactSha256) {
    throw new Error("deployment source hash alias contradicts artifact hash");
  }
  if (!GIT_COMMIT.test(value.gitCommit) || isRepeatedHex(value.gitCommit)) {
    throw new Error("deployment Git commit is invalid");
  }
  if (
    typeof value.deployedAt !== "string" ||
    Number.isNaN(Date.parse(value.deployedAt)) ||
    new Date(value.deployedAt).toISOString() !== value.deployedAt ||
    Date.parse(value.deployedAt) === 0
  ) {
    throw new Error("deployment timestamp is invalid");
  }
  if (value.contractClassification !== "INTENTIONALLY_FROZEN") {
    throw new Error("deployment contract classification is invalid");
  }
  return value;
}

export async function verifyDeployment(
  client: VerificationClient,
  manifest: DeploymentManifest,
  options: VerificationOptions = {},
): Promise<{ accounting: Record<(typeof ACCOUNTING_KEYS)[number], string> }> {
  validateDeploymentManifest(manifest);
  const repoRoot = options.repoRoot ?? process.cwd();
  verifyTrackedArtifact(repoRoot);
  const gitState = readRepositoryGitState(repoRoot);
  if (!gitState.clean) throw new Error("verification Git worktree is dirty");
  if (gitState.commit !== manifest.gitCommit) {
    throw new Error("verification Git commit does not match deployment manifest");
  }
  if (
    client.chain.id !== manifest.chainId ||
    client.chain.name !== NETWORK_CHAIN_NAMES[manifest.network]
  ) {
    throw new Error("client network identity mismatch");
  }
  const readableSource = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal.py")),
  );
  const deploymentArtifact = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal_deploy.py")),
  );
  if (sourceHash(readableSource) !== manifest.readableSourceSha256) {
    throw new Error("readable source hash does not match deployment manifest");
  }
  if (sourceHash(deploymentArtifact) !== manifest.deploymentArtifactSha256) {
    throw new Error("deployment artifact hash does not match deployment manifest");
  }

  const [deploymentTransaction, deployedCode, deployedSchema, expectedSchema] = await Promise.all([
    client.getTransaction({ hash: manifest.deploymentTransaction }),
    client.getContractCode(manifest.contractAddress),
    client.getContractSchema(manifest.contractAddress),
    client.getContractSchemaForCode(deploymentArtifact),
  ]);
  const transaction = normalizeReceipt(deploymentTransaction);
  if (transaction.status !== "FINALIZED") {
    throw new Error("deployment transaction is not finalized");
  }
  if (transaction.execution !== "FINISHED_WITH_RETURN") {
    throw new Error("deployment transaction execution failed");
  }
  if (!transaction.hash || transaction.hash.toLowerCase() !== manifest.deploymentTransaction.toLowerCase()) {
    throw new Error("deployment transaction hash binding is unavailable");
  }
  if (!transaction.contractAddress || transaction.contractAddress !== manifest.contractAddress.toLowerCase()) {
    throw new Error("deployment transaction contract address mismatch");
  }
  if (typeof deployedCode !== "string") {
    throw new Error("official client contract code response is unavailable");
  }
  if (!(deployedSchema && typeof deployedSchema === "object")) {
    throw new Error("official client deployed schema response is unavailable");
  }
  if (!(expectedSchema && typeof expectedSchema === "object")) {
    throw new Error("official client source schema response is unavailable");
  }
  const canonicalDeployedCode = deployedCode.replace(/\r\n/g, "\n");
  if (sourceHash(new TextEncoder().encode(canonicalDeployedCode)) !== manifest.deploymentArtifactSha256) {
    throw new Error("deployed source does not match deployment artifact");
  }
  const expectedSchemaHash = canonicalJsonHash(expectedSchema);
  if (expectedSchemaHash !== manifest.schemaSha256) {
    throw new Error("source-derived schema does not match deployment manifest");
  }
  if (canonicalJsonHash(deployedSchema) !== expectedSchemaHash) {
    throw new Error("deployed schema does not match source-derived schema");
  }
  verifyFrozenSchema(deployedSchema);

  const accountingRaw = await client.readContract({
    address: manifest.contractAddress,
    functionName: "get_accounting",
    args: [],
    transactionHashVariant: "latest-final",
  });
  const accounting = parseAccounting(accountingRaw);
  return { accounting };
}

export function verifyTrackedArtifact(repoRoot: string): void {
  try {
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      [resolve(repoRoot, "scripts", "build_contract_artifact.py"), "--repo-root", repoRoot, "--check"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error("deployment artifact is missing or stale");
  }
}

export function verifyFrozenSchema(schema: object): void {
  if (canonicalJsonHash(schema) !== ACCESSSEAL_FROZEN_SCHEMA_SHA256) {
    throw new Error("deployed frozen schema differs from the exact reviewed policy");
  }
}

export function normalizeReceipt(value: unknown): {
  status: string;
  execution: string;
  contractAddress?: string;
  hash?: string;
} {
  if (!value || typeof value !== "object") {
    throw new Error("official client receipt shape is unavailable");
  }
  const receipt = value as Record<string, unknown>;
  const status = consistentAlias(receipt, "statusName", "status_name", "status");
  const execution = consistentAlias(
    receipt,
    "txExecutionResultName",
    "tx_execution_result_name",
    "execution",
  );
  const studio = nestedString(receipt.data, "contract_address");
  const testnet = nestedString(receipt.txDataDecoded, "contractAddress");
  if (studio && testnet && studio.toLowerCase() !== testnet.toLowerCase()) {
    throw new Error("official client receipt contains contradictory contract addresses");
  }
  const hash = consistentOptionalAlias(receipt, "hash", "txId", "transaction hash");
  return {
    status,
    execution,
    contractAddress: (studio ?? testnet)?.toLowerCase(),
    hash,
  };
}

function consistentAlias(
  record: Record<string, unknown>,
  first: string,
  second: string,
  label: string,
): string {
  const value = consistentOptionalAlias(record, first, second, label);
  if (!value) {
    throw new Error(
      `official client receipt shape has unavailable ${label}; fields=${Object.keys(record).sort().join(",")}`,
    );
  }
  return value;
}

function consistentOptionalAlias(
  record: Record<string, unknown>,
  first: string,
  second: string,
  label: string,
): string | undefined {
  const left = record[first];
  const right = record[second];
  if (left !== undefined && typeof left !== "string") {
    throw new Error(`official client receipt ${label} shape is unavailable`);
  }
  if (right !== undefined && typeof right !== "string") {
    throw new Error(`official client receipt ${label} shape is unavailable`);
  }
  if (left !== undefined && right !== undefined && left !== right) {
    throw new Error(`official client receipt has contradictory ${label} aliases`);
  }
  return (left ?? right) as string | undefined;
}

function nestedString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("official client receipt address shape is unavailable");
  }
  const nested = (value as Record<string, unknown>)[key];
  if (nested === undefined) return undefined;
  if (typeof nested !== "string" || !ADDRESS.test(nested) || isRepeatedHex(nested.slice(2))) {
    throw new Error(
      `official client receipt contract address shape is unavailable: ${String(nested)}`,
    );
  }
  return nested;
}

function isRepeatedHex(value: string): boolean {
  return /^([0-9a-f])\1+$/i.test(value);
}

export function readRepositoryGitState(repoRoot: string): RepositoryGitState {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return { commit, clean: dirty.length === 0 };
}

function parseAccounting(value: unknown): Record<(typeof ACCOUNTING_KEYS)[number], string> {
  const record = parseLosslessJsonObject(value, "accounting readback");
  if (Object.keys(record).sort().join(",") !== [...ACCOUNTING_KEYS].sort().join(",")) {
    throw new Error("accounting readback fields are invalid");
  }
  let accounting: Record<(typeof ACCOUNTING_KEYS)[number], string>;
  try {
    accounting = Object.fromEntries(ACCOUNTING_KEYS.map((key) => [key, canonicalU256(record[key], `accounting ${key}`)])) as Record<(typeof ACCOUNTING_KEYS)[number], string>;
  } catch {
    throw new Error("accounting readback fields are invalid");
  }
  if (
    BigInt(accounting.totalDeposits) !==
    BigInt(accounting.reserved) + BigInt(accounting.pendingDispatch) +
      BigInt(accounting.dispatchedPayouts) + BigInt(accounting.dispatchedRefunds)
  ) {
    throw new Error("accounting readback violates conservation");
  }
  return accounting;
}

export function deploymentToSettlementProofEnvironment(
  manifest: DeploymentManifest,
): Record<string, string> {
  validateDeploymentManifest(manifest);
  if (!(["studionet", "testnet_asimov", "testnet_bradbury"] as string[]).includes(manifest.network)) {
    throw new Error("deployment network is not compatible with live settlement proof collection");
  }
  return {
    ACCESSSEAL_LIVE_NETWORK: manifest.network,
    ACCESSSEAL_LIVE_CHAIN_ID: String(manifest.chainId),
    ACCESSSEAL_LIVE_CONTRACT_ADDRESS: manifest.contractAddress.toLowerCase(),
  };
}

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

type PinnedManifest = {
  body: string;
  identity: FileIdentity;
};

type CheckedDirectory = {
  path: string;
  identity: FileIdentity;
};

type V3CandidateDirectory = CheckedDirectory & {
  deploymentArtifactSha256: string;
};

type V3CandidateSnapshot = {
  root: CheckedDirectory;
  candidates: V3CandidateDirectory[];
};

type V3RequestedManifest = {
  deploymentArtifactSha256: string;
  path: string;
  identity: FileIdentity;
};

export async function readDeploymentManifest(
  repoRoot: string,
  network: NetworkName,
  contractAddress?: string,
): Promise<DeploymentManifest> {
  const v3Root = resolve(
    repoRoot,
    "work",
    "deployments",
    network,
    "v3",
  );
  return withV3ManifestNamespaceLease(
    v3Root,
    () => readDeploymentManifestUnderLease(repoRoot, network, v3Root, contractAddress),
  );
}

async function readDeploymentManifestUnderLease(
  repoRoot: string,
  network: NetworkName,
  v3Root: string,
  contractAddress?: string,
): Promise<DeploymentManifest> {
  const parseV3 = async (
    root: string,
    path: string,
  ): Promise<{ manifest: DeploymentManifest; identity: FileIdentity }> => {
    const pinned = await readPinnedManifest(root, path);
    const manifest = validateDeploymentManifest(
      JSON.parse(pinned.body) as DeploymentManifest,
    );
    if ((manifest as { contractVersion?: unknown }).contractVersion !== "V3") {
      throw new Error("V3 deployment manifest contract version is invalid");
    }
    return { manifest, identity: pinned.identity };
  };
  if (contractAddress) {
    if (!ADDRESS.test(contractAddress)) {
      throw new Error("verification contract address is invalid");
    }
    const target = `${contractAddress.toLowerCase()}.json`;
    let snapshot: V3CandidateSnapshot;
    let requested: V3RequestedManifest[];
    try {
      snapshot = await scanV3CandidateDirectories(v3Root);
      requested = await scanV3RequestedManifests(snapshot, target);
    } catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) {
        throw new Error("V3 deployment manifest is unavailable for the requested contract address");
      }
      throw error;
    }
    const matches = await Promise.all(
      requested.map(async (candidate) => {
        try {
          const parsed = await parseV3(snapshot.root.path, candidate.path);
          assertSameFileIdentity(
            candidate.identity,
            parsed.identity,
            "V3 deployment manifest changed during lookup",
          );
          const manifest = parsed.manifest;
          if (manifest.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) {
            throw new Error("V3 deployment manifest requested contract address mismatch");
          }
          if (manifest.deploymentArtifactSha256 !== candidate.deploymentArtifactSha256) {
            throw new Error("V3 deployment manifest artifact hash does not match containing directory");
          }
          return { manifest, path: candidate.path, identity: parsed.identity };
        } catch (error) {
          if (error instanceof Error && /ENOENT/.test(error.message)) return null;
          throw error;
        }
      }),
    );
    const found = matches.filter((manifest): manifest is NonNullable<typeof manifest> => manifest !== null);
    if (found.length !== 1) {
      throw new Error(
        found.length
          ? "V3 deployment manifest address is ambiguous"
        : "V3 deployment manifest is unavailable for the requested contract address",
      );
    }
    const revalidated = await scanV3CandidateDirectories(v3Root);
    const revalidatedRequested = await scanV3RequestedManifests(revalidated, target);
    if (
      !sameV3CandidateSnapshot(snapshot, revalidated) ||
      !sameV3RequestedManifests(requested, revalidatedRequested)
    ) {
      throw new Error("V3 deployment manifest candidates changed during lookup");
    }
    const selected = found[0];
    const current = await inspectPinnedManifestPath(revalidated.root.path, selected.path);
    assertSameFileIdentity(
      selected.identity,
      current,
      "V3 deployment manifest changed during lookup",
    );
    return selected.manifest;
  }
  const artifact = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal_deploy.py")),
  );
  const artifactHash = sourceHash(artifact);
  try {
    const root = await inspectRealDirectory(v3Root);
    const directory = await inspectRealDirectory(resolve(root.path, artifactHash));
    const candidates = await listAddressManifestCandidates(directory.path);
    const selected = contractAddress
      ? `${contractAddress.toLowerCase()}.json`
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!selected || !candidates.includes(selected)) {
      throw new Error(
        "V3 deployment manifest is ambiguous; provide --contract-address for the exact deployment",
      );
    }
    const path = resolve(directory.path, selected);
    const parsed = await parseV3(root.path, path);
    const revalidatedRoot = await inspectRealDirectory(v3Root);
    const revalidatedDirectory = await inspectRealDirectory(resolve(revalidatedRoot.path, artifactHash));
    if (
      !sameFileIdentity(root.identity, revalidatedRoot.identity) ||
      !sameFileIdentity(directory.identity, revalidatedDirectory.identity) ||
      !sameStringArray(candidates, await listAddressManifestCandidates(revalidatedDirectory.path))
    ) {
      throw new Error("V3 deployment manifest candidates changed during lookup");
    }
    const current = await inspectPinnedManifestPath(revalidatedRoot.path, path);
    assertSameFileIdentity(parsed.identity, current, "V3 deployment manifest changed during lookup");
    return parsed.manifest;
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(error.message)) throw error;
  }
  const legacyDirectory = await inspectRealDirectory(resolve(repoRoot, "work", "deployments"));
  const legacyPath = resolve(legacyDirectory.path, `${network}.json`);
  const legacy = await readPinnedManifest(legacyDirectory.path, legacyPath);
  return validateDeploymentManifest(JSON.parse(legacy.body) as DeploymentManifest);
}

async function readPinnedManifest(
  root: string,
  path: string,
): Promise<PinnedManifest> {
  const beforeOpen = await inspectPinnedManifestPath(root, path);
  const handle = await open(path, manifestReadFlags());
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    if (!openedMetadata.isFile()) throw new Error("opened V3 deployment manifest is not a regular file");
    const opened = fileIdentity(openedMetadata, "opened V3 deployment manifest");
    assertSameFileIdentity(beforeOpen, opened, "V3 deployment manifest changed during lookup");
    const pathAfterOpen = await inspectPinnedManifestPath(root, path);
    assertSameFileIdentity(opened, pathAfterOpen, "V3 deployment manifest changed during lookup");

    const body = (await handle.readFile()).toString("utf8");
    const handleAfterReadMetadata = await handle.stat({ bigint: true });
    if (!handleAfterReadMetadata.isFile()) {
      throw new Error("opened V3 deployment manifest is not a regular file");
    }
    const handleAfterRead = fileIdentity(handleAfterReadMetadata, "opened V3 deployment manifest");
    const pathAfterRead = await inspectPinnedManifestPath(root, path);
    assertSameFileIdentity(opened, handleAfterRead, "V3 deployment manifest changed during lookup");
    assertSameFileIdentity(handleAfterRead, pathAfterRead, "V3 deployment manifest changed during lookup");
    return { body, identity: handleAfterRead };
  } finally {
    await handle.close();
  }
}

async function inspectPinnedManifestPath(root: string, path: string): Promise<FileIdentity> {
  await assertSafeRegularFile(root, path);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("V3 deployment manifest must remain a physically contained regular file");
  }
  return fileIdentity(metadata, "V3 deployment manifest path");
}

async function scanV3CandidateDirectories(v3Root: string): Promise<V3CandidateSnapshot> {
  const root = await inspectRealDirectory(v3Root);
  const names = (await readdir(root.path, { withFileTypes: true }))
    .filter((entry) => HASH.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const candidates = await Promise.all(
    names.map(async (name) => ({
      ...(await inspectRealDirectory(resolve(root.path, name))),
      deploymentArtifactSha256: name,
    })),
  );
  return { root, candidates };
}

async function scanV3RequestedManifests(
  snapshot: V3CandidateSnapshot,
  target: string,
): Promise<V3RequestedManifest[]> {
  const candidates = await Promise.all(
    snapshot.candidates.map(async (directory) => {
      const path = resolve(directory.path, target);
      try {
        return {
          deploymentArtifactSha256: directory.deploymentArtifactSha256,
          path,
          identity: await inspectPinnedManifestPath(snapshot.root.path, path),
        };
      } catch (error) {
        if (error instanceof Error && /ENOENT/.test(error.message)) return null;
        throw error;
      }
    }),
  );
  return candidates.filter((candidate): candidate is V3RequestedManifest => candidate !== null);
}

async function inspectRealDirectory(path: string): Promise<CheckedDirectory> {
  const realPath = await assertRealDirectory(path);
  const metadata = await lstat(realPath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("V3 deployment manifest directory is not a real directory");
  }
  return { path: realPath, identity: fileIdentity(metadata, "V3 deployment manifest directory") };
}

async function listAddressManifestCandidates(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => /^0x[0-9a-f]{40}\.json$/.test(name))
    .sort();
}

function sameV3CandidateSnapshot(
  first: V3CandidateSnapshot,
  second: V3CandidateSnapshot,
): boolean {
  return (
    first.root.path === second.root.path &&
    sameFileIdentity(first.root.identity, second.root.identity) &&
    first.candidates.length === second.candidates.length &&
    first.candidates.every((candidate, index) => {
      const other = second.candidates[index];
      return (
        candidate.path === other.path &&
        candidate.deploymentArtifactSha256 === other.deploymentArtifactSha256 &&
        sameFileIdentity(candidate.identity, other.identity)
      );
    })
  );
}

function sameV3RequestedManifests(
  first: V3RequestedManifest[],
  second: V3RequestedManifest[],
): boolean {
  return (
    first.length === second.length &&
    first.every((candidate, index) => {
      const other = second[index];
      return (
        candidate.deploymentArtifactSha256 === other.deploymentArtifactSha256 &&
        candidate.path === other.path &&
        sameFileIdentity(candidate.identity, other.identity)
      );
    })
  );
}

function sameStringArray(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function fileIdentity(
  metadata: { dev: bigint; ino: bigint },
  description: string,
): FileIdentity {
  const identity = { dev: metadata.dev, ino: metadata.ino };
  if (
    identity.dev === 0n &&
    identity.ino === 0n
  ) {
    throw new Error(`${description} cannot establish a stable filesystem identity`);
  }
  return identity;
}

function assertSameFileIdentity(first: FileIdentity, second: FileIdentity, message: string): void {
  if (!sameFileIdentity(first, second)) throw new Error(message);
}

function sameFileIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function manifestReadFlags(): number {
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW;
  // Windows lacks O_NOFOLLOW. Its fallback is only accepted with the pinned-handle
  // identity checks before and after the read above; absent stable identity, lookup fails closed.
  return typeof noFollow === "number" && noFollow !== 0
    ? constants.O_RDONLY | noFollow
    : constants.O_RDONLY;
}

export default async function main(
  client: VerificationClient,
  requestedNetwork = process.env.GENLAYER_NETWORK,
  contractAddress?: string,
): Promise<void> {
  const network = identifyClientNetwork(client.chain, requestedNetwork);
  const manifest = await readDeploymentManifest(process.cwd(), network, contractAddress);
  await verifyDeployment(client, manifest);
}

export function parseVerificationArguments(args: string[]): NetworkName {
  if (
    (args.length !== 2 && args.length !== 4) ||
    args[0] !== "--network" ||
    (args.length === 4 && args[2] !== "--contract-address")
  ) {
    throw new Error("usage: npm run verify:deployment -- --network <network> [--contract-address <address>]");
  }
  const network = args[1];
  if (!network || !(network in NETWORK_CHAIN_IDS)) {
    throw new Error("verification network is invalid");
  }
  return network as NetworkName;
}

export function parseVerificationContractAddress(args: string[]): string | undefined {
  if (args.length !== 4) return;
  const address = args[3];
  if (!ADDRESS.test(address)) throw new Error("verification contract address is invalid");
  return address.toLowerCase();
}

export async function runVerificationCli(args = process.argv.slice(2)): Promise<void> {
  const network = parseVerificationArguments(args);
  const contractAddress = parseVerificationContractAddress(args);
  const [{ createClient }, chainDefinitions] = await Promise.all([
    import("genlayer-js"),
    import("genlayer-js/chains"),
  ]);
  const chain = {
    localnet: chainDefinitions.localnet,
    studionet: chainDefinitions.studionet,
    testnet_asimov: chainDefinitions.testnetAsimov,
    testnet_bradbury: chainDefinitions.testnetBradbury,
  }[network];
  await main(
    createClient({ chain }) as unknown as VerificationClient,
    network,
    contractAddress,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runVerificationCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "deployment verification failed");
    process.exitCode = 1;
  });
}

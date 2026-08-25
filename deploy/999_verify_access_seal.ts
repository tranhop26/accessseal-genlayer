import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertRealDirectory,
  assertSafeRegularFile,
  canonicalJsonHash,
  sourceHash,
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
      "python",
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
  const parseV3 = async (root: string, path: string): Promise<DeploymentManifest> => {
    await assertSafeRegularFile(root, path);
    const body = await readFile(path, "utf8");
    await assertSafeRegularFile(root, path);
    const manifest = validateDeploymentManifest(
      JSON.parse(body) as DeploymentManifest,
    );
    if ((manifest as { contractVersion?: unknown }).contractVersion !== "V3") {
      throw new Error("V3 deployment manifest contract version is invalid");
    }
    return manifest;
  };
  if (contractAddress) {
    if (!ADDRESS.test(contractAddress)) {
      throw new Error("verification contract address is invalid");
    }
    const target = `${contractAddress.toLowerCase()}.json`;
    let directories: Array<{ path: string; deploymentArtifactSha256: string }>;
    let realV3Root: string;
    try {
      realV3Root = await assertRealDirectory(v3Root);
      directories = (await readdir(realV3Root, { withFileTypes: true }))
        .filter((entry) => HASH.test(entry.name))
        .map((entry) => ({
          path: resolve(realV3Root, entry.name),
          deploymentArtifactSha256: entry.name,
        }));
    } catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) {
        throw new Error("V3 deployment manifest is unavailable for the requested contract address");
      }
      throw error;
    }
    const matches = await Promise.all(
      directories.map(async (directory) => {
        const realDirectory = await assertRealDirectory(directory.path);
        const path = resolve(realDirectory, target);
        try {
          const manifest = await parseV3(realV3Root, path);
          if (manifest.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) {
            throw new Error("V3 deployment manifest requested contract address mismatch");
          }
          if (manifest.deploymentArtifactSha256 !== directory.deploymentArtifactSha256) {
            throw new Error("V3 deployment manifest artifact hash does not match containing directory");
          }
          return manifest;
        } catch (error) {
          if (error instanceof Error && /ENOENT/.test(error.message)) return null;
          throw error;
        }
      }),
    );
    const found = matches.filter((manifest): manifest is DeploymentManifest => manifest !== null);
    if (found.length !== 1) {
      throw new Error(
        found.length
          ? "V3 deployment manifest address is ambiguous"
          : "V3 deployment manifest is unavailable for the requested contract address",
      );
    }
    return found[0];
  }
  const artifact = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal_deploy.py")),
  );
  const artifactHash = sourceHash(artifact);
  let realV3Root: string;
  try {
    realV3Root = await assertRealDirectory(v3Root);
    const directory = await assertRealDirectory(resolve(realV3Root, artifactHash));
    const names = await readdir(directory);
    const candidates = names.filter((name) => /^0x[0-9a-f]{40}\.json$/.test(name));
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
    return await parseV3(realV3Root, resolve(directory, selected));
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(error.message)) throw error;
  }
  const legacyDirectory = await assertRealDirectory(resolve(repoRoot, "work", "deployments"));
  const legacyPath = resolve(legacyDirectory, `${network}.json`);
  await assertSafeRegularFile(legacyDirectory, legacyPath);
  const legacyBody = await readFile(legacyPath, "utf8");
  await assertSafeRegularFile(legacyDirectory, legacyPath);
  return validateDeploymentManifest(JSON.parse(legacyBody) as DeploymentManifest);
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

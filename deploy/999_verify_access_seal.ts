import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJsonHash, sourceHash } from "../scripts/source-hash.ts";
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
  schemaVersion: "accessseal-deployment-manifest/1";
  network: NetworkName;
  chainId: number;
  contractAddress: string;
  deploymentTransaction: string;
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
  "06596ec28d3b6c7932b4aeb7a6e72ee112dcbd3bea125f22ecd43e4cb7d2ba88";
const ACCOUNTING_KEYS = [
  "dispatchedPayouts",
  "dispatchedRefunds",
  "pendingDispatch",
  "reserved",
  "totalDeposits",
] as const;

export function validateDeploymentManifest(value: DeploymentManifest): DeploymentManifest {
  if (!value || typeof value !== "object") throw new Error("deployment manifest is missing");
  if (value.schemaVersion !== "accessseal-deployment-manifest/1") {
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
    !HASH.test(value.sourceSha256) ||
    !HASH.test(value.schemaSha256) ||
    isRepeatedHex(value.sourceSha256) ||
    isRepeatedHex(value.schemaSha256)
  ) {
    throw new Error("deployment source or schema hash is invalid");
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
  const repositorySource = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal.py")),
  );
  if (sourceHash(repositorySource) !== manifest.sourceSha256) {
    throw new Error("repository source hash does not match deployment manifest");
  }

  const [deploymentTransaction, deployedCode, deployedSchema, expectedSchema] = await Promise.all([
    client.getTransaction({ hash: manifest.deploymentTransaction }),
    client.getContractCode(manifest.contractAddress),
    client.getContractSchema(manifest.contractAddress),
    client.getContractSchemaForCode(repositorySource),
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
  if (sourceHash(new TextEncoder().encode(deployedCode)) !== manifest.sourceSha256) {
    throw new Error("deployed source does not match repository source");
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

export default async function main(
  client: VerificationClient,
  requestedNetwork = process.env.GENLAYER_NETWORK,
): Promise<void> {
  const network = identifyClientNetwork(client.chain, requestedNetwork);
  const manifestPath = resolve(process.cwd(), "work", "deployments", `${network}.json`);
  const manifest = validateDeploymentManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as DeploymentManifest,
  );
  await verifyDeployment(client, manifest);
}

export function parseVerificationArguments(args: string[]): NetworkName {
  if (args.length !== 2 || args[0] !== "--network") {
    throw new Error("usage: npm run verify:deployment -- --network <network>");
  }
  const network = args[1];
  if (!network || !(network in NETWORK_CHAIN_IDS)) {
    throw new Error("verification network is invalid");
  }
  return network as NetworkName;
}

export async function runVerificationCli(args = process.argv.slice(2)): Promise<void> {
  const network = parseVerificationArguments(args);
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
  await main(createClient({ chain }) as unknown as VerificationClient, network);
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

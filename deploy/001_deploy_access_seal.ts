import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  atomicWriteJsonExclusive,
  ensurePersistentPosixJsonCapability,
  canonicalJsonHash,
  removeExclusiveJsonInstall,
  sourceHash,
  withV3ManifestNamespaceLease as withV4ManifestNamespaceLease,
  type ExclusiveJsonInstallReceipt,
} from "../scripts/source-hash.ts";
import {
  NETWORK_CHAIN_IDS,
  NETWORK_CHAIN_NAMES,
  identifyClientNetwork,
  normalizeReceipt,
  readRepositoryGitState,
  readReviewedArtifactSchema,
  verifyDeployment,
  verifyFrozenSchema,
  verifyTrackedArtifact,
  type DeploymentManifest,
  type NetworkName,
  type VerificationClient,
} from "./999_verify_access_seal.ts";

export type DeploymentClient = VerificationClient & {
  account?: unknown;
  deployContract(args: { code: Uint8Array; args: unknown[] }): Promise<unknown>;
  waitForTransactionReceipt(args: {
    hash: string;
    status: "ACCEPTED" | "FINALIZED";
    retries: number;
  }): Promise<unknown>;
};

export type GitState = { commit: string; clean: boolean };
export type V4DeploymentManifest = DeploymentManifest & {
  contractVersion: "V4";
};
export type V4ManifestPath = {
  network: string;
  contractVersion: "V4";
  contractAddress: string;
  deploymentArtifactSha256: string;
};

type DeployOptions = {
  network: string;
  repoRoot?: string;
};

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const GIT_COMMIT = /^[0-9a-f]{40,64}$/;
const SOURCE_HASH = /^[0-9a-f]{64}$/;

export function validateNetworkName(value: string): NetworkName {
  if (!Object.prototype.hasOwnProperty.call(NETWORK_CHAIN_IDS, value)) {
    throw new Error("GenLayer network name is invalid");
  }
  return value as NetworkName;
}

function deploymentManifestDirectory(
  repoRoot: string,
  network: string,
  deploymentArtifactSha256: string,
): string {
  if (!SOURCE_HASH.test(deploymentArtifactSha256) || isRepeatedHex(deploymentArtifactSha256)) {
    throw new Error("deployment artifact source hash is invalid");
  }
  return join(
    deploymentManifestV4Root(repoRoot, network),
    deploymentArtifactSha256,
  );
}

function deploymentManifestV4Root(repoRoot: string, network: string): string {
  return join(
    repoRoot,
    "work",
    "deployments",
    validateNetworkName(network),
    "v4",
  );
}

export function deploymentManifestPath(
  repoRoot: string,
  value: V4ManifestPath,
): string {
  if (value.contractVersion !== "V4") {
    throw new Error("deployment manifest contract version is invalid");
  }
  if (!ADDRESS.test(value.contractAddress)) {
    throw new Error("deployment manifest contract address is invalid");
  }
  return join(
    deploymentManifestDirectory(
      repoRoot,
      value.network,
      value.deploymentArtifactSha256,
    ),
    `${value.contractAddress.toLowerCase()}.json`,
  );
}

async function preflightV4ManifestDestination(
  repoRoot: string,
  network: NetworkName,
  deploymentArtifactSha256: string,
): Promise<void> {
  if (process.platform !== "win32") {
    const directory = deploymentManifestDirectory(
      repoRoot,
      network,
      deploymentArtifactSha256,
    );
    await ensurePersistentPosixJsonCapability(
      join(directory, ".accessseal-v4.preflight.json"),
      {
        schemaVersion: "accessseal-v4-posix-preflight/1",
        deploymentArtifactSha256,
      },
    );
    return;
  }
  const directory = deploymentManifestDirectory(
    repoRoot,
    network,
    deploymentArtifactSha256,
  );
  const probe = join(directory, `.accessseal-preflight-${randomUUID()}.probe`);
  let probeReceipt: ExclusiveJsonInstallReceipt | undefined;
  let probeError: unknown;
  try {
    probeReceipt = await atomicWriteJsonExclusive(probe, { preflight: "accessseal-v4" });
  } catch (error) {
    probeError = error;
  }
  let cleanupError: unknown;
  if (probeReceipt) {
    try {
      await removeExclusiveJsonInstall(probeReceipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
  }
  if (probeError || cleanupError) {
    const detail = [probeError, cleanupError]
      .filter((error): error is unknown => error !== undefined)
      .map((error) => error instanceof Error ? error.message : String(error))
      .join("; ");
    throw new Error(`deployment manifest destination preflight failed: ${detail}`);
  }
}

export async function deployAccessSeal(
  client: DeploymentClient,
  options: DeployOptions,
): Promise<V4DeploymentManifest> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const network = validateNetworkName(options.network);
  if (client.chain.id !== NETWORK_CHAIN_IDS[network] || client.chain.name !== NETWORK_CHAIN_NAMES[network]) {
    throw new Error("configured client does not match the requested GenLayer network");
  }
  if (!client.account) throw new Error("configured client has no environment-provided signer account");
  const gitState = readGitState(repoRoot);
  assertDeployableGitState(gitState);
  verifyTrackedArtifact(repoRoot);
  const readableSource = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal.py")),
  );
  const deploymentArtifact = new Uint8Array(
    await readFile(resolve(repoRoot, "contracts", "access_seal_deploy.py")),
  );
  if (readableSource.byteLength === 0 || deploymentArtifact.byteLength === 0) {
    throw new Error("contract source or deployment artifact bytes are missing");
  }
  const deploymentArtifactSha256 = sourceHash(deploymentArtifact);
  const v4Root = deploymentManifestV4Root(repoRoot, network);
  await withV4ManifestNamespaceLease(
    v4Root,
    () => preflightV4ManifestDestination(
      repoRoot,
      network,
      deploymentArtifactSha256,
    ),
  );
  const reviewedSchema = readReviewedArtifactSchema(repoRoot);
  verifyFrozenSchema(reviewedSchema);

  const deploymentTransaction = await client.deployContract({ code: deploymentArtifact, args: [] });
  if (typeof deploymentTransaction !== "string" || !TX_HASH.test(deploymentTransaction)) {
    throw new Error("official client deployment transaction shape is unavailable");
  }

  const accepted = await client.waitForTransactionReceipt({
    hash: deploymentTransaction,
    status: "ACCEPTED",
    retries: 200,
  });
  assertReceipt(accepted, false);
  const finalized = await client.waitForTransactionReceipt({
    hash: deploymentTransaction,
    status: "FINALIZED",
    retries: 200,
  });
  assertReceipt(finalized, true);
  const contractAddress = extractContractAddress(finalized);

  const manifest: V4DeploymentManifest = {
    schemaVersion: "accessseal-deployment-manifest/2",
    contractVersion: "V4",
    network,
    chainId: NETWORK_CHAIN_IDS[network],
    contractAddress,
    deploymentTransaction,
    readableSourceSha256: sourceHash(readableSource),
    deploymentArtifactSha256,
    sourceSha256: deploymentArtifactSha256,
    schemaSha256: canonicalJsonHash(reviewedSchema),
    gitCommit: gitState.commit,
    deployedAt: new Date().toISOString(),
    contractClassification: "INTENTIONALLY_FROZEN",
  };
  await verifyDeployment(client, manifest, { repoRoot });
  const path = deploymentManifestPath(repoRoot, {
    network,
    contractVersion: "V4",
    contractAddress,
    deploymentArtifactSha256,
  });
  await withV4ManifestNamespaceLease(
    v4Root,
    () => atomicWriteJsonExclusive(path, manifest),
  );
  return manifest;
}

function isRepeatedHex(value: string): boolean {
  return /^([0-9a-f])\1+$/i.test(value);
}

function assertReceipt(value: unknown, requireFinalized: boolean): void {
  const receipt = normalizeReceipt(value);
  if (requireFinalized && receipt.status !== "FINALIZED") {
    throw new Error("deployment transaction is not finalized");
  }
  if (!requireFinalized && !["ACCEPTED", "FINALIZED"].includes(receipt.status)) {
    throw new Error("deployment transaction was not accepted");
  }
  if (receipt.execution !== "FINISHED_WITH_RETURN") {
    throw new Error("deployment transaction execution failed");
  }
}

function extractContractAddress(value: unknown): string {
  const address = normalizeReceipt(value).contractAddress;
  if (!address || !ADDRESS.test(address)) {
    throw new Error("official client receipt contract address shape is unavailable");
  }
  return address.toLowerCase();
}

function assertDeployableGitState(state: GitState): void {
  if (!GIT_COMMIT.test(state.commit)) throw new Error("Git commit is missing or invalid");
  if (!state.clean) throw new Error("Git tracked worktree is dirty");
}

export function readGitState(repoRoot: string): GitState {
  return readRepositoryGitState(repoRoot);
}

export default async function main(client: DeploymentClient): Promise<string> {
  const repoRoot = process.cwd();
  const network = identifyClientNetwork(client.chain, process.env.GENLAYER_NETWORK);
  const result = await deployAccessSeal(client, {
    network,
    repoRoot,
  });
  return result.contractAddress;
}

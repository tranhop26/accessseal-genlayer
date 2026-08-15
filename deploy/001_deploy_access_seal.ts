import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { atomicWriteJson, canonicalJsonHash, sourceHash } from "../scripts/source-hash.ts";
import {
  NETWORK_CHAIN_IDS,
  NETWORK_CHAIN_NAMES,
  identifyClientNetwork,
  normalizeReceipt,
  readRepositoryGitState,
  verifyDeployment,
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

type DeployOptions = {
  network: string;
  repoRoot?: string;
};

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const GIT_COMMIT = /^[0-9a-f]{40,64}$/;

export function validateNetworkName(value: string): NetworkName {
  if (!Object.prototype.hasOwnProperty.call(NETWORK_CHAIN_IDS, value)) {
    throw new Error("GenLayer network name is invalid");
  }
  return value as NetworkName;
}

export function deploymentManifestPath(repoRoot: string, network: string): string {
  return join(repoRoot, "work", "deployments", `${validateNetworkName(network)}.json`);
}

export async function deployAccessSeal(
  client: DeploymentClient,
  options: DeployOptions,
): Promise<DeploymentManifest> {
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

  const expectedSchema = await client.getContractSchemaForCode(deploymentArtifact);
  if (!(expectedSchema && typeof expectedSchema === "object")) {
    throw new Error("official client source schema response is unavailable");
  }
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

  const manifest: DeploymentManifest = {
    schemaVersion: "accessseal-deployment-manifest/2",
    network,
    chainId: NETWORK_CHAIN_IDS[network],
    contractAddress,
    deploymentTransaction,
    readableSourceSha256: sourceHash(readableSource),
    deploymentArtifactSha256: sourceHash(deploymentArtifact),
    sourceSha256: sourceHash(deploymentArtifact),
    schemaSha256: canonicalJsonHash(expectedSchema),
    gitCommit: gitState.commit,
    deployedAt: new Date().toISOString(),
    contractClassification: "INTENTIONALLY_FROZEN",
  };
  await verifyDeployment(client, manifest, { repoRoot });
  const path = deploymentManifestPath(repoRoot, network);
  await atomicWriteJson(path, manifest);
  return manifest;
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

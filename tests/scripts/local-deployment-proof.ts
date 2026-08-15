import { resolve } from "node:path";

import { createAccount, createClient } from "genlayer-js";
import { localnet } from "genlayer-js/chains";
import type { TransactionHash } from "genlayer-js/types";

import {
  deployAccessSeal,
  type DeploymentClient,
} from "../../deploy/001_deploy_access_seal.ts";
import {
  normalizeReceipt,
  verifyDeployment,
  type VerificationClient,
} from "../../deploy/999_verify_access_seal.ts";
import { atomicWriteJson } from "../../scripts/source-hash.ts";

const endpoint = "http://127.0.0.1:4000/api";
const rawKey = process.env.GENLAYER_LOCALNET_ACCOUNT_0;
if (!rawKey || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(rawKey)) {
  throw new Error("Task 7 local proof requires an ephemeral environment-only account");
}
const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
const account = createAccount(privateKey);
const client = createClient({ chain: localnet, endpoint, account });

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? "Task 7 local proof RPC failed");
  }
  return payload.result;
}

await rpc("sim_fundAccount", [account.address, "1000000000000000000"]);
const manifest = await deployAccessSeal(client as unknown as DeploymentClient, {
  network: "localnet",
});
const verified = await verifyDeployment(
  client as unknown as VerificationClient,
  manifest,
);
const transaction = normalizeReceipt(
  await client.getTransaction({ hash: manifest.deploymentTransaction as TransactionHash }),
);
await atomicWriteJson(resolve("work", "evidence", "task7-local-deployment.json"), {
  schemaVersion: "accessseal-local-deployment-proof/1",
  network: manifest.network,
  chainId: manifest.chainId,
  contractAddress: manifest.contractAddress,
  deploymentTransaction: manifest.deploymentTransaction,
  transactionStatus: transaction.status,
  executionResult: transaction.execution,
  readableSourceSha256: manifest.readableSourceSha256,
  deploymentArtifactSha256: manifest.deploymentArtifactSha256,
  sourceSha256: manifest.sourceSha256,
  schemaSha256: manifest.schemaSha256,
  accounting: Object.fromEntries(Object.entries(verified.accounting).map(([key, value]) => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) throw new Error(`local proof accounting ${key} exceeds its numeric schema`);
    return [key, numeric];
  })),
});

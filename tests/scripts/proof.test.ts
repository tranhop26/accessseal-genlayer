import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

import { abi, decodeLocalnetTransaction, decodeTransaction, simplifyTransactionReceipt } from "genlayer-js";
import { studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

import type { DeploymentManifest, VerificationClient } from "../../deploy/999_verify_access_seal.ts";
import {
  replaceProofPackageAtomically,
  installVerifiedProofPackage,
  networkProofEndpoints,
  trackedHeadFileProof,
  verifyProofEvidence,
  type CommandResult,
  type ProofLocators,
  type ProofReader,
} from "../../scripts/collect-proof.ts";
import { canonicalJsonHash, sourceHash } from "../../scripts/source-hash.ts";
import { scanRepositorySecrets } from "../../scripts/scan-secrets.ts";

const source = new Uint8Array(await readFile(resolve("contracts/access_seal.py")));
const artifact = new Uint8Array(await readFile(resolve("contracts/access_seal_deploy.py")));
const schema = (JSON.parse(execFileSync("genvm-lint", ["schema", "--json", "contracts/access_seal_deploy.py"], { encoding: "utf8" })) as { schema: object }).schema;
const root = await mkdtemp(join(tmpdir(), "accessseal-proof-v2-"));
const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const address = (label: string) => `0x${digest(label).slice(0, 40)}`;
const tx = (label: string) => `0x${digest(label)}`;
const contract = address("contract");
const payoutRecipient = address("payout-recipient");
const refundRecipient = address("refund-recipient");
const buyer = refundRecipient;
const vendor = payoutRecipient;
const settler = address("settler");
const reviewer = address("reviewer");
const deploymentTx = tx("deployment");
const payoutParent = tx("payout-parent");
const payoutPrepare = tx("payout-prepare");
const payoutChild = tx("payout-child");
const refundParent = tx("refund-parent");
const refundPrepare = tx("refund-prepare");
const refundChild = tx("refund-child");
const rmiCureTx = tx("rmi-cure");
const rmiReviewTx = tx("rmi-review");
const unresolvedTx = tx("unresolved");
const replayTx = tx("replay");
process.env.VERCEL_TOKEN = "proof-test-vercel-credential";
const npmCli = resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
const actualRootLintOutput = execFileSync(process.execPath, [npmCli, "run", "lint"], { cwd: resolve("."), encoding: "utf8" });
const actualSchemaOutput = execFileSync("genvm-lint", ["schema", "--json", "contracts/access_seal.py"], { cwd: resolve("."), encoding: "utf8" });

for (const path of [
  "contracts/access_seal.py",
  "contracts/access_seal_deploy.py",
  "scripts/build_contract_artifact.py",
  "frontend/e2e/happy-path.spec.ts",
  "frontend/e2e/recovery.spec.ts",
  "tests/direct/test_settlement.py",
  "scripts/glsim_support.py",
  "tests/integration/test_harness_controls.py",
  "deploy/999_verify_access_seal.ts",
  "tests/scripts/deploy.test.ts",
]) {
  await mkdir(join(root, path, ".."), { recursive: true });
  const contents = path === "contracts/access_seal.py"
    ? source
    : path === "contracts/access_seal_deploy.py"
      ? artifact
      : path === "scripts/build_contract_artifact.py"
        ? await readFile(resolve(path))
        : `proof source ${path}\n`;
  await writeFile(join(root, path), contents);
}
await writeFile(join(root, ".gitignore"), "work/\n__pycache__/\n");
execFileSync("git", ["init", "-q"], { cwd: root });
execFileSync("git", ["config", "user.email", "proof@example.invalid"], { cwd: root });
execFileSync("git", ["config", "user.name", "Proof Test"], { cwd: root });
execFileSync("git", ["add", "."], { cwd: root });
execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
after(async () => rm(root, { recursive: true, force: true }));

const manifest: DeploymentManifest = {
  schemaVersion: "accessseal-deployment-manifest/2",
  network: "studionet",
  chainId: 61999,
  contractAddress: contract,
  deploymentTransaction: deploymentTx,
  readableSourceSha256: sourceHash(source),
  deploymentArtifactSha256: sourceHash(artifact),
  sourceSha256: sourceHash(artifact),
  schemaSha256: canonicalJsonHash(schema),
  gitCommit: commit,
  deployedAt: "2026-08-15T01:00:00.000Z",
  contractClassification: "INTENTIONALLY_FROZEN",
};

function locators(overrides: Partial<ProofLocators> = {}): ProofLocators {
  return {
    schemaVersion: "accessseal-proof-locators/2",
    repositoryUrl: "https://github.com/carbofozzz/accessseal",
    repositoryCommitUrl: `https://github.com/carbofozzz/accessseal/commit/${commit}`,
    frontendUrl: "https://accessseal-real.vercel.app",
    vercelDeploymentId: "dpl_RealDeployment123456789",
    explorerUrl: `https://genlayer-explorer.vercel.app/transactions/${deploymentTx}`,
    rpcUrl: "https://studio.genlayer.com/api",
    workflows: {
      payout: settlement("payout-case", "payout-settlement", payoutRecipient, "900719925474099312345", payoutPrepare, payoutParent, payoutChild),
      refund: settlement("refund-case", "refund-settlement", refundRecipient, "40000", refundPrepare, refundParent, refundChild),
      rmiCure: { caseId: "rmi-case", fromEpoch: 0, toEpoch: 1, cureTransactionHash: rmiCureTx, reviewTransactionHash: rmiReviewTx },
      unresolved: { caseId: "unresolved-case", epoch: 0, attempt: 0, reviewTransactionHash: unresolvedTx },
      replayRejection: { caseId: "payout-case", settlementId: "payout-settlement", transactionHash: replayTx },
    },
    ...overrides,
  };
}

function settlement(caseId: string, settlementId: string, recipient: string, amount: string, prepareTransactionHash: string, parentTransactionHash: string, childTransactionHash: string) {
  return { caseId, settlementId, recipient, amount, prepareTransactionHash, parentTransactionHash, childTransactionHash };
}

function testnetCall(hash: string, method: string, args: unknown[], sender: string, recipient = contract, success = true, messages: unknown[] = []) {
  const callData = abi.calldata.encode({ method, args, kwargs: {} } as never);
  return decodeTransaction({
    hash,
    sender,
    recipient,
    messages,
    txData: abi.transactions.serialize([callData, false]),
    currentTimestamp: 0n,
    numOfInitialValidators: 5n,
    txSlot: 0n,
    createdTimestamp: 0n,
    lastVoteTimestamp: 0n,
    queuePosition: 0n,
    numOfRounds: 0n,
    status: 7,
    result: 0,
    txExecutionResult: success ? 1 : 2,
    readStateBlockRange: {},
    lastRound: {},
  } as never);
}

function studioCall(hash: string, method: string, args: unknown[], sender: string, recipient = contract, success = true, messages: unknown[] = []) {
  const encoded = abi.calldata.encode({ method, args, kwargs: {} } as never);
  return decodeLocalnetTransaction({
    hash,
    from_address: sender,
    to_address: recipient,
    statusName: "FINALIZED",
    txExecutionResultName: success ? "FINISHED_WITH_RETURN" : "FINISHED_WITH_ERROR",
    messages,
    data: { calldata: Buffer.from(encoded).toString("base64") },
  } as never);
}

function officialDeployment() {
  return simplifyTransactionReceipt({
    statusName: "FINALIZED",
    txExecutionResultName: "FINISHED_WITH_RETURN",
    hash: deploymentTx,
    txDataDecoded: { type: "deploy", contractAddress: contract },
  } as never);
}

class FakeReader implements ProofReader, VerificationClient {
  chain = { id: 61999, name: "Genlayer Studio Network" };
  transactions = new Map<string, unknown>([
    [deploymentTx, officialDeployment()],
    [payoutPrepare, testnetCall(payoutPrepare, "prepare_payout", ["payout-case"], settler)],
    [payoutParent, studioCall(payoutParent, "execute_settlement", ["payout-case", "payout-settlement"], settler, contract, true, [[1, payoutRecipient, "900719925474099312345", "0x", false, 0]])],
    [payoutChild, { ...studioCall(payoutChild, "child", [], settler, payoutRecipient), value: "900719925474099312345" }],
    [refundPrepare, studioCall(refundPrepare, "prepare_refund", ["refund-case"], settler)],
    [refundParent, testnetCall(refundParent, "execute_settlement", ["refund-case", "refund-settlement"], settler, contract, true, [[1, refundRecipient, 40000n, "0x", false, 0]])],
    [refundChild, { ...testnetCall(refundChild, "child", [], settler, refundRecipient), value: 40000n }],
    [rmiCureTx, studioCall(rmiCureTx, "start_cure", ["rmi-case"], vendor)],
    [rmiReviewTx, testnetCall(rmiReviewTx, "request_review", ["rmi-case"], reviewer)],
    [unresolvedTx, studioCall(unresolvedTx, "request_review", ["unresolved-case"], reviewer)],
    [replayTx, testnetCall(replayTx, "execute_settlement", ["payout-case", "payout-settlement"], settler, contract, false)],
  ]);
  triggered = new Map([[payoutParent, [payoutChild]], [refundParent, [refundChild]]]);

  async rpcChainId() { return 61999; }
  async getTransaction(args: { hash: string }) { return this.transactions.get(args.hash); }
  async getTriggeredTransactionIds(args: { hash: string }) { return this.triggered.get(args.hash); }
  async getContractCode() { return new TextDecoder().decode(artifact); }
  async getContractSchema() { return schema; }
  async getContractSchemaForCode() { return schema; }
  async readContract(args: { functionName: string; args: unknown[]; transactionHashVariant: "latest-final" }) {
    assert.equal(args.transactionHashVariant, "latest-final");
    const [caseId, epoch, attempt] = args.args;
    if (args.functionName === "get_accounting") return '{"totalDeposits":900719925474099352345,"reserved":0,"pendingDispatch":0,"dispatchedPayouts":900719925474099312345,"dispatchedRefunds":40000}';
    if (args.functionName === "get_settlement" && caseId === "payout-case") return `{"caseId":"${caseId}","settlementId":"payout-settlement","status":"DISPATCHED_FINALIZED","kind":"PAYOUT","recipient":"${payoutRecipient}","amount":900719925474099312345,"executor":"${settler}","reason":"APPROVED"}`;
    if (args.functionName === "get_settlement" && caseId === "refund-case") return JSON.stringify({ caseId, settlementId: "refund-settlement", status: "DISPATCHED_FINALIZED", kind: "REFUND", recipient: refundRecipient, amount: 40000, executor: settler, reason: "REJECTED" });
    if (args.functionName === "get_settlement" && (caseId === "unresolved-case" || caseId === "rmi-case")) throw new Error("gen_call failed: settlement intent does not exist");
    if (args.functionName === "get_case" && caseId === "rmi-case") return JSON.stringify({ caseId, buyer, vendor, epoch: 1, lifecycle: "DECIDED" });
    if (args.functionName === "get_case" && caseId === "unresolved-case") return JSON.stringify({ caseId, buyer, vendor, epoch: 0, lifecycle: "DECIDED" });
    if (args.functionName === "get_case" && (caseId === "payout-case" || caseId === "refund-case")) return JSON.stringify({ caseId, buyer, vendor, epoch: 0, lifecycle: "DISPATCHED_FINALIZED" });
    if (args.functionName === "get_review_attempt" && caseId === "rmi-case" && epoch === 0) return JSON.stringify({ status: "FINALIZED", review: { verdict: "REQUEST_MORE_INFO" } });
    if (args.functionName === "get_review_attempt" && caseId === "rmi-case" && epoch === 1) return JSON.stringify({ status: "FINALIZED", review: { verdict: "APPROVED" } });
    if (args.functionName === "get_review_attempt" && caseId === "unresolved-case" && attempt === 0) return JSON.stringify({ status: "FINALIZED", review: { verdict: "UNRESOLVED" } });
    if (args.functionName === "get_review_finality") return JSON.stringify({ status: "FINALIZED", proofId: "proof-1" });
    throw new Error(`unexpected read ${args.functionName} ${JSON.stringify(args.args)}`);
  }
}

function fetcher(url: string, _init?: RequestInit): Promise<Response> {
  if (url === `https://api.github.com/repos/carbofozzz/accessseal/commits/${commit}`) return Promise.resolve(Response.json({ sha: commit }));
  if (url === `https://raw.githubusercontent.com/carbofozzz/accessseal/${commit}/contracts/access_seal.py`) return Promise.resolve(new Response(source));
  if (url === `https://raw.githubusercontent.com/carbofozzz/accessseal/${commit}/contracts/access_seal_deploy.py`) return Promise.resolve(new Response(artifact));
  if (url === "https://api.vercel.com/v13/deployments/dpl_RealDeployment123456789") return Promise.resolve(Response.json({ uid: "dpl_RealDeployment123456789", url: "accessseal-real.vercel.app", readyState: "READY", target: "production", meta: { githubCommitSha: commit } }));
  if (url === "https://accessseal-real.vercel.app/") return Promise.resolve(new Response("<title>Untrusted page copy</title>", { status: 200, headers: { "x-vercel-id": "sin1::proof" } }));
  if (url === "https://accessseal-real.vercel.app/.well-known/accessseal/config.json")
    return Promise.resolve(Response.json({
      schemaVersion: "accessseal-public-config/1",
      network: "studionet",
      chainId: 61999,
      contractAddress: contract,
      safeTestConfig: false,
    }, { headers: { "x-vercel-id": "sin1::config-proof" } }));
  if (url === `https://genlayer-explorer.vercel.app/transactions/${deploymentTx}`) return Promise.resolve(new Response("transaction", { status: 200 }));
  throw new Error(`unexpected fetch ${url}`);
}

function commands(overrides: Record<string, CommandResult> = {}) {
  const values: Record<string, CommandResult> = {
    "root-lint": result(actualRootLintOutput),
    "contract-schema": result(actualSchemaOutput),
    "root-typecheck": result("accessseal typecheck\ntsc --noEmit"),
    direct: result("================ 240 passed in 9.0s ================"),
    integration: result("================ 35 passed, 1 skipped in 9.0s ================"),
    "root-scripts": result("ℹ tests 124\nℹ pass 124\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0"),
    "frontend-lint": result("0 warnings"),
    "frontend-typecheck": result("typecheck complete"),
    "frontend-unit": result("Test Files 16 passed (16)\nTests 128 passed (128)"),
    "frontend-build": result("Compiled successfully\nRoute (app)"),
    "frontend-e2e-1": result("9 passed (31.0s)"),
    "frontend-e2e-2": result("9 passed (31.1s)"),
    "secret-scan": result("Secret-value scan: PASS"),
  };
  return { ...values, ...overrides };
}

function result(stdout: string, exitCode = 0): CommandResult { return { exitCode, stdout, stderr: "" }; }

function replaceLast(value: string, search: string, replacement: string): string {
  const index = value.lastIndexOf(search);
  assert.notEqual(index, -1, `missing fixture text: ${search}`);
  return value.slice(0, index) + replacement + value.slice(index + search.length);
}

function ansi(value: string, color = 32): string {
  return `\u001b[${color}m${value}\u001b[0m`;
}

test("only independent official readers, publication APIs, and actual command outputs can create proof", async () => {
  const proof = await verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands() });
  assert.equal(proof.gitCommit, commit);
  assert.equal(proof.repository.commitUrl, `https://github.com/carbofozzz/accessseal/commit/${commit}`);
  assert.deepEqual(proof.frontend.publicConfig, {
    schemaVersion: "accessseal-public-config/1",
    network: "studionet",
    chainId: 61999,
    contractAddress: contract,
    safeTestConfig: false,
  });
  assert.equal(proof.checks.find((item) => item.id === "direct")?.passed, 240);
  assert.equal(proof.checks.find((item) => item.id === "integration")?.passed, 35);
  assert.equal(proof.checks.find((item) => item.id === "root-scripts")?.passed, 124);
  assert.equal(proof.checks.find((item) => item.id === "frontend-unit")?.passed, 128);
  assert.equal(proof.checks.find((item) => item.id === "root-lint")?.passed, 9);
  assert.equal(proof.proofRows.payout.childTransactionHash, payoutChild);
  assert.equal(proof.proofRows.payout.amount, "900719925474099312345");
  assert.equal(proof.proofRows.payout.executor, settler);
  assert.equal(proof.proofRows.payout.provenance.liveSettlementVerifier.path, "scripts/glsim_support.py");
  assert.equal(proof.proofRows.frozenClassification.provenance.deploymentVerifier.path, "deploy/999_verify_access_seal.ts");
  assert.equal(proof.proofRows.rmiCure.transactions.length, 2);
  assert.equal(proof.proofRows.unresolved.transfer, "NO_TRANSFER");
  assert.doesNotMatch(JSON.stringify(proof), /proof-test-vercel-credential|declaredStatus|declaredReadback/);
});

test("rejects a live frontend whose independently fetched config marker is wrong, missing, unsafe, or HTML", async () => {
  const baseFetch = fetcher;
  const cases: Array<[string, unknown, RegExp]> = [
    ["wrong address", { schemaVersion: "accessseal-public-config/1", network: "studionet", chainId: 61999, contractAddress: address("wrong"), safeTestConfig: false }, /config|address|binding/i],
    ["wrong network", { schemaVersion: "accessseal-public-config/1", network: "localnet", chainId: 61127, contractAddress: contract, safeTestConfig: false }, /config|network|chain/i],
    ["safe test", { schemaVersion: "accessseal-public-config/1", network: "studionet", chainId: 61999, contractAddress: contract, safeTestConfig: true }, /safe|config/i],
  ];
  for (const [label, marker, expected] of cases) {
    const altered = (url: string, init?: RequestInit) =>
      url.endsWith("/.well-known/accessseal/config.json")
        ? Promise.resolve(Response.json(marker, { headers: { "x-vercel-id": "sin1::config-proof" } }))
        : baseFetch(url, init);
    await assert.rejects(
      verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher: altered, commandResults: commands() }),
      expected,
      label,
    );
  }
  const html = (url: string, init?: RequestInit) =>
    url.endsWith("/.well-known/accessseal/config.json")
      ? Promise.resolve(new Response(`<script>${JSON.stringify({ contractAddress: contract })}</script>`, { headers: { "content-type": "text/html", "x-vercel-id": "sin1::config-proof" } }))
      : baseFetch(url, init);
  await assert.rejects(
    verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher: html, commandResults: commands() }),
    /json|content|config/i,
  );
});

test("rejects synthetic status, wrong method, unlinked child, spoofed amount, and wrong authoritative readback", async () => {
  const mutations: Array<[string, (reader: FakeReader) => void]> = [
    ["finalized", (reader) => reader.transactions.set(payoutParent, { ...reader.transactions.get(payoutParent) as object, statusName: "PENDING" })],
    ["execution", (reader) => reader.transactions.set(payoutParent, { ...reader.transactions.get(payoutParent) as object, txExecutionResultName: "SUCCESS" })],
    ["method", (reader) => reader.transactions.set(unresolvedTx, studioCall(unresolvedTx, "prepare_payout", ["unresolved-case"], reviewer))],
    ["triggered", (reader) => reader.triggered.set(payoutParent, [tx("unrelated-child")])],
    ["amount", (reader) => reader.transactions.set(payoutParent, studioCall(payoutParent, "execute_settlement", ["payout-case", "payout-settlement"], settler, contract, true, [[1, payoutRecipient, "1", "0x", false, 0]]))],
    ["child transfer amount", (reader) => reader.transactions.set(payoutChild, { ...studioCall(payoutChild, "child", [], settler, payoutRecipient), value: "1" })],
    ["readback", (reader) => { const prior = reader.readContract.bind(reader); reader.readContract = async (args) => args.functionName === "get_settlement" && args.args[0] === "payout-case" ? JSON.stringify({ status: "PREPARED" }) : prior(args); }],
  ];
  for (const [label, mutate] of mutations) {
    const reader = new FakeReader(); mutate(reader);
    await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader, fetcher, commandResults: commands() }), new RegExp(label, "i"));
  }
});

test("normalizes actual pinned SDK Studio and testnet decoder shapes and rejects transaction/actor contradictions", async () => {
  const proof = await verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands() });
  assert.equal(proof.proofRows.payout.parentTransactionHash, payoutParent);
  assert.equal(proof.proofRows.payout.prepareTransactionHash, payoutPrepare);
  assert.equal(proof.proofRows.refund.parentTransactionHash, refundParent);

  const mutations: Array<[string, (reader: FakeReader) => void]> = [
    ["hash", (reader) => reader.transactions.set(payoutParent, { ...reader.transactions.get(payoutParent) as object, hash: tx("wrong") })],
    ["hash", (reader) => reader.transactions.set(payoutParent, { ...reader.transactions.get(payoutParent) as object, txId: tx("contradictory-hash") })],
    ["hash", (reader) => { const value = { ...reader.transactions.get(payoutParent) as Record<string, unknown> }; delete value.hash; reader.transactions.set(payoutParent, value); }],
    ["sender", (reader) => reader.transactions.set(payoutParent, { ...reader.transactions.get(payoutParent) as object, from_address: buyer })],
    ["contradict", (reader) => reader.transactions.set(payoutParent, { ...reader.transactions.get(payoutParent) as object, sender: reviewer })],
    ["unrelated", (reader) => reader.transactions.set(payoutPrepare, testnetCall(payoutPrepare, "prepare_payout", ["payout-case"], buyer))],
    ["vendor", (reader) => reader.transactions.set(rmiCureTx, studioCall(rmiCureTx, "start_cure", ["rmi-case"], reviewer))],
    ["binding|executor", (reader) => { const prior = reader.readContract.bind(reader); reader.readContract = async (args) => args.functionName === "get_settlement" && args.args[0] === "payout-case" ? JSON.stringify({ caseId: "payout-case", settlementId: "payout-settlement", status: "DISPATCHED_FINALIZED", kind: "PAYOUT", recipient: payoutRecipient, amount: "900719925474099312345", executor: reviewer }) : prior(args); }],
  ];
  for (const [label, mutate] of mutations) {
    const reader = new FakeReader(); mutate(reader);
    await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader, fetcher, commandResults: commands() }), new RegExp(label, "i"));
  }
});

test("derives exact RPC and explorer routes from pinned GenLayer chain definitions", () => {
  for (const chain of [studionet, testnetAsimov, testnetBradbury]) {
    const endpoints = networkProofEndpoints(chain.name);
    assert.equal(endpoints.chainId, chain.id);
    assert.equal(endpoints.rpcUrl, chain.rpcUrls.default.http[0]);
    assert.equal(endpoints.explorerBaseUrl, chain.blockExplorers?.default.url.replace(/\/$/, ""));
  }
  assert.equal(networkProofEndpoints(studionet.name).explorerBaseUrl, "https://genlayer-explorer.vercel.app");
});

test("accepts only canonical decimal-string u256 amounts and exact pinned absent-view errors", async () => {
  await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators({ workflows: { ...locators().workflows, payout: { ...locators().workflows.payout, amount: Number.MAX_SAFE_INTEGER + 1 as never } } }), reader: new FakeReader(), fetcher, commandResults: commands() }), /decimal|string|u256|amount/i);
  const reader = new FakeReader();
  const prior = reader.readContract.bind(reader);
  reader.readContract = async (args) => args.functionName === "get_settlement" && args.args[0] === "unresolved-case"
    ? Promise.reject(new Error("An internal error was received.\n\nDetails: UserError(message='settlement intent does not exist')\nVersion: viem@2.55.16"))
    : prior(args);
  const proof = await verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader, fetcher, commandResults: commands() });
  assert.equal(proof.proofRows.unresolved.settlementAbsent, true);

  const contradictory = new FakeReader();
  const original = contradictory.readContract.bind(contradictory);
  contradictory.readContract = async (args) => {
    if (args.functionName === "get_settlement" && args.args[0] === "unresolved-case") {
      const cause = new Error("gen_call failed: another error");
      throw new Error("An internal error was received.\n\nDetails: UserError(message='settlement intent does not exist')\nVersion: viem@2.55.16", { cause });
    }
    return original(args);
  };
  await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: contradictory, fetcher, commandResults: commands() }), /settlement intent|another error|contradict/i);
});

test("rejects failed or count-spoofed command results rather than accepting declared PASS strings", async () => {
  for (const changed of [
    { direct: result("240 passed", 1) },
    { direct: result("239 passed") },
    { integration: result("35 passed, 0 skipped") },
    { "root-scripts": result("ℹ tests 123\nℹ pass 123\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0") },
    { "frontend-unit": result("Test Files 16 passed (16)\nTests 127 passed (127)") },
    { "frontend-e2e-2": result("7 passed") },
    { "root-lint": result(actualRootLintOutput.replaceAll("Lint passed (3 checks)", "prompt lint missing")) },
    { "contract-schema": result('{"ok":false,"schema":{}}') },
    { "root-typecheck": result("", 0) },
  ] as Array<Record<string, CommandResult>>) {
    await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands(changed) }), /command|count|suite|check/i);
  }
});

for (const [name, stdout] of [
  ["missing prompt lint summary", replaceLast(actualRootLintOutput, "✓ Lint passed (3 checks)", "")],
  ["corrupted prompt lint summary", replaceLast(actualRootLintOutput, "✓ Lint passed (3 checks)", "✓ Lint passed (2 checks)")],
  ["warning-bearing lint output", `${actualRootLintOutput}\nWarnings:\n  line 1: fixture warning`],
  ["extra lint summary", `${actualRootLintOutput}\n✓ Lint passed (3 checks)`],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(
      verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands({ "root-lint": result(stdout) }) }),
      /root-lint.*(?:count|output|summary|warning)/i,
    );
  });
}

for (const [name, changed] of [
  ["a prefixed direct total", { direct: result("================ 1240 passed in 9.0s ================") }],
  ["a misleading direct line before the real contradictory summary", { direct: result("diagnostic: 240 passed\n================ 239 passed in 9.0s ================") }],
  ["duplicate direct summaries", { direct: result("================ 240 passed in 9.0s ================\n================ 240 passed in 9.1s ================") }],
  ["a pytest failure summary beside a passing summary", { direct: result("================ 240 passed in 9.0s ================\n================ 1 failed, 239 passed in 9.1s ================") }],
  ["a prefixed integration total", { integration: result("================ 135 passed, 1 skipped in 9.0s ================") }],
  ["duplicate contradictory integration summaries", { integration: result("================ 35 passed, 1 skipped in 9.0s ================\n================ 34 passed, 1 skipped in 9.1s ================") }],
  ["a nonzero script failure count", { "root-scripts": result("ℹ tests 124\nℹ pass 124\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0") }],
  ["a misleading script line before contradictory counts", { "root-scripts": result("ℹ tests 124\ndiagnostic pass 124\nℹ pass 123\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0") }],
  ["duplicate contradictory frontend summaries", { "frontend-unit": result("Test Files 16 passed (16)\nTests 128 passed (128)\nTests 127 passed (127)") }],
  ["a prefixed end-to-end total", { "frontend-e2e-1": result("19 passed (31.0s)") }],
  ["a misleading end-to-end line before the real summary", { "frontend-e2e-1": result("diagnostic: 9 passed\n8 passed (31.0s)") }],
  ["duplicate end-to-end summaries", { "frontend-e2e-1": result("9 passed (31.0s)\n9 passed (31.1s)") }],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(
      verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands(changed) }),
      /(?:direct|integration|root-scripts|frontend-unit|frontend-e2e-1).*(?:count|output|summary|failed)/i,
    );
  });
}

for (const [name, id, expected, changed] of [
  ["lint", "root-lint", 9, { "root-lint": result(actualRootLintOutput.replaceAll("✓ Lint passed (3 checks)", ansi("✓ Lint passed (3 checks)"))) }],
  ["direct pytest", "direct", 240, { direct: result(ansi("================ 240 passed in 9.0s ================")) }],
  ["integration pytest", "integration", 35, { integration: result(ansi("================ 35 passed, 1 skipped in 9.0s ================")) }],
  ["Node test", "root-scripts", 124, { "root-scripts": result(["ℹ tests 124", "ℹ pass 124", "ℹ fail 0", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0"].map((line) => ansi(line)).join("\n")) }],
  ["Vitest", "frontend-unit", 128, { "frontend-unit": result(`${ansi("Test Files 16 passed (16)")}\n${ansi("Tests 128 passed (128)")}`) }],
  ["Playwright", "frontend-e2e-1", 9, { "frontend-e2e-1": result(ansi("9 passed (31.0s)")) }],
] as const) {
  test(`accepts ANSI-colored legitimate ${name} summaries`, async () => {
    const proof = await verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands(changed) });
    assert.equal(proof.checks.find((item) => item.id === id)?.passed, expected);
  });
}

for (const [name, changed] of [
  ["ANSI-colored pytest failure beside a valid summary", { direct: result(`================ 240 passed in 9.0s ================\n${ansi("================ 1 failed, 239 passed in 9.1s ================", 31)}`) }],
  ["ANSI-colored integration contradiction beside a valid summary", { integration: result(`================ 35 passed, 1 skipped in 9.0s ================\n${ansi("================ 34 passed, 1 skipped in 9.1s ================", 31)}`) }],
  ["ANSI-colored Node failure beside a valid summary", { "root-scripts": result(`${commands()["root-scripts"]!.stdout}\n${ansi("ℹ fail 1", 31)}`) }],
  ["ANSI-colored Vitest contradiction beside a valid summary", { "frontend-unit": result(`${commands()["frontend-unit"]!.stdout}\n${ansi("Tests 127 passed (127)", 31)}`) }],
  ["ANSI-colored Playwright failure beside a valid summary", { "frontend-e2e-1": result(`9 passed (31.0s)\n${ansi("1 failed", 31)}`) }],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(
      verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands(changed) }),
      /(?:direct|integration|root-scripts|frontend-unit|frontend-e2e-1).*(?:count|output|summary|failed)/i,
    );
  });
}

for (const duration of ["1.5m", "1.2h"] as const) {
  test(`accepts Playwright ${duration.endsWith("m") ? "minute" : "hour"} duration summaries`, async () => {
    const proof = await verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands({ "frontend-e2e-1": result(`9 passed (${duration})`) }) });
    assert.equal(proof.checks.find((item) => item.id === "frontend-e2e-1")?.passed, 9);
  });
}

test("rechecks clean HEAD and exact source bindings before atomic installation", async () => {
  const output = join(root, "work", "evidence", "final");
  await mkdir(output, { recursive: true });
  const json = join(output, "proof.json");
  const matrix = join(output, "proof-matrix.md");
  await writeFile(json, "old-json\n"); await writeFile(matrix, "old-matrix\n");
  const proof = await verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands() });
  const tracked = join(root, "frontend", "e2e", "happy-path.spec.ts");
  await writeFile(tracked, "mutated by successful command\n");
  try {
    await assert.rejects(installVerifiedProofPackage({ repoRoot: root, manifest, proof, outputDir: output }), /dirty|HEAD|source/i);
    assert.equal(await readFile(json, "utf8"), "old-json\n");
    assert.equal(await readFile(matrix, "utf8"), "old-matrix\n");
  } finally {
    await writeFile(tracked, execFileSync("git", ["show", "HEAD:frontend/e2e/happy-path.spec.ts"], { cwd: root }));
  }
});

test("rejects weak URLs, fake explorer origins, sentinel identifiers, and publication mismatches", async () => {
  const bad: Array<[string, Partial<ProofLocators>]> = [
    ["public HTTPS", { frontendUrl: "https://192.168.1.1" }],
    ["explorer", { explorerUrl: `https://evil.example/transactions/${deploymentTx}` }],
    ["repository", { repositoryUrl: "https://github.com/carbofozzz/example-repo" }],
    ["commit", { repositoryCommitUrl: `https://github.com/carbofozzz/accessseal/commit/${"a".repeat(40)}` }],
  ];
  for (const [label, override] of bad) {
    await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators(override), reader: new FakeReader(), fetcher, commandResults: commands() }), new RegExp(label, "i"));
  }
});

test("binds source/test references to contained tracked HEAD blobs and rejects dirty or symlink escapes", async () => {
  const proof = await trackedHeadFileProof(root, "frontend/e2e/happy-path.spec.ts");
  assert.match(proof.blobSha, /^[0-9a-f]{40,64}$/);
  await assert.rejects(trackedHeadFileProof(root, "../outside"), /relative|contain/i);
  const outside = await mkdtemp(join(tmpdir(), "accessseal-proof-outside-"));
  const link = join(root, "linked-proof");
  await writeFile(join(outside, "file.ts"), "outside\n");
  try {
    await symlink(outside, link, "junction");
    await assert.rejects(trackedHeadFileProof(root, "linked-proof/file.ts"), /symlink|contain|tracked/i);
  } finally {
    await rm(link, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
  const dirty = join(root, "dirty.txt"); await writeFile(dirty, "dirty\n");
  try {
    await assert.rejects(verifyProofEvidence({ repoRoot: root, manifest, locators: locators(), reader: new FakeReader(), fetcher, commandResults: commands() }), /dirty/i);
  } finally { await rm(dirty, { force: true }); }
});

test("rolls back both proof outputs when the second staged rename fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accessseal-atomic-proof-"));
  const json = join(directory, "proof.json");
  const matrix = join(directory, "proof-matrix.md");
  await writeFile(json, "old-json\n"); await writeFile(matrix, "old-matrix\n");
  let installs = 0;
  try {
    await assert.rejects(replaceProofPackageAtomically(json, "new-json\n", matrix, "new-matrix\n", {
      beforeInstall: async () => { installs += 1; if (installs === 2) throw new Error("injected second install failure"); },
    }), /injected/i);
    assert.equal(await readFile(json, "utf8"), "old-json\n");
    assert.equal(await readFile(matrix, "utf8"), "old-matrix\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("secret scan permits variable names but rejects tracked environment secret values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accessseal-secret-scan-"));
  process.env.ACCESSSEAL_TEST_TOKEN = "actual-secret-value-for-test";
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "safe.md"), "Use the VERCEL_TOKEN environment variable.\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    assert.equal((await scanRepositorySecrets(directory)).exitCode, 0);
    await writeFile(join(directory, "leak.txt"), process.env.ACCESSSEAL_TEST_TOKEN);
    execFileSync("git", ["add", "."], { cwd: directory });
    assert.equal((await scanRepositorySecrets(directory)).exitCode, 1);
  } finally {
    delete process.env.ACCESSSEAL_TEST_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});

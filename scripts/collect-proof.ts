import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { abi, createClient } from "genlayer-js";
import { studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

import {
  NETWORK_CHAIN_IDS,
  NETWORK_CHAIN_NAMES,
  ACCESSSEAL_FROZEN_SCHEMA_SHA256,
  normalizeReceipt,
  readRepositoryGitState,
  readDeploymentManifest,
  validateDeploymentManifest,
  verifyDeployment,
  type DeploymentManifest,
  type NetworkName,
  type VerificationClient,
} from "../deploy/999_verify_access_seal.ts";
import { canonicalJson, canonicalJsonHash, sourceHash } from "./source-hash.ts";
import { scanRepositorySecrets } from "./scan-secrets.ts";
import { canonicalU256, parseLosslessJsonObject } from "./u256.ts";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const TX_HASH = /^0x[0-9a-f]{64}$/i;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const CASE_ID = /^(?:0x[0-9a-f]{64}|[a-z0-9][a-z0-9._:-]{3,127})$/i;
const SETTLEMENT_ID = /^(?:sha256:)?[0-9a-f]{64}$|^[a-z0-9][a-z0-9._:-]{3,127}$/i;
const SECRET_MARKER = /(?:VERCEL_TOKEN|PRIVATE[_-]?KEY|MNEMONIC|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY)/gi;

const PROOF_CHAINS = { studionet, testnet_asimov: testnetAsimov, testnet_bradbury: testnetBradbury } as const;

export function networkProofEndpoints(chainName: string): { chainId: number; rpcUrl: string; explorerBaseUrl: string } {
  const chain = Object.values(PROOF_CHAINS).find((candidate) => candidate.name === chainName);
  const rpcUrl = chain?.rpcUrls.default.http[0];
  const explorer = chain?.blockExplorers?.default.url;
  if (!chain || !rpcUrl || !explorer) throw new Error("pinned GenLayer chain proof endpoints are unavailable");
  return { chainId: chain.id, rpcUrl, explorerBaseUrl: explorer.replace(/\/$/, "") };
}

type SettlementLocator = {
  caseId: string;
  settlementId: string;
  recipient: string;
  amount: string;
  prepareTransactionHash: string;
  parentTransactionHash: string;
  childTransactionHash: string;
};

export type ProofLocators = {
  schemaVersion: "accessseal-proof-locators/2";
  repositoryUrl: string;
  repositoryCommitUrl: string;
  frontendUrl: string;
  vercelDeploymentId: string;
  explorerUrl: string;
  rpcUrl: string;
  workflows: {
    payout: SettlementLocator;
    refund: SettlementLocator;
    rmiCure: {
      caseId: string;
      fromEpoch: number;
      toEpoch: number;
      cureTransactionHash: string;
      reviewTransactionHash: string;
    };
    unresolved: {
      caseId: string;
      epoch: number;
      attempt: number;
      reviewTransactionHash: string;
    };
    replayRejection: {
      caseId: string;
      settlementId: string;
      transactionHash: string;
    };
  };
};

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type ProofReader = VerificationClient & {
  rpcChainId(): Promise<number>;
  getTriggeredTransactionIds(args: { hash: string }): Promise<unknown>;
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

type CheckProof = {
  id: string;
  command: string;
  exitCode: 0;
  passed: number;
  skipped: number;
  outputSha256: string;
};

type SourceProof = { path: string; blobSha: string };

type LivePublicConfig = {
  schemaVersion: "accessseal-public-config/1";
  network: NetworkName;
  chainId: number;
  contractAddress: string;
  safeTestConfig: false;
};

type SettlementProofRow = {
  kind: "PAYOUT" | "REFUND";
  actor: "permissionless-settler";
  caseId: string;
  contractAddress: string;
  settlementId: string;
  recipient: string;
  amount: string;
  prepareTransactionHash: string;
  executor: string;
  prepareExecutor: string;
  parentTransactionHash: string;
  childTransactionHash: string;
  parentFinality: "FINALIZED";
  parentExecution: "SUCCESS";
  childFinality: "FINALIZED";
  childExecution: "SUCCESS";
  transfer: "DISPATCHED_FINALIZED";
  settlementReadback: Record<string, unknown>;
  accountingReadback: Record<string, string>;
  provenance: { liveSettlementVerifier: SourceProof; collectorRegression: SourceProof };
};

export type FinalProofV2 = {
  schemaVersion: "accessseal-final-proof/2";
  capturedAt: string;
  gitCommit: string;
  readableSourceSha256: string;
  deploymentArtifactSha256: string;
  sourceSha256: string;
  schemaSha256: string;
  repository: { url: string; commitUrl: string; remoteCommit: string; remoteReadableSourceSha256: string; remoteDeploymentArtifactSha256: string };
  frontend: {
    url: string;
    vercelDeploymentId: string;
    gitCommit: string;
    status: "READY";
    publicConfig: LivePublicConfig;
  };
  deployment: {
    network: NetworkName;
    chainId: number;
    contractAddress: string;
    transactionHash: string;
    explorerUrl: string;
    finality: "FINALIZED";
    execution: "FINISHED_WITH_RETURN";
    accountingReadback: Record<string, string>;
    classification: "INTENTIONALLY_FROZEN";
  };
  checks: CheckProof[];
  proofRows: {
    payout: SettlementProofRow;
    refund: SettlementProofRow;
    rmiCure: {
      actor: "vendor-then-permissionless-reviewer";
      caseId: string;
      fromEpoch: number;
      toEpoch: number;
      transactions: Array<{ method: "start_cure" | "request_review"; hash: string; finality: "FINALIZED"; execution: "SUCCESS" }>;
      priorAttemptReadback: Record<string, unknown>;
      curedAttemptReadback: Record<string, unknown>;
      caseReadback: Record<string, unknown>;
      transfer: "NO_TRANSFER";
      sourceTests: SourceProof[];
    };
    unresolved: {
      actor: "permissionless-reviewer";
      caseId: string;
      epoch: number;
      attempt: number;
      transactionHash: string;
      finality: "FINALIZED";
      execution: "SUCCESS";
      reviewReadback: Record<string, unknown>;
      caseReadback: Record<string, unknown>;
      settlementAbsent: true;
      transfer: "NO_TRANSFER";
      sourceTests: SourceProof[];
    };
    replayRejection: {
      actor: "unrelated-caller";
      caseId: string;
      settlementId: string;
      method: "execute_settlement";
      transactionHash: string;
      finality: "FINALIZED";
      execution: "FAILED_AS_EXPECTED";
      settlementReadback: Record<string, unknown>;
      transfer: "NO_TRANSFER";
      sourceTests: SourceProof[];
    };
    frozenClassification: {
      actor: "deployment-verifier";
      deploymentTransactionHash: string;
      readableSourceSha256: string;
      deploymentArtifactSha256: string;
      sourceSha256: string;
      schemaSha256: string;
      classification: "INTENTIONALLY_FROZEN";
      provenance: { deploymentVerifier: SourceProof; verifierRegression: SourceProof };
    };
  };
  knownLimitations: string[];
};

type VerificationInputs = {
  repoRoot: string;
  manifest: DeploymentManifest;
  locators: ProofLocators;
  reader: ProofReader;
  fetcher: Fetcher;
  commandResults: Record<string, CommandResult>;
};

type ParsedCommandSummary = { passed: number; skipped: number };
type CheckDefinition = {
  id: string;
  command: string;
  parse: (output: string) => ParsedCommandSummary | null;
};

function outputLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => stripVTControlCharacters(line).trim()).filter(Boolean);
}

function fixedSummary(pattern: RegExp, passed: number, skipped = 0): CheckDefinition["parse"] {
  return (output) => pattern.test(output) ? { passed, skipped } : null;
}

function parseRootLintSummary(output: string): ParsedCommandSummary | null {
  const lines = outputLines(output);
  if (lines.some((line) => /\bwarnings?:/i.test(line))) return null;
  const lintLines = lines.filter((line) => /\bLint (?:passed|failed)\b/i.test(line));
  const summaries = lintLines.map((line) => line.match(/^✓ Lint passed \((\d+) checks\)$/));
  if (summaries.length !== 3 || summaries.some((match) => match === null)) return null;
  const counts = summaries.map((match) => Number(match![1]));
  if (counts.some((count) => count !== 3)) return null;
  if (lines.filter((line) => /^> accessseal-frontend@\S+ lint$/.test(line)).length !== 1) return null;
  if (lines.filter((line) => line === "> eslint . --max-warnings=0").length !== 1) return null;
  return { passed: counts.reduce((total, count) => total + count, 0), skipped: 0 };
}

function parsePytestSummary(output: string, expectedPassed: number, expectedSkipped: number): ParsedCommandSummary | null {
  const terminalSummaries = outputLines(output).filter((line) => /^=+\s+.+ in \d+(?:\.\d+)?s\s+=+$/.test(line));
  if (terminalSummaries.length !== 1) return null;
  const match = terminalSummaries[0].match(/^=+\s+(\d+) passed(?:, (\d+) skipped)? in \d+(?:\.\d+)?s\s+=+$/);
  if (!match) return null;
  const passed = Number(match[1]);
  const skipped = Number(match[2] ?? 0);
  return passed === expectedPassed && skipped === expectedSkipped ? { passed, skipped } : null;
}

function parseNodeTestSummary(output: string): ParsedCommandSummary | null {
  const matches = outputLines(output)
    .map((line) => line.match(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  const values = new Map<string, number>();
  for (const match of matches) {
    if (values.has(match[1])) return null;
    values.set(match[1], Number(match[2]));
  }
  if (values.size !== 6 || values.get("tests") !== 130 || values.get("pass") !== 130) return null;
  if (values.get("fail") !== 0 || values.get("cancelled") !== 0 || values.get("skipped") !== 0 || values.get("todo") !== 0) return null;
  return { passed: values.get("pass")!, skipped: values.get("skipped")! };
}

function parseFrontendUnitSummary(output: string): ParsedCommandSummary | null {
  const summaryLines = outputLines(output).filter((line) => /^(?:Test Files|Tests)\b/.test(line));
  if (summaryLines.length !== 2) return null;
  const fileMatches = summaryLines.map((line) => line.match(/^Test Files\s+(\d+) passed \((\d+)\)$/)).filter((match): match is RegExpMatchArray => match !== null);
  const testMatches = summaryLines.map((line) => line.match(/^Tests\s+(\d+) passed \((\d+)\)$/)).filter((match): match is RegExpMatchArray => match !== null);
  if (fileMatches.length !== 1 || testMatches.length !== 1) return null;
  const filesPassed = Number(fileMatches[0][1]);
  const filesTotal = Number(fileMatches[0][2]);
  const passed = Number(testMatches[0][1]);
  const total = Number(testMatches[0][2]);
  if (filesPassed !== 16 || filesTotal !== 16 || passed !== 128 || total !== 128) return null;
  return { passed, skipped: 0 };
}

function parsePlaywrightSummary(output: string): ParsedCommandSummary | null {
  const summaryLines = outputLines(output).filter((line) => /^\d+ (?:passed|failed|skipped|interrupted|flaky|did not run)(?:,\s*\d+ (?:passed|failed|skipped|interrupted|flaky|did not run))*(?: \(\d+(?:\.\d+)?(?:ms|s|m|h)\))?$/.test(line));
  if (summaryLines.length !== 1) return null;
  const match = summaryLines[0].match(/^(\d+) passed \(\d+(?:\.\d+)?(?:ms|s|m|h)\)$/);
  if (!match) return null;
  const passed = Number(match[1]);
  return passed === 9 ? { passed, skipped: 0 } : null;
}

const CHECKS: readonly CheckDefinition[] = [
  { id: "root-lint", command: "npm run lint", parse: parseRootLintSummary },
  { id: "contract-schema", command: "genvm-lint schema --json contracts/access_seal.py", parse: fixedSummary(/^\s*\{"ok":true,"schema":\{[\s\S]*\}\}\s*$/i, 22) },
  { id: "root-typecheck", command: "npm run typecheck", parse: fixedSummary(/(?:accessseal.*typecheck|tsc --noEmit)/i, 1) },
  { id: "direct", command: "npm run test:direct", parse: (output) => parsePytestSummary(output, 250, 0) },
  { id: "integration", command: "npm run test:integration", parse: (output) => parsePytestSummary(output, 38, 1) },
  { id: "root-scripts", command: "npm run test:scripts", parse: parseNodeTestSummary },
  { id: "frontend-lint", command: "npm --prefix frontend run lint", parse: fixedSummary(/(?:0 warnings|accessseal-frontend)/i, 1) },
  { id: "frontend-typecheck", command: "npm --prefix frontend run typecheck", parse: fixedSummary(/(?:typecheck|tsc --noEmit)/i, 1) },
  { id: "frontend-unit", command: "npm --prefix frontend run test", parse: parseFrontendUnitSummary },
  { id: "frontend-build", command: "npm --prefix frontend run build", parse: fixedSummary(/(?:Compiled successfully|Route \(app\))/i, 1) },
  { id: "frontend-e2e-1", command: "npm --prefix frontend run test:e2e # run 1", parse: parsePlaywrightSummary },
  { id: "frontend-e2e-2", command: "npm --prefix frontend run test:e2e # run 2", parse: parsePlaywrightSummary },
  { id: "secret-scan", command: "internal environment-secret value and credential-material scan", parse: fixedSummary(/Secret-value scan: PASS/i, 1) },
];

export async function verifyProofEvidence(inputs: VerificationInputs): Promise<FinalProofV2> {
  const repoRoot = resolve(inputs.repoRoot);
  const gitState = readRepositoryGitState(repoRoot);
  if (!gitState.clean) throw new Error("proof collection rejected a dirty Git worktree");
  const manifest = validateDeploymentManifest(inputs.manifest);
  const locators = validateLocators(inputs.locators, manifest.network, manifest);
  if (manifest.gitCommit !== gitState.commit) throw new Error("deployment manifest commit does not match clean HEAD");

  const observedChainId = await inputs.reader.rpcChainId();
  if (observedChainId !== manifest.chainId || inputs.reader.chain.id !== manifest.chainId ||
      inputs.reader.chain.name !== NETWORK_CHAIN_NAMES[manifest.network]) {
    throw new Error("official RPC chain identity mismatch");
  }
  const deploymentVerification = await verifyDeployment(inputs.reader, manifest, { repoRoot });

  const repository = await verifyRepositoryPublication(repoRoot, manifest, locators, inputs.fetcher);
  const frontend = await verifyFrontendPublication(manifest, locators, inputs.fetcher);
  await requireFetchOk(locators.explorerUrl, inputs.fetcher, "explorer transaction");
  const checks = verifyActualCommandResults(inputs.commandResults);

  const [recoverySource, settlementSource, liveSettlementVerifier, liveSettlementRegression, deploymentVerifierSource, deploymentVerifierRegression] = await Promise.all([
    trackedHeadFileProof(repoRoot, "frontend/e2e/recovery.spec.ts"),
    trackedHeadFileProof(repoRoot, "tests/direct/test_settlement.py"),
    trackedHeadFileProof(repoRoot, "scripts/glsim_support.py"),
    trackedHeadFileProof(repoRoot, "tests/integration/test_harness_controls.py"),
    trackedHeadFileProof(repoRoot, "deploy/999_verify_access_seal.ts"),
    trackedHeadFileProof(repoRoot, "tests/scripts/deploy.test.ts"),
  ]);

  const accounting = await readAccounting(inputs.reader, manifest.contractAddress);
  if (canonicalJson(accounting) !== canonicalJson(deploymentVerification.accounting)) {
    throw new Error("deployment accounting readback changed during proof collection");
  }
  const settlementProvenance = { liveSettlementVerifier, collectorRegression: liveSettlementRegression };
  const payout = await verifySettlementRow("PAYOUT", locators.workflows.payout, inputs.reader, manifest, accounting, settlementProvenance);
  const refund = await verifySettlementRow("REFUND", locators.workflows.refund, inputs.reader, manifest, accounting, settlementProvenance);
  const rmiCure = await verifyRmi(locators.workflows.rmiCure, inputs.reader, manifest, [recoverySource]);
  const unresolved = await verifyUnresolved(locators.workflows.unresolved, inputs.reader, manifest, [recoverySource]);
  const replayRejection = await verifyReplay(locators.workflows.replayRejection, inputs.reader, manifest, [settlementSource]);

  const proof: FinalProofV2 = {
    schemaVersion: "accessseal-final-proof/2",
    capturedAt: new Date().toISOString(),
    gitCommit: manifest.gitCommit,
    readableSourceSha256: manifest.readableSourceSha256,
    deploymentArtifactSha256: manifest.deploymentArtifactSha256,
    sourceSha256: manifest.sourceSha256,
    schemaSha256: manifest.schemaSha256,
    repository,
    frontend,
    deployment: {
      network: manifest.network,
      chainId: manifest.chainId,
      contractAddress: manifest.contractAddress.toLowerCase(),
      transactionHash: manifest.deploymentTransaction.toLowerCase(),
      explorerUrl: locators.explorerUrl,
      finality: "FINALIZED",
      execution: "FINISHED_WITH_RETURN",
      accountingReadback: accounting,
      classification: "INTENTIONALLY_FROZEN",
    },
    checks,
    proofRows: {
      payout,
      refund,
      rmiCure,
      unresolved,
      replayRejection,
      frozenClassification: {
        actor: "deployment-verifier",
        deploymentTransactionHash: manifest.deploymentTransaction.toLowerCase(),
        readableSourceSha256: manifest.readableSourceSha256,
        deploymentArtifactSha256: manifest.deploymentArtifactSha256,
        sourceSha256: manifest.sourceSha256,
        schemaSha256: manifest.schemaSha256,
        classification: "INTENTIONALLY_FROZEN",
        provenance: { deploymentVerifier: deploymentVerifierSource, verifierRegression: deploymentVerifierRegression },
      },
    },
    knownLimitations: [
      "GenLayer test value is simulated and is not production money.",
      "DISPATCHED_FINALIZED proves finalized parent dispatch; recipient confirmation is the separately linked finalized successful child transaction.",
      "The contract exposes no case enumeration, case createdAt, or originating review/appeal transaction history.",
      "GenVM v0.2.16 buffers web responses before AccessSeal can enforce post-fetch byte limits.",
    ],
  };
  return redactProof(proof);
}

async function verifySettlementRow(
  kind: "PAYOUT" | "REFUND",
  locator: SettlementLocator,
  reader: ProofReader,
  manifest: DeploymentManifest,
  accounting: Record<string, string>,
  provenance: SettlementProofRow["provenance"],
): Promise<SettlementProofRow> {
  const prepared = requireObject(await reader.getTransaction({ hash: locator.prepareTransactionHash }), `${kind} prepare transaction`);
  requireFinalized(prepared, `${kind} prepare`, true);
  requireTransactionHash(prepared, locator.prepareTransactionHash, `${kind} prepare`);
  requireContractAndCall(prepared, manifest.contractAddress, kind === "PAYOUT" ? "prepare_payout" : "prepare_refund", [locator.caseId], `${kind} prepare method`);
  const prepareExecutor = requireTransactionSender(prepared, `${kind} prepare`);
  const parent = requireObject(await reader.getTransaction({ hash: locator.parentTransactionHash }), `${kind} parent transaction`);
  requireFinalized(parent, `${kind} parent`, true);
  requireTransactionHash(parent, locator.parentTransactionHash, `${kind} parent`);
  requireContractAndCall(parent, manifest.contractAddress, "execute_settlement", [locator.caseId, locator.settlementId], `${kind} parent method`);
  const executor = requireTransactionSender(parent, `${kind} parent`);
  const caseReadback = await readJsonView(reader, manifest.contractAddress, "get_case", [locator.caseId]);
  const { buyer, vendor } = requireCaseActors(caseReadback, locator.caseId, `${kind} case`);
  if (prepareExecutor === buyer || prepareExecutor === vendor) throw new Error(`${kind} prepare sender must be an unrelated settler`);
  if (executor === buyer || executor === vendor) throw new Error(`${kind} sender must be an unrelated settler`);
  requireExternalMessage(parent, locator.recipient, locator.amount, kind);
  const triggered = await reader.getTriggeredTransactionIds({ hash: locator.parentTransactionHash });
  if (!Array.isArray(triggered) || triggered.length !== 1 || String(triggered[0]).toLowerCase() !== locator.childTransactionHash.toLowerCase()) {
    throw new Error(`${kind} triggered child linkage mismatch`);
  }
  const child = requireObject(await reader.getTransaction({ hash: locator.childTransactionHash }), `${kind} child transaction`);
  requireFinalized(child, `${kind} child`, true);
  requireTransactionHash(child, locator.childTransactionHash, `${kind} child`);
  if (transactionRecipient(child) !== locator.recipient.toLowerCase()) throw new Error(`${kind} child recipient mismatch`);
  if (child.value !== undefined && canonicalU256(child.value, `${kind} child transfer amount`) !== locator.amount) {
    throw new Error(`${kind} child transfer amount mismatch`);
  }

  const settlement = await readJsonView(reader, manifest.contractAddress, "get_settlement", [locator.caseId]);
  if (settlement.caseId !== locator.caseId || settlement.settlementId !== locator.settlementId ||
      settlement.status !== "DISPATCHED_FINALIZED" || settlement.kind !== kind ||
      String(settlement.recipient).toLowerCase() !== locator.recipient.toLowerCase() ||
      canonicalU256(settlement.amount, `${kind} settlement amount`) !== locator.amount ||
      normalizeAddress(settlement.executor, `${kind} settlement executor`) !== executor) {
    throw new Error(`${kind} settlement readback binding mismatch`);
  }
  return {
    kind,
    actor: "permissionless-settler",
    caseId: locator.caseId,
    contractAddress: manifest.contractAddress.toLowerCase(),
    settlementId: locator.settlementId,
    recipient: locator.recipient.toLowerCase(),
    amount: locator.amount,
    prepareTransactionHash: locator.prepareTransactionHash.toLowerCase(),
    executor,
    prepareExecutor,
    parentTransactionHash: locator.parentTransactionHash.toLowerCase(),
    childTransactionHash: locator.childTransactionHash.toLowerCase(),
    parentFinality: "FINALIZED",
    parentExecution: "SUCCESS",
    childFinality: "FINALIZED",
    childExecution: "SUCCESS",
    transfer: "DISPATCHED_FINALIZED",
    settlementReadback: settlement,
    accountingReadback: accounting,
    provenance,
  };
}

async function verifyRmi(locator: ProofLocators["workflows"]["rmiCure"], reader: ProofReader, manifest: DeploymentManifest, sources: SourceProof[]): Promise<FinalProofV2["proofRows"]["rmiCure"]> {
  const cure = requireObject(await reader.getTransaction({ hash: locator.cureTransactionHash }), "RMI cure transaction");
  requireFinalized(cure, "RMI cure", true);
  requireTransactionHash(cure, locator.cureTransactionHash, "RMI cure");
  requireContractAndCall(cure, manifest.contractAddress, "start_cure", [locator.caseId], "RMI cure method");
  const review = requireObject(await reader.getTransaction({ hash: locator.reviewTransactionHash }), "RMI review transaction");
  requireFinalized(review, "RMI review", true);
  requireTransactionHash(review, locator.reviewTransactionHash, "RMI review");
  requireContractAndCall(review, manifest.contractAddress, "request_review", [locator.caseId], "RMI review method");
  const caseReadback = await readJsonView(reader, manifest.contractAddress, "get_case", [locator.caseId]);
  const actors = requireCaseActors(caseReadback, locator.caseId, "RMI case");
  if (requireTransactionSender(cure, "RMI cure") !== actors.vendor) throw new Error("RMI cure sender is not the authoritative vendor");
  requireTransactionSender(review, "RMI review");
  const prior = await readJsonView(reader, manifest.contractAddress, "get_review_attempt", [locator.caseId, locator.fromEpoch, 0]);
  const cured = await readJsonView(reader, manifest.contractAddress, "get_review_attempt", [locator.caseId, locator.toEpoch, 0]);
  if (caseReadback.epoch !== locator.toEpoch || caseReadback.lifecycle !== "DECIDED" ||
      nestedVerdict(prior) !== "REQUEST_MORE_INFO" || nestedVerdict(cured) === "REQUEST_MORE_INFO" ||
      prior.status !== "FINALIZED" || cured.status !== "FINALIZED") {
    throw new Error("RMI cure authoritative readback mismatch");
  }
  await requireSettlementAbsent(reader, manifest.contractAddress, locator.caseId, "RMI cure");
  return {
    actor: "vendor-then-permissionless-reviewer",
    caseId: locator.caseId,
    fromEpoch: locator.fromEpoch,
    toEpoch: locator.toEpoch,
    transactions: [
      { method: "start_cure", hash: locator.cureTransactionHash.toLowerCase(), finality: "FINALIZED", execution: "SUCCESS" },
      { method: "request_review", hash: locator.reviewTransactionHash.toLowerCase(), finality: "FINALIZED", execution: "SUCCESS" },
    ],
    priorAttemptReadback: prior,
    curedAttemptReadback: cured,
    caseReadback,
    transfer: "NO_TRANSFER",
    sourceTests: sources,
  };
}

async function verifyUnresolved(locator: ProofLocators["workflows"]["unresolved"], reader: ProofReader, manifest: DeploymentManifest, sources: SourceProof[]): Promise<FinalProofV2["proofRows"]["unresolved"]> {
  const transaction = requireObject(await reader.getTransaction({ hash: locator.reviewTransactionHash }), "unresolved review transaction");
  requireFinalized(transaction, "unresolved review", true);
  requireTransactionHash(transaction, locator.reviewTransactionHash, "unresolved review");
  requireTransactionSender(transaction, "unresolved review");
  requireContractAndCall(transaction, manifest.contractAddress, "request_review", [locator.caseId], "unresolved review method");
  const review = await readJsonView(reader, manifest.contractAddress, "get_review_attempt", [locator.caseId, locator.epoch, locator.attempt]);
  const caseReadback = await readJsonView(reader, manifest.contractAddress, "get_case", [locator.caseId]);
  if (review.status !== "FINALIZED" || nestedVerdict(review) !== "UNRESOLVED" || caseReadback.lifecycle !== "DECIDED") {
    throw new Error("unresolved authoritative review readback mismatch");
  }
  await requireSettlementAbsent(reader, manifest.contractAddress, locator.caseId, "unresolved");
  return {
    actor: "permissionless-reviewer",
    caseId: locator.caseId,
    epoch: locator.epoch,
    attempt: locator.attempt,
    transactionHash: locator.reviewTransactionHash.toLowerCase(),
    finality: "FINALIZED",
    execution: "SUCCESS",
    reviewReadback: review,
    caseReadback,
    settlementAbsent: true,
    transfer: "NO_TRANSFER",
    sourceTests: sources,
  };
}

async function verifyReplay(locator: ProofLocators["workflows"]["replayRejection"], reader: ProofReader, manifest: DeploymentManifest, sources: SourceProof[]): Promise<FinalProofV2["proofRows"]["replayRejection"]> {
  const transaction = requireObject(await reader.getTransaction({ hash: locator.transactionHash }), "replay transaction");
  requireFinalized(transaction, "replay", false);
  requireTransactionHash(transaction, locator.transactionHash, "replay");
  requireContractAndCall(transaction, manifest.contractAddress, "execute_settlement", [locator.caseId, locator.settlementId], "replay method");
  const executor = requireTransactionSender(transaction, "replay");
  const caseReadback = await readJsonView(reader, manifest.contractAddress, "get_case", [locator.caseId]);
  const actors = requireCaseActors(caseReadback, locator.caseId, "replay case");
  if (executor === actors.buyer || executor === actors.vendor) throw new Error("replay sender must be an unrelated caller");
  const settlement = await readJsonView(reader, manifest.contractAddress, "get_settlement", [locator.caseId]);
  if (settlement.settlementId !== locator.settlementId || settlement.status !== "DISPATCHED_FINALIZED") {
    throw new Error("replay authoritative settlement readback mismatch");
  }
  return {
    actor: "unrelated-caller",
    caseId: locator.caseId,
    settlementId: locator.settlementId,
    method: "execute_settlement",
    transactionHash: locator.transactionHash.toLowerCase(),
    finality: "FINALIZED",
    execution: "FAILED_AS_EXPECTED",
    settlementReadback: settlement,
    transfer: "NO_TRANSFER",
    sourceTests: sources,
  };
}

function validateLocators(value: ProofLocators, network: NetworkName, manifest: DeploymentManifest): ProofLocators {
  if (!value || typeof value !== "object" || value.schemaVersion !== "accessseal-proof-locators/2") throw new Error("proof locator schema is invalid");
  requireExactKeys(value as unknown as Record<string, unknown>, ["explorerUrl", "frontendUrl", "repositoryCommitUrl", "repositoryUrl", "rpcUrl", "schemaVersion", "vercelDeploymentId", "workflows"], "proof locator");
  if (network === "localnet") throw new Error("final proof cannot use localnet");
  const endpoints = networkProofEndpoints(NETWORK_CHAIN_NAMES[network]);
  if (endpoints.chainId !== manifest.chainId) throw new Error("pinned chain identity does not match deployment manifest");
  const rpc = requirePublicUrl(value.rpcUrl, "RPC URL");
  if (rpc.href.replace(/\/$/, "") !== endpoints.rpcUrl.replace(/\/$/, "")) throw new Error("RPC URL is not the authoritative network endpoint");
  const explorer = requirePublicUrl(value.explorerUrl, "explorer URL");
  const exactExplorer = `${endpoints.explorerBaseUrl}/transactions/${manifest.deploymentTransaction.toLowerCase()}`;
  if (explorer.href !== exactExplorer) throw new Error("explorer URL origin/path/hash is invalid");
  const repository = parseGithubRepository(value.repositoryUrl);
  if (value.repositoryCommitUrl !== `${repository.url}/commit/${manifest.gitCommit}`) throw new Error("repository commit URL does not bind exact HEAD");
  requirePublicUrl(value.frontendUrl, "frontend URL");
  if (!/^dpl_[A-Za-z0-9]{16,}$/.test(value.vercelDeploymentId)) throw new Error("Vercel deployment identifier is invalid or a placeholder");
  requireExactKeys(value.workflows as unknown as Record<string, unknown>, ["payout", "refund", "replayRejection", "rmiCure", "unresolved"], "workflow locators");
  validateSettlementLocator(value.workflows.payout, "payout");
  validateSettlementLocator(value.workflows.refund, "refund");
  if (value.workflows.payout.parentTransactionHash === value.workflows.refund.parentTransactionHash) throw new Error("payout and refund transactions must be distinct");
  requireExactKeys(value.workflows.rmiCure as unknown as Record<string, unknown>, ["caseId", "cureTransactionHash", "fromEpoch", "reviewTransactionHash", "toEpoch"], "RMI locator");
  validateCase(value.workflows.rmiCure.caseId, "RMI case");
  if (value.workflows.rmiCure.fromEpoch !== 0 || value.workflows.rmiCure.toEpoch !== 1) throw new Error("RMI epoch binding is invalid");
  requireTx(value.workflows.rmiCure.cureTransactionHash, "RMI cure transaction");
  requireTx(value.workflows.rmiCure.reviewTransactionHash, "RMI review transaction");
  requireExactKeys(value.workflows.unresolved as unknown as Record<string, unknown>, ["attempt", "caseId", "epoch", "reviewTransactionHash"], "unresolved locator");
  validateCase(value.workflows.unresolved.caseId, "unresolved case");
  requireNatural(value.workflows.unresolved.epoch, "unresolved epoch");
  requireNatural(value.workflows.unresolved.attempt, "unresolved attempt");
  requireTx(value.workflows.unresolved.reviewTransactionHash, "unresolved transaction");
  requireExactKeys(value.workflows.replayRejection as unknown as Record<string, unknown>, ["caseId", "settlementId", "transactionHash"], "replay locator");
  validateCase(value.workflows.replayRejection.caseId, "replay case");
  validateSettlementId(value.workflows.replayRejection.settlementId, "replay settlement");
  requireTx(value.workflows.replayRejection.transactionHash, "replay transaction");
  return value;
}

function validateSettlementLocator(value: SettlementLocator, label: string): void {
  requireExactKeys(value as unknown as Record<string, unknown>, ["amount", "caseId", "childTransactionHash", "parentTransactionHash", "prepareTransactionHash", "recipient", "settlementId"], `${label} locator`);
  validateCase(value.caseId, `${label} case`);
  validateSettlementId(value.settlementId, `${label} settlement`);
  requireAddress(value.recipient, `${label} recipient`);
  if (typeof value.amount !== "string" || canonicalU256(value.amount, `${label} amount`) === "0") throw new Error(`${label} amount must be a positive canonical decimal-string u256`);
  requireTx(value.parentTransactionHash, `${label} parent transaction`);
  requireTx(value.prepareTransactionHash, `${label} prepare transaction`);
  requireTx(value.childTransactionHash, `${label} child transaction`);
  if (new Set([value.prepareTransactionHash, value.parentTransactionHash, value.childTransactionHash].map((item) => item.toLowerCase())).size !== 3) throw new Error(`${label} prepare, parent, and child transactions must be distinct`);
}

async function verifyRepositoryPublication(repoRoot: string, manifest: DeploymentManifest, locators: ProofLocators, fetcher: Fetcher): Promise<FinalProofV2["repository"]> {
  const repository = parseGithubRepository(locators.repositoryUrl);
  const commitResponse = await fetcher(`https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/${manifest.gitCommit}`, githubHeaders());
  if (!commitResponse.ok) throw new Error("repository publication commit is unavailable");
  const commitPayload = requireObject(await commitResponse.json(), "repository commit response");
  if (commitPayload.sha !== manifest.gitCommit) throw new Error("repository publication commit mismatch");
  const [remoteReadableResponse, remoteArtifactResponse] = await Promise.all([
    fetcher(`https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${manifest.gitCommit}/contracts/access_seal.py`, githubHeaders()),
    fetcher(`https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${manifest.gitCommit}/contracts/access_seal_deploy.py`, githubHeaders()),
  ]);
  if (!remoteReadableResponse.ok || !remoteArtifactResponse.ok) throw new Error("repository published contract sources are unavailable");
  const remoteReadable = new Uint8Array(await remoteReadableResponse.arrayBuffer());
  const remoteArtifact = new Uint8Array(await remoteArtifactResponse.arrayBuffer());
  if (sourceHash(remoteReadable) !== manifest.readableSourceSha256 || sourceHash(remoteArtifact) !== manifest.deploymentArtifactSha256) {
    throw new Error("repository published contract hash mismatch");
  }
  const localReadable = new Uint8Array(await readFile(join(repoRoot, "contracts", "access_seal.py")));
  const localArtifact = new Uint8Array(await readFile(join(repoRoot, "contracts", "access_seal_deploy.py")));
  if (sourceHash(localReadable) !== sourceHash(remoteReadable) || sourceHash(localArtifact) !== sourceHash(remoteArtifact)) {
    throw new Error("repository contract sources differ from local HEAD");
  }
  return {
    url: repository.url,
    commitUrl: locators.repositoryCommitUrl,
    remoteCommit: manifest.gitCommit,
    remoteReadableSourceSha256: sourceHash(remoteReadable),
    remoteDeploymentArtifactSha256: sourceHash(remoteArtifact),
  };
}

async function verifyFrontendPublication(manifest: DeploymentManifest, locators: ProofLocators, fetcher: Fetcher): Promise<FinalProofV2["frontend"]> {
  const token = process.env.VERCEL_TOKEN;
  if (!token || token.length < 8) throw new Error("VERCEL_TOKEN is required for authoritative frontend deployment readback");
  const response = await fetcher(`https://api.vercel.com/v13/deployments/${locators.vercelDeploymentId}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Vercel deployment readback is unavailable");
  const deployment = requireObject(await response.json(), "Vercel deployment response");
  const meta = requireObject(deployment.meta, "Vercel deployment metadata");
  const frontend = requirePublicUrl(locators.frontendUrl, "frontend URL");
  if (deployment.uid !== locators.vercelDeploymentId || deployment.readyState !== "READY" || deployment.target !== "production" ||
      meta.githubCommitSha !== manifest.gitCommit || deployment.url !== frontend.hostname) {
    throw new Error("Vercel deployment URL/status/commit binding mismatch");
  }
  const page = await fetcher(frontend.href);
  if (!page.ok || !page.headers.get("x-vercel-id")) {
    throw new Error("frontend live response is not a verified AccessSeal Vercel deployment");
  }
  const configUrl = new URL("/.well-known/accessseal/config.json", frontend).href;
  const configResponse = await fetcher(configUrl);
  if (
    !configResponse.ok ||
    !configResponse.headers.get("x-vercel-id") ||
    !/^application\/json(?:;|$)/i.test(configResponse.headers.get("content-type") ?? "")
  ) {
    throw new Error("frontend public config JSON response is unavailable");
  }
  let publicConfig: Record<string, unknown>;
  try {
    publicConfig = requireObject(await configResponse.json(), "frontend public config");
  } catch {
    throw new Error("frontend public config is not valid JSON");
  }
  requireExactKeys(
    publicConfig,
    ["chainId", "contractAddress", "network", "safeTestConfig", "schemaVersion"],
    "frontend public config",
  );
  if (
    publicConfig.schemaVersion !== "accessseal-public-config/1" ||
    publicConfig.network !== manifest.network ||
    publicConfig.chainId !== manifest.chainId ||
    String(publicConfig.contractAddress).toLowerCase() !== manifest.contractAddress.toLowerCase() ||
    publicConfig.safeTestConfig !== false
  ) {
    throw new Error("frontend public config deployment binding mismatch or safe-test mode is enabled");
  }
  return {
    url: frontend.href.replace(/\/$/, ""),
    vercelDeploymentId: locators.vercelDeploymentId,
    gitCommit: manifest.gitCommit,
    status: "READY",
    publicConfig: publicConfig as LivePublicConfig,
  };
}

function verifyActualCommandResults(results: Record<string, CommandResult>): CheckProof[] {
  requireExactKeys(results, CHECKS.map((item) => item.id), "actual command result set");
  return CHECKS.map((expected) => {
    const result = results[expected.id];
    if (!result || result.exitCode !== 0) throw new Error(`${expected.id} command failed`);
    const output = `${result.stdout}\n${result.stderr}`;
    const summary = expected.parse(output);
    if (!summary) throw new Error(`${expected.id} suite count/output summary mismatch`);
    if (expected.id === "contract-schema") {
      let payload: { ok?: unknown; schema?: object };
      try { payload = JSON.parse(result.stdout) as { ok?: unknown; schema?: object }; }
      catch { throw new Error("contract-schema machine output is not valid JSON"); }
      if (payload.ok !== true || !payload.schema || canonicalJsonHash(payload.schema) !== ACCESSSEAL_FROZEN_SCHEMA_SHA256) {
        throw new Error("contract-schema output does not bind the exact frozen schema");
      }
    }
    return { id: expected.id, command: expected.command, exitCode: 0, passed: summary.passed, skipped: summary.skipped, outputSha256: hashText(output) };
  });
}

export async function trackedHeadFileProof(repoRoot: string, inputPath: string): Promise<SourceProof> {
  if (isAbsolute(inputPath) || inputPath.includes("\\") || inputPath.split("/").includes("..") || inputPath.startsWith("./")) {
    throw new Error("source/test path must be a normalized repository-relative path");
  }
  const rootReal = await realpath(repoRoot);
  const candidate = resolve(rootReal, inputPath);
  const candidateReal = await realpath(candidate).catch(() => "");
  const contained = candidateReal && relative(rootReal, candidateReal) !== ".." && !relative(rootReal, candidateReal).startsWith(`..${sep}`) && !isAbsolute(relative(rootReal, candidateReal));
  if (!contained) throw new Error("source/test path escapes repository containment");
  if ((await lstat(candidate)).isSymbolicLink()) throw new Error("source/test path cannot be a symlink");
  const tracked = execFileSync("git", ["ls-files", "--error-unmatch", "--", inputPath], { cwd: rootReal, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (tracked !== inputPath.replaceAll("\\", "/")) throw new Error("source/test path is not tracked at HEAD");
  const blobSha = execFileSync("git", ["rev-parse", `HEAD:${inputPath}`], { cwd: rootReal, encoding: "utf8" }).trim();
  const headBytes = execFileSync("git", ["show", `HEAD:${inputPath}`], { cwd: rootReal });
  const workingBytes = await readFile(candidateReal);
  if (!headBytes.equals(workingBytes)) throw new Error("source/test working file differs from exact HEAD blob");
  return { path: inputPath, blobSha };
}

async function readAccounting(reader: ProofReader, contractAddress: string): Promise<Record<string, string>> {
  const accounting = await readJsonView(reader, contractAddress, "get_accounting", []);
  const keys = ["dispatchedPayouts", "dispatchedRefunds", "pendingDispatch", "reserved", "totalDeposits"];
  requireExactKeys(accounting, keys, "accounting readback");
  const typed = Object.fromEntries(keys.map((key) => [key, canonicalU256(accounting[key], `accounting ${key}`)])) as Record<string, string>;
  if (BigInt(typed.totalDeposits!) !== BigInt(typed.reserved!) + BigInt(typed.pendingDispatch!) + BigInt(typed.dispatchedPayouts!) + BigInt(typed.dispatchedRefunds!)) throw new Error("accounting readback violates conservation");
  return typed;
}

async function readJsonView(reader: ProofReader, address: string, functionName: string, args: unknown[]): Promise<Record<string, unknown>> {
  const value = await reader.readContract({ address, functionName, args, transactionHashVariant: "latest-final" });
  if (typeof value !== "string") throw new Error(`${functionName} latest-final readback shape is unavailable`);
  return parseLosslessJsonObject(value, `${functionName} latest-final readback`);
}

async function requireSettlementAbsent(reader: ProofReader, address: string, caseId: string, label: string): Promise<void> {
  try {
    await readJsonView(reader, address, "get_settlement", [caseId]);
    throw new Error(`${label} settlement unexpectedly exists`);
  } catch (error) {
    if (!matchesPinnedAbsentViewError(error, "settlement intent does not exist")) throw error;
  }
}

function matchesPinnedAbsentViewError(error: unknown, expected: string): boolean {
  let current = error;
  const seen = new Set<unknown>();
  const observed: string[] = [];
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message === expected) observed.push(expected);
      const direct = current.message.match(/^gen_call failed: (.+)$/);
      if (direct?.[1]) observed.push(direct[1]);
      const wrapped = current.message.match(/^An internal error was received\.\s+Details: UserError\(message='([^']+)'\)\s+Version: viem@2\.55\.16$/);
      if (wrapped?.[1]) observed.push(wrapped[1]);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && "cause" in current) { current = (current as { cause?: unknown }).cause; continue; }
    break;
  }
  return observed.length > 0 && observed.every((message) => message === expected);
}

function requireContractAndCall(transaction: Record<string, unknown>, contractAddress: string, method: string, args: unknown[], label: string): void {
  if (transactionRecipient(transaction) !== contractAddress.toLowerCase()) throw new Error(`${label} contract mismatch`);
  requireDecodedCall(transaction, method, args, label);
}

function requireDecodedCall(transaction: Record<string, unknown>, method: string, args: unknown[], label: string): void {
  const candidates: Array<{ method: unknown; args: unknown; kwargs: unknown }> = [];
  if (transaction.txDataDecoded !== undefined) {
    const decoded = requireObject(transaction.txDataDecoded, `${label} decoded transaction`);
    if (decoded.type !== "call") throw new Error(`${label} decoded transaction is not a call`);
    candidates.push(normalizeCallData(decoded.callData, `${label} decoded calldata`));
  }
  const data = transaction.data;
  if (data !== undefined) {
    const calldata = requireObject(requireObject(data, `${label} Studio data`).calldata, `${label} Studio calldata`);
    const raw = calldata.raw;
    if (!Array.isArray(raw) || raw.some((item) => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 255)) {
      throw new Error(`${label} Studio calldata raw bytes are unavailable`);
    }
    candidates.push(normalizeCallData(abi.calldata.decode(Uint8Array.from(raw as number[])), `${label} Studio decoded calldata`));
  }
  if (transaction.tx_data_decoded !== undefined) throw new Error(`${label} unproven snake-case decoded transaction shape is rejected`);
  if (candidates.length !== 1) throw new Error(`${label} requires one exact pinned SDK decoded-call shape`);
  const call = candidates[0]!;
  if (call.method !== method || canonicalJson(call.args) !== canonicalJson(args) || canonicalJson(call.kwargs) !== "{}") {
    throw new Error(`${label} decoded method/arguments mismatch`);
  }
}

function normalizeCallData(value: unknown, label: string): { method: unknown; args: unknown; kwargs: unknown } {
  if (value instanceof Map) {
    requireExactKeys(Object.fromEntries(value), ["args", "kwargs", "method"], label);
    return { method: value.get("method"), args: value.get("args"), kwargs: mapToObject(value.get("kwargs")) };
  }
  const record = requireObject(value, label);
  requireExactKeys(record, ["args", "kwargs", "method"], label);
  return { method: record.method, args: mapToObject(record.args), kwargs: mapToObject(record.kwargs) };
}

function mapToObject(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), mapToObject(item)]));
  if (Array.isArray(value)) return value.map(mapToObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapToObject(item)]));
  return value;
}

function requireFinalized(transaction: Record<string, unknown>, label: string, success: boolean): void {
  const { status, execution } = normalizeReceipt(transaction);
  if (status !== "FINALIZED") throw new Error(`${label} transaction is not finalized`);
  if (success ? execution !== "FINISHED_WITH_RETURN" : execution === "FINISHED_WITH_RETURN") {
    throw new Error(`${label} transaction execution ${success ? "failed" : "did not fail as expected"}`);
  }
}

function requireExternalMessage(parent: Record<string, unknown>, recipient: string, amount: string, label: string): void {
  const messages = parent.messages;
  if (!Array.isArray(messages) || messages.length !== 1 || !Array.isArray(messages[0]) || ![5, 6].includes(messages[0].length)) throw new Error(`${label} requires exactly one authoritative external message`);
  const [type, to, value, data, onAcceptance, saltNonce] = messages[0];
  if (type !== 1) throw new Error(`${label} parent message type mismatch`);
  if (String(to).toLowerCase() !== recipient.toLowerCase()) throw new Error(`${label} parent message recipient mismatch`);
  if (canonicalU256(value, `${label} parent message amount`) !== amount) throw new Error(`${label} parent message amount mismatch`);
  if (!["", "0x"].includes(String(data)) || onAcceptance !== false || (messages[0].length === 6 && (!Number.isInteger(saltNonce) || typeof saltNonce === "boolean"))) throw new Error(`${label} parent message is not a finalized-only pure transfer`);
}

function transactionRecipient(transaction: Record<string, unknown>): string | undefined {
  return consistentTransactionAddress(transaction, ["recipient", "to_address"], "recipient", false);
}

function requireTransactionSender(transaction: Record<string, unknown>, label: string): string {
  const sender = consistentTransactionAddress(transaction, ["sender", "from_address"], `${label} sender`, true);
  if (!sender) throw new Error(`${label} sender is unavailable`);
  return sender;
}

function requireTransactionHash(transaction: Record<string, unknown>, expected: string, label: string): void {
  const values = [transaction.hash, transaction.txId].filter((value) => value !== undefined);
  if (values.length === 0 || values.some((value) => typeof value !== "string" || !TX_HASH.test(value))) throw new Error(`${label} returned transaction hash is unavailable`);
  const normalized = values.map((value) => String(value).toLowerCase());
  if (new Set(normalized).size !== 1 || normalized[0] !== expected.toLowerCase()) throw new Error(`${label} returned transaction hash mismatch`);
}

function consistentTransactionAddress(transaction: Record<string, unknown>, keys: string[], label: string, required: boolean): string | undefined {
  const values = keys.map((key) => transaction[key]).filter((value) => value !== undefined);
  if (values.length === 0) {
    if (required) throw new Error(`${label} is unavailable`);
    return undefined;
  }
  const normalized = values.map((value) => normalizeAddress(value, label));
  if (new Set(normalized).size !== 1) throw new Error(`${label} aliases contradict`);
  return normalized[0];
}

function normalizeAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`${label} is not an address`);
  return value.toLowerCase();
}

function requireCaseActors(value: Record<string, unknown>, caseId: string, label: string): { buyer: string; vendor: string } {
  if (value.caseId !== caseId) throw new Error(`${label} case binding mismatch`);
  const buyer = normalizeAddress(value.buyer, `${label} buyer`);
  const vendor = normalizeAddress(value.vendor, `${label} vendor`);
  if (buyer === vendor) throw new Error(`${label} buyer/vendor actor binding is invalid`);
  return { buyer, vendor };
}

function nestedVerdict(record: Record<string, unknown>): unknown {
  return record.review && typeof record.review === "object" ? (record.review as Record<string, unknown>).verdict : undefined;
}

function parseGithubRepository(value: string): { url: string; owner: string; repo: string } {
  const url = requirePublicUrl(value, "repository URL");
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/?$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || !match || /(?:example|placeholder|replace|test-repo)/i.test(`${match[1]}/${match[2]}`)) throw new Error("repository URL must identify a published GitHub repository");
  return { url: `${url.origin}/${match[1]}/${match[2].replace(/\.git$/i, "")}`, owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

function requirePublicUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || isPrivateHost(url.hostname) || /(?:example|placeholder|replace|localhost)/i.test(url.hostname)) throw new Error(`${label} must be public HTTPS without placeholders`);
  return url;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "0.0.0.0", "::1"].includes(host) || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    return octets.some((value) => value > 255) || octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
  }
  return host.includes(":");
}

function requireTx(value: string, label: string): void { if (!TX_HASH.test(value) || patternedHex(value.slice(2))) throw new Error(`${label} hash is invalid or a sentinel`); }
function requireAddress(value: string, label: string): void { if (!ADDRESS.test(value) || patternedHex(value.slice(2))) throw new Error(`${label} is invalid or a sentinel`); }
function validateCase(value: string, label: string): void { if (!CASE_ID.test(value) || /(?:example|placeholder|replace)/i.test(value)) throw new Error(`${label} identifier is invalid or a placeholder`); }
function validateSettlementId(value: string, label: string): void { if (!SETTLEMENT_ID.test(value) || /(?:example|placeholder|replace)/i.test(value)) throw new Error(`${label} identifier is invalid or a placeholder`); }
function requireNatural(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`); }
function patternedHex(value: string): boolean { return /^(.{1,8})\1+$/i.test(value) || /^0+$/.test(value); }

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable or invalid`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(record).sort().join("\n") !== [...expected].sort().join("\n")) throw new Error(`${label} fields are invalid`);
}

async function requireFetchOk(url: string, fetcher: Fetcher, label: string): Promise<void> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${label} URL is unavailable`);
}

function githubHeaders(): RequestInit { const token = process.env.GITHUB_TOKEN; return token ? { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } } : { headers: { accept: "application/vnd.github+json" } }; }
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function redactProof<T>(value: T): T {
  const secrets = Object.entries(process.env).filter(([key, item]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE.*KEY|MNEMONIC)/i.test(key) && typeof item === "string" && item.length >= 8).map(([, item]) => item as string).sort((a, b) => b.length - a.length);
  const redact = (item: unknown): unknown => {
    if (typeof item === "string") {
      let next = item.replace(SECRET_MARKER, "[REDACTED]");
      for (const secret of secrets) next = next.replaceAll(secret, "[REDACTED]");
      return next;
    }
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child)]));
    return item;
  };
  const result = redact(value) as T;
  const serialized = JSON.stringify(result);
  for (const secret of secrets) if (serialized.includes(secret)) throw new Error("proof output contains an environment secret");
  return result;
}

export async function replaceProofPackageAtomically(
  jsonPath: string,
  jsonBody: string,
  matrixPath: string,
  matrixBody: string,
  hooks: { beforeInstall?: () => Promise<void> } = {},
): Promise<void> {
  if (resolve(jsonPath, "..").toLowerCase() !== resolve(matrixPath, "..").toLowerCase()) throw new Error("proof package outputs must share one directory");
  const directory = resolve(jsonPath, "..");
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(join(directory, ".proof-stage-"));
  const stagedJson = join(stage, "proof.json");
  const stagedMatrix = join(stage, "proof-matrix.md");
  const backupJson = join(stage, "old-proof.json");
  const backupMatrix = join(stage, "old-proof-matrix.md");
  let jsonBacked = false; let matrixBacked = false; let jsonInstalled = false; let matrixInstalled = false;
  try {
    await durableWrite(stagedJson, jsonBody);
    await durableWrite(stagedMatrix, matrixBody);
    if (await exists(jsonPath)) { await rename(jsonPath, backupJson); jsonBacked = true; }
    if (await exists(matrixPath)) { await rename(matrixPath, backupMatrix); matrixBacked = true; }
    await hooks.beforeInstall?.(); await rename(stagedJson, jsonPath); jsonInstalled = true;
    await hooks.beforeInstall?.(); await rename(stagedMatrix, matrixPath); matrixInstalled = true;
  } catch (error) {
    if (jsonInstalled) await rm(jsonPath, { force: true });
    if (matrixInstalled) await rm(matrixPath, { force: true });
    if (jsonBacked) await rename(backupJson, jsonPath);
    if (matrixBacked) await rename(backupMatrix, matrixPath);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function durableWrite(path: string, body: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }

function renderMatrix(proof: FinalProofV2): string {
  const p = proof.proofRows;
  return [
    "# AccessSeal fixed proof matrix", "",
    `Repository: ${proof.repository.commitUrl}`, `Frontend: ${proof.frontend.url}`, "",
    "| Proof | Exact transaction binding | Finality/execution | Authoritative readback | Transfer/recipient proof | Source at HEAD |",
    "|---|---|---|---|---|---|",
    `| Payout | prepare_payout(${p.payout.caseId}) — ${p.payout.prepareTransactionHash}; execute_settlement(${p.payout.caseId}, ${p.payout.settlementId}) — ${p.payout.parentTransactionHash} | both FINALIZED / SUCCESS | ${escapeCell(canonicalJson(p.payout.settlementReadback))} | DISPATCHED_FINALIZED; child ${p.payout.childTransactionHash} FINALIZED / SUCCESS | ${sourceCells(Object.values(p.payout.provenance))} |`,
    `| Refund | prepare_refund(${p.refund.caseId}) — ${p.refund.prepareTransactionHash}; execute_settlement(${p.refund.caseId}, ${p.refund.settlementId}) — ${p.refund.parentTransactionHash} | both FINALIZED / SUCCESS | ${escapeCell(canonicalJson(p.refund.settlementReadback))} | DISPATCHED_FINALIZED; child ${p.refund.childTransactionHash} FINALIZED / SUCCESS | ${sourceCells(Object.values(p.refund.provenance))} |`,
    `| RMI cure | ${p.rmiCure.transactions.map((item) => `${item.method}: ${item.hash}`).join("; ")} | both FINALIZED / SUCCESS | epoch ${p.rmiCure.fromEpoch} RMI -> epoch ${p.rmiCure.toEpoch} ${nestedVerdict(p.rmiCure.curedAttemptReadback)} | NO_TRANSFER | ${sourceCells(p.rmiCure.sourceTests)} |`,
    `| Unresolved | request_review(${p.unresolved.caseId}) — ${p.unresolved.transactionHash} | FINALIZED / SUCCESS | UNRESOLVED; settlement absent | NO_TRANSFER | ${sourceCells(p.unresolved.sourceTests)} |`,
    `| Replay rejection | execute_settlement(${p.replayRejection.caseId}, ${p.replayRejection.settlementId}) — ${p.replayRejection.transactionHash} | FINALIZED / FAILED_AS_EXPECTED | prior terminal settlement preserved | NO_TRANSFER | ${sourceCells(p.replayRejection.sourceTests)} |`,
    `| Frozen classification | deploy — ${p.frozenClassification.deploymentTransactionHash} | FINALIZED / FINISHED_WITH_RETURN | source ${p.frozenClassification.sourceSha256}; schema ${p.frozenClassification.schemaSha256} | NO_TRANSFER | ${sourceCells(Object.values(p.frozenClassification.provenance))} |`,
    "",
  ].join("\n");
}
function sourceCells(values: SourceProof[]): string { return values.map((item) => `${item.path}@${item.blobSha}`).join("; "); }
function escapeCell(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }

async function runCommands(repoRoot: string, manifest: DeploymentManifest): Promise<Record<string, CommandResult>> {
  const env = { ...process.env, PYTHONUTF8: "1", NEXT_PUBLIC_GENLAYER_NETWORK: manifest.network, NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: manifest.contractAddress };
  const invocations: Record<string, [string, string[]]> = {
    "root-lint": ["npm", ["run", "lint"]],
    "contract-schema": ["genvm-lint", ["schema", "--json", "contracts/access_seal.py"]],
    "root-typecheck": ["npm", ["run", "typecheck"]],
    direct: ["npm", ["run", "test:direct"]],
    integration: ["npm", ["run", "test:integration"]],
    "root-scripts": ["npm", ["run", "test:scripts"]],
    "frontend-lint": ["npm", ["--prefix", "frontend", "run", "lint"]],
    "frontend-typecheck": ["npm", ["--prefix", "frontend", "run", "typecheck"]],
    "frontend-unit": ["npm", ["--prefix", "frontend", "run", "test"]],
    "frontend-build": ["npm", ["--prefix", "frontend", "run", "build"]],
    "frontend-e2e-1": ["npm", ["--prefix", "frontend", "run", "test:e2e"]],
    "frontend-e2e-2": ["npm", ["--prefix", "frontend", "run", "test:e2e"]],
  };
  const results: Record<string, CommandResult> = {};
  for (const [id, [command, args]] of Object.entries(invocations)) {
    const npmCli = process.platform === "win32" && command === "npm" ? process.env.npm_execpath : undefined;
    const execution = spawnSync(npmCli ? process.execPath : command, npmCli ? [npmCli, ...args] : args, { cwd: repoRoot, env, encoding: "utf8", shell: false });
    results[id] = { exitCode: execution.status ?? 1, stdout: execution.stdout ?? "", stderr: `${execution.stderr ?? ""}${execution.error ? `\n${execution.error.message}` : ""}` };
  }
  const secretScan = await scanRepositorySecrets(repoRoot);
  results["secret-scan"] = { exitCode: secretScan.exitCode, stdout: secretScan.summary, stderr: "" };
  return results;
}

export async function collectProof(options: { repoRoot?: string; network: NetworkName }): Promise<FinalProofV2> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (options.network === "localnet") throw new Error("final proof cannot use localnet");
  const locatorPath = join(repoRoot, "work", "evidence", "final", "locators.json");
  const manifest = await readDeploymentManifest(repoRoot, options.network);
  const locators = JSON.parse(await readFile(locatorPath, "utf8")) as ProofLocators;
  validateLocators(locators, options.network, manifest);
  const client = createClient({ chain: PROOF_CHAINS[options.network], endpoint: locators.rpcUrl });
  const reader = Object.assign(client, {
    rpcChainId: async () => {
      const value = await client.request({ method: "eth_chainId" });
      if (typeof value === "string") return Number.parseInt(value, 16);
      if (typeof value === "number") return value;
      throw new Error("official RPC chain ID response is unavailable");
    },
  }) as unknown as ProofReader;
  const fetcher: Fetcher = (url, init = {}) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  const commandResults = await runCommands(repoRoot, manifest);
  const proof = await verifyProofEvidence({ repoRoot, manifest, locators, reader, fetcher, commandResults });
  const outputDir = join(repoRoot, "work", "evidence", "final");
  await installVerifiedProofPackage({ repoRoot, manifest, proof, outputDir });
  return proof;
}

export async function installVerifiedProofPackage(inputs: { repoRoot: string; manifest: DeploymentManifest; proof: FinalProofV2; outputDir: string }): Promise<void> {
  const root = resolve(inputs.repoRoot);
  const outputDir = resolve(inputs.outputDir);
  if (outputDir !== join(root, "work", "evidence", "final")) throw new Error("final proof output directory is not allowlisted");
  const manifest = validateDeploymentManifest(inputs.manifest);
  const state = readRepositoryGitState(root);
  if (!state.clean || state.commit !== manifest.gitCommit || inputs.proof.gitCommit !== state.commit) {
    throw new Error("final proof installation requires the exact clean HEAD");
  }
  const readableBytes = new Uint8Array(await readFile(join(root, "contracts", "access_seal.py")));
  const artifactBytes = new Uint8Array(await readFile(join(root, "contracts", "access_seal_deploy.py")));
  if (
    sourceHash(readableBytes) !== manifest.readableSourceSha256 ||
    sourceHash(artifactBytes) !== manifest.deploymentArtifactSha256 ||
    inputs.proof.readableSourceSha256 !== manifest.readableSourceSha256 ||
    inputs.proof.deploymentArtifactSha256 !== manifest.deploymentArtifactSha256 ||
    inputs.proof.sourceSha256 !== manifest.sourceSha256
  ) {
    throw new Error("final proof contract sources no longer match deployment and HEAD");
  }
  const generated = JSON.parse(execFileSync("genvm-lint", ["schema", "--json", "contracts/access_seal_deploy.py"], { cwd: root, encoding: "utf8" })) as { schema?: object };
  if (!generated.schema || canonicalJsonHash(generated.schema) !== manifest.schemaSha256 || inputs.proof.schemaSha256 !== manifest.schemaSha256) {
    throw new Error("final proof schema no longer matches deployment and HEAD");
  }
  for (const expected of collectSourceProofs(inputs.proof.proofRows)) {
    const observed = await trackedHeadFileProof(root, expected.path);
    if (observed.blobSha !== expected.blobSha) throw new Error(`final proof source binding changed for ${expected.path}`);
  }
  await replaceProofPackageAtomically(
    join(outputDir, "proof.json"), `${canonicalJson(inputs.proof)}\n`,
    join(outputDir, "proof-matrix.md"), renderMatrix(inputs.proof),
  );
}

function collectSourceProofs(value: unknown): SourceProof[] {
  const found: SourceProof[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (typeof record.path === "string" && typeof record.blobSha === "string") { found.push(record as SourceProof); return; }
    Object.values(record).forEach(visit);
  };
  visit(value);
  if (found.length === 0) throw new Error("final proof has no typed source provenance");
  return found;
}

function parseArgs(args: string[]): NetworkName {
  if (args.length !== 2 || args[0] !== "--network" || !(args[1] in NETWORK_CHAIN_IDS)) throw new Error("usage: npm run proof:collect -- --network <studionet|testnet_asimov|testnet_bradbury>");
  return args[1] as NetworkName;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  collectProof({ network: parseArgs(process.argv.slice(2)) }).then((proof) => console.log(`Proof fixed for ${proof.repository.commitUrl}`)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "proof collection failed"); process.exitCode = 1; });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { simplifyTransactionReceipt } from "genlayer-js";
import type { GenLayerTransaction } from "genlayer-js/types";

import {
  atomicWriteJson,
  canonicalJsonHash,
  sourceHash,
} from "../../scripts/source-hash.ts";
import {
  deployAccessSeal,
  deploymentManifestPath,
  readGitState,
  validateNetworkName,
  type DeploymentClient,
} from "../../deploy/001_deploy_access_seal.ts";
import {
  deploymentToSettlementProofEnvironment,
  identifyClientNetwork,
  normalizeReceipt,
  parseVerificationArguments,
  validateDeploymentManifest,
  verifyFrozenSchema,
  verifyDeployment,
  type DeploymentManifest,
} from "../../deploy/999_verify_access_seal.ts";

const address = "0x1234567890abcdef1234567890abcdef12345678";
const txHash =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const readableSource = new Uint8Array(await readFile(resolve("contracts/access_seal.py")));
const artifactSource = new Uint8Array(await readFile(resolve("contracts/access_seal_deploy.py")));
const source = readableSource;
const schema = (JSON.parse(execFileSync(
  "genvm-lint",
  ["schema", "--json", "contracts/access_seal.py"],
  { encoding: "utf8" },
)) as {
  schema: {
    ctor: Record<string, unknown>;
    methods: Record<string, Record<string, unknown>>;
  };
}).schema;
const fixtureRepoRoot = await mkdtemp(join(tmpdir(), "accessseal-clean-repo-"));
await mkdir(join(fixtureRepoRoot, "contracts"), { recursive: true });
await mkdir(join(fixtureRepoRoot, "scripts"), { recursive: true });
await writeFile(join(fixtureRepoRoot, "contracts", "access_seal.py"), source);
await writeFile(join(fixtureRepoRoot, "contracts", "access_seal_deploy.py"), artifactSource);
await copyFile(
  resolve("scripts/build_contract_artifact.py"),
  join(fixtureRepoRoot, "scripts", "build_contract_artifact.py"),
);
await writeFile(join(fixtureRepoRoot, ".gitignore"), "work/\n");
execFileSync("git", ["init", "-q"], { cwd: fixtureRepoRoot });
execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: fixtureRepoRoot });
execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixtureRepoRoot });
execFileSync("git", ["config", "user.name", "AccessSeal Test"], { cwd: fixtureRepoRoot });
execFileSync("git", ["add", "."], { cwd: fixtureRepoRoot });
execFileSync("git", ["commit", "-qm", "fixture"], { cwd: fixtureRepoRoot });
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: fixtureRepoRoot,
  encoding: "utf8",
}).trim();
after(async () => rm(fixtureRepoRoot, { recursive: true, force: true }));

function manifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: "accessseal-deployment-manifest/2",
    network: "studionet",
    chainId: 61999,
    contractAddress: address,
    deploymentTransaction: txHash,
    readableSourceSha256: sourceHash(readableSource),
    deploymentArtifactSha256: sourceHash(artifactSource),
    sourceSha256: sourceHash(artifactSource),
    schemaSha256: canonicalJsonHash(schema),
    gitCommit: commit,
    deployedAt: "2026-08-14T10:00:00.000Z",
    contractClassification: "INTENTIONALLY_FROZEN",
    ...overrides,
  };
}

function v3ManifestPath(value: DeploymentManifest): string {
  return deploymentManifestPath(fixtureRepoRoot, {
    network: value.network,
    contractVersion: "V3",
    contractAddress: value.contractAddress,
    deploymentArtifactSha256: value.deploymentArtifactSha256,
  });
}

function client(overrides: Partial<DeploymentClient> = {}): DeploymentClient {
  return {
    chain: { id: 61999, name: "Genlayer Studio Network" },
    account: { address: "0x9999999999999999999999999999999999999999" },
    deployContract: async () => txHash,
    waitForTransactionReceipt: async () => officialReceipt(),
    getTransaction: async () => officialReceipt(),
    getContractCode: async () => new TextDecoder().decode(artifactSource),
    getContractSchema: async () => schema,
    getContractSchemaForCode: async () => schema,
    readContract: async () =>
      JSON.stringify({
        dispatchedPayouts: 0,
        dispatchedRefunds: 0,
        pendingDispatch: 0,
        reserved: 0,
        totalDeposits: 0,
      }),
    ...overrides,
  };
}

test("deploys only the compact artifact and binds both tracked source hashes", async () => {
  let submittedCode: Uint8Array | undefined;
  const result = await deployAccessSeal(
    client({
      deployContract: async ({ code }) => {
        submittedCode = code;
        return txHash;
      },
      getContractCode: async () => new TextDecoder().decode(artifactSource),
    }),
    { network: "studionet", repoRoot: fixtureRepoRoot },
  );
  assert.deepEqual(submittedCode, artifactSource);
  assert.deepEqual(
    {
      schemaVersion: result.schemaVersion,
      readableSourceSha256: (result as unknown as Record<string, unknown>).readableSourceSha256,
      deploymentArtifactSha256: (result as unknown as Record<string, unknown>).deploymentArtifactSha256,
      sourceSha256: result.sourceSha256,
    },
    {
      schemaVersion: "accessseal-deployment-manifest/2",
      readableSourceSha256: sourceHash(readableSource),
      deploymentArtifactSha256: sourceHash(artifactSource),
      sourceSha256: sourceHash(artifactSource),
    },
  );
});

function officialReceipt(
  statusName = "FINALIZED",
  txExecutionResultName = "FINISHED_WITH_RETURN",
  addressShape: "studio" | "testnet" = "studio",
): GenLayerTransaction {
  return simplifyTransactionReceipt({
    statusName,
    txExecutionResultName,
    hash: txHash,
    ...(addressShape === "studio"
      ? { data: { contract_address: address } }
      : { txDataDecoded: { type: "deploy", contractAddress: address } }),
  } as GenLayerTransaction);
}

test("hashes exact source bytes and canonical schema objects stably", () => {
  assert.equal(
    sourceHash(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    canonicalJsonHash({ z: [3, { b: true, a: null }], a: "x" }),
    "b9e4db22e811ab3b92364a0aa53caf6b108f5f0dcee91e69d518d3668d91f106",
  );
});

test("rejects missing and placeholder deployment addresses", () => {
  for (const contractAddress of ["", "REPLACE_AT_DEPLOYMENT", `0x${"0".repeat(40)}`]) {
    assert.throws(
      () => validateDeploymentManifest(manifest({ contractAddress })),
      /contract address/i,
    );
  }
});

test("accepts only canonical network names and keeps manifest paths contained", () => {
  assert.equal(validateNetworkName("testnet_bradbury"), "testnet_bradbury");
  for (const value of ["../studionet", "STUDIONET", "testnet/bradbury", "bradbury"]) {
    assert.throws(() => validateNetworkName(value), /network/i);
  }
  assert.equal(
    deploymentManifestPath("C:\\repo", {
      network: "studionet",
      contractVersion: "V3",
      contractAddress: address,
      deploymentArtifactSha256: sourceHash(artifactSource),
    }),
    join(
      "C:\\repo",
      "work",
      "deployments",
      "studionet",
      "v3",
      sourceHash(artifactSource),
      `${address}.json`,
    ),
  );
});

test("writes V3 beside the historical V2 network manifest without changing V2 bytes", async () => {
  const legacyPath = join(fixtureRepoRoot, "work", "deployments", "studionet.json");
  const legacyBytes = '{"contractVersion":"V2","historical":true}\n';
  await mkdir(join(fixtureRepoRoot, "work", "deployments"), { recursive: true });
  await writeFile(legacyPath, legacyBytes);

  const result = await deployAccessSeal(client(), {
    network: "studionet",
    repoRoot: fixtureRepoRoot,
  });
  const v3Path = deploymentManifestPath(fixtureRepoRoot, {
    network: result.network,
    contractVersion: "V3",
    contractAddress: result.contractAddress,
    deploymentArtifactSha256: result.deploymentArtifactSha256,
  });

  assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
  assert.notEqual(v3Path, legacyPath);
  assert.deepEqual(JSON.parse(await readFile(v3Path, "utf8")), result);
  assert.equal((result as unknown as Record<string, unknown>).contractVersion, "V3");
});

test("preflights the V3 manifest destination before calling deployContract", async () => {
  const artifactHash = sourceHash(artifactSource);
  const versionDirectory = join(
    fixtureRepoRoot,
    "work",
    "deployments",
    "studionet",
    "v3",
    artifactHash,
  );
  await rm(versionDirectory, { recursive: true, force: true });
  await mkdir(join(versionDirectory, ".."), { recursive: true });
  await writeFile(versionDirectory, "blocks destination directory\n");
  let deployCalls = 0;
  const deployContract = async () => {
    deployCalls += 1;
    return txHash;
  };
  try {
    await assert.rejects(
      deployAccessSeal(client({ deployContract }), {
        network: "studionet",
        repoRoot: fixtureRepoRoot,
      }),
      /manifest destination preflight/i,
    );
    assert.equal(deployCalls, 0);
  } finally {
    await rm(versionDirectory, { force: true });
  }
});

test("requires one explicit canonical network for the standalone verifier", () => {
  assert.equal(parseVerificationArguments(["--network", "studionet"]), "studionet");
  for (const args of [[], ["--network"], ["--network", "../studionet"], ["studionet"]]) {
    assert.throws(() => parseVerificationArguments(args), /network|usage/i);
  }
});

test("normalizes the pinned simplified receipt and both official address shapes", async () => {
  const studio = officialReceipt();
  assert.equal((studio as Record<string, unknown>).status_name, "FINALIZED");
  assert.equal((studio as Record<string, unknown>).statusName, undefined);
  for (const addressShape of ["studio", "testnet"] as const) {
    const result = await deployAccessSeal(
      client({
        waitForTransactionReceipt: async () => officialReceipt(
          "FINALIZED",
          "FINISHED_WITH_RETURN",
          addressShape,
        ),
      }),
      {
        network: "studionet",
        repoRoot: fixtureRepoRoot,
      },
    );
    assert.equal(result.contractAddress, address);
    assert.deepEqual(
      JSON.parse(await readFile(v3ManifestPath(result), "utf8")),
      result,
    );
  }
});

test("normalizes the official full receipt without weakening contradiction checks", () => {
  assert.deepEqual(
    normalizeReceipt({
      statusName: "FINALIZED",
      txExecutionResultName: "FINISHED_WITH_RETURN",
      hash: txHash,
      txDataDecoded: { type: "deploy", contractAddress: address },
    }),
    {
      status: "FINALIZED",
      execution: "FINISHED_WITH_RETURN",
      contractAddress: address,
      hash: txHash,
    },
  );
  assert.throws(
    () => normalizeReceipt({
      statusName: "FINALIZED",
      status_name: "ACCEPTED",
      txExecutionResultName: "FINISHED_WITH_RETURN",
      tx_execution_result_name: "FINISHED_WITH_ERROR",
      hash: txHash,
      data: { contract_address: address },
      txDataDecoded: {
        type: "deploy",
        contractAddress: "0x8888888888888888888888888888888888888888",
      },
    }),
    /contradictory/i,
  );
});

test("rejects contradictory receipt aliases", async () => {
  const contradictory = {
    ...officialReceipt(),
    statusName: "ACCEPTED",
  };
  await assert.rejects(
    deployAccessSeal(client({ waitForTransactionReceipt: async () => contradictory }), {
      network: "studionet",
      repoRoot: fixtureRepoRoot,
    }),
    /contradictory/i,
  );
});

test("derives deploy-script network from the configured client and rejects same-chain aliases", () => {
  assert.equal(
    identifyClientNetwork({ id: 61999, name: "Genlayer Studio Network" }),
    "studionet",
  );
  assert.equal(
    identifyClientNetwork(
      { id: 4221, name: "Genlayer Bradbury Testnet" },
      "testnet_bradbury",
    ),
    "testnet_bradbury",
  );
  assert.throws(
    () =>
      identifyClientNetwork(
        { id: 4221, name: "Genlayer Asimov Testnet" },
        "testnet_bradbury",
      ),
    /network identity/i,
  );
});

test("rejects a deploy receipt that is accepted but not finalized", async () => {
  await assert.rejects(
    deployAccessSeal(
      client({
        waitForTransactionReceipt: async () => officialReceipt("ACCEPTED"),
      }),
      {
        network: "studionet",
        repoRoot: fixtureRepoRoot,
      },
    ),
    /finalized/i,
  );
});

test("rejects a finalized deployment whose execution failed", async () => {
  await assert.rejects(
    deployAccessSeal(
      client({
        waitForTransactionReceipt: async () =>
          officialReceipt("FINALIZED", "FINISHED_WITH_ERROR"),
      }),
      {
        network: "studionet",
        repoRoot: fixtureRepoRoot,
      },
    ),
    /execution/i,
  );
});

test("fails closed when deployed code differs from repository bytes", async () => {
  await assert.rejects(
    verifyDeployment(
      client({ getContractCode: async () => "different source" }),
      manifest(),
      { repoRoot: fixtureRepoRoot },
    ),
    /source/i,
  );
});

test("accepts Studio CRLF serialization while preserving the reviewed LF artifact hash", async () => {
  const studioSerialized = new TextDecoder()
    .decode(artifactSource)
    .replace(/\n/g, "\r\n");

  await verifyDeployment(
    client({ getContractCode: async () => studioSerialized }),
    manifest(),
    { repoRoot: fixtureRepoRoot },
  );
});

test("fails closed when deployed schema differs from the source-derived schema", async () => {
  await assert.rejects(
    verifyDeployment(
      client({
        getContractSchema: async () => ({ ...schema, methods: {} }),
      }),
      manifest(),
      { repoRoot: fixtureRepoRoot },
    ),
    /schema/i,
  );
});

test("public deployment independently rejects non-repository and dirty worktrees", async () => {
  const nonRepository = await mkdtemp(join(tmpdir(), "accessseal-no-git-"));
  const dirtyRepository = await mkdtemp(join(tmpdir(), "accessseal-dirty-git-"));
  try {
    await mkdir(join(nonRepository, "contracts"), { recursive: true });
    await writeFile(join(nonRepository, "contracts", "access_seal.py"), source);
    await mkdir(join(dirtyRepository, "contracts"), { recursive: true });
    await writeFile(join(dirtyRepository, "contracts", "access_seal.py"), source);
    execFileSync("git", ["init", "-q"], { cwd: dirtyRepository });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dirtyRepository });
    execFileSync("git", ["config", "user.name", "AccessSeal Test"], { cwd: dirtyRepository });
    execFileSync("git", ["add", "."], { cwd: dirtyRepository });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dirtyRepository });
    await writeFile(join(dirtyRepository, "untracked.txt"), "dirty\n");
    for (const repoRoot of [nonRepository, dirtyRepository]) {
      await assert.rejects(
        deployAccessSeal(client(), {
          network: "studionet",
          repoRoot,
        }),
        /git/i,
      );
    }
  } finally {
    await rm(nonRepository, { recursive: true, force: true });
    await rm(dirtyRepository, { recursive: true, force: true });
  }
});

test("does not write a manifest when authoritative readback fails", async () => {
  const path = v3ManifestPath(manifest());
  await rm(path, { force: true });
  await assert.rejects(
    deployAccessSeal(
      client({ getContractSchema: async () => ({ ctor: {}, methods: {} }) }),
      {
        network: "studionet",
        repoRoot: fixtureRepoRoot,
      },
    ),
    /schema/i,
  );
  await assert.rejects(readFile(path, "utf8"), /ENOENT/);
});

test("writes valid JSON atomically without leaving a temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accessseal-deploy-"));
  const destination = join(directory, "studionet.json");
  try {
    await atomicWriteJson(destination, manifest());
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest());
    assert.deepEqual(await readdir(directory), ["studionet.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when official client response fields drift", async () => {
  await assert.rejects(
    deployAccessSeal(
      client({
        waitForTransactionReceipt: async () => ({
          status: "FINALIZED",
          execution: "SUCCESS",
          contractAddress: address,
        }),
      }),
      {
        network: "studionet",
        repoRoot: fixtureRepoRoot,
      },
    ),
    /receipt shape/i,
  );
  await assert.rejects(
    verifyDeployment(
      client({ getContractCode: async () => undefined as never }),
      manifest(),
      { repoRoot: fixtureRepoRoot },
    ),
    /client.*code/i,
  );
});

test("standalone verification rebinds transaction finality, execution, and address", async () => {
  for (const transaction of [
    officialReceipt("ACCEPTED"),
    officialReceipt("FINALIZED", "FINISHED_WITH_ERROR"),
    simplifyTransactionReceipt({
      statusName: "FINALIZED",
      txExecutionResultName: "FINISHED_WITH_RETURN",
      hash: txHash,
      data: { contract_address: "0x8888888888888888888888888888888888888888" },
    } as GenLayerTransaction),
  ]) {
    await assert.rejects(
      verifyDeployment(
        client({ getTransaction: async () => transaction }),
        manifest(),
        { repoRoot: fixtureRepoRoot },
      ),
      /finalized|execution|address/i,
    );
  }
});

test("standalone verification requires manifest commit to equal independently read clean HEAD", async () => {
  await assert.rejects(
    verifyDeployment(client(), manifest({ gitCommit: "b".repeat(40) }), {
      repoRoot: fixtureRepoRoot,
    }),
    /git commit/i,
  );
  const dirty = join(fixtureRepoRoot, "untracked-verification.txt");
  await writeFile(dirty, "dirty\n");
  try {
    await assert.rejects(
      verifyDeployment(client(), manifest(), { repoRoot: fixtureRepoRoot }),
      /git.*dirty/i,
    );
  } finally {
    await rm(dirty, { force: true });
  }
});

test("the committed example is intentionally non-consumable", async () => {
  const example = JSON.parse(
    await readFile(resolve("docs/deployment-manifest.example.json"), "utf8"),
  ) as DeploymentManifest;
  assert.throws(() => validateDeploymentManifest(example), /placeholder|invalid/i);
});

test("rejects repeated sentinel address, hashes, commit, and zero timestamp", () => {
  const sentinels: Partial<DeploymentManifest>[] = [
    { contractAddress: `0x${"1".repeat(40)}` },
    { deploymentTransaction: `0x${"2".repeat(64)}` },
    { readableSourceSha256: "3".repeat(64) },
    { deploymentArtifactSha256: "4".repeat(64), sourceSha256: "4".repeat(64) },
    { sourceSha256: "3".repeat(64) },
    { schemaSha256: "4".repeat(64) },
    { gitCommit: "5".repeat(40) },
    { deployedAt: "1970-01-01T00:00:00.000Z" },
  ];
  for (const override of sentinels) {
    assert.throws(() => validateDeploymentManifest(manifest(override)), /placeholder|invalid/i);
  }
});

test("frozen schema policy rejects extra privilege and signature drift", () => {
  const toySchema = {
    ctor: { params: [], kwparams: {} },
    methods: { get_accounting: schema.methods.get_accounting },
  };
  assert.throws(
    () => (verifyFrozenSchema as (...args: object[]) => void)(toySchema, toySchema),
    /frozen schema/i,
  );
  assert.doesNotThrow(() => verifyFrozenSchema(schema));
  assert.throws(
    () => verifyFrozenSchema({ ...schema, methods: { ...schema.methods, migrate: schema.methods.get_accounting } }),
    /frozen schema/i,
  );
  assert.throws(
    () => verifyFrozenSchema({
      ...schema,
      methods: {
        get_accounting: { ...schema.methods.get_accounting, readonly: false },
      },
    }),
    /frozen schema/i,
  );
});

test("V3 schema exposes buyer evidence sealing and rejects privileged escape hatches", () => {
  assert.deepEqual(schema.methods.close_evidence, {
    params: [["case_id", "string"]],
    kwparams: {},
    readonly: false,
    ret: "null",
    payable: false,
  });
  for (const method of ["owner", "upgrade", "override_verdict"] as const) {
    assert.throws(
      () =>
        verifyFrozenSchema({
          ...schema,
          methods: { ...schema.methods, [method]: schema.methods.close_evidence },
        }),
      /frozen schema/i,
    );
  }
});

test("deployment manifest accepts only the intentionally frozen classification", () => {
  assert.throws(
    () =>
      validateDeploymentManifest(
        manifest({ contractClassification: "UPGRADEABLE" as "INTENTIONALLY_FROZEN" }),
      ),
    /classification/i,
  );
});

test("accounting readback explicitly selects finalized state", async () => {
  let readArgs: Record<string, unknown> | undefined;
  await verifyDeployment(
    client({
      readContract: async (args) => {
        readArgs = args;
        return JSON.stringify({
          dispatchedPayouts: 0,
          dispatchedRefunds: 0,
          pendingDispatch: 0,
          reserved: 0,
          totalDeposits: 0,
        });
      },
    }),
    manifest(),
    { repoRoot: fixtureRepoRoot },
  );
  assert.equal(readArgs?.transactionHashVariant, "latest-final");
});

test("real git-state inspection treats an untracked file as dirty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accessseal-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "AccessSeal Test"], { cwd: directory });
    await writeFile(join(directory, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
    assert.equal(readGitState(directory).clean, true);
    await writeFile(join(directory, "untracked.txt"), "untracked\n");
    assert.equal(readGitState(directory).clean, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("produces inputs compatible with the live settlement proof collector", () => {
  assert.deepEqual(deploymentToSettlementProofEnvironment(manifest()), {
    ACCESSSEAL_LIVE_NETWORK: "studionet",
    ACCESSSEAL_LIVE_CHAIN_ID: "61999",
    ACCESSSEAL_LIVE_CONTRACT_ADDRESS: address,
  });
  assert.throws(
    () =>
      deploymentToSettlementProofEnvironment(
        manifest({ network: "localnet", chainId: 61127 }),
      ),
    /live settlement/i,
  );
});

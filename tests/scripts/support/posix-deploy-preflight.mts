import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  deployAccessSeal,
  type DeploymentClient,
} from "../../../deploy/001_deploy_access_seal.ts";
import { sourceHash } from "../../../scripts/source-hash.ts";

if (process.platform === "win32") {
  throw new Error("POSIX deployment preflight regression requires a POSIX host");
}

const sourceRoot = resolve(".");
const repoRoot = await mkdtemp(join(tmpdir(), "accessseal-posix-preflight-"));
try {
  const testBin = join(repoRoot, "test-bin");
  await mkdir(testBin);
  const systemPython = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  const pythonShim = join(testBin, "python3");
  await writeFile(
    pythonShim,
    `#!/bin/sh\nif [ "$1" = "-c" ]; then exec ${systemPython} "$@"; fi\nexit 0\n`,
  );
  await chmod(pythonShim, 0o700);
  process.env.PATH = `${testBin}:${process.env.PATH ?? ""}`;
  await mkdir(join(repoRoot, "contracts"), { recursive: true });
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await copyFile(
    join(sourceRoot, "contracts", "access_seal.py"),
    join(repoRoot, "contracts", "access_seal.py"),
  );
  await copyFile(
    join(sourceRoot, "contracts", "access_seal_deploy.py"),
    join(repoRoot, "contracts", "access_seal_deploy.py"),
  );
  await copyFile(
    join(sourceRoot, "scripts", "build_contract_artifact.py"),
    join(repoRoot, "scripts", "build_contract_artifact.py"),
  );
  await writeFile(join(repoRoot, ".gitignore"), "work/\n");
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "AccessSeal Test"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repoRoot });

  const artifact = new Uint8Array(
    await readFile(join(repoRoot, "contracts", "access_seal_deploy.py")),
  );
  const artifactDirectory = join(
    repoRoot,
    "work",
    "deployments",
    "studionet",
    "v3",
    sourceHash(artifact),
  );
  await mkdir(resolve(artifactDirectory, ".."), { recursive: true });
  await writeFile(artifactDirectory, "blocks artifact directory creation\n", { flag: "wx" });

  let deployCalls = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("unavailable after preflight");
  };
  const client: DeploymentClient = {
    chain: { id: 61999, name: "Genlayer Studio Network" },
    account: { address: "0x9999999999999999999999999999999999999999" },
    getContractSchemaForCode: async () => ({ ctor: {}, methods: {} }),
    deployContract: async () => {
      deployCalls += 1;
      throw new Error("external deploy must not run before exact-directory preflight");
    },
    waitForTransactionReceipt: unavailable,
    getTransaction: unavailable,
    getContractCode: unavailable,
    getContractSchema: unavailable,
    readContract: unavailable,
  };

  await assert.rejects(
    deployAccessSeal(client, { network: "studionet", repoRoot }),
    /preflight|directory ancestor|not a directory/i,
  );
  assert.equal(deployCalls, 0);
} finally {
  await rm(repoRoot, { recursive: true, force: true });
}

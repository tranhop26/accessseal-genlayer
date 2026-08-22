import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const windows = process.platform === "win32";
if (windows && !process.env.PYTHONUTF8) process.env.PYTHONUTF8 = "1";

function run(command, args) {
  const npmCli = windows && command === "npm" ? process.env.npm_execpath : undefined;
  if (windows && command === "npm" && (!npmCli || !existsSync(npmCli))) {
    throw new Error("npm CLI path is unavailable for Windows frontend orchestration");
  }
  const executable = npmCli ? process.execPath : command;
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(executable, commandArgs, { shell: false, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { shell: false, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function filesWithExtension(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesWithExtension(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

function runFrontend(script) {
  if (!existsSync("frontend/package.json")) {
    console.log(`No frontend/package.json yet; skipping frontend ${script}.`);
    return;
  }
  run("npm", ["--prefix", "frontend", "run", script]);
}

function checkContractArtifact() {
  run("python", ["scripts/build_contract_artifact.py", "--check"]);
}

function runContractTests(directory, label) {
  if (!existsSync(directory)) {
    console.log(`No ${label} tests yet; skipping.`);
    return;
  }
  if (!process.env.GENLAYER_LOCALNET_ACCOUNT_0) {
    process.env.GENLAYER_LOCALNET_ACCOUNT_0 = randomBytes(32).toString("hex");
  }
  run("gltest", [directory]);
}

switch (process.argv[2]) {
  case "lint": {
    checkContractArtifact();
    const contracts = filesWithExtension("contracts", ".py");
    if (contracts.length === 0) console.log("No contract sources yet; skipping contract lint.");
    for (const contract of contracts) run("genvm-lint", ["lint", contract]);
    runFrontend("lint");
    break;
  }
  case "typecheck":
    runFrontend("typecheck");
    break;
  case "test":
    checkContractArtifact();
    if (existsSync("tests/scripts")) {
      const requested = process.argv.slice(3).filter((value) =>
        value.replaceAll("\\", "/").startsWith("tests/scripts/"),
      );
      runNode(["--import", "tsx", "--test", ...(requested.length > 0 ? requested : ["tests/scripts/*.test.ts"])]);
    }
    runFrontend("test");
    break;
  case "test:direct":
    checkContractArtifact();
    runContractTests("tests/direct", "direct contract");
    break;
  case "test:integration":
    checkContractArtifact();
    runContractTests("tests/integration", "integration");
    break;
  case "build":
    checkContractArtifact();
    runFrontend("build");
    break;
  default:
    throw new Error(`Unknown orchestration command: ${process.argv[2]}`);
}

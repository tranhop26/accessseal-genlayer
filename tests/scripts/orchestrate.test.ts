import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("root orchestration invokes the frontend package on modern Windows Node", { skip: process.platform !== "win32" }, () => {
  const npmCli = join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  assert.equal(existsSync(npmCli), true, "npm CLI fixture must exist");
  const result = spawnSync(process.execPath, ["scripts/orchestrate.mjs", "typecheck"], {
    cwd: process.cwd(),
    env: { ...process.env, npm_execpath: npmCli },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /accessseal-frontend@0\.1\.0 typecheck/);
});

test("direct-test orchestration is native and does not require a WSL distro", () => {
  const source = readFileSync("scripts/orchestrate.mjs", "utf8");
  assert.doesNotMatch(source, /wsl\.exe|runDirectTestsInWsl/);
  assert.match(source, /run\("gltest", \[directory\]\)/);
});

test("native Windows direct tests clean fd0 injection tempfiles", { skip: process.platform !== "win32" }, () => {
  const isolatedTemp = mkdtempSync(join(tmpdir(), "accessseal-direct-"));
  try {
    const result = spawnSync("gltest", ["tests/direct/test_case_lifecycle.py", "-q"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GENLAYER_LOCALNET_ACCOUNT_0: "1".repeat(64),
        TEMP: isolatedTemp,
        TMP: isolatedTemp,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(readdirSync(isolatedTemp), []);
  } finally {
    rmSync(isolatedTemp, { recursive: true, force: true });
  }
});

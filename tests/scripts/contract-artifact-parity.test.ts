import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const env = {
  ...process.env,
  GENVM_VERSION: "v0.2.16",
  PYTHONUTF8: "1",
};

function lint(path: string) {
  return spawnSync("genvm-lint", ["check", path], { encoding: "utf8", env });
}

function schema(path: string): unknown {
  const result = spawnSync("genvm-lint", ["schema", "--json", path], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout) as { ok: boolean; schema?: unknown };
  assert.equal(parsed.ok, true, result.stdout);
  return parsed.schema;
}

test("compact artifact remains GenVM-valid after local-name compaction", () => {
  const result = lint("contracts/access_seal_deploy.py");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Methods: 23 \(8 view, 15 write\)/);
});

test("compact artifact exposes the exact readable contract schema", () => {
  assert.deepEqual(
    schema("contracts/access_seal_deploy.py"),
    schema("contracts/access_seal.py"),
  );
});

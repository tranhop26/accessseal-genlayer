import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("exclusive-install fault injection stays in an isolated test-only module boundary", () => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      resolve("tests/scripts/support/exclusive-install-faults.mts"),
    ],
    { encoding: "utf8", env: childEnvironment, windowsHide: true },
  );
  assert.equal(
    result.status,
    0,
    `isolated exclusive-install fault tests failed:\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /pass 6/);
});

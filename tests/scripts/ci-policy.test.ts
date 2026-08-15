import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/ci.yml", "utf8");

test("Windows CI supplies a validated non-secret local build configuration", () => {
  const network = workflow.match(/NEXT_PUBLIC_GENLAYER_NETWORK:\s*([^\s]+)/)?.[1];
  const address = workflow.match(
    /NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS:\s*([^\s]+)/,
  )?.[1];
  assert.equal(network, "localnet");
  assert.match(address ?? "", /^0x[0-9a-f]{40}$/);
  assert.doesNotMatch(address ?? "", /^0x([0-9a-f])\1{39}$/);
});

test("integration CI has no repository-secret signer dependency", () => {
  assert.doesNotMatch(workflow, /secrets\.GENLAYER_LOCALNET_ACCOUNT_0/);
  assert.doesNotMatch(workflow, /must be configured as a repository secret/i);
  assert.doesNotMatch(workflow, /glsim\s+--no-browser/);
  assert.match(workflow, /run:\s+npm run test:integration/);
});

test("public repository excludes generated agent guardrails", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/);
  assert(!tracked.includes("frontend/AGENTS.md"));
  assert(!tracked.includes("frontend/CLAUDE.md"));
  for (const path of ["frontend/AGENTS.md", "frontend/CLAUDE.md"]) {
    assert.doesNotThrow(() =>
      execFileSync("git", ["check-ignore", "--quiet", path]),
    );
  }
});

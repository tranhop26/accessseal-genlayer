import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/ci.yml", "utf8");
const addressPattern =
  /^[ \t]*NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS:[ \t]*(?:"(0x[0-9a-f]{40})"|'(0x[0-9a-f]{40})'|(0x[0-9a-f]{40}))(?:[ \t]+#.*)?[ \t]*$/m;

function extractAddress(source: string): string | undefined {
  const match = source.match(addressPattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

test("Windows CI supplies a validated non-secret local build configuration", () => {
  const network = workflow.match(/NEXT_PUBLIC_GENLAYER_NETWORK:\s*([^\s]+)/)?.[1];
  const address = extractAddress(workflow);
  assert.equal(network, "localnet");
  assert.match(address ?? "", /^0x[0-9a-f]{40}$/);
  assert.doesNotMatch(address ?? "", /^0x([0-9a-f])\1{39}$/);
});

test("CI address extraction rejects an unmatched trailing quote", () => {
  const malformed =
    "NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: 0x7216c4492b0266a630265f92c9489e9511086e4a\"\n";
  assert.equal(extractAddress(malformed), undefined);
});

test("integration CI has no repository-secret signer dependency", () => {
  assert.doesNotMatch(workflow, /secrets\.GENLAYER_LOCALNET_ACCOUNT_0/);
  assert.doesNotMatch(workflow, /must be configured as a repository secret/i);
  assert.doesNotMatch(workflow, /glsim\s+--no-browser/);
  assert.match(workflow, /run:\s+npm run test:integration/);
});

test("every CI job that runs root lint installs frontend dependencies first", () => {
  const jobs = workflow.split(/^  (?=[a-z][a-z0-9_-]*:\s*$)/m).slice(1);
  const lintJobs = jobs.filter((job) => /^\s*-[ \t]+run:[ \t]+npm run lint\s*$/m.test(job));
  assert.notEqual(lintJobs.length, 0);
  for (const job of lintJobs) {
    const install = job.search(/npm --prefix frontend ci/);
    const lint = job.search(/^\s*-[ \t]+run:[ \t]+npm run lint\s*$/m);
    assert(install >= 0 && install < lint, "frontend dependencies must be installed before root lint");
  }
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

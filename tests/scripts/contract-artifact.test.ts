import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const builder = resolve("scripts/build_contract_artifact.py");
const fixtures: string[] = [];

after(async () => {
  await Promise.all(fixtures.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(sourcePath = resolve("contracts/access_seal.py")): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "accessseal-artifact-"));
  fixtures.push(root);
  await mkdir(join(root, "contracts"));
  await copyFile(sourcePath, join(root, "contracts/access_seal.py"));
  return root;
}

function run(root: string, mode: "--write" | "--check") {
  return spawnSync("python", [builder, "--repo-root", root, mode], {
    encoding: "utf8",
  });
}

function runGit(root: string, args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

async function ciCheckoutFixture(): Promise<string> {
  const source = await fixture();
  assert.equal(run(source, "--write").status, 0);

  try {
    await access(resolve(".gitattributes"));
    await copyFile(resolve(".gitattributes"), join(source, ".gitattributes"));
  } catch {
    // The fixture mirrors the repository as it exists, including no attributes file.
  }

  assert.equal(runGit(source, ["init", "--quiet"]).status, 0);
  assert.equal(runGit(source, ["add", "."]).status, 0);
  const commit = runGit(source, [
    "-c", "user.name=AccessSeal Test",
    "-c", "user.email=accessseal-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  assert.equal(commit.status, 0, commit.stderr);

  const checkout = await mkdtemp(join(tmpdir(), "accessseal-ci-checkout-"));
  fixtures.push(checkout);
  const clone = runGit(source, ["-c", "core.autocrlf=true", "clone", "--quiet", source, checkout]);
  assert.equal(clone.status, 0, clone.stderr);
  return checkout;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("builds the exact dependency-bound artifact deterministically within the Bradbury budget", async () => {
  const root = await fixture();
  const firstRun = run(root, "--write");
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const readable = await readFile(join(root, "contracts/access_seal.py"));
  const artifactPath = join(root, "contracts/access_seal_deploy.py");
  const first = await readFile(artifactPath);
  const secondRun = run(root, "--write");
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.deepEqual(await readFile(artifactPath), first);
  assert.ok(first.byteLength <= 48_000, `artifact is ${first.byteLength} bytes`);
  assert.equal(
    first.toString("utf8").split("\n", 1)[0],
    readable.toString("utf8").split("\n", 1)[0],
  );
  const metadata = JSON.parse(secondRun.stdout) as Record<string, unknown>;
  assert.deepEqual(metadata, {
    artifactBytes: first.byteLength,
    artifactSha256: sha256(first),
    readableSha256: sha256(readable),
  });
});

test("check rejects missing and stale artifacts without rewriting them", async () => {
  const root = await fixture();
  const missing = run(root, "--check");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing/i);

  assert.equal(run(root, "--write").status, 0);
  const artifactPath = join(root, "contracts/access_seal_deploy.py");
  const original = await readFile(artifactPath);
  await writeFile(
    join(root, "contracts/access_seal.py"),
    `${await readFile(join(root, "contracts/access_seal.py"), "utf8")}\nCASE_SCHEMA = "changed"\n`,
  );
  const stale = run(root, "--check");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale/i);
  assert.deepEqual(await readFile(artifactPath), original);

  await unlink(artifactPath);
  assert.match(run(root, "--check").stderr, /missing/i);
});

test("CI checkout with autocrlf preserves the tracked deployment artifact bytes", async () => {
  const checkout = await ciCheckoutFixture();
  const result = run(checkout, "--check");
  assert.equal(result.status, 0, result.stderr);
});

test("refuses an artifact whose encoded source exceeds 48000 bytes", async () => {
  const root = await fixture();
  const header = (await readFile(join(root, "contracts/access_seal.py"), "utf8")).split("\n", 1)[0];
  await writeFile(
    join(root, "contracts/access_seal.py"),
    `${header}\nPAYLOAD = ${JSON.stringify("x".repeat(50_000))}\n`,
  );
  const result = run(root, "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds 48000 bytes/i);
});

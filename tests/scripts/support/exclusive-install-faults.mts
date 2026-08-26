import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import test, { mock } from "node:test";

type FaultOperations = {
  link?: typeof realFs.link;
  open?: typeof realFs.open;
  unlink?: typeof realFs.unlink;
};

let activeOperations: FaultOperations = {};

mock.module("node:fs/promises", {
  exports: {
    link: (...args: Parameters<typeof realFs.link>) =>
      (activeOperations.link ?? realFs.link)(...args),
    lstat: realFs.lstat,
    mkdir: realFs.mkdir,
    open: (...args: Parameters<typeof realFs.open>) =>
      (activeOperations.open ?? realFs.open)(...args),
    readFile: realFs.readFile,
    readdir: realFs.readdir,
    realpath: realFs.realpath,
    rename: realFs.rename,
    rm: realFs.rm,
    unlink: (...args: Parameters<typeof realFs.unlink>) =>
      (activeOperations.unlink ?? realFs.unlink)(...args),
    writeFile: realFs.writeFile,
  },
});

const {
  atomicWriteJsonExclusive,
  canonicalJson,
  sourceHash,
} = await import("../../../scripts/source-hash.ts?exclusive-install-fault-harness");
const {
  ACCESSSEAL_FROZEN_SCHEMA_SHA256,
  readDeploymentManifest,
} = await import("../../../deploy/999_verify_access_seal.ts?exclusive-install-fault-harness");

async function withFaultOperations<T>(
  operations: FaultOperations,
  action: () => Promise<T>,
): Promise<T> {
  assert.deepEqual(activeOperations, {});
  activeOperations = operations;
  try {
    return await action();
  } finally {
    activeOperations = {};
  }
}

function injectedFilesystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function stagingEntries(names: string[]): string[] {
  return names.filter((name) => name.endsWith(".tmp"));
}

function canonicalFaultPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function existingCanonicalFaultPath(path: string): Promise<string | undefined> {
  try {
    return canonicalFaultPath(await realFs.realpath(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

test("production writer rejects a no-op link implementation", async () => {
  const directory = await realFs.mkdtemp(join(tmpdir(), "accessseal-exclusive-noop-"));
  const destination = join(directory, "manifest.json");
  try {
    await assert.rejects(
      withFaultOperations(
        { link: async () => undefined },
        () => atomicWriteJsonExclusive(destination, { accepted: true }),
      ),
      /final.*missing|post-install|integrity/i,
    );
    assert.deepEqual(await realFs.readdir(directory), []);
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

test("production writer rejects linked bytes changed by the installer", async () => {
  const directory = await realFs.mkdtemp(join(tmpdir(), "accessseal-exclusive-bytes-"));
  const destination = join(directory, "manifest.json");
  const replacedBytes = '{"accepted":false}\n';
  try {
    await assert.rejects(
      withFaultOperations(
        {
          link: async (stage, final) => {
            await realFs.link(stage, final);
            await realFs.writeFile(final, replacedBytes);
          },
        },
        () => atomicWriteJsonExclusive(destination, { accepted: true }),
      ),
      /expected bytes|post-install|integrity/i,
    );
    assert.equal(await realFs.readFile(destination, "utf8"), replacedBytes);
    assert.deepEqual(stagingEntries(await realFs.readdir(directory)), []);
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

test("production writer rejects a same-byte replacement during stage cleanup", async () => {
  const directory = await realFs.mkdtemp(join(tmpdir(), "accessseal-exclusive-identity-"));
  const destination = join(directory, "manifest.json");
  const replacement = join(directory, "replacement.json");
  const value = { accepted: true };
  const expectedBytes = `${canonicalJson(value)}\n`;
  try {
    await assert.rejects(
      withFaultOperations(
        {
          unlink: async (path) => {
            if (path.endsWith(".tmp")) {
              await realFs.writeFile(replacement, expectedBytes, { flag: "wx" });
              await realFs.rm(destination);
              await realFs.rename(replacement, destination);
            }
            await realFs.unlink(path);
          },
        },
        () => atomicWriteJsonExclusive(destination, value),
      ),
      /changed after post-install verification/i,
    );
    assert.equal(await realFs.readFile(destination, "utf8"), expectedBytes);
    assert.deepEqual(stagingEntries(await realFs.readdir(directory)), []);
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

test("production writer preserves a foreign EEXIST winner byte-for-byte", async () => {
  const directory = await realFs.mkdtemp(join(tmpdir(), "accessseal-exclusive-eexist-"));
  const destination = join(directory, "manifest.json");
  const foreignBytes = "foreign bytes must survive\n";
  try {
    await assert.rejects(
      withFaultOperations(
        {
          link: async (_stage, final) => {
            await realFs.writeFile(final, foreignBytes, { flag: "wx" });
            throw injectedFilesystemError("EEXIST");
          },
        },
        () => atomicWriteJsonExclusive(destination, { accepted: true }),
      ),
      /EEXIST|already exists/i,
    );
    assert.equal(await realFs.readFile(destination, "utf8"), foreignBytes);
    assert.deepEqual(stagingEntries(await realFs.readdir(directory)), []);
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

test("production writer reports retained staging when cleanup fails", async () => {
  const directory = await realFs.mkdtemp(join(tmpdir(), "accessseal-exclusive-stage-"));
  const destination = join(directory, "manifest.json");
  const value = { accepted: true };
  try {
    await assert.rejects(
      withFaultOperations(
        {
          unlink: async () => {
            throw injectedFilesystemError("EPERM");
          },
        },
        () => atomicWriteJsonExclusive(destination, value),
      ),
      /installed.*manual recovery/i,
    );
    const entries = await realFs.readdir(directory);
    assert.equal(stagingEntries(entries).length, 1);
    assert.equal(await realFs.readFile(destination, "utf8"), `${canonicalJson(value)}\n`);
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

test("production lookup rejects a requested manifest swapped before its pinned open", async () => {
  const rawRepoRoot = await realFs.mkdtemp(join(tmpdir(), "accessseal-lookup-swap-"));
  const repoRoot = process.platform === "win32" ? toNamespacedPath(rawRepoRoot) : rawRepoRoot;
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const artifactHash = sourceHash(new TextEncoder().encode("fault harness artifact"));
  const directory = join(repoRoot, "work", "deployments", "studionet", "v3", artifactHash);
  const path = join(directory, `${address}.json`);
  const original = {
    schemaVersion: "accessseal-deployment-manifest/2",
    contractVersion: "V3",
    network: "studionet",
    chainId: 61999,
    contractAddress: address,
    deploymentTransaction:
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    readableSourceSha256: sourceHash(new TextEncoder().encode("readable source")),
    deploymentArtifactSha256: artifactHash,
    sourceSha256: artifactHash,
    schemaSha256: ACCESSSEAL_FROZEN_SCHEMA_SHA256,
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    deployedAt: "2026-08-14T10:00:00.000Z",
    contractClassification: "INTENTIONALLY_FROZEN",
  };
  const replacement = { ...original, deployedAt: "2026-08-15T10:00:00.000Z" };
  let swapped = false;
  try {
    await realFs.mkdir(directory, { recursive: true });
    await realFs.writeFile(path, `${JSON.stringify(original)}\n`);
    const faultTarget = canonicalFaultPath(await realFs.realpath(path));
    await assert.rejects(
      withFaultOperations(
        {
          open: async (requested, flags, mode) => {
            const requestedPath = await existingCanonicalFaultPath(String(requested));
            if (!swapped && requestedPath === faultTarget) {
              swapped = true;
              await realFs.rm(path);
              await realFs.writeFile(path, `${JSON.stringify(replacement)}\n`, { flag: "wx" });
            }
            return realFs.open(requested, flags, mode);
          },
        },
        () => readDeploymentManifest(repoRoot, "studionet", address),
      ),
      /identity|changed during lookup/i,
    );
    assert.equal(swapped, true);
  } finally {
    await realFs.rm(rawRepoRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { mock } from "node:test";

if (process.platform === "win32") {
  throw new Error("POSIX cleanup-race regression requires a POSIX host");
}

let armed = false;
let cleanupHandleOpened = false;
let swapped = false;
let target = "";
let replacement = "";
let displacedOwned = "";
let rejectPathnameUnlink = false;
let expectedPublishedBytes: string | undefined;
let expectedPublishedDestination: string | undefined;
let observedCompleteStage = false;

const nativeFs = {
  link: realFs.link,
  lstat: realFs.lstat,
  mkdtemp: realFs.mkdtemp,
  mkdir: realFs.mkdir,
  open: realFs.open,
  readFile: realFs.readFile,
  readdir: realFs.readdir,
  realpath: realFs.realpath,
  rename: realFs.rename,
  rm: realFs.rm,
  unlink: realFs.unlink,
  writeFile: realFs.writeFile,
};

const mockedFs = {
    link: async (...args: Parameters<typeof realFs.link>) => {
      if (
        expectedPublishedBytes !== undefined &&
        resolve(String(args[1])) === expectedPublishedDestination
      ) {
        assert.equal(await nativeFs.readFile(args[0], "utf8"), expectedPublishedBytes);
        await assert.rejects(nativeFs.lstat(args[1]), { code: "ENOENT" });
        observedCompleteStage = true;
      }
      return nativeFs.link(...args);
    },
    lstat: async (...args: Parameters<typeof realFs.lstat>) => {
      const metadata = await nativeFs.lstat(...args);
      if (
        armed &&
        cleanupHandleOpened &&
        !swapped &&
        resolve(String(args[0])) === target
      ) {
        swapped = true;
        await nativeFs.rename(target, displacedOwned);
        await nativeFs.rename(replacement, target);
      }
      return metadata;
    },
    mkdtemp: nativeFs.mkdtemp,
    mkdir: nativeFs.mkdir,
    open: async (...args: Parameters<typeof realFs.open>) => {
      const handle = await nativeFs.open(...args);
      if (armed && resolve(String(args[0])) === target) {
        cleanupHandleOpened = true;
      }
      return handle;
    },
    readFile: nativeFs.readFile,
    readdir: nativeFs.readdir,
    realpath: nativeFs.realpath,
    rename: nativeFs.rename,
    rm: nativeFs.rm,
    unlink: async (...args: Parameters<typeof realFs.unlink>) => {
      if (rejectPathnameUnlink) {
        throw Object.assign(new Error("POSIX pathname unlink must not be used"), {
          code: "EPERM",
        });
      }
      return nativeFs.unlink(...args);
    },
    writeFile: nativeFs.writeFile,
};

mock.module(
  "node:fs/promises",
  Number(process.versions.node.split(".")[0]) >= 23
    ? { exports: mockedFs }
    : { namedExports: mockedFs },
);

const {
  atomicWriteJsonExclusive,
  canonicalJson,
  ensurePersistentPosixJsonCapability,
  removeExclusiveJsonInstall,
} = await import("../../../scripts/source-hash.ts?posix-cleanup-race");

test("POSIX persistent capability reuse does not accumulate retained aliases", async () => {
  const directory = await nativeFs.mkdtemp(join(tmpdir(), "accessseal-posix-capability-"));
  const destination = resolve(directory, ".accessseal-v3.preflight.json");
  const value = { schemaVersion: "capability/1" };
  try {
    await ensurePersistentPosixJsonCapability(destination, value);
    const firstEntries = (await nativeFs.readdir(directory)).sort();
    await ensurePersistentPosixJsonCapability(destination, value);
    assert.deepEqual((await nativeFs.readdir(directory)).sort(), firstEntries);
    assert.equal(firstEntries.length, 2);
  } finally {
    await nativeFs.rm(directory, { recursive: true, force: true });
  }
});

test("POSIX exclusive install publishes complete bytes without pathname cleanup", async () => {
  const directory = await nativeFs.mkdtemp(join(tmpdir(), "accessseal-posix-direct-install-"));
  const destination = resolve(directory, "manifest.json");
  try {
    rejectPathnameUnlink = true;
    expectedPublishedBytes = '{"installed":true}\n';
    expectedPublishedDestination = destination;
    const receipt = await atomicWriteJsonExclusive(destination, { installed: true });
    assert.equal(observedCompleteStage, true, "final publication must hard-link complete staging bytes");
    assert.equal(await nativeFs.readFile(destination, "utf8"), expectedPublishedBytes);
    const entries = (await nativeFs.readdir(directory)).sort();
    assert.equal(entries.length, 2);
    assert.equal(entries.includes("manifest.json"), true);
    const retained = entries.find((entry) => entry !== "manifest.json");
    assert.match(retained ?? "", /^\.manifest\.json\.[0-9]+\.[0-9a-f-]+\.retained$/);
    const finalMetadata = await nativeFs.lstat(destination, { bigint: true });
    const retainedMetadata = await nativeFs.lstat(resolve(directory, retained!), { bigint: true });
    assert.equal(finalMetadata.dev, retainedMetadata.dev);
    assert.equal(finalMetadata.ino, retainedMetadata.ino);
    assert.equal(finalMetadata.nlink, 2n);
    assert.equal(retainedMetadata.nlink, 2n);
    assert.equal(receipt.identity.dev, finalMetadata.dev);
    assert.equal(receipt.identity.ino, finalMetadata.ino);
  } finally {
    rejectPathnameUnlink = false;
    expectedPublishedBytes = undefined;
    expectedPublishedDestination = undefined;
    observedCompleteStage = false;
    await nativeFs.rm(directory, { recursive: true, force: true });
  }
});

test("POSIX owned cleanup never deletes a foreign pathname replacement after final lstat", async () => {
  const directory = await nativeFs.mkdtemp(join(tmpdir(), "accessseal-posix-cleanup-race-"));
  target = resolve(directory, "owned.json");
  replacement = resolve(directory, "foreign.json");
  displacedOwned = resolve(directory, "displaced-owned.json");
  const ownedValue = { owned: true };
  const foreignBytes = "foreign replacement must survive\n";
  try {
    const receipt = await atomicWriteJsonExclusive(target, ownedValue);
    await nativeFs.writeFile(replacement, foreignBytes, { flag: "wx" });
    armed = true;

    await assert.rejects(
      removeExclusiveJsonInstall(receipt),
      /cleanup|manual recovery/i,
    );

    assert.equal(swapped, true, "the pathname replacement must occur at the last lstat boundary");
    assert.equal(await nativeFs.readFile(target, "utf8"), foreignBytes);
    assert.equal(
      await nativeFs.readFile(displacedOwned, "utf8"),
      `${canonicalJson(ownedValue)}\n`,
    );
  } finally {
    armed = false;
    await nativeFs.rm(directory, { recursive: true, force: true });
  }
});

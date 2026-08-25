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
    link: nativeFs.link,
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
  removeExclusiveJsonInstall,
} = await import("../../../scripts/source-hash.ts?posix-cleanup-race");

test("POSIX exclusive install publishes complete bytes without pathname cleanup", async () => {
  const directory = await nativeFs.mkdtemp(join(tmpdir(), "accessseal-posix-direct-install-"));
  const destination = resolve(directory, "manifest.json");
  try {
    rejectPathnameUnlink = true;
    await atomicWriteJsonExclusive(destination, { installed: true });
    assert.equal(await nativeFs.readFile(destination, "utf8"), '{"installed":true}\n');
    assert.deepEqual(await nativeFs.readdir(directory), ["manifest.json"]);
  } finally {
    rejectPathnameUnlink = false;
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

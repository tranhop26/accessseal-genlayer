import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicWriteJsonExclusive,
  removeExclusiveJsonInstall,
  withV3ManifestNamespaceLease,
} from "../../../scripts/source-hash.ts";

if (process.platform === "win32") {
  throw new Error("POSIX exclusive-install smoke test requires a POSIX host");
}

const root = await mkdtemp(join(tmpdir(), "accessseal-posix-exclusive-"));
try {
  const destination = join(root, "manifest.json");
  const receipt = await atomicWriteJsonExclusive(destination, { accepted: true });
  await assert.rejects(
    removeExclusiveJsonInstall(receipt),
    /POSIX.*manual cleanup|manual recovery/i,
  );
  assert.equal(await readFile(destination, "utf8"), '{"accepted":true}\n');

  const v3Root = join(root, "v3");
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstEnteredPromise = new Promise<void>((resolveEntered) => {
    firstEntered = resolveEntered;
  });
  const holdFirst = new Promise<void>((resolveRelease) => {
    releaseFirst = resolveRelease;
  });
  let secondEntered = false;
  const first = withV3ManifestNamespaceLease(v3Root, async () => {
    firstEntered();
    await holdFirst;
  });
  await firstEnteredPromise;
  const leasePath = join(v3Root, ".accessseal-v3.namespace.lock");
  const originalLeaseBytes = await readFile(leasePath, "utf8");
  const second = withV3ManifestNamespaceLease(v3Root, async () => {
    secondEntered = true;
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  assert.equal(secondEntered, false, "a POSIX contender must wait for the held advisory lock");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);

  await withV3ManifestNamespaceLease(v3Root, async () => undefined);
  assert.equal(await readFile(leasePath, "utf8"), originalLeaseBytes);
  assert.deepEqual(await readdir(v3Root), [".accessseal-v3.namespace.lock"]);

  let releaseTimeoutOwner!: () => void;
  let timeoutOwnerEntered!: () => void;
  const timeoutOwnerEnteredPromise = new Promise<void>((resolveEntered) => {
    timeoutOwnerEntered = resolveEntered;
  });
  const holdTimeoutOwner = new Promise<void>((resolveRelease) => {
    releaseTimeoutOwner = resolveRelease;
  });
  const timeoutOwner = withV3ManifestNamespaceLease(v3Root, async () => {
    timeoutOwnerEntered();
    await holdTimeoutOwner;
  });
  await timeoutOwnerEnteredPromise;
  try {
    await assert.rejects(
      withV3ManifestNamespaceLease(v3Root, async () => undefined),
      /timed out|timeout|failed closed/i,
    );
  } finally {
    releaseTimeoutOwner();
    await timeoutOwner;
  }

  const displacedLease = join(v3Root, "owned-lease-marker");
  const foreignLeaseBytes = "foreign lease marker must survive\n";
  await assert.rejects(
    withV3ManifestNamespaceLease(v3Root, async () => {
      await rename(leasePath, displacedLease);
      await writeFile(leasePath, foreignLeaseBytes, { flag: "wx" });
      throw new Error("callback sentinel must survive lease failure");
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((cause) => /callback sentinel/i.test(String(cause))) &&
      error.errors.some((cause) => /lease|identity|failed closed/i.test(String(cause))),
  );
  assert.equal(await readFile(leasePath, "utf8"), foreignLeaseBytes);
  assert.equal(await readFile(displacedLease, "utf8"), originalLeaseBytes);
} finally {
  await rm(root, { recursive: true, force: true });
}

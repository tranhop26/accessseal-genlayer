import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  await removeExclusiveJsonInstall(receipt);
  assert.deepEqual(await readdir(root), []);

  const v3Root = join(root, "v3");
  await withV3ManifestNamespaceLease(v3Root, async () => {
    assert.deepEqual(await readdir(v3Root), [".accessseal-v3.namespace.lock"]);
  });
  assert.deepEqual(await readdir(v3Root), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

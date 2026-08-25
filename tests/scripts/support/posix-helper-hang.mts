import assert from "node:assert/strict";
import * as realChildProcess from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

if (process.platform === "win32") {
  throw new Error("POSIX helper-hang regression requires a POSIX host");
}

const hangingHelper = [
  "import signal,sys,time",
  "signal.signal(signal.SIGTERM, lambda *_: None)",
  "sys.stdout.write('READY\\n')",
  "sys.stdout.flush()",
  "time.sleep(60)",
].join(";");

const mockedChildProcess = {
  ...realChildProcess,
  spawn: (
    _command: string,
    _args: readonly string[],
    options: realChildProcess.SpawnOptions,
  ) => realChildProcess.spawn("python3", ["-c", hangingHelper], options),
};

mock.module(
  "node:child_process",
  Number(process.versions.node.split(".")[0]) >= 23
    ? { exports: mockedChildProcess }
    : { namedExports: mockedChildProcess },
);

const { withV3ManifestNamespaceLease } =
  await import("../../../scripts/source-hash.ts?posix-helper-hang");

test("post-ready helper hang is terminated and confirmed closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "accessseal-posix-helper-hang-"));
  try {
    await assert.rejects(
      withV3ManifestNamespaceLease(join(root, "v3"), async () => undefined),
      /helper.*signal|advisory-lock.*failed closed|acquisition/i,
    );
    assert.equal(
      (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")).trim(),
      "",
      "the post-ready helper must be confirmed closed before rejection",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

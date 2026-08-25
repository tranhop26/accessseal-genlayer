import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("exclusive install and namespace lease run on a real POSIX filesystem", (context) => {
  const relativeScript = "tests/scripts/support/posix-exclusive-smoke.mts";
  const script = resolve(relativeScript);
  const result = process.platform === "win32"
    ? spawnSync(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "--cd",
          process.cwd(),
          "--",
          "node",
          "--experimental-strip-types",
          relativeScript,
        ],
        { encoding: "utf8", windowsHide: true },
      )
    : spawnSync(
        process.execPath,
        ["--experimental-strip-types", script],
        { encoding: "utf8" },
      );
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    process.platform === "win32" &&
    ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      /not installed|no distribution|WSL_E_DISTRO_NOT_FOUND/i.test(diagnostic))
  ) {
    context.skip("WSL Ubuntu is unavailable on this Windows host");
    return;
  }
  assert.equal(result.status, 0, `POSIX filesystem smoke test failed:\n${diagnostic}`);
});

test("POSIX cleanup preserves a pathname replacement at the last unlink boundary", (context) => {
  const relativeScript = "tests/scripts/support/posix-cleanup-race.mts";
  const script = resolve(relativeScript);
  const args = [
    "--experimental-test-module-mocks",
    "--experimental-strip-types",
    "--test",
    process.platform === "win32" ? relativeScript : script,
  ];
  const result = process.platform === "win32"
    ? spawnSync(
        "wsl.exe",
        ["-d", "Ubuntu", "--cd", process.cwd(), "--", "node", ...args],
        { encoding: "utf8", windowsHide: true },
      )
    : spawnSync(process.execPath, args, { encoding: "utf8" });
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    process.platform === "win32" &&
    ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      /not installed|no distribution|WSL_E_DISTRO_NOT_FOUND/i.test(diagnostic))
  ) {
    context.skip("WSL Ubuntu is unavailable on this Windows host");
    return;
  }
  assert.equal(result.status, 0, `POSIX cleanup-race regression failed:\n${diagnostic}`);
});

test("POSIX deploy preflights the exact artifact directory before external deployment", (context) => {
  const relativeScript = "tests/scripts/support/posix-deploy-preflight.mts";
  const script = resolve(relativeScript);
  const result = process.platform === "win32"
    ? spawnSync(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "--cd",
          process.cwd(),
          "--",
          "node",
          "--experimental-strip-types",
          relativeScript,
        ],
        { encoding: "utf8", windowsHide: true },
      )
    : spawnSync(
        process.execPath,
        ["--experimental-strip-types", script],
        { encoding: "utf8" },
      );
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    process.platform === "win32" &&
    ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      /not installed|no distribution|WSL_E_DISTRO_NOT_FOUND/i.test(diagnostic))
  ) {
    context.skip("WSL Ubuntu is unavailable on this Windows host");
    return;
  }
  assert.equal(result.status, 0, `POSIX exact-directory preflight regression failed:\n${diagnostic}`);
});

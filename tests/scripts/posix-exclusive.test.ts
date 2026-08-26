import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

type SpawnResult = ReturnType<typeof spawnSync>;

function hasUnavailableWslDiagnostic(diagnostic: string): boolean {
  const normalized = diagnostic.replaceAll("\0", "");
  return /WSL_E_DISTRO_NOT_FOUND|Windows Subsystem for Linux has no installed distributions|There is no distribution with the supplied name/i
    .test(normalized);
}

function isUnavailableWsl(result: SpawnResult, diagnostic: string): boolean {
  return (
    process.platform === "win32" &&
    ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      hasUnavailableWslDiagnostic(diagnostic))
  );
}

test("recognizes UTF-16-style missing WSL distribution diagnostics on every platform", () => {
  const diagnostic = "W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0N\0O\0T\0_\0F\0O\0U\0N\0D\0";
  assert.equal(hasUnavailableWslDiagnostic(diagnostic), true);
});

test("does not classify unrelated child output as an unavailable WSL distribution", () => {
  assert.equal(
    hasUnavailableWslDiagnostic("artifact dependency not installed; no distribution was produced"),
    false,
  );
});

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
    isUnavailableWsl(result, diagnostic)
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
    isUnavailableWsl(result, diagnostic)
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
    isUnavailableWsl(result, diagnostic)
  ) {
    context.skip("WSL Ubuntu is unavailable on this Windows host");
    return;
  }
  assert.equal(result.status, 0, `POSIX exact-directory preflight regression failed:\n${diagnostic}`);
});

test("POSIX acquisition kills a helper that hangs after readiness", (context) => {
  const relativeScript = "tests/scripts/support/posix-helper-hang.mts";
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
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      )
    : spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15_000 });
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    isUnavailableWsl(result, diagnostic)
  ) {
    context.skip("WSL Ubuntu is unavailable on this Windows host");
    return;
  }
  assert.equal(result.status, 0, `POSIX post-ready helper timeout regression failed:\n${diagnostic}`);
});

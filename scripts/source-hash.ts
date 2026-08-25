import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from "node:path";
import { promisify } from "node:util";

type DirectoryIdentity = {
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
};

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

type PlatformFileIdentity =
  | { platform: "win32"; value: string }
  | { platform: "posix"; dev: bigint; ino: bigint };

export type ExclusiveJsonInstallReceipt = {
  directory: DirectoryIdentity;
  destination: string;
  identity: FileIdentity;
  platformIdentity: PlatformFileIdentity;
};

const execFileAsync = promisify(execFile);
const V3_NAMESPACE_LEASE_FILENAME = ".accessseal-v3.namespace.lock";
const V3_NAMESPACE_LEASE_WAIT_MS = 5_000;
const V3_NAMESPACE_LEASE_POLL_MS = 25;

const WINDOWS_FILE_HANDLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class AccessSealWindowsFileHandle {
  [StructLayout(LayoutKind.Sequential)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_DISPOSITION_INFO {
    [MarshalAs(UnmanagedType.Bool)]
    public bool DeleteFile;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetFileInformationByHandle(
    SafeFileHandle file,
    out BY_HANDLE_FILE_INFORMATION information);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetFileInformationByHandle(
    SafeFileHandle file,
    int fileInformationClass,
    ref FILE_DISPOSITION_INFO information,
    uint informationSize);

  public static string InspectOrDelete(string path, string expected, bool deleteFile) {
    const uint GENERIC_READ = 0x80000000;
    const uint DELETE = 0x00010000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    const int FileDispositionInfo = 4;

    using (SafeFileHandle file = CreateFile(
      path,
      GENERIC_READ | DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      IntPtr.Zero)) {
      if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(file, out information)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      string identity = information.VolumeSerialNumber.ToString("x8") + ":" +
        information.FileIndexHigh.ToString("x8") + information.FileIndexLow.ToString("x8");
      if (expected != "NONE" && identity != expected) return "MISMATCH";
      if (deleteFile) {
        FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO();
        disposition.DeleteFile = true;
        if (!SetFileInformationByHandle(
          file,
          FileDispositionInfo,
          ref disposition,
          (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      }
      return identity;
    }
  }
}
'@

$expected = $env:ACCESSSEAL_EXPECTED_FILE_ID
$deleteFile = $env:ACCESSSEAL_DELETE_FILE -eq '1'
[Console]::Out.Write([AccessSealWindowsFileHandle]::InspectOrDelete(
  $env:ACCESSSEAL_MANIFEST_PATH,
  $expected,
  $deleteFile
))
`;

export function sourceHash(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("source hash input must be bytes");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalJsonHash(value: unknown): string {
  return sourceHash(new TextEncoder().encode(canonicalJson(value)));
}

function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("value is not canonical JSON data");
  }
  if (ancestors.has(value)) throw new TypeError("canonical JSON cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON requires plain objects");
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const body = `${canonicalJson(value)}\n`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function ensureRealDirectory(path: string): Promise<string> {
  return (await inspectRealDirectory(path, true)).realPath;
}

export async function assertRealDirectory(path: string): Promise<string> {
  return (await inspectRealDirectory(path, false)).realPath;
}

export async function assertSafeRegularFile(root: string, path: string): Promise<void> {
  const realRoot = await assertRealDirectory(root);
  const destination = resolve(path);
  if (!isContained(realRoot, destination)) {
    throw new Error("deployment manifest path escapes its physical root");
  }
  const child = relative(realRoot, destination);
  let current = realRoot;
  const parts = child.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new Error(`deployment manifest path contains a symbolic link or junction: ${current}`);
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new Error(`deployment manifest ancestor is not a directory: ${current}`);
    }
    if (index === parts.length - 1 && !metadata.isFile()) {
      throw new Error(`deployment manifest must be a regular file: ${current}`);
    }
  }
  if (!isContained(realRoot, await realpath(destination))) {
    throw new Error("deployment manifest file escapes its physical root");
  }
}

export async function atomicWriteJsonExclusive(
  path: string,
  value: unknown,
): Promise<ExclusiveJsonInstallReceipt> {
  const body = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const directory = await inspectRealDirectory(dirname(path), true);
  const destination = join(directory.realPath, basename(resolve(path)));
  const temporary = join(
    directory.realPath,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let finalLinkCompleted = false;
  let installationVerified = false;
  let receipt: ExclusiveJsonInstallReceipt | undefined;
  let installError: unknown;
  try {
    await assertSafeExclusiveDestination(destination);
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertUnchangedDirectory(directory);
    await assertSafeExclusiveDestination(destination);
    await link(temporary, destination);
    finalLinkCompleted = true;
    const identity = await assertExclusiveInstallation(directory, temporary, destination, body);
    installationVerified = true;
    receipt = {
      directory: { ...directory },
      destination,
      identity,
      platformIdentity: await inspectPlatformFileIdentity(destination, 2n),
    };
  } catch (error) {
    installError = error;
  }
  try {
    await assertUnchangedDirectory(directory);
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const phase = installationVerified
        ? "final manifest installed but staging cleanup failed"
        : finalLinkCompleted
          ? "final manifest link completed but post-install verification failed and staging cleanup failed"
        : "manifest installation failed and staging cleanup failed";
      const installationDetail = installError
        ? `; original installation error: ${errorMessage(installError)}`
        : "";
      throw new Error(
        `${phase}; manual recovery required for ${temporary}: ${errorMessage(error)}${installationDetail}`,
      );
    }
  }
  if (installError) {
    throw installError;
  }
  if (!receipt) throw new Error("exclusive manifest installation completed without a verified receipt");
  await assertExclusiveReceiptUnchanged(receipt, body);
  return receipt;
}

export async function removeExclusiveJsonInstall(receipt: ExclusiveJsonInstallReceipt): Promise<void> {
  const destination = await assertOwnedExclusiveJsonInstall(receipt);
  await assertOwnedExclusiveJsonInstall(receipt);
  await deletePlatformOwnedFile(destination, receipt.platformIdentity);
}

export async function withV3ManifestNamespaceLease<T>(
  v3Root: string,
  action: () => Promise<T>,
): Promise<T> {
  const lease = await acquireV3ManifestNamespaceLease(v3Root);
  try {
    return await action();
  } finally {
    await removeExclusiveJsonInstall(lease);
  }
}

async function acquireV3ManifestNamespaceLease(
  v3Root: string,
): Promise<ExclusiveJsonInstallReceipt> {
  const directory = await inspectRealDirectory(v3Root, true);
  const destination = join(directory.realPath, V3_NAMESPACE_LEASE_FILENAME);
  const deadline = Date.now() + V3_NAMESPACE_LEASE_WAIT_MS;
  while (true) {
    await assertUnchangedDirectory(directory);
    let handle;
    try {
      handle = await open(destination, exclusiveLeaseOpenFlags(), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertSafeExistingLease(destination);
      if (Date.now() >= deadline) {
        throw new Error(
          `V3 deployment manifest namespace lease is held or stale; manual recovery required: ${destination}`,
        );
      }
      await delay(V3_NAMESPACE_LEASE_POLL_MS);
      continue;
    }
    try {
      const token = `${process.pid}:${randomUUID()}\n`;
      await handle.writeFile(token, "utf8");
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        throw new Error("V3 deployment manifest namespace lease is not a unique regular file");
      }
      const identity = stableFileIdentity(metadata, "V3 deployment manifest namespace lease");
      const current = await inspectRegularFile(destination, "V3 deployment manifest namespace lease");
      if (!sameStrictFileIdentity(identity, current)) {
        throw new Error("V3 deployment manifest namespace lease changed during acquisition");
      }
      const platformIdentity = await inspectPlatformFileIdentity(destination, 1n);
      const revalidated = await inspectRegularFile(
        destination,
        "V3 deployment manifest namespace lease",
      );
      if (!sameStrictFileIdentity(identity, revalidated)) {
        throw new Error("V3 deployment manifest namespace lease changed during acquisition");
      }
      return {
        directory: { ...directory },
        destination,
        identity,
        platformIdentity,
      };
    } finally {
      await handle.close();
    }
  }
}

async function assertSafeExistingLease(path: string): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `V3 deployment manifest namespace lease is unsafe; manual recovery required: ${path}`,
    );
  }
  stableFileIdentity(metadata, "V3 deployment manifest namespace lease");
}

async function assertOwnedExclusiveJsonInstall(
  receipt: ExclusiveJsonInstallReceipt,
): Promise<string> {
  const directory = await inspectRealDirectory(receipt.directory.path, false);
  if (
    directory.realPath !== receipt.directory.realPath ||
    !sameStrictFileIdentity(directory, receipt.directory)
  ) {
    throw new Error("exclusive manifest directory changed before owned-probe cleanup; manual recovery required");
  }
  if (!hasStableFileIdentity(receipt.identity)) {
    throw new Error("exclusive manifest probe has no stable filesystem identity; manual recovery required");
  }
  const destination = join(directory.realPath, basename(receipt.destination));
  if (destination !== receipt.destination) {
    throw new Error("exclusive manifest probe destination changed before cleanup; manual recovery required");
  }
  const current = await inspectRegularFile(destination, "owned exclusive manifest probe");
  if (!sameStrictFileIdentity(current, receipt.identity)) {
    throw new Error("exclusive manifest probe changed before cleanup; manual recovery required");
  }
  return destination;
}

async function assertExclusiveReceiptUnchanged(
  receipt: ExclusiveJsonInstallReceipt,
  expectedBytes: Buffer,
): Promise<void> {
  await assertUnchangedDirectory(receipt.directory);
  const current = await inspectRegularFile(receipt.destination, "exclusive manifest");
  if (!sameStrictFileIdentity(current, receipt.identity)) {
    throw new Error("exclusive manifest changed after post-install verification");
  }
  if (!samePlatformFileIdentity(
    await inspectPlatformFileIdentity(receipt.destination, 1n),
    receipt.platformIdentity,
  )) {
    throw new Error("exclusive manifest changed after post-install verification");
  }
  assertExpectedBytes(await readFile(receipt.destination), expectedBytes, "exclusive manifest");
}

async function inspectPlatformFileIdentity(
  path: string,
  expectedLinkCount: bigint,
): Promise<PlatformFileIdentity> {
  if (process.platform === "win32") {
    return { platform: "win32", value: await runWindowsFileHandleOperation(path) };
  }
  const handle = await open(path, noFollowReadFlags());
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== expectedLinkCount) {
      throw new Error("exclusive manifest does not have the expected regular-file link count");
    }
    const identity = stableFileIdentity(metadata, "exclusive manifest opened handle");
    const current = await lstat(path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== expectedLinkCount ||
      !sameStrictFileIdentity(identity, current)
    ) {
      throw new Error("exclusive manifest pathname changed during handle-bound inspection");
    }
    return { platform: "posix", ...identity };
  } finally {
    await handle.close();
  }
}

async function deletePlatformOwnedFile(
  path: string,
  expectedIdentity: PlatformFileIdentity,
): Promise<void> {
  if (expectedIdentity.platform === "win32") {
    if (process.platform !== "win32") {
      throw new Error("exclusive manifest receipt platform does not match the current host");
    }
    const actualIdentity = await runWindowsFileHandleOperation(path, expectedIdentity.value, true);
    if (actualIdentity !== expectedIdentity.value) {
      throw new Error("exclusive manifest probe changed before cleanup; manual recovery required");
    }
    return;
  }
  if (process.platform === "win32") {
    throw new Error("exclusive manifest receipt platform does not match the current host");
  }
  const handle = await open(path, noFollowReadFlags());
  try {
    const opened = await handle.stat({ bigint: true });
    const identity = stableFileIdentity(opened, "owned exclusive manifest probe");
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      identity.dev !== expectedIdentity.dev ||
      identity.ino !== expectedIdentity.ino
    ) {
      throw new Error("exclusive manifest probe changed before cleanup; manual recovery required");
    }
    const current = await lstat(path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameStrictFileIdentity(identity, current)
    ) {
      throw new Error("exclusive manifest probe changed before cleanup; manual recovery required");
    }
    await unlink(path);
    const after = await handle.stat({ bigint: true });
    if (!sameStrictFileIdentity(identity, after) || after.nlink !== 0n) {
      throw new Error("exclusive manifest probe cleanup did not unlink the owned file");
    }
    try {
      await lstat(path);
      throw new Error("exclusive manifest probe path remains after cleanup; manual recovery required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    await handle.close();
  }
}

async function runWindowsFileHandleOperation(
  path: string,
  expectedIdentity?: string,
  deleteFile = false,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_FILE_HANDLE_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          ACCESSSEAL_MANIFEST_PATH: toNamespacedPath(path),
          ACCESSSEAL_EXPECTED_FILE_ID: expectedIdentity ?? "NONE",
          ACCESSSEAL_DELETE_FILE: deleteFile ? "1" : "0",
        },
      },
    );
    const identity = stdout.trim();
    if (!/^[0-9a-f]{8}:[0-9a-f]{16}$/i.test(identity)) {
      throw new Error(identity === "MISMATCH"
        ? "exclusive manifest probe changed before cleanup; manual recovery required"
        : "Windows handle-bound filesystem identity primitive returned an invalid result");
    }
    return identity.toLowerCase();
  } catch (error) {
    if (error instanceof Error && /exclusive manifest probe changed before cleanup/i.test(error.message)) {
      throw error;
    }
    throw new Error(
      `Windows handle-bound filesystem operation failed; manual recovery required: ${errorMessage(error)}`,
    );
  }
}

async function inspectRealDirectory(path: string, create: boolean): Promise<DirectoryIdentity> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await lstat(current);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`deployment manifest directory ancestor must be a real directory, not a symbolic link or junction: ${current}`);
    }
  }
  const metadata = await lstat(absolute, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`deployment manifest directory ancestor must be a real directory, not a symbolic link or junction: ${absolute}`);
  }
  return {
    path: absolute,
    realPath: await realpath(absolute),
    dev: metadata.dev,
    ino: metadata.ino,
  };
}

async function assertUnchangedDirectory(directory: DirectoryIdentity): Promise<void> {
  const current = await inspectRealDirectory(directory.path, false);
  if (
    current.realPath !== directory.realPath ||
    current.dev !== directory.dev ||
    current.ino !== directory.ino
  ) {
    throw new Error("deployment manifest staging directory changed during installation");
  }
}

async function assertSafeExclusiveDestination(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`deployment manifest destination cannot be a symbolic link or junction: ${path}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`deployment manifest destination must be a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertExclusiveInstallation(
  directory: DirectoryIdentity,
  temporary: string,
  destination: string,
  expectedBytes: Buffer,
): Promise<FileIdentity> {
  await assertUnchangedDirectory(directory);
  const stageBeforeRead = await inspectRegularFile(temporary, "staging manifest");
  const finalBeforeRead = await inspectRegularFile(destination, "final manifest");
  assertMatchingIdentity(stageBeforeRead, finalBeforeRead, "staging and final manifests do not identify the same file");

  const [stageBytes, finalBytes] = await Promise.all([readFile(temporary), readFile(destination)]);
  assertExpectedBytes(stageBytes, expectedBytes, "staging manifest");
  assertExpectedBytes(finalBytes, expectedBytes, "final manifest");

  await assertUnchangedDirectory(directory);
  const stageAfterRead = await inspectRegularFile(temporary, "staging manifest");
  const finalAfterRead = await inspectRegularFile(destination, "final manifest");
  assertMatchingIdentity(stageBeforeRead, stageAfterRead, "staging manifest changed during post-install verification");
  assertMatchingIdentity(finalBeforeRead, finalAfterRead, "final manifest changed during post-install verification");
  assertMatchingIdentity(stageAfterRead, finalAfterRead, "staging and final manifests do not identify the same file");
  return finalAfterRead;
}

async function inspectRegularFile(path: string, label: string): Promise<FileIdentity> {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} is missing after exclusive installation`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} is not a regular file after exclusive installation`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertMatchingIdentity(
  first: FileIdentity,
  second: FileIdentity,
  message: string,
): void {
  if (!hasStableFileIdentity(first) || !hasStableFileIdentity(second)) return;
  if (first.dev !== second.dev || first.ino !== second.ino) throw new Error(message);
}

function hasStableFileIdentity(identity: FileIdentity): boolean {
  return identity.ino !== 0n;
}

function sameStrictFileIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return (
    hasStableFileIdentity(first) &&
    hasStableFileIdentity(second) &&
    first.dev === second.dev &&
    first.ino === second.ino
  );
}

function assertExpectedBytes(actual: Buffer, expected: Buffer, label: string): void {
  const actualHash = sourceHash(actual);
  const expectedHash = sourceHash(expected);
  if (!actual.equals(expected) || actualHash !== expectedHash) {
    throw new Error(`${label} does not contain the expected bytes after exclusive installation`);
  }
}

function stableFileIdentity(
  metadata: { dev: bigint; ino: bigint },
  label: string,
): FileIdentity {
  const identity = { dev: metadata.dev, ino: metadata.ino };
  if (!hasStableFileIdentity(identity)) {
    throw new Error(`${label} has no stable filesystem identity`);
  }
  return identity;
}

function samePlatformFileIdentity(
  first: PlatformFileIdentity,
  second: PlatformFileIdentity,
): boolean {
  if (first.platform !== second.platform) return false;
  return first.platform === "win32"
    ? first.value === (second as Extract<PlatformFileIdentity, { platform: "win32" }>).value
    : first.dev === (second as Extract<PlatformFileIdentity, { platform: "posix" }>).dev &&
        first.ino === (second as Extract<PlatformFileIdentity, { platform: "posix" }>).ino;
}

function exclusiveLeaseOpenFlags(): number {
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  return constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow;
}

function noFollowReadFlags(): number {
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW;
  if (process.platform !== "win32" && (typeof noFollow !== "number" || noFollow === 0)) {
    throw new Error("POSIX host does not expose O_NOFOLLOW; filesystem operation fails closed");
  }
  return constants.O_RDONLY | (noFollow ?? 0);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

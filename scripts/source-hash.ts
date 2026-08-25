import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

type DirectoryIdentity = {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
};

export type AtomicWriteJsonExclusiveOptions = {
  operations?: {
    link?: (existingPath: string, newPath: string) => Promise<void>;
    unlink?: (path: string) => Promise<void>;
    beforeLink?: () => Promise<void>;
  };
};

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
    const metadata = await lstat(current);
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
  options: AtomicWriteJsonExclusiveOptions = {},
): Promise<void> {
  const body = `${canonicalJson(value)}\n`;
  const directory = await inspectRealDirectory(dirname(path), true);
  const destination = join(directory.realPath, basename(resolve(path)));
  const temporary = join(
    directory.realPath,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const install = options.operations?.link ?? link;
  const remove = options.operations?.unlink ?? unlink;
  let installed = false;
  let installError: unknown;
  try {
    await assertSafeExclusiveDestination(destination);
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await options.operations?.beforeLink?.();
    await assertUnchangedDirectory(directory);
    await assertSafeExclusiveDestination(destination);
    await install(temporary, destination);
    installed = true;
  } catch (error) {
    installError = error;
  }
  try {
    await assertUnchangedDirectory(directory);
    await remove(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const phase = installed
        ? "final manifest installed but staging cleanup failed"
        : "manifest installation failed and staging cleanup failed";
      throw new Error(`${phase}; manual recovery required for ${temporary}: ${errorMessage(error)}`);
    }
  }
  if (installError) {
    throw installError;
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
  const metadata = await lstat(absolute);
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

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

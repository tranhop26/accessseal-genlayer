import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

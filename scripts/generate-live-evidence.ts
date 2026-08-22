import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  LIVE_EVIDENCE_BINDING,
  PAYLOAD_SPECS,
  buildReleaseManifest,
  type EvidencePayloads,
  type EvidenceType,
} from "./live-evidence-schema.ts";

const CAPTURE_FILES: Readonly<Record<EvidenceType, string>> = Object.freeze({
  HTML_BUNDLE: "release.html",
  SCREENSHOT: "screenshot.png",
  DOM_FACTS: "dom-facts.json",
  SCANNER_REPORT: "scanner-report.json",
  CRITICAL_FLOW_TRACE: "critical-flow-trace.json",
});
const MANIFEST_PATH = "/.well-known/accessseal/release-manifest.json";

type PlannedWrite = { path: string; bytes: Buffer };

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function safePublicRoot(publicDirectory: string): Promise<string> {
  const root = resolve(publicDirectory);
  const parsed = parse(root);
  let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await stat(current)) === undefined) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`public root ancestor must be a real directory, not a symbolic link or junction: ${current}`);
    }
  }
  return realpath(root);
}

async function assertSafeOutputPath(publicRoot: string, path: string, allowMultipleFinalLinks = false): Promise<void> {
  const destination = resolve(path);
  const child = relative(publicRoot, destination);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("unsafe evidence output path escapes the public root");
  }
  let current = publicRoot;
  const parts = child.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const currentStat = await stat(current);
    if (currentStat === undefined) break;
    if (currentStat.isSymbolicLink()) throw new Error(`unsafe symbolic link or junction in evidence output path: ${current}`);
    if (index < parts.length - 1 && !currentStat.isDirectory()) throw new Error(`evidence output parent is not a directory: ${current}`);
    if (index === parts.length - 1) {
      if (!currentStat.isFile()) throw new Error(`evidence output is not a regular file: ${current}`);
      if (!allowMultipleFinalLinks && currentStat.nlink !== 1) throw new Error(`unsafe evidence output has multiple hard links: ${current}`);
    }
  }
}

async function readPayloads(inputDirectory: string): Promise<EvidencePayloads> {
  return {
    HTML_BUNDLE: await readFile(join(inputDirectory, CAPTURE_FILES.HTML_BUNDLE)),
    SCREENSHOT: await readFile(join(inputDirectory, CAPTURE_FILES.SCREENSHOT)),
    DOM_FACTS: await readFile(join(inputDirectory, CAPTURE_FILES.DOM_FACTS)),
    SCANNER_REPORT: await readFile(join(inputDirectory, CAPTURE_FILES.SCANNER_REPORT)),
    CRITICAL_FLOW_TRACE: await readFile(join(inputDirectory, CAPTURE_FILES.CRITICAL_FLOW_TRACE)),
  };
}

async function rejectConflictingOutputs(publicRoot: string, writes: readonly PlannedWrite[]): Promise<void> {
  for (const write of writes) {
    await assertSafeOutputPath(publicRoot, write.path);
    if ((await stat(write.path)) === undefined) continue;
    const current = await readFile(write.path);
    if (!current.equals(write.bytes)) {
      throw new Error(`refusing to overwrite immutable evidence with different bytes: ${write.path}`);
    }
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

async function removeAbandonedStagingFiles(publicRoot: string, writes: readonly PlannedWrite[]): Promise<void> {
  for (const write of writes) {
    await assertSafeOutputPath(publicRoot, write.path, true);
    const directory = dirname(write.path);
    if ((await stat(directory)) === undefined) continue;
    const escapedName = basename(write.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\.${escapedName}\\.(\\d+)\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`, "i");
    for (const entry of await readdir(directory)) {
      const match = pattern.exec(entry);
      if (match === null || processIsRunning(Number(match[1]))) continue;
      const temporary = join(directory, entry);
      await assertSafeOutputPath(publicRoot, temporary, true);
      const temporaryStat = await lstat(temporary);
      if (temporaryStat.nlink !== 1) {
        const destinationStat = await stat(write.path);
        const sameInstalledFile = destinationStat !== undefined
          && destinationStat.dev === temporaryStat.dev
          && destinationStat.ino === temporaryStat.ino
          && Buffer.from(await readFile(temporary)).equals(write.bytes);
        if (!sameInstalledFile) throw new Error(`unsafe abandoned evidence staging hard link: ${temporary}`);
      }
      await unlink(temporary);
    }
  }
}

async function installFileAtomically(publicRoot: string, write: PlannedWrite): Promise<void> {
  await assertSafeOutputPath(publicRoot, write.path);
  const currentStat = await stat(write.path);
  if (currentStat !== undefined) {
    const current = await readFile(write.path);
    if (!current.equals(write.bytes)) throw new Error(`refusing to overwrite immutable evidence with different bytes: ${write.path}`);
    return;
  }

  const directory = dirname(write.path);
  await mkdir(directory, { recursive: true });
  await assertSafeOutputPath(publicRoot, write.path);
  const temporary = join(directory, `.${basename(write.path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(write.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, write.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertSafeOutputPath(publicRoot, write.path);
      const current = await readFile(write.path);
      if (!current.equals(write.bytes)) throw new Error(`refusing to overwrite immutable evidence with different bytes: ${write.path}`);
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function installMissingOutputs(publicRoot: string, writes: readonly PlannedWrite[]): Promise<void> {
  for (const write of writes) {
    await installFileAtomically(publicRoot, write);
  }
}

export async function generateLiveEvidenceBundle(inputDirectory: string, publicDirectory: string) {
  const payloads = await readPayloads(inputDirectory);
  const built = buildReleaseManifest(payloads);
  const publicRoot = await safePublicRoot(publicDirectory);
  const payloadWrites = (Object.entries(PAYLOAD_SPECS) as Array<[EvidenceType, (typeof PAYLOAD_SPECS)[EvidenceType]]>)
    .map(([evidenceType, spec]) => ({ path: join(publicRoot, spec.path.slice(1)), bytes: Buffer.from(payloads[evidenceType]) }));
  const manifestWrite = { path: join(publicRoot, MANIFEST_PATH.slice(1)), bytes: built.bytes };
  const writes = [...payloadWrites, manifestWrite];

  await removeAbandonedStagingFiles(publicRoot, writes);
  await rejectConflictingOutputs(publicRoot, writes);
  await installMissingOutputs(publicRoot, payloadWrites);
  await installMissingOutputs(publicRoot, [manifestWrite]);

  return {
    releaseId: LIVE_EVIDENCE_BINDING.releaseId,
    releaseDigest: built.releaseDigest,
    sourceCommit: LIVE_EVIDENCE_BINDING.sourceCommit,
    files: writes.map((write) => write.path),
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith("--")) throw new Error(`missing required argument ${name}`);
  return value;
}

async function main(): Promise<void> {
  const result = await generateLiveEvidenceBundle(argument("--input"), argument("--public"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/generate-live-evidence.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

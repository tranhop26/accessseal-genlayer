import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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

async function rejectConflictingOutputs(writes: readonly PlannedWrite[]): Promise<void> {
  for (const write of writes) {
    if (!(await exists(write.path))) continue;
    const current = await readFile(write.path);
    if (!current.equals(write.bytes)) {
      throw new Error(`refusing to overwrite immutable evidence with different bytes: ${write.path}`);
    }
  }
}

async function installMissingOutputs(writes: readonly PlannedWrite[]): Promise<void> {
  for (const write of writes) {
    if (await exists(write.path)) continue;
    await mkdir(dirname(write.path), { recursive: true });
    await writeFile(write.path, write.bytes, { flag: "wx" });
  }
}

export async function generateLiveEvidenceBundle(inputDirectory: string, publicDirectory: string) {
  const payloads = await readPayloads(inputDirectory);
  const built = buildReleaseManifest(payloads);
  const payloadWrites = (Object.entries(PAYLOAD_SPECS) as Array<[EvidenceType, (typeof PAYLOAD_SPECS)[EvidenceType]]>)
    .map(([evidenceType, spec]) => ({ path: join(publicDirectory, spec.path.slice(1)), bytes: Buffer.from(payloads[evidenceType]) }));
  const manifestWrite = { path: join(publicDirectory, MANIFEST_PATH.slice(1)), bytes: built.bytes };
  const writes = [...payloadWrites, manifestWrite];

  await rejectConflictingOutputs(writes);
  await installMissingOutputs(payloadWrites);
  await installMissingOutputs([manifestWrite]);

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

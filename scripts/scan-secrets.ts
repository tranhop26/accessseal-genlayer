import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SecretScanResult = { exitCode: 0 | 1; summary: string };

export async function scanRepositorySecrets(repoRoot = process.cwd()): Promise<SecretScanResult> {
  const root = resolve(repoRoot);
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const secrets = Object.entries(process.env)
    .filter(([key, value]) =>
      /(?:TOKEN|SECRET|PASSWORD|PRIVATE.*KEY|MNEMONIC)/i.test(key) &&
      typeof value === "string" && value.length >= 8,
    );
  for (const file of files) {
    const bytes = await readFile(join(root, file)).catch(() => Buffer.alloc(0));
    const text = bytes.toString("utf8");
    if (/-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/.test(text)) {
      return { exitCode: 1, summary: `${file} contains private-key material` };
    }
    for (const [key, value] of secrets) {
      if (text.includes(value as string)) {
        return { exitCode: 1, summary: `${file} contains environment secret value from ${key}` };
      }
    }
  }
  return { exitCode: 0, summary: "Secret-value scan: PASS" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  scanRepositorySecrets().then((result) => {
    (result.exitCode === 0 ? console.log : console.error)(result.summary);
    process.exitCode = result.exitCode;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "secret scan failed");
    process.exitCode = 1;
  });
}

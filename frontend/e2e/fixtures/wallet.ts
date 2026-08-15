import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { createAccount, createClient } from "genlayer-js";
import { localnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const projectRoot = resolve(import.meta.dirname, "../../..");
const rpcUrl = "http://127.0.0.1:4000/api";
const profileHash = `0x${"11".repeat(32)}`;
const subjectOrigin = "https://fixture.accessseal.test";
const screenshotBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const evidenceTypes = [
  "HTML_BUNDLE",
  "SCREENSHOT",
  "DOM_FACTS",
  "SCANNER_REPORT",
  "CRITICAL_FLOW_TRACE",
] as const;
const mediaTypes = {
  RELEASE_MANIFEST: "application/json",
  HTML_BUNDLE: "text/html",
  SCREENSHOT: "image/png",
  DOM_FACTS: "application/json",
  SCANNER_REPORT: "application/json",
  CRITICAL_FLOW_TRACE: "application/json",
} as const;
const paths = {
  HTML_BUNDLE: "/index.html",
  SCREENSHOT: "/evidence/checkout.png",
  DOM_FACTS: "/evidence/dom-facts.json",
  SCANNER_REPORT: "/evidence/scanner-report.json",
  CRITICAL_FLOW_TRACE: "/evidence/critical-flow-trace.json",
} as const;
const envelopeFields = [
  "action",
  "caseId",
  "chainId",
  "contract",
  "epoch",
  "evidenceType",
  "expiresAt",
  "issuer",
  "mediaType",
  "nonce",
  "observedAt",
  "payloadSha256",
  "payloadUri",
  "profileVersion",
  "releaseDigest",
  "schemaVersion",
  "subjectOrigin",
  "submittedAt",
] as const;

type Role = "buyer" | "vendor" | "reviewer" | "outsider";
type WalletMode = "ready" | "reject" | "wrong-network";
type Account = ReturnType<typeof createAccount>;
type EvidenceType = (typeof evidenceTypes)[number] | "RELEASE_MANIFEST";
type Envelope = Record<(typeof envelopeFields)[number], string | number>;

export type ReleaseFixture = {
  releaseDigest: `sha256:${string}`;
  envelopes: Envelope[];
  webMocks: Record<
    string,
    {
      status: number;
      headers: Record<string, string>;
      body?: string;
      bodyBase64?: string;
    }
  >;
  evidenceRefs: `sha256:${string}`[];
};

export type AccessSealRuntime = {
  baseURL: string;
  walletBridgeURL: string;
  contractAddress: `0x${string}`;
  addresses: Record<Role, `0x${string}`>;
  profileHash: string;
  subjectOrigin: string;
  escrow: string;
  connect(page: Page, role: Role): Promise<void>;
  selectRole(page: Page, role: Role): Promise<void>;
  setWalletMode(page: Page, mode: WalletMode): Promise<void>;
  beginTest(page: Page): Promise<void>;
  setReviewTime(page: Page): Promise<void>;
  prepareHardTimeout(page: Page, caseId: string): Promise<void>;
  buildRelease(caseId: string, options?: { epoch?: number; keyboardTrap?: boolean; supporting?: EvidenceType[] }): ReleaseFixture;
  installReview(release: ReleaseFixture, verdict: "APPROVED" | "REJECTED" | "UNRESOLVED", options?: { unavailableManifest?: boolean }): Promise<void>;
  resetValidatorTelemetry(): Promise<void>;
  readValidatorTelemetry(): Promise<ValidatorTelemetry>;
};

export type ValidatorTelemetry = {
  callbackInvocations: number;
  capturedValidatorSessions: number;
  consensusSessions: number;
};

export function requireValidatorTelemetry(telemetry: ValidatorTelemetry): void {
  if (
    telemetry.callbackInvocations !== 5 ||
    telemetry.capturedValidatorSessions !== 1 ||
    telemetry.consensusSessions !== 1
  )
    throw new Error(
      `validator callbacks missing or not bound to one consensus session: ${JSON.stringify(telemetry)}`,
    );
}

type WorkerFixtures = { runtime: AccessSealRuntime };
type TestFixtures = { accessSeal: AccessSealRuntime };

function sha(body: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function rpc<T = unknown>(method: string, params: unknown): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `${method} failed`);
  return payload.result as T;
}

async function waitFor(url: string, process?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process && process.exitCode !== null) throw new Error(`owned process exited before readiness: ${process.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`readiness deadline exceeded for ${url}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate loopback port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

async function stop(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill();
  await Promise.race([once(process, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
  if (process.exitCode === null && process.signalCode === null) {
    const exited = once(process, "exit");
    if (globalThis.process.platform === "win32" && process.pid) {
      const killer = spawn("taskkill", ["/pid", String(process.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await once(killer, "exit");
    } else process.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
    if (process.exitCode === null && process.signalCode === null)
      throw new Error("owned process did not exit after forced termination");
  }
}

async function waitForExit(process: ChildProcess, label: string): Promise<void> {
  const [code] = (await once(process, "exit")) as [number | null];
  if (code !== 0) throw new Error(`${label} exited with code ${String(code)}`);
}

function asBigInt(value: unknown): bigint | undefined {
  return typeof value === "string" ? BigInt(value) : undefined;
}

async function startWalletBridge(accounts: Record<Role, Account>): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        role: Role;
        method: string;
        params?: unknown[];
      };
      const account = accounts[input.role];
      if (!account) throw new Error("wallet signer role is unknown");
      if (input.method === "accessseal_handshake") {
        const selected = String(input.params?.[0] ?? "").toLowerCase();
        if (selected !== account.address.toLowerCase()) throw new Error("wallet signer binding mismatch");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ result: { role: input.role, address: account.address.toLowerCase() } }));
        return;
      }
      if (input.method !== "eth_sendTransaction") throw new Error("wallet bridge only signs transactions");
      const tx = (input.params?.[0] ?? {}) as Record<string, string>;
      if (tx.from?.toLowerCase() !== account.address.toLowerCase()) throw new Error("wallet signer binding mismatch");
      const serialized = await account.signTransaction({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: asBigInt(tx.value) ?? 0n,
        gas: asBigInt(tx.gas),
        gasPrice: asBigInt(tx.gasPrice),
        nonce: Number(BigInt(tx.nonce)),
        chainId: Number(BigInt(tx.chainId)),
        type: "legacy",
      });
      const result = await rpc<string>("eth_sendRawTransaction", [serialized]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "wallet bridge failure" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("wallet bridge did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function makeRelease(
  contractAddress: `0x${string}`,
  vendor: string,
  caseId: string,
  currentTimestamp: number,
  options: { epoch?: number; keyboardTrap?: boolean; supporting?: EvidenceType[] } = {},
): ReleaseFixture {
  const epoch = options.epoch ?? 0;
  const keyboardTrap = options.keyboardTrap ?? false;
  const supporting = options.supporting ?? [...evidenceTypes];
  const bodies: Record<(typeof evidenceTypes)[number], string | Buffer> = {
    HTML_BUNDLE: keyboardTrap
      ? '<main><button id="start">Start</button><div data-keyboard-trap="true">Blocked</div></main>'
      : '<main><label for="email">Email</label><input id="email"><button>Place order</button><p role="status">Ready</p></main>',
    SCREENSHOT: Buffer.from(screenshotBase64, "base64"),
    DOM_FACTS: stable({ focusObscured: false, forms: [{ control: "email", label: "Email" }], images: [{ alt: "Blue running shoe", src: "shoe.jpg" }] }),
    SCANNER_REPORT: stable({ engine: "fixture-scanner/1", score: keyboardTrap ? 70 : 100, violations: keyboardTrap ? ["keyboard-trap"] : [] }),
    CRITICAL_FLOW_TRACE: stable({ completed: !keyboardTrap, flow: "checkout", keyboardTrap, steps: keyboardTrap ? ["start", "blocked"] : ["email", "place-order", "status"] }),
  };
  const manifest = {
    schemaVersion: "accessseal-release-manifest/1",
    caseId,
    epoch,
    subjectOrigin,
    profileHash,
    files: evidenceTypes.map((evidenceType) => ({
      path: paths[evidenceType],
      evidenceType,
      mediaType: mediaTypes[evidenceType],
      sha256: sha(bodies[evidenceType]),
    })),
  };
  const manifestBody = stable(manifest);
  const releaseDigest = sha(manifestBody);
  const submittedAt = currentTimestamp - 2;
  const base = {
    schemaVersion: "accessseal-evidence/1",
    chainId: "61127",
    contract: contractAddress,
    caseId,
    epoch,
    subjectOrigin,
    profileVersion: "accessseal-static/1",
    releaseDigest,
    issuer: vendor,
    observedAt: submittedAt - 10,
    submittedAt,
    expiresAt: submittedAt + 200_000,
  };
  const envelope = (evidenceType: EvidenceType, index: number): Envelope => ({
    ...base,
    action: evidenceType === "RELEASE_MANIFEST" ? "OPEN_RELEASE" : "APPEND_EVIDENCE",
    evidenceType,
    payloadUri: `${subjectOrigin}${evidenceType === "RELEASE_MANIFEST" ? "/.well-known/accessseal/release-manifest.json" : paths[evidenceType]}`,
    payloadSha256: evidenceType === "RELEASE_MANIFEST" ? releaseDigest : sha(bodies[evidenceType]),
    mediaType: mediaTypes[evidenceType],
    nonce: `browser-epoch-${epoch}-${index}`,
  });
  const envelopes = [envelope("RELEASE_MANIFEST", 0), ...supporting.map((kind, index) => envelope(kind, index + 1))];
  const evidenceRefs = envelopes.map((item) => {
    const canonical = JSON.stringify(Object.fromEntries(envelopeFields.map((field) => [field, item[field]])));
    return sha(canonical);
  });
  const webMocks: ReleaseFixture["webMocks"] = {
    [`${subjectOrigin}/.well-known/accessseal/release-manifest.json`]: { status: 200, headers: { "content-type": "application/json" }, body: manifestBody },
  };
  for (const kind of evidenceTypes)
    webMocks[`${subjectOrigin}${paths[kind]}`] = {
      status: 200,
      headers: { "content-type": mediaTypes[kind] },
      ...(kind === "SCREENSHOT"
        ? { bodyBase64: screenshotBase64 }
        : { body: bodies[kind] as string }),
    };
  return { releaseDigest, envelopes, webMocks, evidenceRefs };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  runtime: [async ({}, provide) => {
    let glsim: ChildProcess | undefined;
    let next: ChildProcess | undefined;
    let bridge: Server | undefined;
    try {
      try {
        await rpc("ping", []);
        throw new Error("GLSim port 4000 is occupied; Task 11 refuses to reuse an unowned process");
      } catch (error) {
        if (error instanceof Error && error.message.includes("refuses to reuse")) throw error;
      }
      const sessionId = randomUUID().replaceAll("-", "");
      glsim = spawn("python", ["scripts/run-glsim-integration.py"], {
        cwd: projectRoot,
        env: { ...process.env, ACCESSSEAL_GLSIM_SESSION_ID: sessionId },
        stdio: "ignore",
        windowsHide: true,
      });
      {
        const deadline = Date.now() + 20_000;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            await rpc("ping", []);
            ready = true;
            break;
          } catch {}
          if (glsim.exitCode !== null) throw new Error("owned GLSim exited before readiness");
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        }
        if (!ready) throw new Error("GLSim readiness deadline exceeded");
      }
      const fingerprint = await rpc<{ sessionId: string; validators: number; chainId: number }>(
        "accessseal_getFingerprint",
        [],
      );
      if (fingerprint.sessionId !== sessionId || fingerprint.validators !== 5 || fingerprint.chainId !== 61127)
        throw new Error("owned GLSim fingerprint mismatch");
      const accounts = {
        buyer: createAccount(),
        vendor: createAccount(),
        reviewer: createAccount(),
        outsider: createAccount(),
      };
      for (const account of Object.values(accounts)) await rpc("sim_fundAccount", [account.address, "1000000000000000000"]);
      const initialTimestamp = Math.floor(Date.now() / 1000) - 86_420;
      let currentTimestamp = initialTimestamp;
      let activeCaseTimestamp = initialTimestamp;
      let nextCaseTimestamp = initialTimestamp;
      const initialTime = new Date(currentTimestamp * 1000).toISOString();
      await rpc("sim_setTime", [initialTime]);
      const deployment = await rpc<{ contract_address: string }>("sim_deploy", {
        code_path: resolve(projectRoot, "contracts/access_seal.py"),
        sender: accounts.buyer.address,
      });
      const contractAddress = String(deployment.contract_address).toLowerCase() as `0x${string}`;
      const walletBridge = await startWalletBridge(accounts);
      bridge = walletBridge.server;
      const port = await freePort();
      const frontendEnv = {
        ...process.env,
        NEXT_PUBLIC_GENLAYER_NETWORK: "localnet",
        NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: contractAddress,
      };
      const build = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
        cwd: resolve(projectRoot, "frontend"),
        env: frontendEnv,
        stdio: "ignore",
        windowsHide: true,
      });
      await waitForExit(build, "Next production build");
      next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: resolve(projectRoot, "frontend"),
        env: frontendEnv,
        stdio: "ignore",
        windowsHide: true,
      });
      const baseURL = `http://127.0.0.1:${port}`;
      await waitFor(baseURL, next);
      const addresses = Object.fromEntries(Object.entries(accounts).map(([role, account]) => [role, account.address.toLowerCase()])) as Record<Role, `0x${string}`>;
      const runtime: AccessSealRuntime = {
        baseURL,
        walletBridgeURL: walletBridge.url,
        contractAddress,
        addresses,
        profileHash,
        subjectOrigin,
        escrow: "50000",
        async beginTest(page) {
          activeCaseTimestamp = nextCaseTimestamp;
          nextCaseTimestamp += 700_000;
          currentTimestamp = activeCaseTimestamp;
          await rpc("sim_setTime", [new Date(currentTimestamp * 1000).toISOString()]);
          await page.clock.setFixedTime(currentTimestamp * 1000);
        },
        async connect(page, role) {
          const connected = page.getByRole("button", {
            name: new RegExp(`disconnect wallet ${addresses[role]}`, "i"),
          });
          if (!(await connected.isVisible()))
            await page.getByRole("button", { name: /connect wallet|switch network/i }).click();
          await expect(connected).toBeVisible();
          await expect(page.locator('[data-wallet-status="connected"]')).toHaveAttribute(
            "data-wallet-address",
            addresses[role],
          );
          await expect(page.locator('[data-wallet-status="connected"]')).toHaveAttribute(
            "data-wallet-network",
            "localnet",
          );
          await expect
            .poll(() =>
              page.evaluate(async ({ expectedRole, expectedAddress }) => {
                const wallet = (window as unknown as {
                  __accessSealWallet: {
                    getState(): { role: Role; address: string; chainId: string; inFlight: number };
                    verifySignerBinding(role: Role, address: string): Promise<{ role: Role; address: string }>;
                  };
                }).__accessSealWallet;
                const state = wallet.getState();
                if (
                  state.role !== expectedRole ||
                  state.address !== expectedAddress ||
                  state.chainId !== "0xeec7" ||
                  state.inFlight !== 0
                )
                  return false;
                const signer = await wallet.verifySignerBinding(expectedRole, expectedAddress);
                return signer.role === expectedRole && signer.address === expectedAddress;
              }, { expectedRole: role, expectedAddress: addresses[role] }),
            )
            .toBe(true);
        },
        async selectRole(page, role) {
          const connected = page.getByRole("button", {
            name: new RegExp(`disconnect wallet ${addresses[role]}`, "i"),
          });
          const providerAligned = async () =>
            page.evaluate(({ expectedRole, expectedAddress }) => {
              const state = (window as unknown as {
                __accessSealWallet: { getState(): { role: Role; address: string; chainId: string; inFlight: number } };
              }).__accessSealWallet.getState();
              return (
                state.role === expectedRole &&
                state.address === expectedAddress &&
                state.chainId === "0xeec7" &&
                state.inFlight === 0
              );
            }, { expectedRole: role, expectedAddress: addresses[role] });
          if (await connected.isVisible()) {
            await expect.poll(providerAligned).toBe(true);
            return;
          }
          await expect
            .poll(() =>
              page.evaluate(() =>
                (window as unknown as {
                  __accessSealWallet: { getState(): { inFlight: number } };
                }).__accessSealWallet.getState().inFlight,
              ),
            )
            .toBe(0);
          await page.evaluate(
             (nextRole) =>
               (window as unknown as { __accessSealWallet: { selectRole(role: Role): void } }).__accessSealWallet.selectRole(
                 nextRole,
               ),
             role,
           );
          await expect.poll(providerAligned).toBe(true);
          await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
        },
        async setWalletMode(page, mode) {
           await page.evaluate(
             (nextMode) =>
               (window as unknown as { __accessSealWallet: { setMode(mode: WalletMode): void } }).__accessSealWallet.setMode(
                 nextMode,
               ),
             mode,
           );
        },
        async setReviewTime(page) {
          currentTimestamp = activeCaseTimestamp + 172_800;
          await rpc("sim_setTime", [new Date(currentTimestamp * 1000).toISOString()]);
          await page.clock.setFixedTime(currentTimestamp * 1000);
        },
        async prepareHardTimeout(page, caseId) {
          const advanced = await rpc<{ effective_datetime: string }>(
            "sim_increaseTime",
            [604_801],
          );
          currentTimestamp = Math.floor(
            Date.parse(advanced.effective_datetime) / 1000,
          );
          if (!Number.isSafeInteger(currentTimestamp))
            throw new Error("simulator timeout clock is invalid");
          await page.clock.setFixedTime(currentTimestamp * 1000);
          const client = createClient({
            chain: localnet,
            endpoint: rpcUrl,
            account: accounts.outsider,
          });
          const hash = await client.writeContract({
            address: contractAddress,
            functionName: "timeout_refund",
            args: [caseId],
            value: 0n,
          });
          const receipt = await client.waitForTransactionReceipt({
            hash,
            status: TransactionStatus.FINALIZED,
          });
          const status =
            receipt.statusName ??
            (receipt as unknown as { status_name?: string }).status_name;
          if (
            status !== "FINALIZED" ||
            receipt.txExecutionResultName !== "FINISHED_WITH_RETURN"
          )
            throw new Error("hard-timeout fixture did not finalize successfully");
        },
        buildRelease(caseId, options) {
          return makeRelease(contractAddress, addresses.vendor, caseId, currentTimestamp, options);
        },
        async installReview(release, verdict, options = {}) {
          const webMocks = structuredClone(release.webMocks);
          if (options.unavailableManifest)
            webMocks[`${subjectOrigin}/.well-known/accessseal/release-manifest.json`]!.status = 503;
          const blockers = verdict === "REJECTED" ? ["keyboard-trap"] : [];
          const candidate = {
            schemaVersion: "accessseal-review/1",
            verdict,
            releaseDigest: release.releaseDigest,
            profileHash,
            materialBlockers: blockers,
            missingEvidence: [],
            evidenceRefs: release.evidenceRefs,
            rationale: blockers.length ? "Bound critical flow contains a keyboard trap." : "Bound artifacts establish no material accessibility blocker.",
          };
          await rpc("sim_installMocks", {
            web_mocks: webMocks,
            llm_mocks: { "[\\s\\S]*": JSON.stringify(candidate) },
            strict: true,
          });
        },
        async resetValidatorTelemetry() {
          await rpc("accessseal_resetValidatorTelemetry", []);
        },
        async readValidatorTelemetry() {
          return rpc<ValidatorTelemetry>("accessseal_getValidatorTelemetry", []);
        },
      };
       await provide(runtime);
    } finally {
      if (bridge) await new Promise<void>((resolvePromise) => bridge!.close(() => resolvePromise()));
      await stop(next);
      await stop(glsim);
    }
  }, { scope: "worker" }],
  accessSeal: async ({ runtime, page }, provide) => {
    await runtime.beginTest(page);
    await page.addInitScript(({ bridgeUrl, addresses }) => {
      let role: Role = "buyer";
      let mode = "ready";
      let inFlight = 0;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const emit = (event: string, value?: unknown) => listeners.get(event)?.forEach((listener) => listener(value));
      const provider = {
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
          const requestRole = role;
          inFlight += 1;
          try {
            if (method === "eth_requestAccounts") {
              if (mode === "reject") throw Object.assign(new Error("User rejected request"), { code: 4001 });
              return [addresses[requestRole]];
            }
            if (method === "eth_accounts") return [addresses[requestRole]];
            if (method === "eth_chainId") return mode === "wrong-network" ? "0x1" : "0xeec7";
            if (method === "wallet_addEthereumChain" || method === "wallet_switchEthereumChain") {
              if (mode === "wrong-network") throw new Error("wallet chain mismatch");
              return null;
            }
            if (method === "wallet_getSnaps") return {};
            if (method === "wallet_requestSnaps") return { "npm:genlayer-wallet-plugin": { id: "npm:genlayer-wallet-plugin" } };
            if (method === "eth_sendTransaction") {
              if (mode === "reject") throw Object.assign(new Error("User rejected transaction"), { code: 4001 });
              const response = await fetch(bridgeUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ role: requestRole, method, params }),
              });
              const payload = await response.json();
              if (!response.ok) throw new Error(payload.error ?? "wallet signing failed");
              return payload.result;
            }
            throw new Error(`unsupported browser wallet method: ${method}`);
          } finally {
            inFlight -= 1;
          }
        },
        on(event: string, listener: (...args: unknown[]) => void) {
          const entries = listeners.get(event) ?? new Set();
          entries.add(listener);
          listeners.set(event, entries);
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
        },
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
      Object.defineProperty(window, "__accessSealWallet", {
        value: {
          selectRole(nextRole: Role) {
            if (inFlight !== 0) throw new Error("wallet role switch attempted during an active provider request");
            role = nextRole;
            emit("accountsChanged", [addresses[role]]);
          },
          getState() {
            return {
              role,
              address: addresses[role],
              chainId: mode === "wrong-network" ? "0x1" : "0xeec7",
              inFlight,
            };
          },
          async verifySignerBinding(expectedRole: Role, expectedAddress: string) {
            const response = await fetch(bridgeUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                role: expectedRole,
                method: "accessseal_handshake",
                params: [expectedAddress],
              }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error ?? "wallet signer handshake failed");
            return payload.result;
          },
          setMode(nextMode: WalletMode) {
            const previousMode = mode;
            mode = nextMode;
            if (previousMode === "wrong-network" || mode === "wrong-network")
              emit("chainChanged", mode === "wrong-network" ? "0x1" : "0xeec7");
          },
        },
      });
    }, { bridgeUrl: runtime.walletBridgeURL, addresses: runtime.addresses });
    await provide(runtime);
  },
});

export { expect };

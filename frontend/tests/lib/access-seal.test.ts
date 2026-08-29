import { describe, expect, it, vi } from "vitest";
import { abi } from "genlayer-js";
import {
  AccessSealClient,
  deriveCaseBindings,
  hasAuthoritativeEvidenceSeal,
  matchesExactUserError,
  parsePendingCloseEvidenceBinding,
  parseReviewTxBinding,
  validatePendingCloseEvidenceBinding,
  validateReviewTxBinding,
} from "@/lib/access-seal";

const address = "0x1234567890abcdef1234567890abcdef12345678" as const;
const buyer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const vendor = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const digest = `0x${"c".repeat(64)}`;
type TestCalldataValue =
  | string
  | TestCalldataValue[]
  | Map<string, TestCalldataValue>;
const caseJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    buyer,
    caseId: `0x${"d".repeat(64)}`,
    chainId: 61999,
    contractAddress: address,
    createdAt: 1_701_230_000,
    escrowAmount: "1000000000000000000",
    evidenceDeadline: 86400,
    evidenceCutoff: 1_701_316_400,
    evidenceSealed: false,
    evidenceSealedAt: 0,
    evidenceSealedBy: `0x${"0".repeat(40)}`,
    flowsHash: digest,
    hardDeadline: 604800,
    lifecycle: "DRAFT",
    epoch: 0,
    maxUnresolvedRetries: 2,
    profileHash: digest,
    reserved: "0",
    readAt: 1_701_234_568,
    salt: "salt-1",
    subjectOrigin: "https://product.example",
    termsHash: digest,
    vendor,
    vendorAccepted: false,
    ...overrides,
  });

const legacyV2CaseJson = (overrides: Record<string, unknown> = {}) => {
  const value = JSON.parse(caseJson(overrides)) as Record<string, unknown>;
  for (const key of [
    "createdAt",
    "evidenceCutoff",
    "evidenceSealed",
    "evidenceSealedAt",
    "evidenceSealedBy",
    "readAt",
  ])
    delete value[key];
  return JSON.stringify(value);
};

async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function v4ReviewContext(caseId = `0x${"d".repeat(64)}`) {
  const contextJson = JSON.stringify({
    schemaVersion: "accessseal-review-context/1",
    binding: {
      chainId: 61999,
      contractAddress: address,
      caseId,
      epoch: 0,
      profileHash: digest,
      releaseDigest: `sha256:${"a".repeat(64)}`,
      subjectOrigin: "https://product.example",
    },
    evidence: [],
    dom: { pages: [] },
    scanner: { tool: "scanner", scans: [] },
    criticalFlows: { flowsHash: digest, flows: [], materialBlockers: {} },
    screenshot: {
      uri: "https://product.example/screenshot.png",
      sha256: `sha256:${"b".repeat(64)}`,
      mediaType: "image/png",
      byteLength: 8,
    },
    observedAt: 1,
    expiresAt: 2,
  });
  return {
    caseId,
    epoch: 0,
    schemaVersion: "accessseal-review-context/1",
    ready: true,
    contextJson,
    contextHash: await sha256(contextJson),
    imageUri: "https://product.example/screenshot.png",
    imageSha256: `sha256:${"b".repeat(64)}`,
  };
}

describe("AccessSeal contract adapter", () => {
  it("accepts an exact bound V4 review context", async () => {
    const context = await v4ReviewContext();
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "get_case" ? caseJson({
        reviewContextReady: true,
        reviewContextHash: context.contextHash,
      }) : JSON.stringify(context),
    );
    const client = new AccessSealClient({ readContract } as never, address);

    const result = await client.readReviewContext(`0x${"d".repeat(64)}`, 0);

    expect(result.ready).toBe(true);
    expect(result.schemaVersion).toBe("accessseal-review-context/1");
    expect(result.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(new TextEncoder().encode(result.contextJson).byteLength).toBeLessThanOrEqual(16_384);
  });

  it("rejects a ready context whose parsed binding disagrees", async () => {
    const context = await v4ReviewContext();
    const tampered = JSON.parse(context.contextJson) as Record<string, unknown>;
    (tampered.binding as Record<string, unknown>).caseId = `0x${"e".repeat(64)}`;
    const contextJson = JSON.stringify(tampered);
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "get_case" ? caseJson({
        reviewContextReady: true,
        reviewContextHash: await sha256(contextJson),
      }) : JSON.stringify({ ...context, contextJson, contextHash: await sha256(contextJson) }),
    );
    const client = new AccessSealClient({ readContract } as never, address);

    await expect(client.readReviewContext(`0x${"d".repeat(64)}`, 0)).rejects.toThrow(
      "Review context binding is invalid.",
    );
  });

  it("rejects review contexts with malicious extra fields or ready=false", async () => {
    const context = await v4ReviewContext();
    for (const malformed of [
      { ...context, injected: true },
      { ...context, ready: false },
    ]) {
      const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "get_case"
          ? caseJson({
              reviewContextReady: true,
              reviewContextHash: context.contextHash,
            })
          : JSON.stringify(malformed),
      );
      const client = new AccessSealClient({ readContract } as never, address);
      await expect(
        client.readReviewContext(`0x${"d".repeat(64)}`, 0),
      ).rejects.toThrow(/schema|binding/i);
    }
  });

  it("enforces the UTF-8 review-context limit at the Unicode byte boundary", async () => {
    const original = await v4ReviewContext();
    const parsed = JSON.parse(original.contextJson) as Record<string, unknown>;
    const base = (payload: string) =>
      JSON.stringify({ ...parsed, dom: { pages: [`${"😀".repeat(64)}${payload}`] } });
    const target = 16_384;
    const exactContextJson = base(
      "x".repeat(target - new TextEncoder().encode(base("")).byteLength),
    );
    expect(new TextEncoder().encode(exactContextJson).byteLength).toBe(target);
    for (const [contextJson, expected] of [
      [exactContextJson, true],
      [
        base(
          "x".repeat(
            target + 1 - new TextEncoder().encode(base("")).byteLength,
          ),
        ),
        false,
      ],
    ] as const) {
      const context = {
        ...original,
        contextJson,
        contextHash: await sha256(contextJson),
      };
      const client = new AccessSealClient(
        {
          readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
            functionName === "get_case"
              ? caseJson({
                  reviewContextReady: true,
                  reviewContextHash: context.contextHash,
                })
              : JSON.stringify(context),
          ),
        } as never,
        address,
      );
      const outcome = client.readReviewContext(`0x${"d".repeat(64)}`, 0);
      if (expected) await expect(outcome).resolves.toMatchObject({ contextJson });
      else await expect(outcome).rejects.toThrow("Review context binding is invalid.");
    }
  });

  it("rejects unavailable browser crypto and unsafe numeric or string review-context representations", async () => {
    const context = await v4ReviewContext();
    const makeClient = (value: Record<string, unknown>) =>
      new AccessSealClient(
        {
          readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
            functionName === "get_case"
              ? caseJson({
                  reviewContextReady: true,
                  reviewContextHash: context.contextHash,
                })
              : JSON.stringify(value),
          ),
        } as never,
        address,
      );
    await expect(
      makeClient({ ...context, epoch: "0" }).readReviewContext(
        `0x${"d".repeat(64)}`,
        0,
      ),
    ).rejects.toThrow(/counter/i);
    await expect(
      makeClient({ ...context, epoch: 9_007_199_254_740_992 }).readReviewContext(
        `0x${"d".repeat(64)}`,
        0,
      ),
    ).rejects.toThrow(/counter/i);
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    await expect(
      makeClient(context).readReviewContext(`0x${"d".repeat(64)}`, 0),
    ).rejects.toThrow("Browser SHA-256 is unavailable");
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  });
  it("requires an exact epoch-bound pending seal record and rejects legacy unbound records", () => {
    const binding = {
      action: "close_evidence" as const,
      account: buyer as `0x${string}`,
      caseId: `0x${"d".repeat(64)}`,
      chainId: 61999,
      contract: address,
      epoch: 2,
      hash: `0x${"e".repeat(64)}` as `0x${string}`,
    };

    const parsed = parsePendingCloseEvidenceBinding(JSON.stringify(binding));
    expect(parsed).toEqual(binding);
    expect(
      parsePendingCloseEvidenceBinding(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(binding).filter(([key]) => key !== "epoch"),
          ),
        ),
      ),
    ).toBeNull();
    expect(
      parsePendingCloseEvidenceBinding(
        JSON.stringify({ ...binding, epoch: -1 }),
      ),
    ).toBeNull();
    expect(
      parsePendingCloseEvidenceBinding(
        JSON.stringify({ ...binding, epoch: 1.5 }),
      ),
    ).toBeNull();
    expect(
      validatePendingCloseEvidenceBinding(parsed, {
        account: binding.account,
        caseId: binding.caseId,
        chainId: binding.chainId,
        contract: binding.contract,
        epoch: 2,
      }),
    ).toBe(true);
    expect(
      validatePendingCloseEvidenceBinding(parsed, {
        account: binding.account,
        caseId: binding.caseId,
        chainId: binding.chainId,
        contract: binding.contract,
        epoch: 3,
      }),
    ).toBe(false);
  });

  it("uses exact finalized read method names and argument order", async () => {
    const readContract = vi.fn().mockResolvedValue(caseJson());
    const client = new AccessSealClient({ readContract } as never, address);
    await client.readCase(`0x${"d".repeat(64)}`);
    expect(readContract).toHaveBeenCalledWith({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      functionName: "get_case",
      args: [`0x${"d".repeat(64)}`],
      transactionHashVariant: "latest-final",
    });
  });

  it("parses the V3 evidence seal readback and submits the exact close method", async () => {
    const readContract = vi.fn().mockResolvedValue(
      caseJson({
        evidenceSealed: true,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: buyer,
        lifecycle: "EVIDENCE_SEALED",
      }),
    );
    const writeContract = vi.fn().mockResolvedValue(`0x${"e".repeat(64)}`);
    const client = new AccessSealClient(
      { connect: vi.fn(), readContract, writeContract } as never,
      address,
      "studionet",
    );

    await expect(client.readCase(`0x${"d".repeat(64)}`)).resolves.toMatchObject(
      {
        evidenceSealed: true,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: buyer,
        lifecycle: "EVIDENCE_SEALED",
      },
    );
    await client.closeEvidence("case-1");

    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "close_evidence",
        args: ["case-1"],
      }),
    );
  });

  it("keeps an authoritative buyer seal historical after the lifecycle advances", () => {
    const base = JSON.parse(
      caseJson({
        lifecycle: "DECIDED",
        evidenceSealed: true,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: buyer,
      }),
    );

    expect(hasAuthoritativeEvidenceSeal(base)).toBe(true);
  });

  it("strictly binds V3 createdAt, absolute cutoff, and authoritative read time", async () => {
    const client = new AccessSealClient(
      { readContract: vi.fn().mockResolvedValue(caseJson()) } as never,
      address,
    );
    await expect(client.readCase(`0x${"d".repeat(64)}`)).resolves.toMatchObject({
      createdAt: 1_701_230_000,
      evidenceCutoff: 1_701_316_400,
      readAt: 1_701_234_568,
    });

    for (const mutation of [
      { evidenceCutoff: 1_701_316_399 },
      { createdAt: 1_701_316_401 },
      { readAt: 1_701_229_999 },
      { readAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const invalid = new AccessSealClient(
        {
          readContract: vi.fn().mockResolvedValue(caseJson(mutation)),
        } as never,
        address,
      );
      await expect(invalid.readCase(`0x${"d".repeat(64)}`)).rejects.toThrow(
        /cutoff|clock|counter|binding/i,
      );
    }
  });

  it.each([
    [
      "requires the sealed flag for EVIDENCE_SEALED",
      {
        lifecycle: "EVIDENCE_SEALED",
        evidenceSealed: false,
        evidenceSealedAt: 0,
        evidenceSealedBy: `0x${"0".repeat(40)}`,
      },
    ],
    [
      "rejects a sealed flag without a timestamp",
      {
        lifecycle: "EVIDENCE_SEALED",
        evidenceSealed: true,
        evidenceSealedAt: 0,
        evidenceSealedBy: buyer,
      },
    ],
    [
      "rejects a sealed flag without a sealing account",
      {
        lifecycle: "EVIDENCE_SEALED",
        evidenceSealed: true,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: `0x${"0".repeat(40)}`,
      },
    ],
    [
      "rejects a seal attributed to someone other than the buyer",
      {
        lifecycle: "EVIDENCE_SEALED",
        evidenceSealed: true,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: vendor,
      },
    ],
    [
      "rejects unsealed state with a sealing timestamp",
      {
        lifecycle: "EVIDENCE_OPEN",
        evidenceSealed: false,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: `0x${"0".repeat(40)}`,
      },
    ],
    [
      "rejects unsealed state with a sealing account",
      {
        lifecycle: "EVIDENCE_OPEN",
        evidenceSealed: false,
        evidenceSealedAt: 0,
        evidenceSealedBy: buyer,
      },
    ],
    [
      "rejects a sealed tuple while evidence remains open",
      {
        lifecycle: "EVIDENCE_OPEN",
        evidenceSealed: true,
        evidenceSealedAt: 1_701_234_567,
        evidenceSealedBy: buyer,
      },
    ],
  ])("%s", async (_name, overrides) => {
    const client = new AccessSealClient(
      { readContract: vi.fn().mockResolvedValue(caseJson(overrides)) } as never,
      address,
    );

    await expect(client.readCase(`0x${"d".repeat(64)}`)).rejects.toThrow(
      /seal/i,
    );
  });

  it.each(["REVIEW_PENDING", "CANCELLED"])(
    "parses the exact legacy V2 %s case schema with unavailable cutoff metadata",
    async (lifecycle) => {
      const client = new AccessSealClient(
        {
          readContract: vi
            .fn()
            .mockResolvedValue(legacyV2CaseJson({ lifecycle })),
        } as never,
        address,
      );

      await expect(
        client.readCase(`0x${"d".repeat(64)}`),
      ).resolves.toMatchObject({
        lifecycle,
        evidenceSealed: false,
        createdAt: null,
        evidenceCutoff: null,
        readAt: null,
      });
    },
  );

  it("parses u256 tokens above 2^53 without losing a wei and rejects already-parsed readbacks", async () => {
    const valid = new AccessSealClient(
      { readContract: vi.fn().mockResolvedValue(caseJson()) } as never,
      address,
    );
    await expect(valid.readCase(`0x${"d".repeat(64)}`)).resolves.toMatchObject({
      escrowAmount: 1000000000000000000n,
      reserved: 0n,
    });
    const bare = new AccessSealClient(
      {
        readContract: vi
          .fn()
          .mockResolvedValue(caseJson({ escrowAmount: 1000000000000000000 })),
      } as never,
      address,
    );
    await expect(bare.readCase(`0x${"d".repeat(64)}`)).resolves.toMatchObject({
      escrowAmount: 1000000000000000000n,
    });
    const unsafeObject = new AccessSealClient(
      {
        readContract: vi
          .fn()
          .mockResolvedValue({ escrowAmount: 1000000000000000000 }),
      } as never,
      address,
    );
    await expect(unsafeObject.readCase(`0x${"d".repeat(64)}`)).rejects.toThrow(
      /not JSON text/i,
    );
  });

  it("rejects exact-schema and binding mismatches", async () => {
    const client = new AccessSealClient(
      {
        readContract: vi.fn().mockResolvedValue(caseJson({ extra: true })),
      } as never,
      address,
    );
    await expect(client.readCase(`0x${"d".repeat(64)}`)).rejects.toThrow(
      /schema/i,
    );
    const wrongId = new AccessSealClient(
      { readContract: vi.fn().mockResolvedValue(caseJson()) } as never,
      address,
    );
    await expect(wrongId.readCase(`0x${"e".repeat(64)}`)).rejects.toThrow(
      /binding/i,
    );
  });

  it("derives the exact case, flow, and terms hashes before signature", async () => {
    await expect(
      deriveCaseBindings({
        buyer,
        chainId: 61999,
        contractAddress: address,
        salt: "salt-1",
        vendor,
        profileHash: digest,
        flows: ["Keyboard checkout", "Screen reader signup", "Zoom recovery"],
        subjectOrigin: "https://product.example",
        evidenceDeadline: 86400,
        hardDeadline: 604800,
        maxUnresolvedRetries: 2,
        escrowAmount: 1000000000000000000n,
      }),
    ).resolves.toMatchObject({
      caseId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      flowsHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      termsHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  });

  it("rejects raw, stale, wrong-case appeal history and verifies decoded review calldata", async () => {
    const txId = `0x${"f".repeat(64)}` as const;
    const caseId = `0x${"d".repeat(64)}`;
    expect(parseReviewTxBinding(txId)).toBeNull();
    const binding = {
      txId,
      chainId: 61999,
      network: "studionet" as const,
      contract: address,
      method: "request_review" as const,
      caseId,
      epoch: 1,
      releaseDigest: `sha256:${"a".repeat(64)}`,
      proofId: "proof-1",
    };
    expect(validateReviewTxBinding(binding, { ...binding, epoch: 2 })).toBe(
      false,
    );
    const client = new AccessSealClient(
      {
        getTransaction: vi.fn().mockResolvedValue({
          to_address: address,
          txDataDecoded: {
            type: "call",
            callData: new Map<string, unknown>([
              ["method", "request_review"],
              ["args", [caseId]],
            ]),
          },
        }),
      } as never,
      address,
    );
    await expect(client.verifyReviewTransaction(txId, caseId)).resolves.toBe(
      true,
    );
    await expect(
      client.verifyReviewTransaction(txId, `0x${"e".repeat(64)}`),
    ).resolves.toBe(false);
  });

  it("accepts the exact Studio/localnet close_evidence response shape", async () => {
    const txId = `0x${"c".repeat(64)}` as const;
    const caseId = `0x${"d".repeat(64)}`;
    const expected = {
      account: buyer as `0x${string}`,
      caseId,
      chainId: 61999,
      contract: address,
      epoch: 0,
    };
    const receiptContext = {
      binding: {
        caseId,
        chainId: 61999,
        contractAddress: address,
        epoch: 0,
        profileHash: digest,
        releaseDigest: `sha256:${"a".repeat(64)}`,
        subjectOrigin: "https://product.example",
      },
    };
    const receiptBytes = abi.calldata.encode(
      new Map<string, TestCalldataValue>([
        ["contextJson", JSON.stringify(receiptContext)],
      ]),
    );
    const receiptBase64 = btoa(String.fromCharCode(...receiptBytes));
    const callBytes = abi.calldata.encode(
      new Map<string, TestCalldataValue>([
        ["method", "close_evidence"],
        ["args", [caseId]],
        ["kwargs", new Map()],
      ]),
    );
    const studioTransaction = {
      hash: txId,
      sender: buyer,
      recipient: address,
      data: {
        calldata: {
          raw: Array.from(callBytes),
          base64: btoa(String.fromCharCode(...callBytes)),
          readable: abi.calldata.toString(abi.calldata.decode(callBytes)),
        },
      },
      consensus_data: {
        leader_receipt: [{ calldata: { base64: receiptBase64 } }],
      },
    };
    const getTransaction = vi.fn().mockResolvedValue(studioTransaction);
    const client = new AccessSealClient({ getTransaction } as never, address);

    await expect(
      client.verifyCloseEvidenceTransaction(txId, expected),
    ).resolves.toBe(true);
  });

  it("fails closed for the realistic Bradbury shape because it cannot prove chain and epoch", async () => {
    const txId = `0x${"c".repeat(64)}` as const;
    const caseId = `0x${"d".repeat(64)}`;
    const client = new AccessSealClient(
      {
        getTransaction: vi.fn().mockResolvedValue({
          txId,
          from_address: buyer,
          to_address: address,
          txDataDecoded: {
            type: "call",
            callData: new Map<string, unknown>([
              ["method", "close_evidence"],
              ["args", [caseId]],
              ["kwargs", new Map()],
            ]),
          },
        }),
      } as never,
      address,
    );

    await expect(
      client.verifyCloseEvidenceTransaction(txId, {
        account: buyer as `0x${string}`,
        caseId,
        chainId: 61999,
        contract: address,
        epoch: 0,
      }),
    ).resolves.toBe(false);
  });

  it("rejects missing, conflicting, mixed, and fabricated recovery proof aliases", async () => {
    const txId = `0x${"c".repeat(64)}` as const;
    const caseId = `0x${"d".repeat(64)}`;
    const expected = {
      account: buyer as `0x${string}`,
      caseId,
      chainId: 61999,
      contract: address,
      epoch: 0,
    };
    const receiptContext = {
      binding: {
        caseId,
        chainId: 61999,
        contractAddress: address,
        epoch: 0,
        profileHash: digest,
        releaseDigest: `sha256:${"a".repeat(64)}`,
        subjectOrigin: "https://product.example",
      },
    };
    const receiptBytes = abi.calldata.encode(
      new Map([["contextJson", JSON.stringify(receiptContext)]]),
    );
    const callBytes = abi.calldata.encode(
      new Map<string, TestCalldataValue>([
        ["method", "close_evidence"],
        ["args", [caseId]],
        ["kwargs", new Map()],
      ]),
    );
    const studioTransaction = {
      hash: txId,
      sender: buyer,
      recipient: address,
      data: { calldata: { raw: Array.from(callBytes) } },
      consensus_data: {
        leader_receipt: [
          { calldata: { base64: btoa(String.fromCharCode(...receiptBytes)) } },
        ],
      },
    };
    const bradburyCall = {
      type: "call",
      callData: new Map<string, unknown>([
        ["method", "close_evidence"],
        ["args", [caseId]],
        ["kwargs", new Map()],
      ]),
    };
    const wrongCallBytes = abi.calldata.encode(
      new Map<string, TestCalldataValue>([
        ["method", "request_review"],
        ["args", [caseId]],
        ["kwargs", new Map()],
      ]),
    );
    const getTransaction = vi.fn();
    const client = new AccessSealClient({ getTransaction } as never, address);

    for (const transaction of [
      { ...studioTransaction, hash: undefined },
      { ...studioTransaction, hash: `0x${"e".repeat(64)}` },
      { ...studioTransaction, txId: `0x${"e".repeat(64)}` },
      { ...studioTransaction, sender: undefined },
      { ...studioTransaction, sender: `0x${"e".repeat(40)}`, from_address: buyer },
      { ...studioTransaction, recipient: undefined },
      { ...studioTransaction, recipient: address, to_address: `0x${"e".repeat(40)}` },
      {
        ...studioTransaction,
        txDataDecoded: bradburyCall,
      },
      {
        txId,
        from_address: buyer,
        to_address: address,
        txDataDecoded: bradburyCall,
        consensus_data: studioTransaction.consensus_data,
      },
      {
        ...studioTransaction,
        data: { calldata: { raw: Array.from(wrongCallBytes) } },
      },
      {
        ...studioTransaction,
        data: {
          calldata: {
            raw: Array.from(callBytes),
            base64: btoa(String.fromCharCode(...wrongCallBytes)),
          },
        },
      },
      {
        ...studioTransaction,
        data: {
          calldata: {
            raw: Array.from(callBytes),
            readable: "request_review(...)"
          },
        },
      },
      { ...studioTransaction, data: undefined },
      { ...studioTransaction, consensus_data: undefined },
      {
        ...studioTransaction,
        consensus_data: {
          leader_receipt: [
            {
              calldata: {
                base64: btoa(
                  String.fromCharCode(
                    ...abi.calldata.encode(
                      new Map([
                        [
                          "contextJson",
                          JSON.stringify({
                            binding: { ...receiptContext.binding, epoch: 1 },
                          }),
                        ],
                      ]),
                    ),
                  ),
                ),
              },
            },
          ],
        },
      },
    ]) {
      getTransaction.mockResolvedValueOnce(transaction);
      await expect(
        client.verifyCloseEvidenceTransaction(txId, expected),
      ).resolves.toBe(false);
    }
  });

  it("uses the normal consensus default for intelligent review", async () => {
    const connect = vi.fn();
    const writeContract = vi.fn().mockResolvedValue(`0x${"d".repeat(64)}`);
    const client = new AccessSealClient(
      { connect, writeContract } as never,
      "0x1234567890abcdef1234567890abcdef12345678",
      "studionet",
    );
    await client.fund("case-1", 42n);
    await client.requestReview("case-1");
    expect(connect).toHaveBeenCalledWith("studionet");
    expect(writeContract).toHaveBeenNthCalledWith(1, {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      functionName: "fund",
      args: ["case-1"],
      value: 42n,
    });
    expect(writeContract).toHaveBeenNthCalledWith(2, {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      functionName: "request_review",
      args: ["case-1"],
      value: 0n,
    });
    expect(writeContract.mock.calls[1]?.[0]).not.toHaveProperty(
      "consensusMaxRotations",
    );
  });

  it("refuses malformed evidence before opening a wallet request", async () => {
    const writeContract = vi.fn();
    const client = new AccessSealClient(
      { connect: vi.fn(), writeContract } as never,
      "0x1234567890abcdef1234567890abcdef12345678",
      "studionet",
    );
    await expect(
      client.openEvidence("case-1", {
        schemaVersion: "accessseal-evidence/1",
      } as never),
    ).rejects.toThrow(/fields do not match schema/i);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("rejects malformed or non-conserving finalized accounting readback", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValue(
        '{"totalDeposits":"10","reserved":"2","pendingDispatch":"0","dispatchedPayouts":"1","dispatchedRefunds":"0"}',
      );
    const client = new AccessSealClient(
      { readContract } as never,
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    await expect(client.readAccounting()).rejects.toThrow(/conservation/i);
  });

  it("parses the exact deployed contract review schema without inventing criterion text", async () => {
    const review = {
      schemaVersion: "accessseal-review/1",
      verdict: "REJECTED",
      releaseDigest: `sha256:${"a".repeat(64)}`,
      profileHash: digest,
      materialBlockers: ["keyboard-trap"],
      missingEvidence: [],
      evidenceRefs: [`sha256:${"b".repeat(64)}`],
      rationaleHash: `sha256:${"c".repeat(64)}`,
    };
    const client = new AccessSealClient(
      {
        readContract: vi.fn().mockResolvedValue(JSON.stringify(review)),
      } as never,
      address,
    );
    await expect(client.readReview("case-1", 0)).resolves.toEqual(review);
  });

  it("accepts the unchanged eight-field V2 final review readback", async () => {
    const v2Review = {
      schemaVersion: "accessseal-review/1",
      verdict: "APPROVED",
      releaseDigest: `sha256:${"a".repeat(64)}`,
      profileHash: `0x${"b".repeat(64)}`,
      materialBlockers: [],
      missingEvidence: [],
      evidenceRefs: [`sha256:${"c".repeat(64)}`],
      rationaleHash: `sha256:${"d".repeat(64)}`,
    };
    const client = new AccessSealClient(
      {
        readContract: vi.fn().mockResolvedValue(JSON.stringify(v2Review)),
      } as never,
      address,
    );

    await expect(client.readReview("case-1", 0)).resolves.toEqual(v2Review);
  });

  it("matches only the exact pinned viem UserError message for an absent view", () => {
    const wrapped = new Error(
      "An internal error was received.\n\nDetails: UserError(message='evidence epoch does not exist')\nVersion: viem@2.55.16",
    );
    expect(
      matchesExactUserError(wrapped, "evidence epoch does not exist"),
    ).toBe(true);
    expect(matchesExactUserError(wrapped, "review does not exist")).toBe(false);
    expect(
      matchesExactUserError(
        new Error("RPC offline"),
        "evidence epoch does not exist",
      ),
    ).toBe(false);
  });

  it("decodes the exact Bradbury GenVM UserError payload without accepting another error", () => {
    const rpcError = Object.assign(
      new Error("Missing or invalid parameters."),
      {
        cause: {
          code: -32000,
          data: "1604646174618402736574746c656d656e7420696e74656e7420646f6573206e6f74206578697374046b696e644c557365724572726f72",
        },
      },
    );
    expect(
      matchesExactUserError(rpcError, "settlement intent does not exist"),
    ).toBe(true);
    expect(matchesExactUserError(rpcError, "review does not exist")).toBe(
      false,
    );
    expect(
      matchesExactUserError(
        Object.assign(new Error("Missing or invalid parameters."), {
          cause: {
            code: -32000,
            data: "1604646174618402736574746c656d656e7420696e74656e7420646f6573206e6f74206578697374046b696e644c56616c75654572726f72",
          },
        }),
        "settlement intent does not exist",
      ),
    ).toBe(false);
  });
});

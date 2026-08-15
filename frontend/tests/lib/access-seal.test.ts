import { describe, expect, it, vi } from "vitest";
import {
  AccessSealClient,
  deriveCaseBindings,
  matchesExactUserError,
  parseReviewTxBinding,
  validateReviewTxBinding,
} from "@/lib/access-seal";

const address = "0x1234567890abcdef1234567890abcdef12345678" as const;
const buyer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const vendor = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const digest = `0x${"c".repeat(64)}`;
const caseJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    buyer,
    caseId: `0x${"d".repeat(64)}`,
    chainId: 61999,
    contractAddress: address,
    escrowAmount: "1000000000000000000",
    evidenceDeadline: 86400,
    flowsHash: digest,
    hardDeadline: 604800,
    lifecycle: "DRAFT",
    epoch: 0,
    maxUnresolvedRetries: 2,
    profileHash: digest,
    reserved: "0",
    salt: "salt-1",
    subjectOrigin: "https://product.example",
    termsHash: digest,
    vendor,
    vendorAccepted: false,
    ...overrides,
  });

describe("AccessSeal contract adapter", () => {
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

  it("passes value only to funding and zero to every other write", async () => {
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
    expect(writeContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        functionName: "fund",
        args: ["case-1"],
        value: 42n,
      }),
    );
    expect(writeContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        functionName: "request_review",
        args: ["case-1"],
        value: 0n,
      }),
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
      { readContract: vi.fn().mockResolvedValue(JSON.stringify(review)) } as never,
      address,
    );
    await expect(client.readReview("case-1", 0)).resolves.toEqual(review);
  });

  it("matches only the exact pinned viem UserError message for an absent view", () => {
    const wrapped = new Error(
      "An internal error was received.\n\nDetails: UserError(message='evidence epoch does not exist')\nVersion: viem@2.55.16",
    );
    expect(matchesExactUserError(wrapped, "evidence epoch does not exist")).toBe(true);
    expect(matchesExactUserError(wrapped, "review does not exist")).toBe(false);
    expect(matchesExactUserError(new Error("RPC offline"), "evidence epoch does not exist")).toBe(false);
  });
});

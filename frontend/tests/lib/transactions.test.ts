import { describe, expect, it, vi } from "vitest";
import {
  actionReadbackConfirmed,
  classifyTransactionFailure,
  reconcileCase,
  trackTransaction,
  waitingForWallet,
} from "@/lib/transactions";

describe("transaction truth", () => {
  const readback = (overrides: Record<string, unknown> = {}) => ({
    case: {
      caseId: "case-1",
      lifecycle: "DRAFT",
      epoch: 0,
      vendorAccepted: false,
      escrowAmount: 10n,
      reserved: 0n,
      evidenceSealed: false,
      ...overrides,
    },
    review: null,
    reviewFinality: null,
    reviewAttempt: null,
    settlement: null,
    accounting: {
      totalDeposits: 0n,
      reserved: 0n,
      pendingDispatch: 0n,
      dispatchedPayouts: 0n,
      dispatchedRefunds: 0n,
    },
    evidence: null,
  });

  it.each([
    ["accept_terms", readback(), readback({ vendorAccepted: true })],
    ["fund", readback(), readback({ lifecycle: "FUNDED", reserved: 10n })],
    [
      "open_evidence",
      readback({ lifecycle: "FUNDED" }),
      { ...readback({ lifecycle: "EVIDENCE_OPEN" }), evidence: { epoch: 0, envelopes: [{}] } },
    ],
    [
      "append_evidence",
      { ...readback({ lifecycle: "EVIDENCE_OPEN" }), evidence: { epoch: 0, envelopes: [{}] } },
      { ...readback({ lifecycle: "EVIDENCE_OPEN" }), evidence: { epoch: 0, envelopes: [{}, {}] } },
    ],
    [
      "close_evidence",
      readback({ lifecycle: "EVIDENCE_OPEN" }),
      readback({ lifecycle: "EVIDENCE_SEALED", evidenceSealed: true }),
    ],
    [
      "request_review",
      readback({ lifecycle: "EVIDENCE_SEALED", evidenceSealed: true }),
      {
        ...readback({ lifecycle: "REVIEW_PENDING", evidenceSealed: true }),
        review: { verdict: "APPROVED" },
        reviewFinality: { epoch: 0, attempt: 0, status: "PENDING_PROTOCOL_FINALITY" },
      },
    ],
    [
      "start_cure",
      {
        ...readback({ lifecycle: "DECIDED" }),
        review: { verdict: "REQUEST_MORE_INFO" },
        reviewFinality: { epoch: 0, attempt: 0, status: "FINALIZED" },
      },
      readback({ lifecycle: "EVIDENCE_OPEN", epoch: 1 }),
    ],
    [
      "retry_review",
      {
        ...readback({ lifecycle: "DECIDED", evidenceSealed: true }),
        review: { verdict: "UNRESOLVED" },
        reviewFinality: { epoch: 0, attempt: 0, status: "FINALIZED" },
      },
      {
        ...readback({ lifecycle: "REVIEW_PENDING", evidenceSealed: true }),
        review: { verdict: "APPROVED" },
        reviewFinality: { epoch: 0, attempt: 1, status: "PENDING_PROTOCOL_FINALITY" },
      },
    ],
    [
      "expire_unresolved",
      readback({ lifecycle: "DECIDED" }),
      {
        ...readback({ lifecycle: "SETTLEMENT_PENDING" }),
        settlement: { kind: "REFUND", reason: "UNRESOLVED_EXHAUSTED", status: "PREPARED" },
      },
    ],
    [
      "timeout_refund",
      readback({ lifecycle: "EVIDENCE_OPEN" }),
      {
        ...readback({ lifecycle: "SETTLEMENT_PENDING" }),
        settlement: { kind: "REFUND", reason: "HARD_TIMEOUT", status: "PREPARED" },
      },
    ],
    [
      "prepare_settlement",
      {
        ...readback({ lifecycle: "DECIDED" }),
        review: { verdict: "APPROVED" },
      },
      {
        ...readback({ lifecycle: "SETTLEMENT_PENDING" }),
        review: { verdict: "APPROVED" },
        settlement: { kind: "PAYOUT", status: "PREPARED" },
      },
    ],
    [
      "execute_settlement",
      {
        ...readback({ lifecycle: "SETTLEMENT_PENDING" }),
        settlement: { status: "PREPARED" },
      },
      {
        ...readback({ lifecycle: "DISPATCHED_FINALIZED" }),
        settlement: { status: "DISPATCHED_FINALIZED" },
      },
    ],
    [
      "appeal",
      { ...readback(), appealRound: 0n },
      { ...readback(), appealRound: 1n },
    ],
  ] as const)("confirms only the authoritative %s action effect", (action, before, after) => {
    expect(actionReadbackConfirmed(action, before as never, after as never)).toBe(true);
    expect(actionReadbackConfirmed(action, before as never, before as never)).toBe(false);
  });

  it("permits an already-sealed close readback only for persisted recovery", () => {
    const sealed = readback({ lifecycle: "EVIDENCE_SEALED", evidenceSealed: true });
    expect(actionReadbackConfirmed("close_evidence", sealed as never, sealed as never)).toBe(false);
    expect(
      actionReadbackConfirmed("close_evidence", sealed as never, sealed as never, {
        recoveredPersistedCloseEvidence: true,
      }),
    ).toBe(true);
  });

  it("uses real pinned SDK receipt names instead of a fictional rejected status", async () => {
    for (const statusName of [
      "VALIDATORS_TIMEOUT",
      "LEADER_TIMEOUT",
      "CANCELED",
      "UNDETERMINED",
    ]) {
      await expect(
        trackTransaction(
          { waitForTransactionReceipt: vi.fn().mockResolvedValue({ statusName }) } as never,
          `0x${"4".repeat(64)}`,
          () => undefined,
        ),
      ).resolves.toMatchObject({ phase: "VALIDATORS_TIMEOUT" });
    }
    await expect(
      trackTransaction(
        {
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            statusName: "FINALIZED",
            resultName: "DETERMINISTIC_VIOLATION",
            txExecutionResultName: "FINISHED_WITH_RETURN",
          }),
        } as never,
        `0x${"5".repeat(64)}`,
        () => undefined,
      ),
    ).resolves.toMatchObject({ phase: "DETERMINISTIC_VIOLATION" });

    for (const resultName of ["DISAGREE", "MAJORITY_DISAGREE", "NO_MAJORITY"]) {
      await expect(
        trackTransaction(
          {
            waitForTransactionReceipt: vi.fn().mockResolvedValue({
              statusName: "FINALIZED",
              resultName,
              txExecutionResultName: "FINISHED_WITH_RETURN",
            }),
          } as never,
          `0x${"6".repeat(64)}`,
          () => undefined,
          async () => true,
        ),
      ).resolves.toMatchObject({ phase: "READBACK_CONFIRMED" });
    }
  });

  it("classifies only exact AccessSeal buyer and vendor role errors", () => {
    expect(
      classifyTransactionFailure(
        new Error("gen_call failed: only the buyer can close evidence"),
      ).phase,
    ).toBe("WRONG_ROLE");
    expect(
      classifyTransactionFailure(
        new Error("gen_call failed: only the vendor can start a cure"),
      ).phase,
    ).toBe("WRONG_ROLE");
    expect(
      classifyTransactionFailure(
        new Error("gen_call failed: only the buyer can close evidence now"),
      ).phase,
    ).toBe("RPC_ERROR");
  });
  it("classifies a wallet rejection before any submission", () => {
    expect(waitingForWallet()).toMatchObject({
      phase: "WAITING_FOR_WALLET",
      hash: null,
    });
    expect(classifyTransactionFailure({ code: 4001 })).toMatchObject({
      phase: "WALLET_REJECTED",
      hash: null,
    });
  });
  it("emits only observed V4 phases and confirms only successful readback", async () => {
    const events: string[] = [];
    const result = await trackTransaction(
      {
        waitForTransactionReceipt: vi
          .fn()
          .mockResolvedValueOnce({ statusName: "ACCEPTED" })
          .mockResolvedValueOnce({
            statusName: "FINALIZED",
            txExecutionResultName: "FINISHED_WITH_RETURN",
          }),
      },
      `0x${"1".repeat(64)}`,
      (event) => events.push(event.phase),
      async () => true,
    );

    expect(events).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "PROTOCOL_FINALIZED",
      "EXECUTION_SUCCESS",
      "READBACK_CONFIRMED",
    ]);
    expect(result.phase).toBe("READBACK_CONFIRMED");
  });

  it.each([
    [{ statusName: "UNDETERMINED" }, "VALIDATORS_TIMEOUT"],
    [{ statusName: "FINALIZED", resultName: "DETERMINISTIC_VIOLATION" }, "DETERMINISTIC_VIOLATION"],
    [{ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR" }, "EXECUTION_ERROR"],
  ] as const)("classifies terminal receipt failure %s", async (receipt, expected) => {
    const events: string[] = [];
    const result = await trackTransaction(
      { waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt) } as never,
      `0x${"2".repeat(64)}`,
      (event) => events.push(event.phase),
      async () => true,
    );
    expect(result.phase).toBe(expected);
    expect(events).not.toContain("READBACK_CONFIRMED");
  });

  it("classifies an exact nested simplified SDK UserError role failure", async () => {
    const result = await trackTransaction(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_ERROR",
          consensus_data: {
            leader_receipt: [
              {
                genvm_result: {
                  stderr: "UserError(message='only the buyer can close evidence')",
                },
              },
            ],
          },
        }),
      } as never,
      `0x${"7".repeat(64)}`,
      () => undefined,
      async () => true,
    );
    expect(result.phase).toBe("WRONG_ROLE");
  });

  it("does not broaden nested simplified SDK role errors", async () => {
    const result = await trackTransaction(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_ERROR",
          consensus_data: {
            leader_receipt: [
              {
                genvm_result: {
                  stderr: "UserError(message='only the buyer can close evidence now')",
                },
              },
            ],
          },
        }),
      } as never,
      `0x${"8".repeat(64)}`,
      () => undefined,
      async () => true,
    );
    expect(result.phase).toBe("EXECUTION_ERROR");
  });

  it("classifies a false action-specific readback as a mismatch", async () => {
    const events: string[] = [];
    const result = await trackTransaction(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
      `0x${"3".repeat(64)}`,
      (event) => events.push(event.phase),
      async () => false,
      "close_evidence",
    );
    expect(result.phase).toBe("READBACK_MISMATCH");
    expect(events).not.toContain("READBACK_CONFIRMED");
  });
  it.each(["DRAFT", "FUNDED", "EVIDENCE_OPEN"])(
    "recognizes pinned genlayer-js absent-view wrappers while reconciling %s",
    async (lifecycle) => {
      const absent = (message: string) =>
        new Error(`gen_call failed: ${message}`);
      const source = {
        readCase: vi.fn().mockResolvedValue({
          caseId: "case-1",
          lifecycle,
          epoch: 0,
        }),
        readReview: vi.fn().mockRejectedValue(absent("review does not exist")),
        readReviewFinality: vi
          .fn()
          .mockRejectedValue(absent("review finality proof does not exist")),
        readSettlement: vi
          .fn()
          .mockRejectedValue(absent("settlement intent does not exist")),
        readReviewAttempt: vi.fn(),
        readAccounting: vi.fn().mockResolvedValue({
          totalDeposits: 0n,
          reserved: 0n,
          pendingDispatch: 0n,
          dispatchedPayouts: 0n,
          dispatchedRefunds: 0n,
        }),
      };
      const result = await reconcileCase(source as never, "case-1");
      expect(result.review).toBeNull();
      expect(result.reviewFinality).toBeNull();
      expect(result.settlement).toBeNull();
      expect(source.readReviewAttempt).not.toHaveBeenCalled();
    },
  );

  it("recognizes the pinned viem GLSim UserError wrapper only for exact absent views", async () => {
    const wrapped = (message: string) =>
      new Error(
        `An internal error was received.\n\nDetails: UserError(message='${message}')\nVersion: viem@2.55.16`,
      );
    const source = {
      readCase: vi.fn().mockResolvedValue({
        caseId: "case-1",
        lifecycle: "DRAFT",
        epoch: 0,
      }),
      readReview: vi.fn().mockRejectedValue(wrapped("review does not exist")),
      readReviewFinality: vi
        .fn()
        .mockRejectedValue(wrapped("review finality proof does not exist")),
      readSettlement: vi
        .fn()
        .mockRejectedValue(wrapped("settlement intent does not exist")),
      readReviewAttempt: vi.fn(),
      readAccounting: vi.fn().mockResolvedValue({
        totalDeposits: 0n,
        reserved: 0n,
        pendingDispatch: 0n,
        dispatchedPayouts: 0n,
        dispatchedRefunds: 0n,
      }),
    };
    const result = await reconcileCase(source as never, "case-1");
    expect(result.review).toBeNull();
    expect(result.reviewFinality).toBeNull();
    expect(result.settlement).toBeNull();
    await expect(
      reconcileCase(
        {
          ...source,
          readReview: vi.fn().mockRejectedValue(wrapped("RPC offline")),
        } as never,
        "case-1",
      ),
    ).rejects.toThrow("RPC offline");
  });

  it("unwraps an exact structured cause but rethrows every unknown VM/RPC error", async () => {
    const common = {
      readCase: vi
        .fn()
        .mockResolvedValue({ caseId: "case-1", lifecycle: "DRAFT", epoch: 0 }),
      readReviewFinality: vi.fn().mockRejectedValue(
        new Error("outer", {
          cause: new Error(
            "gen_call failed: review finality proof does not exist",
          ),
        }),
      ),
      readSettlement: vi
        .fn()
        .mockRejectedValue(
          new Error("gen_call failed: settlement intent does not exist"),
        ),
      readReviewAttempt: vi.fn(),
      readAccounting: vi.fn().mockResolvedValue({
        totalDeposits: 0n,
        reserved: 0n,
        pendingDispatch: 0n,
        dispatchedPayouts: 0n,
        dispatchedRefunds: 0n,
      }),
    };
    await expect(
      reconcileCase(
        {
          ...common,
          readReview: vi.fn().mockRejectedValue(
            Object.assign(new Error("gen_call failed: RPC offline"), {
              code: "CONTRACT_NOT_FOUND",
            }),
          ),
        } as never,
        "case-1",
      ),
    ).rejects.toThrow("gen_call failed: RPC offline");
  });
  it("does not confirm readback when a reconciler returns no verdict", async () => {
    const updates: string[] = [];
    const waitForTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        statusName: "ACCEPTED",
        txExecutionResultName: "FINISHED_WITH_RETURN",
      })
      .mockResolvedValueOnce({
        statusName: "FINALIZED",
        txExecutionResultName: "FINISHED_WITH_RETURN",
      });
    const result = await trackTransaction(
      { waitForTransactionReceipt },
      `0x${"a".repeat(64)}`,
      (state) => updates.push(state.phase),
      async () => undefined as never,
    );
    expect(updates).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "PROTOCOL_FINALIZED",
      "EXECUTION_SUCCESS",
      "READBACK_MISMATCH",
    ]);
    expect(result.phase).toBe("READBACK_MISMATCH");
  });

  it("accepts the pinned GenLayerJS simplified snake-case finality field", async () => {
    const updates: string[] = [];
    const result = await trackTransaction(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          status_name: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      } as never,
      `0x${"d".repeat(64)}`,
      (value) => updates.push(value.phase),
      async () => true,
    );
    expect(updates).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "PROTOCOL_FINALIZED",
      "EXECUTION_SUCCESS",
      "READBACK_CONFIRMED",
    ]);
    expect(result.phase).toBe("READBACK_CONFIRMED");
  });

  it("does not claim green success when authoritative reconciliation fails", async () => {
    const updates: string[] = [];
    await expect(
      trackTransaction(
        {
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            statusName: "FINALIZED",
            txExecutionResultName: "FINISHED_WITH_RETURN",
          }),
        },
        `0x${"f".repeat(64)}`,
        (value) => updates.push(value.phase),
        async () => {
          throw new Error("RPC readback unavailable");
        },
      ),
    ).resolves.toMatchObject({ phase: "RPC_ERROR" });
    expect(updates).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "PROTOCOL_FINALIZED",
      "EXECUTION_SUCCESS",
      "RPC_ERROR",
    ]);
  });

  it("keeps a close-evidence transaction reconciling until the sealed readback is authoritative", async () => {
    const updates: string[] = [];
    const reconcile = vi.fn().mockResolvedValue(false as never);
    const result = await (trackTransaction as (...args: unknown[]) => Promise<{
      phase: string;
    }>)(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
      `0x${"e".repeat(64)}`,
      (value: { phase: string }) => updates.push(value.phase),
      reconcile,
      "close_evidence",
    );

    expect(reconcile).toHaveBeenCalledWith("close_evidence");
    expect(updates).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "PROTOCOL_FINALIZED",
      "EXECUTION_SUCCESS",
      "READBACK_MISMATCH",
    ]);
    expect(result.phase).toBe("READBACK_MISMATCH");
  });

  it("never maps undetermined or failed execution to success", async () => {
    const undetermined = await trackTransaction(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "UNDETERMINED",
          txExecutionResultName: "NOT_VOTED",
        }),
      },
      `0x${"b".repeat(64)}`,
      () => undefined,
    );
    expect(undetermined.phase).toBe("VALIDATORS_TIMEOUT");
    const failed = await trackTransaction(
      {
        waitForTransactionReceipt: vi.fn().mockResolvedValueOnce({
          statusName: "ACCEPTED",
          txExecutionResultName: "FINISHED_WITH_ERROR",
        }),
      },
      `0x${"c".repeat(64)}`,
      () => undefined,
    );
    expect(failed.phase).toBe("EXECUTION_ERROR");
  });

  it("replaces stale local state with finalized contract readback", async () => {
    const source = {
      readCase: vi.fn().mockResolvedValue({
        caseId: "case-1",
        lifecycle: "DECIDED",
        epoch: 2,
      }),
      readReview: vi.fn().mockResolvedValue({ verdict: "APPROVED" }),
      readReviewFinality: vi.fn().mockResolvedValue({
        status: "FINALIZED",
        proofId: "sha256:proof",
        attempt: 1,
        epoch: 2,
      }),
      readAccounting: vi.fn().mockResolvedValue({
        totalDeposits: 10,
        reserved: 10,
        pendingDispatch: 0,
        dispatchedPayouts: 0,
        dispatchedRefunds: 0,
      }),
      readSettlement: vi
        .fn()
        .mockRejectedValue(new Error("settlement intent does not exist")),
      readReviewAttempt: vi.fn().mockResolvedValue({
        caseId: "case-1",
        epoch: 2,
        attempt: 1,
        decidedAt: 1000,
        finalizedAt: 1100,
        status: "FINALIZED",
        proofId: "sha256:proof",
        review: { verdict: "APPROVED" },
      }),
    };
    const result = await reconcileCase(source, "case-1", {
      lifecycle: "FUNDED",
    });
    expect(result.case.lifecycle).toBe("DECIDED");
    expect(result.reviewFinality?.status).toBe("FINALIZED");
    expect(result.settlement).toBeNull();
  });

  it("surfaces settlement transport outages instead of treating them as absent", async () => {
    const source = {
      readCase: vi.fn().mockResolvedValue({
        caseId: "case-1",
        lifecycle: "DECIDED",
        epoch: 0,
      }),
      readReview: vi.fn().mockRejectedValue(
        Object.assign(new Error("review does not exist"), {
          code: "CONTRACT_NOT_FOUND",
        }),
      ),
      readReviewFinality: vi.fn().mockRejectedValue(
        Object.assign(new Error("review finality proof does not exist"), {
          code: "CONTRACT_NOT_FOUND",
        }),
      ),
      readAccounting: vi.fn().mockResolvedValue({
        totalDeposits: 0n,
        reserved: 0n,
        pendingDispatch: 0n,
        dispatchedPayouts: 0n,
        dispatchedRefunds: 0n,
      }),
      readSettlement: vi.fn().mockRejectedValue(new Error("RPC offline")),
      readReviewAttempt: vi.fn(),
    };
    await expect(reconcileCase(source as never, "case-1")).rejects.toThrow(
      /RPC offline/,
    );
  });
});

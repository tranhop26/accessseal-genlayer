import { describe, expect, it, vi } from "vitest";
import { trackTransaction, reconcileCase } from "@/lib/transactions";

describe("transaction truth", () => {
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
  it("reports accepted separately and waits for finalized execution success", async () => {
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
    );
    expect(updates).toEqual(["PENDING", "ACCEPTED", "RECONCILING"]);
    expect(result.phase).toBe("RECONCILING");
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
      async () => undefined,
    );
    expect(updates).toEqual([
      "PENDING",
      "ACCEPTED",
      "RECONCILING",
      "FINALIZED_SUCCESS",
    ]);
    expect(result.phase).toBe("FINALIZED_SUCCESS");
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
    ).rejects.toThrow(/readback unavailable/i);
    expect(updates).toEqual(["PENDING", "ACCEPTED", "RECONCILING"]);
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
    expect(updates).toEqual(["PENDING", "ACCEPTED", "RECONCILING"]);
    expect(result.phase).toBe("RECONCILING");
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
    expect(undetermined.phase).toBe("UNDETERMINED");
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

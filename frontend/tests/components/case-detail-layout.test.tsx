import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseDetail } from "@/components/case-detail";
import { StatusPanel } from "@/components/status-panel";
import { useWallet } from "@/providers/wallet-provider";
import type { ReconciledCase } from "@/lib/transactions";

vi.mock("@/providers/wallet-provider", () => ({ useWallet: vi.fn() }));

const CASE_ID = `0x${"1".repeat(64)}`;
const BUYER = `0x${"2".repeat(40)}` as const;
const VENDOR = `0x${"3".repeat(40)}` as const;

function finalizedReadback(): ReconciledCase {
  return {
    case: {
      buyer: BUYER,
      caseId: CASE_ID,
      chainId: 61999,
      contractAddress: `0x${"4".repeat(40)}`,
      escrowAmount: 100n,
      evidenceDeadline: 2_000,
      flowsHash: `0x${"5".repeat(64)}`,
      hardDeadline: 3_000,
      lifecycle: "DECIDED",
      epoch: 0,
      maxUnresolvedRetries: 1,
      profileHash: `0x${"6".repeat(64)}`,
      reserved: 100n,
      salt: "case-salt",
      subjectOrigin: "https://audit.example",
      termsHash: `0x${"7".repeat(64)}`,
      vendor: VENDOR,
      vendorAccepted: true,
    },
    review: {
      schemaVersion: "accessseal-review/1",
      verdict: "APPROVED",
      releaseDigest: `sha256:${"8".repeat(64)}`,
      profileHash: `0x${"6".repeat(64)}`,
      materialBlockers: [],
      missingEvidence: [],
      evidenceRefs: [],
      rationaleHash: `sha256:${"9".repeat(64)}`,
    },
    reviewFinality: {
      attempt: 0,
      epoch: 0,
      proofId: "proof-1",
      status: "FINALIZED",
    },
    reviewAttempt: {
      attempt: 0,
      caseId: CASE_ID,
      decidedAt: 1_000,
      epoch: 0,
      finalizedAt: 1_100,
      proofId: "proof-1",
      status: "FINALIZED",
      review: {
        schemaVersion: "accessseal-review/1",
        verdict: "APPROVED",
        releaseDigest: `sha256:${"8".repeat(64)}`,
        profileHash: `0x${"6".repeat(64)}`,
        materialBlockers: [],
        missingEvidence: [],
        evidenceRefs: [],
        rationaleHash: `sha256:${"9".repeat(64)}`,
      },
    },
    settlement: null,
    accounting: {
      totalDeposits: 100n,
      reserved: 100n,
      pendingDispatch: 0n,
      dispatchedPayouts: 0n,
      dispatchedRefunds: 0n,
    },
    localStateWasReplaced: false,
  };
}

function mockWallet(readback: ReconciledCase) {
  const readContract = {
    readCase: vi.fn().mockResolvedValue(readback.case),
    readReview: vi.fn().mockResolvedValue(readback.review),
    readReviewFinality: vi.fn().mockResolvedValue(readback.reviewFinality),
    readReviewAttempt: vi.fn().mockResolvedValue(readback.reviewAttempt),
    readSettlement: readback.settlement
      ? vi.fn().mockResolvedValue(readback.settlement)
      : vi
          .fn()
          .mockRejectedValue(new Error("settlement intent does not exist")),
    readAccounting: vi.fn().mockResolvedValue(readback.accounting),
    readEvidence: vi
      .fn()
      .mockRejectedValue(new Error("evidence epoch does not exist")),
    appealEligibility: vi.fn().mockResolvedValue({
      available: false,
      reason:
        "Review transaction ID is unavailable; eligibility cannot be proven.",
      round: null,
      bond: null,
      roundData: null,
    }),
    verifyReviewTransaction: vi.fn().mockResolvedValue(false),
  };
  vi.mocked(useWallet).mockReturnValue({
    status: "connected",
    address: BUYER,
    error: null,
    contract: null,
    readContract,
    sdk: null,
    config: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as never);
  return readContract;
}

describe("case detail document layout", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("renders one invoice summary and four visible workflow sections", async () => {
    mockWallet(finalizedReadback());
    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", { name: /case summary/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Case sections" }),
    ).toBeVisible();
    for (const name of ["Terms", "Evidence", "AI decision", "Settlement"]) {
      expect(screen.getByRole("link", { name })).toBeVisible();
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
    expect(screen.getByText("Submitted")).toBeVisible();
    expect(screen.getByText("Readback confirmed")).toBeVisible();
  });

  it("moves keyboard focus to each case section after its hash link activates", async () => {
    mockWallet(finalizedReadback());
    const user = userEvent.setup();
    render(<CaseDetail caseId={CASE_ID} />);

    const lifecycle = await screen.findByRole("list", {
      name: "Case lifecycle",
    });
    const navigation = screen.getByRole("navigation", {
      name: "Case sections",
    });
    const escapeControl = within(
      screen.getByRole("region", { name: "Settlement" }),
    ).getByRole("button", { name: "Prepare settlement" });
    const sections = [
      ["Terms", "terms"],
      ["Evidence", "evidence"],
      ["AI decision", "decision"],
      ["Settlement", "settlement"],
    ] as const;

    lifecycle.focus();
    for (const [name] of sections) {
      await user.tab();
      expect(within(navigation).getByRole("link", { name })).toHaveFocus();
    }
    await user.tab();
    expect(escapeControl).toHaveFocus();

    for (const [index, [name, id]] of sections.entries()) {
      lifecycle.focus();
      for (let step = 0; step <= index; step++) await user.tab();

      const link = within(navigation).getByRole("link", { name });
      expect(link).toHaveAttribute("href", `#${id}`);
      expect(link).toHaveFocus();

      await user.keyboard("{Enter}");

      const target = screen.getByRole("region", { name });
      await waitFor(() => expect(window.location.hash).toBe(`#${id}`));
      await waitFor(() => expect(target).toHaveFocus());

      await user.tab();
      expect(escapeControl).toHaveFocus();
    }
  });

  it("keeps the initial readback error under a page H1", async () => {
    const reader = mockWallet(finalizedReadback());
    reader.readCase.mockRejectedValue(new Error("Finalized RPC unavailable"));

    render(<CaseDetail caseId={CASE_ID} />);

    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Case readback",
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Readback unavailable",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("does not style an accepted transaction as success", () => {
    render(
      <StatusPanel
        state={{
          phase: "ACCEPTED",
          hash: `0x${"a".repeat(64)}`,
          message:
            "Accepted by validators. It remains appealable and is not final.",
        }}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-tone", "warning");
    expect(status).not.toHaveAttribute("data-tone", "success");
    expect(screen.getByText("Accepted")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("prioritizes executing an authoritative prepared intent over preparing again", async () => {
    const readback = finalizedReadback();
    readback.case.lifecycle = "SETTLEMENT_PENDING";
    readback.settlement = {
      amount: 100n,
      caseId: CASE_ID,
      epoch: 0,
      executor: "",
      kind: "PAYOUT",
      reason: "APPROVED",
      recipient: VENDOR,
      reviewProofId: "proof-1",
      settlementId: "settlement-1",
      status: "PREPARED",
    };
    readback.accounting = {
      totalDeposits: 100n,
      reserved: 0n,
      pendingDispatch: 100n,
      dispatchedPayouts: 0n,
      dispatchedRefunds: 0n,
    };
    mockWallet(readback);

    render(<CaseDetail caseId={CASE_ID} />);

    const summary = await screen.findByRole("region", { name: "Case summary" });
    expect(
      within(summary).getByRole("button", {
        name: "Execute prepared settlement",
      }),
    ).toBeEnabled();
  });
});

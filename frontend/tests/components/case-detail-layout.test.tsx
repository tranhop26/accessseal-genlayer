import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseDetail } from "@/components/case-detail";
import { StatusPanel } from "@/components/status-panel";
import { useWallet } from "@/providers/wallet-provider";
import type { ReconciledCase } from "@/lib/transactions";
import type { EvidenceEnvelopeV1, EvidenceType } from "@/lib/evidence";
import type { EvidenceRecord, Hash } from "@/lib/access-seal";

vi.mock("@/providers/wallet-provider", () => ({ useWallet: vi.fn() }));

const CASE_ID = `0x${"1".repeat(64)}`;
const BUYER = `0x${"2".repeat(40)}` as const;
const VENDOR = `0x${"3".repeat(40)}` as const;
const REQUIRED_EVIDENCE_TYPES: EvidenceType[] = [
  "RELEASE_MANIFEST",
  "HTML_BUNDLE",
  "SCREENSHOT",
  "DOM_FACTS",
  "SCANNER_REPORT",
  "CRITICAL_FLOW_TRACE",
];

const mediaTypes: Record<EvidenceType, string> = {
  RELEASE_MANIFEST: "application/json",
  HTML_BUNDLE: "text/html",
  SCREENSHOT: "image/png",
  DOM_FACTS: "application/json",
  SCANNER_REPORT: "application/json",
  CRITICAL_FLOW_TRACE: "application/json",
};

function finalizedReadback(): ReconciledCase {
  return {
    case: {
      buyer: BUYER,
      caseId: CASE_ID,
      chainId: 61999,
      contractAddress: `0x${"4".repeat(40)}`,
      escrowAmount: 100n,
      evidenceDeadline: 2_000,
      evidenceSealed: false,
      evidenceSealedAt: 0,
      evidenceSealedBy: `0x${"0".repeat(40)}`,
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

function evidenceReadback(
  types: EvidenceType[],
  epoch = 0,
): EvidenceRecord {
  const releaseDigest = `sha256:${"8".repeat(64)}` as const;
  return {
    caseId: CASE_ID,
    epoch,
    releaseDigest,
    hashes: types.map(
      (_, index) => `sha256:${String(index).padStart(64, "0")}`,
    ),
    envelopes: types.map(
      (evidenceType, index) =>
        ({
          schemaVersion: "accessseal-evidence/1",
          chainId: "61999",
          contract: `0x${"4".repeat(40)}`,
          caseId: CASE_ID,
          epoch,
          action: index === 0 ? "OPEN_RELEASE" : "APPEND_EVIDENCE",
          subjectOrigin: "https://audit.example",
          profileVersion: "accessseal-static/1",
          releaseDigest,
          evidenceType,
          issuer: VENDOR,
          payloadUri: `https://audit.example/evidence-${index}`,
          payloadSha256:
            evidenceType === "RELEASE_MANIFEST"
              ? releaseDigest
              : `sha256:${String(index + 1).padStart(64, "0")}`,
          mediaType: mediaTypes[evidenceType],
          observedAt: 1_000,
          submittedAt: 1_000,
          expiresAt: 9_999_999_999,
          nonce: `nonce-${index}`,
        }) satisfies EvidenceEnvelopeV1,
    ),
  };
}

function evidenceOpenReadback(
  sealed = false,
  epoch = 0,
): ReconciledCase {
  const readback = finalizedReadback();
  readback.case.lifecycle = sealed ? "EVIDENCE_SEALED" : "EVIDENCE_OPEN";
  readback.case.epoch = epoch;
  readback.case.evidenceSealed = sealed;
  readback.case.evidenceSealedAt = sealed ? 1_701_234_567 : 0;
  readback.case.evidenceSealedBy = sealed ? BUYER : `0x${"0".repeat(40)}`;
  readback.review = null;
  readback.reviewFinality = null;
  readback.reviewAttempt = null;
  return readback;
}

function mockWallet(
  readback: ReconciledCase,
  options: {
    address?: string | null;
    changeAccount?: () => Promise<void>;
    contract?: Record<string, unknown> | null;
    evidence?: EvidenceRecord | null;
    sdk?: Record<string, unknown> | null;
  } = {},
) {
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
    readEvidence: options.evidence
      ? vi.fn().mockResolvedValue(options.evidence)
      : vi
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
    address: options.address ?? BUYER,
    error: null,
    contract: options.contract ?? null,
    readContract,
    sdk: options.sdk ?? null,
    config: null,
    connect: vi.fn(),
    changeAccount: options.changeAccount ?? vi.fn(),
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

  it("shows the buyer a disabled seal action with the exact missing evidence types", async () => {
    const incomplete = evidenceOpenReadback();
    mockWallet(incomplete, {
      evidence: evidenceReadback([
        "RELEASE_MANIFEST",
        "HTML_BUNDLE",
        "HTML_BUNDLE",
        "DOM_FACTS",
        "SCANNER_REPORT",
        "CRITICAL_FLOW_TRACE",
      ]),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    const button = await screen.findByRole("button", {
      name: "Close evidence & enable review",
    });
    expect(button).toBeDisabled();
    expect(screen.getByText(/missing evidence types/i)).toHaveTextContent(
      "SCREENSHOT",
    );
    expect(
      screen.getAllByText(/six exact current-epoch evidence types/i),
    ).toHaveLength(2);
  });

  it("hides the seal action for a wrong wallet and lets the user change wallets", async () => {
    const changeAccount = vi.fn().mockResolvedValue(undefined);
    mockWallet(evidenceOpenReadback(), {
      address: VENDOR,
      changeAccount,
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);

    await screen.findByText("Evidence trail");
    expect(
      screen.queryByRole("button", {
        name: "Close evidence & enable review",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/connect the buyer wallet to close evidence/i),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Change wallet" }));
    expect(changeAccount).toHaveBeenCalledTimes(1);
  });

  it("enables the seal action only for the complete authoritative current epoch", async () => {
    mockWallet(evidenceOpenReadback(), {
      contract: { closeEvidence: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("button", {
        name: "Close evidence & enable review",
      }),
    ).toBeEnabled();
  });

  it("revalidates evidence freshness before submitting a seal", async () => {
    let currentTime = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    try {
      const evidence = evidenceReadback(REQUIRED_EVIDENCE_TYPES);
      evidence.envelopes[0].expiresAt = Math.floor(currentTime / 1000) + 1;
      const closeEvidence = vi.fn();
      mockWallet(evidenceOpenReadback(), {
        contract: { closeEvidence },
        evidence,
      });
      const user = userEvent.setup();

      render(<CaseDetail caseId={CASE_ID} />);
      expect(
        await screen.findByRole("button", {
          name: "Close evidence & enable review",
        }),
      ).toBeEnabled();

      currentTime += 2_000;
      await user.click(
        screen.getByRole("button", { name: "Close evidence & enable review" }),
      );

      expect(closeEvidence).not.toHaveBeenCalled();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Evidence is no longer complete and current for sealing.",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("disables the seal action when a required authoritative envelope is expired", async () => {
    const evidence = evidenceReadback(REQUIRED_EVIDENCE_TYPES);
    evidence.envelopes[2] = {
      ...evidence.envelopes[2]!,
      expiresAt: 0,
    };
    mockWallet(evidenceOpenReadback(), {
      contract: { closeEvidence: vi.fn() },
      evidence,
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("button", {
        name: "Close evidence & enable review",
      }),
    ).toBeDisabled();
    expect(screen.getByText(/expired evidence types/i)).toHaveTextContent(
      "SCREENSHOT",
    );
  });

  it("separates wallet confirmation, submission, and consensus pending seal states", async () => {
    let resolveClose: ((hash: Hash) => void) | undefined;
    let resolveAccepted: ((receipt: Record<string, string>) => void) | undefined;
    const closeEvidence = vi.fn(
      () =>
        new Promise<Hash>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const waitForTransactionReceipt = vi.fn(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveAccepted = resolve;
        }),
    );
    mockWallet(evidenceOpenReadback(), {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: { waitForTransactionReceipt },
    });
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Close evidence & enable review",
      }),
    );
    expect(await screen.findByText(/confirm the seal in your wallet/i)).toBeVisible();

    resolveClose?.(`0x${"a".repeat(64)}`);
    expect(
      await screen.findByRole("heading", { name: "Transaction submitted" }),
    ).toBeVisible();

    resolveAccepted?.({
      statusName: "ACCEPTED",
      txExecutionResultName: "FINISHED_WITH_RETURN",
    });
    expect(await screen.findByText(/accepted by validators/i)).toBeVisible();
  });

  it("does not show seal success when final execution has no sealed readback", async () => {
    const readback = evidenceOpenReadback();
    mockWallet(readback, {
      contract: { closeEvidence: vi.fn().mockResolvedValue(`0x${"b".repeat(64)}`) },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Close evidence & enable review",
      }),
    );

    expect(
      await screen.findByText(/waiting for sealed evidence readback/i),
    ).toBeVisible();
    expect(
      screen
        .getByRole("heading", { name: "Transaction finalized" })
        .closest("[role='status']"),
    ).not.toHaveAttribute("data-tone", "success");
    expect(
      screen.getByRole("button", { name: "Close evidence & enable review" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh readback" })).toBeEnabled();
    expect(screen.getByText(/fallback review path/i)).toBeVisible();
  });

  it("shows seal success and enables review only after sealed authoritative readback", async () => {
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const reader = mockWallet(opened, {
      contract: { closeEvidence: vi.fn().mockResolvedValue(`0x${"d".repeat(64)}`) },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });
    reader.readCase
      .mockResolvedValueOnce(opened.case)
      .mockResolvedValue(sealed.case);
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Close evidence & enable review",
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback confirmed",
      }),
    ).toBeVisible();
    expect(screen.getByText("Evidence sealed")).toBeVisible();
    for (const button of screen.getAllByRole("button", {
      name: "Request intelligent review",
    }))
      expect(button).toBeEnabled();
  });

  it("surfaces a seal readback error and retries the read without resubmitting", async () => {
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const closeEvidence = vi.fn().mockResolvedValue(`0x${"e".repeat(64)}`);
    const reader = mockWallet(opened, {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });
    reader.readCase
      .mockResolvedValueOnce(opened.case)
      .mockRejectedValueOnce(new Error("Finalized seal readback offline"))
      .mockResolvedValue(sealed.case);
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Close evidence & enable review",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finalized seal readback offline",
    );

    await user.click(screen.getByRole("button", { name: "Retry readback" }));
    await waitFor(() => expect(reader.readCase).toHaveBeenCalledTimes(3));
    expect(closeEvidence).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback confirmed",
      }),
    ).toBeVisible();
  });

  it("reconstructs a sealed readback without local state and enables immediate review", async () => {
    localStorage.clear();
    mockWallet(evidenceOpenReadback(true), {
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(await screen.findByText("Evidence sealed")).toBeVisible();
    expect(screen.getByText("evidence sealed").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    for (const button of screen.getAllByRole("button", {
      name: "Request intelligent review",
    }))
      expect(button).toBeEnabled();
  });

  it("shows wallet rejection and execution errors without disabling a retry", async () => {
    const closeEvidence = vi
      .fn()
      .mockRejectedValueOnce(new Error("Wallet rejected the seal"))
      .mockResolvedValueOnce(`0x${"c".repeat(64)}`);
    mockWallet(evidenceOpenReadback(), {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_ERROR",
        }),
      },
    });
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);
    const button = await screen.findByRole("button", {
      name: "Close evidence & enable review",
    });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wallet rejected the seal",
    );
    expect(button).toBeEnabled();

    await user.click(button);
    expect(await screen.findByText(/execution error/i)).toBeVisible();
    expect(button).toBeEnabled();
  });
});

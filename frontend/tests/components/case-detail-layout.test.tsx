import { act, render, screen, waitFor, within } from "@testing-library/react";
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
const PENDING_CLOSE_EVIDENCE_PREFIX = "accessseal.pending-close-evidence.v1:";

const mediaTypes: Record<EvidenceType, string> = {
  RELEASE_MANIFEST: "application/json",
  HTML_BUNDLE: "text/html",
  SCREENSHOT: "image/png",
  DOM_FACTS: "application/json",
  SCANNER_REPORT: "application/json",
  CRITICAL_FLOW_TRACE: "application/json",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function persistPendingSeal(
  hash: Hash,
  { account = BUYER, epoch = 0 }: { account?: string; epoch?: number } = {},
) {
  localStorage.setItem(
    `${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`,
    JSON.stringify({
      action: "close_evidence",
      account,
      caseId: CASE_ID,
      chainId: 61999,
      contract: `0x${"4".repeat(40)}`,
      epoch,
      hash,
    }),
  );
}

function finalizedReadback(): ReconciledCase {
  return {
    case: {
      buyer: BUYER,
      caseId: CASE_ID,
      chainId: 61999,
      contractAddress: `0x${"4".repeat(40)}`,
      createdAt: 1_701_230_000,
      escrowAmount: 100n,
      evidenceDeadline: 2_000,
      evidenceCutoff: 1_701_232_000,
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
      readAt: 1_701_232_001,
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

function evidenceReadback(types: EvidenceType[], epoch = 0): EvidenceRecord {
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

function evidenceOpenReadback(sealed = false, epoch = 0): ReconciledCase {
  const readback = finalizedReadback();
  readback.case.lifecycle = sealed ? "EVIDENCE_SEALED" : "EVIDENCE_OPEN";
  readback.case.epoch = epoch;
  readback.case.evidenceSealed = sealed;
  readback.case.evidenceSealedAt = sealed ? 1_701_231_000 : 0;
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
      : vi.fn().mockRejectedValue(new Error("evidence epoch does not exist")),
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

    const button = await screen.findByRole("button", {
      name: "Close evidence & enable review",
    });
    await waitFor(() => expect(button).toBeEnabled());
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
      const button = await screen.findByRole("button", {
        name: "Close evidence & enable review",
      });
      await waitFor(() => expect(button).toBeEnabled());

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
    expect(screen.getByText(/expired evidence types/i)).toHaveTextContent(
      /cannot be replaced in this epoch.*wait for cutoff review.*bounded cure\/new epoch.*timeout recovery/i,
    );
    expect(screen.getByText(/expired evidence types/i)).not.toHaveTextContent(
      /replace them with fresh current-epoch evidence/i,
    );
  });

  it.each([
    ["before", 2_999, false, /1 second until the evidence cutoff/i],
    ["at", 3_000, false, /cutoff reached.*confirming.*finalized contract time/i],
    ["after", 3_001, true, /finalized contract time confirms.*cutoff has passed/i],
  ] as const)(
    "uses the authoritative contract clock %s the unsealed cutoff",
    async (_position, readAt, enabled, statusCopy) => {
      const readback = evidenceOpenReadback();
      readback.case.createdAt = 1_000;
      readback.case.evidenceCutoff = 3_000;
      readback.case.readAt = readAt;
      readback.case.hardDeadline = 4_000;
      mockWallet(readback, {
        contract: { requestReview: vi.fn() },
        evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      });

      render(<CaseDetail caseId={CASE_ID} />);

      const buttons = await screen.findAllByRole("button", {
        name: "Request intelligent review",
      });
      for (const button of buttons) {
        if (enabled) expect(button).toBeEnabled();
        else expect(button).toBeDisabled();
      }
      expect(screen.getByText(statusCopy)).toBeVisible();
    },
  );

  it("keeps review disabled at the exact cutoff and enables only after a refreshed contract clock passes it", async () => {
    const before = evidenceOpenReadback();
    before.case.createdAt = 1_000;
    before.case.evidenceCutoff = 3_000;
    before.case.readAt = 2_999;
    before.case.hardDeadline = 4_000;
    const exact = structuredClone(before);
    exact.case.readAt = 3_000;
    const after = structuredClone(before);
    after.case.readAt = 3_001;
    const reader = mockWallet(before, {
      contract: { requestReview: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });
    reader.readCase
      .mockResolvedValueOnce(before.case)
      .mockResolvedValueOnce(exact.case)
      .mockResolvedValue(after.case);
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      (await screen.findAllByRole("button", {
        name: "Request intelligent review",
      }))[0],
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh readback" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", {
          name: "Request intelligent review",
        })[0],
      ).toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: "Refresh readback" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", {
          name: "Request intelligent review",
        })[0],
      ).toBeEnabled(),
    );
  });

  it("keeps both sealed and fallback review disabled at the exact hard deadline", async () => {
    const sealed = evidenceOpenReadback(true);
    sealed.case.createdAt = 1_000;
    sealed.case.evidenceCutoff = 3_000;
    sealed.case.hardDeadline = 4_000;
    sealed.case.readAt = 5_000;
    mockWallet(sealed, {
      contract: { requestReview: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    for (const button of await screen.findAllByRole("button", {
      name: "Request intelligent review",
    }))
      expect(button).toBeDisabled();
    expect(
      screen.getByText(/hard deadline has expired.*timeout recovery may apply/i),
    ).toBeVisible();
  });

  it("separates wallet confirmation, submission, and consensus pending seal states", async () => {
    let resolveClose: ((hash: Hash) => void) | undefined;
    let resolveAccepted:
      ((receipt: Record<string, string>) => void) | undefined;
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
    expect(
      await screen.findByText(/confirm the seal in your wallet/i),
    ).toBeVisible();
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toBeNull();

    resolveClose?.(`0x${"a".repeat(64)}`);
    expect(
      await screen.findByRole("heading", { name: "Transaction submitted" }),
    ).toBeVisible();
    expect(
      JSON.parse(
        localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`)!,
      ),
    ).toMatchObject({
      action: "close_evidence",
      account: BUYER,
      caseId: CASE_ID,
      chainId: 61999,
      contract: `0x${"4".repeat(40)}`,
      epoch: 0,
      hash: `0x${"a".repeat(64)}`,
    });

    resolveAccepted?.({
      statusName: "ACCEPTED",
      txExecutionResultName: "FINISHED_WITH_RETURN",
    });
    expect(await screen.findByText(/accepted by validators/i)).toBeVisible();
  });

  it("restores a bound persisted seal hash through submitted and consensus states without sending again", async () => {
    const hash = `0x${"b".repeat(64)}` as Hash;
    const accepted = deferred<Record<string, string>>();
    const closeEvidence = vi.fn();
    persistPendingSeal(hash);
    mockWallet(evidenceOpenReadback(), {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn(({ status }: { status: string }) =>
          status === "ACCEPTED"
            ? accepted.promise
            : new Promise(() => undefined),
        ),
      },
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Transaction submitted" }),
    ).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Close evidence & enable review" }),
    ).toBeDisabled();

    await act(async () => {
      accepted.resolve({
        statusName: "ACCEPTED",
        txExecutionResultName: "FINISHED_WITH_RETURN",
      });
    });
    expect(await screen.findByText(/accepted by validators/i)).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
  });

  it("retries a persisted undetermined seal receipt with its original hash", async () => {
    const hash = `0x${"e".repeat(64)}` as Hash;
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const closeEvidence = vi.fn();
    const waitForTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce({ statusName: "UNDETERMINED" })
      .mockResolvedValueOnce({
        statusName: "FINALIZED",
        txExecutionResultName: "FINISHED_WITH_RETURN",
      });
    persistPendingSeal(hash);
    const reader = mockWallet(opened, {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: { waitForTransactionReceipt },
    });
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Transaction undetermined" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry transaction status" }),
    ).toBeEnabled();
    expect(closeEvidence).not.toHaveBeenCalled();

    reader.readCase.mockResolvedValue(sealed.case);
    await user.click(
      screen.getByRole("button", { name: "Retry transaction status" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback confirmed",
      }),
    ).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toBeNull();
  });

  it("retries a persisted receipt RPC failure without resending a submitted seal", async () => {
    const hash = `0x${"f".repeat(64)}` as Hash;
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const closeEvidence = vi.fn().mockResolvedValue(hash);
    const waitForTransactionReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error("Receipt RPC unavailable"))
      .mockResolvedValueOnce({
        statusName: "FINALIZED",
        txExecutionResultName: "FINISHED_WITH_RETURN",
      });
    const reader = mockWallet(opened, {
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

    expect(
      await screen.findByRole("button", { name: "Retry transaction status" }),
    ).toBeEnabled();
    expect(screen.getByText(/receipt rpc unavailable/i)).toBeVisible();
    expect(closeEvidence).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`)!,
      ),
    ).toMatchObject({ hash, epoch: 0 });

    reader.readCase.mockResolvedValue(sealed.case);
    await user.click(
      screen.getByRole("button", { name: "Retry transaction status" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback confirmed",
      }),
    ).toBeVisible();
    expect(closeEvidence).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it("clears a legacy unbound pending seal instead of blocking a new evidence epoch", async () => {
    const hash = `0x${"a".repeat(64)}` as Hash;
    localStorage.setItem(
      `${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`,
      JSON.stringify({
        action: "close_evidence",
        account: BUYER,
        caseId: CASE_ID,
        chainId: 61999,
        contract: `0x${"4".repeat(40)}`,
        hash,
      }),
    );
    const opened = evidenceOpenReadback(false, 1);
    mockWallet(opened, {
      contract: { closeEvidence: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES, 1),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close evidence & enable review" }),
      ).toBeEnabled(),
    );
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toBeNull();
  });

  it("clears a stale epoch-bound pending seal without blocking the current epoch", async () => {
    const hash = `0x${"b".repeat(64)}` as Hash;
    persistPendingSeal(hash, { epoch: 0 });
    const opened = evidenceOpenReadback(false, 1);
    mockWallet(opened, {
      contract: { closeEvidence: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES, 1),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close evidence & enable review" }),
      ).toBeEnabled(),
    );
    await waitFor(() =>
      expect(
        localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
      ).toBeNull(),
    );
  });

  it("reuses a restored finalized seal hash for readback retry without a duplicate send", async () => {
    const hash = `0x${"c".repeat(64)}` as Hash;
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const closeEvidence = vi.fn();
    persistPendingSeal(hash);
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
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByText(/waiting for sealed evidence readback/i),
    ).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Close evidence & enable review" }),
    ).toBeDisabled();

    reader.readCase.mockResolvedValue(sealed.case);
    await user.click(screen.getByRole("button", { name: "Refresh readback" }));

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback confirmed",
      }),
    ).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toBeNull();
  });

  it("does not let a late pre-seal refresh overwrite a newer sealed readback", async () => {
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const staleReadback = deferred<typeof opened.case>();
    const staleStarted = deferred<void>();
    const closeEvidence = vi.fn().mockResolvedValue(`0x${"d".repeat(64)}`);
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
      .mockImplementationOnce(() => {
        staleStarted.resolve();
        return staleReadback.promise;
      })
      .mockResolvedValue(sealed.case);
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);
    await screen.findByRole("button", {
      name: "Close evidence & enable review",
    });
    await user.click(screen.getByRole("button", { name: "Refresh readback" }));
    await staleStarted.promise;
    await user.click(
      screen.getByRole("button", { name: "Close evidence & enable review" }),
    );
    expect(await screen.findByText("Evidence sealed")).toBeVisible();
    await waitFor(() =>
      expect(reader.readCase.mock.calls.length).toBeGreaterThanOrEqual(4),
    );

    await act(async () => {
      staleReadback.resolve(opened.case);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByText("Evidence sealed")).toBeVisible(),
    );
    expect(closeEvidence).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Close evidence & enable review" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer immediate review from an inconsistent sealed lifecycle tuple", async () => {
    const inconsistent = evidenceOpenReadback(true);
    inconsistent.case.evidenceSealed = false;
    inconsistent.case.evidenceSealedAt = 0;
    inconsistent.case.evidenceSealedBy = `0x${"0".repeat(40)}`;
    mockWallet(inconsistent, {
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    await screen.findByText("EVIDENCE SEALED");
    expect(
      screen.queryAllByRole("button", { name: "Request intelligent review" }),
    ).toHaveLength(0);
  });

  it("does not show seal success when final execution has no sealed readback", async () => {
    const readback = evidenceOpenReadback();
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      statusName: "FINALIZED",
      txExecutionResultName: "FINISHED_WITH_RETURN",
    });
    mockWallet(readback, {
      contract: {
        closeEvidence: vi.fn().mockResolvedValue(`0x${"b".repeat(64)}`),
      },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt,
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
    expect(
      screen.getByRole("button", { name: "Refresh readback" }),
    ).toBeEnabled();
    expect(screen.getByText(/fallback review path/i)).toBeVisible();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it("shows seal success and enables review only after sealed authoritative readback", async () => {
    const opened = evidenceOpenReadback();
    const sealed = evidenceOpenReadback(true);
    const reader = mockWallet(opened, {
      contract: {
        closeEvidence: vi.fn().mockResolvedValue(`0x${"d".repeat(64)}`),
      },
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

  it("reconstructs historical seal metadata after reload in DECIDED without offering a duplicate review", async () => {
    const decided = finalizedReadback();
    decided.case.evidenceSealed = true;
    decided.case.evidenceSealedAt = 1_701_231_000;
    decided.case.evidenceSealedBy = BUYER;
    mockWallet(decided, {
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(await screen.findByText("Evidence sealed")).toBeVisible();
    expect(
      screen.queryAllByRole("button", { name: "Request intelligent review" }),
    ).toHaveLength(0);
  });

  it("reconciles a finalized seal receipt when another caller advances the case to DECIDED", async () => {
    const hash = `0x${"f".repeat(64)}` as Hash;
    const opened = evidenceOpenReadback();
    const decided = finalizedReadback();
    decided.case.evidenceSealed = true;
    decided.case.evidenceSealedAt = 1_701_231_000;
    decided.case.evidenceSealedBy = BUYER;
    persistPendingSeal(hash);
    const reader = mockWallet(opened, {
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });
    reader.readCase.mockResolvedValueOnce(opened.case).mockResolvedValue(decided.case);
    reader.readReview.mockResolvedValue(decided.review);
    reader.readReviewFinality.mockResolvedValue(decided.reviewFinality);
    reader.readReviewAttempt.mockResolvedValue(decided.reviewAttempt);

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback confirmed",
      }),
    ).toBeVisible();
    expect(screen.getByText("Evidence sealed")).toBeVisible();
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toBeNull();
    expect(
      screen.queryAllByRole("button", { name: "Request intelligent review" }),
    ).toHaveLength(0);
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

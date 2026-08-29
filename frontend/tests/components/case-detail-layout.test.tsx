import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { abi } from "genlayer-js";
import { CaseDetail } from "@/components/case-detail";
import { StatusPanel } from "@/components/status-panel";
import { useWallet } from "@/providers/wallet-provider";
import type { ReconciledCase } from "@/lib/transactions";
import type { EvidenceEnvelopeV1, EvidenceType } from "@/lib/evidence";
import { AccessSealClient, type EvidenceRecord, type Hash } from "@/lib/access-seal";
import {
  deriveCaseWorkspaceModel,
  type CaseWorkspaceModelInput,
} from "@/components/cases/case-dashboard-model";

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
type TestCalldataValue =
  | string
  | TestCalldataValue[]
  | Map<string, TestCalldataValue>;

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

function actualCloseEvidenceTransaction(
  hash: Hash,
  caseId = CASE_ID,
  contract = `0x${"4".repeat(40)}`,
  sender = BUYER,
  epoch = 0,
) {
  const receiptContext = JSON.stringify({
    binding: {
      chainId: 61999,
      contractAddress: contract,
      caseId,
      epoch,
      profileHash: `0x${"6".repeat(64)}`,
      releaseDigest: `sha256:${"8".repeat(64)}`,
      subjectOrigin: "https://audit.example",
    },
  });
  const receiptBytes = abi.calldata.encode(
    new Map([["contextJson", receiptContext]]),
  );
  const callBytes = abi.calldata.encode(
    new Map<string, TestCalldataValue>([
      ["method", "close_evidence"],
      ["args", [caseId]],
      ["kwargs", new Map()],
    ]),
  );
  return {
    hash,
    sender,
    recipient: contract,
    data: { calldata: { raw: Array.from(callBytes) } },
    consensus_data: {
      leader_receipt: [
        { calldata: { base64: btoa(String.fromCharCode(...receiptBytes)) } },
      ],
    },
  };
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
    config?: Record<string, unknown> | null;
    recoveryTransaction?: unknown;
    reviewContext?: {
      caseId: string;
      epoch: number;
      schemaVersion: "accessseal-review-context/1";
      ready: boolean;
      contextJson: string;
      contextHash: `sha256:${string}`;
      imageUri: string;
      imageSha256: `sha256:${string}`;
    } | null;
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
    readReviewContext: options.reviewContext
      ? vi.fn().mockResolvedValue(options.reviewContext)
      : vi.fn().mockRejectedValue(new Error("review context does not exist")),
    appealEligibility: vi.fn().mockResolvedValue({
      available: false,
      reason:
        "Review transaction ID is unavailable; eligibility cannot be proven.",
      round: null,
      bond: null,
      roundData: null,
    }),
    verifyReviewTransaction: vi.fn().mockResolvedValue(false),
    verifyCloseEvidenceTransaction: (
      hash: Hash,
      input: { account: `0x${string}`; caseId: string },
    ) =>
      new AccessSealClient(
        {
          getTransaction: vi
            .fn()
            .mockResolvedValue(options.recoveryTransaction),
        } as never,
        (options.config?.contractAddress as `0x${string}` | undefined) ??
          (`0x${"4".repeat(40)}` as `0x${string}`),
      ).verifyCloseEvidenceTransaction(hash, input as never),
  };
  vi.mocked(useWallet).mockReturnValue({
    status: "connected",
    address: options.address ?? BUYER,
    error: null,
    contract: options.contract ?? null,
    readContract,
    sdk: options.sdk ?? null,
    config: options.config ?? null,
    connect: vi.fn(),
    changeAccount: options.changeAccount ?? vi.fn(),
    disconnect: vi.fn(),
  } as never);
  return readContract;
}

function readyReviewContext() {
  const contextHash = `sha256:${"a".repeat(64)}` as const;
  return {
    caseId: CASE_ID,
    epoch: 0,
    schemaVersion: "accessseal-review-context/1" as const,
    ready: true,
    contextJson: JSON.stringify({ rubric: "accessseal-static/1" }),
    contextHash,
    imageUri: "https://audit.example/release.png",
    imageSha256: `sha256:${"b".repeat(64)}` as const,
  };
}

describe("case workspace model", () => {
  function sealedWorkspaceInput(): CaseWorkspaceModelInput {
    const reconciledCase = evidenceOpenReadback(true);
    const reviewContext = readyReviewContext();
    reconciledCase.case.reviewContextReady = true;
    reconciledCase.case.reviewContextHash = reviewContext.contextHash;
    return {
      reconciledCase,
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      reviewContext,
      actorAddress: BUYER,
      walletStatus: "connected" as const,
      hasSigner: true,
      transaction: null,
      now: 1_701_232_001,
      retryEligible: false,
      evidenceSubmissionReady: true,
      sealRecoveryPending: false,
    };
  }

  it("offers one enabled review action from sealed authoritative context", () => {
    const model = deriveCaseWorkspaceModel(sealedWorkspaceInput());

    expect(model.primaryAction).toEqual({
      id: "REQUEST_REVIEW",
      label: "Request intelligent review",
      enabled: true,
      requiresWallet: true,
    });
    expect(model.stages.map((stage) => stage.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "current",
      "upcoming",
    ]);
    expect(model.roleWarning).toBeNull();
    expect([model.primaryAction].filter((action) => action.enabled)).toHaveLength(1);
  });

  it("keeps the lifecycle action visible but disabled for the wrong role", () => {
    const input = sealedWorkspaceInput();
    input.reconciledCase.case.lifecycle = "DRAFT";
    input.reconciledCase.case.vendorAccepted = false;
    input.reconciledCase.case.evidenceSealed = false;
    input.reconciledCase.case.evidenceSealedAt = 0;
    input.actorAddress = BUYER;

    const model = deriveCaseWorkspaceModel(input);

    expect(model.primaryAction.id).toBe("ACCEPT_TERMS");
    expect(model.primaryAction.enabled).toBe(false);
    expect(model.primaryActionReason).toMatch(/vendor wallet/i);
    expect(model.roleWarning).toMatch(/buyer wallet.*vendor/i);
  });

  it("explains why evidence submission is disabled before canonical validation", () => {
    const input = sealedWorkspaceInput();
    input.reconciledCase.case.lifecycle = "FUNDED";
    input.reconciledCase.case.evidenceSealed = false;
    input.reconciledCase.case.evidenceSealedAt = 0;
    input.actorAddress = VENDOR;
    input.evidenceSubmissionReady = false;

    const model = deriveCaseWorkspaceModel(input);

    expect(model.primaryAction.id).toBe("SUBMIT_EVIDENCE");
    expect(model.primaryAction.enabled).toBe(false);
    expect(model.primaryActionReason).toMatch(/canonical preview/i);
  });

  it("does not request review until the exact context readback is ready", () => {
    const input = sealedWorkspaceInput();
    input.reviewContext = null;

    const model = deriveCaseWorkspaceModel(input);

    expect(model.primaryAction.id).toBe("REQUEST_REVIEW");
    expect(model.primaryAction.enabled).toBe(false);
    expect(model.primaryActionReason).toMatch(/review context/i);
    expect(model.verdictTone).toBe("neutral");
  });

  it("offers an eligible retry after a finalized unresolved review", () => {
    const input = sealedWorkspaceInput();
    const unresolved = finalizedReadback();
    unresolved.review!.verdict = "UNRESOLVED";
    unresolved.reviewAttempt!.review.verdict = "UNRESOLVED";
    input.reconciledCase = unresolved;
    input.retryEligible = true;

    const model = deriveCaseWorkspaceModel(input);

    expect(model.primaryAction).toEqual({
      id: "RETRY_REVIEW",
      label: "Retry intelligent review",
      enabled: true,
      requiresWallet: true,
    });
    expect(model.verdictTone).toBe("warning");
  });

  it("marks finalized dispatch complete and exposes only immutable activity", () => {
    const input = sealedWorkspaceInput();
    const settled = finalizedReadback();
    settled.case.lifecycle = "DISPATCHED_FINALIZED";
    settled.settlement = {
      amount: 100n,
      caseId: CASE_ID,
      epoch: 0,
      executor: BUYER,
      kind: "PAYOUT",
      reason: "APPROVED",
      recipient: VENDOR,
      reviewProofId: "proof-1",
      settlementId: "settlement-1",
      status: "DISPATCHED_FINALIZED",
    };
    input.reconciledCase = settled;

    const model = deriveCaseWorkspaceModel(input);

    expect(model.primaryAction.id).toBe("SETTLED");
    expect(model.primaryAction.enabled).toBe(false);
    expect(model.stages.map((stage) => stage.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
    expect(model.activityRows.some((row) => row.proof === "settlement-1")).toBe(true);
  });
});

describe("case detail document layout", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("renders the V4 evidence command center from authoritative sealed readback", async () => {
    const readback = evidenceOpenReadback(true);
    const reviewContext = readyReviewContext();
    readback.case.reviewContextReady = true;
    readback.case.reviewContextHash = reviewContext.contextHash;
    mockWallet(readback, {
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      reviewContext,
      contract: { requestReview: vi.fn() },
    });

    render(<CaseDetail caseId={CASE_ID} />);

    for (const heading of [
      "Evidence workspace",
      "Intelligent review",
      "Simulated escrow",
      "Immutable activity",
    ])
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeVisible();
    for (const label of [
      "Release manifest",
      "HTML bundle",
      "Screenshot",
      "DOM facts",
      "Scanner report",
      "Critical flow trace",
    ])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Active wallet role")).toBeVisible();
    expect(screen.getByText("Active wallet role").parentElement).toHaveTextContent(
      "Buyer",
    );
  });

  it("never exposes an approved verdict before finalized review readback", async () => {
    const pending = finalizedReadback();
    pending.reviewFinality!.status = "PENDING_PROTOCOL_FINALITY";
    pending.reviewAttempt!.status = "PENDING_PROTOCOL_FINALITY";
    mockWallet(pending);

    render(<CaseDetail caseId={CASE_ID} />);

    await screen.findByRole("heading", { name: "Case summary" });
    expect(screen.queryByText("APPROVED")).not.toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });

  it("renders the command center in the approved operational order", async () => {
    mockWallet(finalizedReadback());
    render(<CaseDetail caseId={CASE_ID} />);

    const summary = await screen.findByRole("region", { name: "Case summary" });
    const progression = screen.getByRole("region", { name: "Case progression" });
    const evidencePanel = screen.getByRole("region", { name: "Evidence workspace" });
    const reviewPanel = screen.getByRole("region", { name: "Intelligent review" });
    const accounting = screen.getByRole("region", { name: "Simulated escrow" });
    const activity = screen.getByRole("region", { name: "Immutable activity" });

    expect(summary.compareDocumentPosition(progression) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(evidencePanel.compareDocumentPosition(reviewPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reviewPanel.compareDocumentPosition(accounting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(accounting.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("places the single authoritative action immediately after the keyboard-focusable stepper", async () => {
    const readback = evidenceOpenReadback(true);
    const reviewContext = readyReviewContext();
    readback.case.reviewContextReady = true;
    readback.case.reviewContextHash = reviewContext.contextHash;
    mockWallet(readback, {
      contract: { requestReview: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      reviewContext,
    });
    const user = userEvent.setup();
    render(<CaseDetail caseId={CASE_ID} />);

    const stepper = await screen.findByRole("list", { name: "Case lifecycle" });
    stepper.focus();
    await user.tab();

    expect(
      screen.getByRole("button", { name: "Request intelligent review" }),
    ).toHaveFocus();
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
    expect(screen.getByText("Consensus pending")).toHaveAttribute(
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
    mockWallet(readback, {
      contract: { executeSettlement: vi.fn() },
    });

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
    ).toHaveLength(1);
  });

  it("disables the seal action for a wrong wallet and lets the user change wallets", async () => {
    const changeAccount = vi.fn().mockResolvedValue(undefined);
    mockWallet(evidenceOpenReadback(), {
      address: VENDOR,
      changeAccount,
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });
    const user = userEvent.setup();

    render(<CaseDetail caseId={CASE_ID} />);

    await screen.findByRole("heading", { name: "Evidence workspace" });
    expect(
      screen.getByRole("button", {
        name: "Close evidence & enable review",
      }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/vendor wallet.*buyer wallet/i)[0],
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
      /remain immutable in this epoch.*bounded recovery.*contract lifecycle/i,
    );
    expect(screen.getByText(/expired evidence types/i)).not.toHaveTextContent(
      /replace them with fresh current-epoch evidence/i,
    );
  });

  it("keeps sealed review disabled at the exact hard deadline", async () => {
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
      screen.getByText(/contract clock has reached the hard deadline/i),
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
    expect(await screen.findByText(/validators accepted the transaction/i)).toBeVisible();
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
    expect(await screen.findByText(/validators accepted the transaction/i)).toBeVisible();
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
      await screen.findByRole("heading", { name: "Transaction validators timeout" }),
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
    expect(
      screen.getByRole("heading", { name: "Transaction rpc error" }),
    ).toBeVisible();
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

  it("does not confirm an arbitrary persisted finalized-success hash for an already sealed case", async () => {
    const hash = `0x${"c".repeat(64)}` as Hash;
    const sealed = evidenceOpenReadback(true);
    const closeEvidence = vi.fn();
    persistPendingSeal(hash);
    mockWallet(sealed, {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      config: {
        network: "studionet",
        chainId: 61999,
        contractChainId: 1,
        contractAddress: `0x${"4".repeat(40)}`,
        explorerBaseUrl: "https://studio.genlayer.com",
      },
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback mismatch",
      }),
    ).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toContain(hash);
  });

  it("confirms a persisted sealed recovery only with configured-chain close evidence proof", async () => {
    const hash = `0x${"c".repeat(64)}` as Hash;
    const sealed = evidenceOpenReadback(true);
    const closeEvidence = vi.fn();
    persistPendingSeal(hash);
    mockWallet(sealed, {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      config: {
        network: "studionet",
        chainId: 61999,
        contractChainId: 1,
        contractAddress: `0x${"4".repeat(40)}`,
        explorerBaseUrl: "https://studio.genlayer.com",
      },
      recoveryTransaction: actualCloseEvidenceTransaction(hash),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });

    render(<CaseDetail caseId={CASE_ID} />);

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

  it("does not bypass a persisted sealed recovery on the wrong configured chain", async () => {
    const hash = `0x${"d".repeat(64)}` as Hash;
    persistPendingSeal(hash);
    mockWallet(evidenceOpenReadback(true), {
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      config: {
        network: "localnet",
        chainId: 61127,
        contractChainId: 1,
        contractAddress: `0x${"4".repeat(40)}`,
        explorerBaseUrl: null,
      },
      recoveryTransaction: actualCloseEvidenceTransaction(hash),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback mismatch",
      }),
    ).toBeVisible();
    expect(localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`)).toContain(hash);
  });

  it("keeps a persisted seal hash recoverable when its authoritative state is not sealed", async () => {
    const hash = `0x${"e".repeat(64)}` as Hash;
    const closeEvidence = vi.fn();
    persistPendingSeal(hash);
    mockWallet(evidenceOpenReadback(), {
      contract: { closeEvidence },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
      sdk: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          statusName: "FINALIZED",
          txExecutionResultName: "FINISHED_WITH_RETURN",
        }),
      },
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(
      await screen.findByRole("heading", {
        name: "Transaction readback mismatch",
      }),
    ).toBeVisible();
    expect(closeEvidence).not.toHaveBeenCalled();
    expect(localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`)).not.toBeNull();
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
      (await screen.findByRole("heading", {
        name: "Transaction readback mismatch",
      }))
        .closest("[role='status']"),
    ).toHaveAttribute("data-tone", "danger");
    expect(
      screen.getByRole("button", { name: "Close evidence & enable review" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Retry transaction status" }),
    ).toBeEnabled();
    expect(
      localStorage.getItem(`${PENDING_CLOSE_EVIDENCE_PREFIX}${CASE_ID}`),
    ).toContain(`0x${"b".repeat(64)}`);
    expect(
      screen.getByRole("button", { name: "Refresh readback" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Close evidence & enable review" }),
    ).toBeDisabled();
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
    expect(
      await screen.findByRole("heading", { name: "Transaction rpc error" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry transaction status" }),
    ).toBeEnabled();

    await user.click(
      screen.getByRole("button", { name: "Retry transaction status" }),
    );
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
      contract: { requestReview: vi.fn() },
      evidence: evidenceReadback(REQUIRED_EVIDENCE_TYPES),
    });

    render(<CaseDetail caseId={CASE_ID} />);

    expect(await screen.findByText("Evidence sealed")).toBeVisible();
    const lifecycle = screen.getByRole("list", { name: "Case lifecycle" });
    expect(within(lifecycle).getByText("Evidence sealed").closest("li")).toHaveAttribute(
      "data-state",
      "complete",
    );
    expect(within(lifecycle).getByText("AI review").closest("li")).toHaveAttribute(
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
    expect(
      await screen.findByRole("heading", { name: "Transaction execution error" }),
    ).toBeVisible();
    expect(button).toBeEnabled();
  });
});

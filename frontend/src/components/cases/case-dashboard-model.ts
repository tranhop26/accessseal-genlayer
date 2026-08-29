import type {
  CaseRecord,
  EvidenceRecord,
  ReviewContextRecord,
  ReviewFinality,
  ReviewRecord,
  Settlement,
} from "@/lib/access-seal";
import type { ReconciledCase, TransactionState } from "@/lib/transactions";

export type DashboardCase = {
  caseId: string;
  case: CaseRecord | null;
  evidence: EvidenceRecord | null;
  review: ReviewRecord | null;
  finality: ReviewFinality | null;
  settlement: Settlement | null;
  readError: string | null;
};

export type DashboardFilters = {
  lifecycle: string;
  verdict: string;
};

export function deriveDashboardMetrics(
  rows: readonly DashboardCase[],
  knownCaseCount = rows.length,
) {
  let awaitingEvidence = 0;
  let underReview = 0;
  let readyToSettle = 0;

  for (const row of rows) {
    if (row.readError || !row.case) continue;

    if (
      row.case.lifecycle === "FUNDED" ||
      (row.case.lifecycle === "EVIDENCE_OPEN" && row.evidence === null)
    )
      awaitingEvidence += 1;
    if (
      row.case.lifecycle === "REVIEW_PENDING" ||
      row.case.lifecycle === "EVIDENCE_SEALED"
    )
      underReview += 1;
    if (
      row.finality?.status === "FINALIZED" &&
      (row.review?.verdict === "APPROVED" ||
        row.review?.verdict === "REJECTED") &&
      row.settlement?.status !== "DISPATCHED_FINALIZED"
    )
      readyToSettle += 1;
  }

  return {
    total: knownCaseCount,
    awaitingEvidence,
    underReview,
    readyToSettle,
  };
}

export function filterDashboardCases(
  rows: readonly DashboardCase[],
  filters: DashboardFilters,
) {
  return rows.filter((row) => {
    if (row.readError) return true;
    if (!row.case) return false;
    const lifecycleMatches =
      filters.lifecycle === "ALL" || row.case.lifecycle === filters.lifecycle;
    const verdictMatches =
      filters.verdict === "ALL" || row.review?.verdict === filters.verdict;
    return lifecycleMatches && verdictMatches;
  });
}

export type CaseWorkspaceActionId =
  | "ACCEPT_TERMS"
  | "FUND"
  | "SUBMIT_EVIDENCE"
  | "CLOSE_EVIDENCE"
  | "REQUEST_REVIEW"
  | "RETRY_REVIEW"
  | "START_CURE"
  | "EXPIRE_UNRESOLVED"
  | "TIMEOUT_REFUND"
  | "PREPARE_SETTLEMENT"
  | "EXECUTE_SETTLEMENT"
  | "AWAIT_FINALITY"
  | "SETTLED";

export type CaseWorkspacePrimaryAction = {
  id: CaseWorkspaceActionId;
  label: string;
  enabled: boolean;
  requiresWallet: boolean;
};

export type CaseWorkspaceStage = {
  id: "FUNDED" | "TERMS" | "EVIDENCE" | "REVIEW" | "SETTLEMENT";
  label: string;
  state: "complete" | "current" | "upcoming";
  nextActor: string;
  nextAction: string;
};

export type CaseActivityRow = {
  id: string;
  label: string;
  detail: string;
  timestamp: number | null;
  actor: string | null;
  proof: string | null;
};

export type CaseWorkspaceModelInput = {
  reconciledCase: ReconciledCase;
  evidence: EvidenceRecord | null;
  reviewContext: ReviewContextRecord | null;
  actorAddress: string | null;
  walletStatus:
    | "connected"
    | "connecting"
    | "disconnected"
    | "switching"
    | "wrong-network";
  hasSigner: boolean;
  transaction: TransactionState | null;
  now: number;
  retryEligible: boolean;
  evidenceSubmissionReady: boolean;
  sealRecoveryPending: boolean;
};

export type CaseWorkspaceModel = {
  primaryAction: CaseWorkspacePrimaryAction;
  primaryActionReason: string | null;
  stages: CaseWorkspaceStage[];
  roleWarning: string | null;
  actorRole: "Buyer" | "Vendor" | "Reviewer" | "Observer";
  verdictTone: "success" | "danger" | "warning" | "neutral";
  finalizedVerdict: ReviewRecord["verdict"] | null;
  activityRows: CaseActivityRow[];
};

const REQUIRED_EVIDENCE_TYPES = new Set([
  "RELEASE_MANIFEST",
  "HTML_BUNDLE",
  "SCREENSHOT",
  "DOM_FACTS",
  "SCANNER_REPORT",
  "CRITICAL_FLOW_TRACE",
]);

const ACTION_LABELS: Record<CaseWorkspaceActionId, string> = {
  ACCEPT_TERMS: "Accept exact terms",
  FUND: "Fund simulated escrow",
  SUBMIT_EVIDENCE: "Submit evidence",
  CLOSE_EVIDENCE: "Close evidence & enable review",
  REQUEST_REVIEW: "Request intelligent review",
  RETRY_REVIEW: "Retry intelligent review",
  START_CURE: "Start bounded cure",
  EXPIRE_UNRESOLVED: "Expire unresolved review",
  TIMEOUT_REFUND: "Prepare timeout refund",
  PREPARE_SETTLEMENT: "Prepare settlement",
  EXECUTE_SETTLEMENT: "Execute prepared settlement",
  AWAIT_FINALITY: "Await protocol finality",
  SETTLED: "Settlement finalized",
};

function connected(input: CaseWorkspaceModelInput) {
  return input.walletStatus === "connected" && input.hasSigner;
}

function normalized(value: string | null | undefined) {
  return value?.toLowerCase() ?? "";
}

function isBoundReviewContext(input: CaseWorkspaceModelInput) {
  const context = input.reviewContext;
  const caseRecord = input.reconciledCase.case;
  return (
    caseRecord.reviewContextReady === true &&
    !!caseRecord.reviewContextHash &&
    context?.ready === true &&
    context.caseId === caseRecord.caseId &&
    context.epoch === caseRecord.epoch &&
    context.contextHash === caseRecord.reviewContextHash
  );
}

function completeEvidence(input: CaseWorkspaceModelInput) {
  const current = (input.evidence?.envelopes ?? []).filter(
    (item) => item.epoch === input.reconciledCase.case.epoch && item.expiresAt > input.now,
  );
  return (
    current.length === REQUIRED_EVIDENCE_TYPES.size &&
    current.every((item) => REQUIRED_EVIDENCE_TYPES.has(item.evidenceType)) &&
    new Set(current.map((item) => item.evidenceType)).size ===
      REQUIRED_EVIDENCE_TYPES.size
  );
}

function roleFor(input: CaseWorkspaceModelInput): CaseWorkspaceModel["actorRole"] {
  if (input.walletStatus !== "connected" || !input.actorAddress) return "Observer";
  const actor = normalized(input.actorAddress);
  if (actor === normalized(input.reconciledCase.case.buyer)) return "Buyer";
  if (actor === normalized(input.reconciledCase.case.vendor)) return "Vendor";
  return "Reviewer";
}

function action(
  id: CaseWorkspaceActionId,
  enabled: boolean,
  requiresWallet = true,
): CaseWorkspacePrimaryAction {
  return { id, label: ACTION_LABELS[id], enabled, requiresWallet };
}

function derivePrimaryAction(input: CaseWorkspaceModelInput): {
  primaryAction: CaseWorkspacePrimaryAction;
  primaryActionReason: string | null;
  roleWarning: string | null;
} {
  const { case: caseRecord, review, reviewFinality, reviewAttempt, settlement } =
    input.reconciledCase;
  const actorRole = roleFor(input);
  const signerReady = connected(input);
  const wrongRole = (expected: "Buyer" | "Vendor") =>
    actorRole === "Observer"
      ? `Connect the ${expected.toLowerCase()} wallet to continue.`
      : `The active ${actorRole.toLowerCase()} wallet cannot perform this action; use the ${expected.toLowerCase()} wallet.`;
  const withRole = (
    id: CaseWorkspaceActionId,
    expected: "Buyer" | "Vendor",
    otherwiseReason?: string,
  ) => {
    const correctRole = actorRole === expected;
    const reason = !correctRole
      ? wrongRole(expected)
      : !signerReady
        ? `Reconnect the ${expected.toLowerCase()} wallet signer to continue.`
        : (otherwiseReason ?? null);
    return {
      primaryAction: action(id, correctRole && signerReady && !otherwiseReason),
      primaryActionReason: reason,
      roleWarning: !correctRole ? reason : null,
    };
  };
  const withAnySigner = (id: CaseWorkspaceActionId, blocker?: string) => ({
    primaryAction: action(id, signerReady && !blocker),
    primaryActionReason: blocker ?? (signerReady ? null : "Connect a wallet signer to continue."),
    roleWarning: null,
  });

  if (settlement?.status === "DISPATCHED_FINALIZED")
    return {
      primaryAction: action("SETTLED", false, false),
      primaryActionReason: "The contract reports finalized settlement dispatch.",
      roleWarning: null,
    };
  if (settlement?.status === "PREPARED")
    return withAnySigner("EXECUTE_SETTLEMENT");

  const finalizedReview = reviewFinality?.status === "FINALIZED" && !!review;
  if (finalizedReview) {
    if (review.verdict === "UNRESOLVED") {
      const exhausted =
        !!reviewAttempt && reviewAttempt.attempt >= caseRecord.maxUnresolvedRetries;
      if (exhausted) return withAnySigner("EXPIRE_UNRESOLVED");
      return withAnySigner(
        "RETRY_REVIEW",
        input.retryEligible
          ? undefined
          : "The authoritative retry cooldown has not elapsed.",
      );
    }
    if (review.verdict === "REQUEST_MORE_INFO") {
      if (caseRecord.epoch > 0) return withAnySigner("EXPIRE_UNRESOLVED");
      return withRole("START_CURE", "Vendor");
    }
    return withAnySigner("PREPARE_SETTLEMENT");
  }

  if (review || reviewFinality)
    return {
      primaryAction: action("AWAIT_FINALITY", false, false),
      primaryActionReason:
        "The review is not finalized. Settlement and verdict display remain locked.",
      roleWarning: null,
    };

  const hardDeadlineReached =
    caseRecord.createdAt !== null &&
    caseRecord.readAt !== null &&
    caseRecord.readAt >= caseRecord.createdAt + caseRecord.hardDeadline;
  if (
    hardDeadlineReached &&
    caseRecord.readAt !== caseRecord.createdAt! + caseRecord.hardDeadline &&
    ["FUNDED", "EVIDENCE_OPEN", "EVIDENCE_SEALED"].includes(caseRecord.lifecycle)
  )
    return withAnySigner("TIMEOUT_REFUND");

  if (hardDeadlineReached)
    return withAnySigner(
      caseRecord.lifecycle === "EVIDENCE_SEALED"
        ? "REQUEST_REVIEW"
        : "TIMEOUT_REFUND",
      "The finalized contract clock has reached the hard deadline; refresh after it passes for timeout recovery.",
    );

  if (caseRecord.lifecycle === "EVIDENCE_SEALED" && caseRecord.evidenceSealed) {
    const contextBlocker =
      caseRecord.reviewContextReady === undefined || isBoundReviewContext(input)
      ? undefined
      : "The exact review context is not ready or its authoritative binding is unavailable.";
    return withAnySigner("REQUEST_REVIEW", contextBlocker);
  }
  if (caseRecord.lifecycle === "EVIDENCE_OPEN") {
    if (actorRole === "Buyer" || completeEvidence(input))
      return withRole(
        "CLOSE_EVIDENCE",
        "Buyer",
        input.sealRecoveryPending
          ? "The original evidence-seal transaction is still being recovered; its receipt and readback must resolve before another write."
          : completeEvidence(input)
            ? undefined
          : "All six fresh, current-epoch evidence types are required before sealing.",
      );
    return withRole(
      "SUBMIT_EVIDENCE",
      "Vendor",
      input.evidenceSubmissionReady
        ? undefined
        : "Validate the canonical preview before submitting this evidence envelope.",
    );
  }
  if (caseRecord.lifecycle === "FUNDED")
    return withRole(
      "SUBMIT_EVIDENCE",
      "Vendor",
      input.evidenceSubmissionReady
        ? undefined
        : "Validate the canonical preview before submitting this evidence envelope.",
    );
  if (caseRecord.lifecycle === "DRAFT" && !caseRecord.vendorAccepted)
    return withRole("ACCEPT_TERMS", "Vendor");
  if (caseRecord.lifecycle === "DRAFT") return withRole("FUND", "Buyer");

  return {
    primaryAction: action("AWAIT_FINALITY", false, false),
    primaryActionReason: "No contract-authorized write is available in this lifecycle.",
    roleWarning: null,
  };
}

function deriveStages(input: CaseWorkspaceModelInput): CaseWorkspaceStage[] {
  const { case: caseRecord, review, reviewFinality, settlement } =
    input.reconciledCase;
  const reviewed = reviewFinality?.status === "FINALIZED" && !!review;
  const settled = settlement?.status === "DISPATCHED_FINALIZED";
  const funded = caseRecord.lifecycle !== "DRAFT" || reviewed || !!settlement;
  const terms = caseRecord.vendorAccepted || reviewed || !!settlement;
  const sealed =
    (caseRecord.evidenceSealed && caseRecord.evidenceSealedAt > 0) ||
    reviewed ||
    !!settlement;
  const completed = [funded, terms, sealed, reviewed, settled];
  const currentIndex = completed.findIndex((value) => !value);
  const definitions = [
    ["FUNDED", "Funded", "Buyer", "Fund the simulated escrow"],
    ["TERMS", "Terms accepted", "Vendor", "Accept the exact terms"],
    ["EVIDENCE", "Evidence sealed", "Buyer", "Seal complete evidence"],
    ["REVIEW", "AI review", "Reviewer", "Request or finalize intelligent review"],
    ["SETTLEMENT", "Settlement", "Participant", "Prepare and execute settlement"],
  ] as const;
  return definitions.map(([id, label, nextActor, nextAction], index) => ({
    id,
    label,
    state: completed[index]
      ? "complete"
      : index === currentIndex
        ? "current"
        : "upcoming",
    nextActor,
    nextAction,
  }));
}

function deriveVerdict(input: CaseWorkspaceModelInput) {
  const { review, reviewFinality } = input.reconciledCase;
  const finalizedVerdict =
    reviewFinality?.status === "FINALIZED" ? (review?.verdict ?? null) : null;
  const verdictTone: CaseWorkspaceModel["verdictTone"] =
    finalizedVerdict === "APPROVED"
      ? "success"
      : finalizedVerdict === "REJECTED"
        ? "danger"
        : finalizedVerdict === "REQUEST_MORE_INFO" || finalizedVerdict === "UNRESOLVED"
          ? "warning"
          : "neutral";
  return { finalizedVerdict, verdictTone };
}

function deriveActivity(input: CaseWorkspaceModelInput): CaseActivityRow[] {
  const { case: caseRecord, review, reviewFinality, reviewAttempt, settlement } =
    input.reconciledCase;
  const rows: CaseActivityRow[] = [];
  if (caseRecord.createdAt !== null)
    rows.push({
      id: "created",
      label: "Case created",
      detail: "The authoritative case record exposes its creation time.",
      timestamp: caseRecord.createdAt,
      actor: caseRecord.buyer,
      proof: caseRecord.termsHash,
    });
  if (caseRecord.evidenceSealed && caseRecord.evidenceSealedAt > 0)
    rows.push({
      id: `evidence-sealed-${caseRecord.epoch}`,
      label: "Evidence sealing finalized",
      detail: `Epoch ${caseRecord.epoch} evidence was sealed on contract.`,
      timestamp: caseRecord.evidenceSealedAt,
      actor: caseRecord.evidenceSealedBy,
      proof: input.evidence?.releaseDigest ?? null,
    });
  if (
    review &&
    reviewFinality?.status === "FINALIZED" &&
    reviewAttempt?.status === "FINALIZED"
  )
    rows.push({
      id: `review-finalized-${reviewFinality.attempt}`,
      label: "Intelligent review finalized",
      detail: `${review.verdict.replaceAll("_", " ")} verdict finalized for epoch ${reviewFinality.epoch}.`,
      timestamp: reviewAttempt.finalizedAt || reviewAttempt.decidedAt || null,
      actor: null,
      proof: reviewFinality.proofId,
    });
  if (settlement)
    rows.push({
      id: `settlement-${settlement.settlementId}`,
      label:
        settlement.status === "DISPATCHED_FINALIZED"
          ? "Settlement dispatch finalized"
          : "Settlement intent prepared",
      detail: `${settlement.kind} of ${settlement.amount.toString()} wei to ${settlement.recipient}.`,
      timestamp: null,
      actor: settlement.executor || null,
      proof: settlement.settlementId,
    });
  return rows.sort((left, right) => (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER));
}

export function deriveCaseWorkspaceModel(
  input: CaseWorkspaceModelInput,
): CaseWorkspaceModel {
  let primary = derivePrimaryAction(input);
  const transactionInFlight = new Set([
    "WAITING_FOR_WALLET",
    "SUBMITTED",
    "CONSENSUS_PENDING",
    "PROTOCOL_FINALIZED",
    "EXECUTION_SUCCESS",
    "PENDING",
    "ACCEPTED",
    "RECONCILING",
    "FINALIZED_SUCCESS",
  ]).has(input.transaction?.phase ?? "");
  if (transactionInFlight && primary.primaryAction.enabled)
    primary = {
      ...primary,
      primaryAction: { ...primary.primaryAction, enabled: false },
      primaryActionReason:
        "The submitted transaction is still progressing; authoritative readback must complete before another write.",
    };
  const verdict = deriveVerdict(input);
  return {
    ...primary,
    stages: deriveStages(input),
    actorRole: roleFor(input),
    ...verdict,
    activityRows: deriveActivity(input),
  };
}

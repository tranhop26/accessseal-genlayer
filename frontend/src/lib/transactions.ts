import type {
  Accounting,
  CaseRecord,
  ReviewFinality,
  ReviewRecord,
  ReviewAttempt,
  Settlement,
} from "./access-seal";
import { matchesExactUserError } from "./access-seal";

export type TransactionPhase =
  | "WAITING_FOR_WALLET"
  | "SUBMITTED"
  | "CONSENSUS_PENDING"
  | "PROTOCOL_FINALIZED"
  | "EXECUTION_SUCCESS"
  | "READBACK_CONFIRMED"
  | TransactionFailureKind
  // V3 UI history remains renderable, but new tracking never emits these values.
  | "PENDING"
  | "ACCEPTED"
  | "RECONCILING"
  | "FINALIZED_SUCCESS"
  | "UNDETERMINED"
  | "EXECUTION_ERROR"
  | "REJECTED";
export type TransactionFailureKind =
  | "WALLET_REJECTED"
  | "WRONG_ROLE"
  | "RPC_ERROR"
  | "VALIDATORS_TIMEOUT"
  | "DETERMINISTIC_VIOLATION"
  | "EXECUTION_ERROR"
  | "READBACK_MISMATCH";
export type TransactionState = {
  phase: TransactionPhase;
  hash: `0x${string}` | null;
  message: string;
};
export type PendingAction =
  | "accept_terms"
  | "fund"
  | "open_evidence"
  | "append_evidence"
  | "close_evidence"
  | "request_review"
  | "start_cure"
  | "retry_review"
  | "expire_unresolved"
  | "timeout_refund"
  | "prepare_settlement"
  | "execute_settlement"
  | "appeal";
type Receipt = {
  statusName?: string;
  status_name?: string;
  status?: string | number;
  resultName?: string;
  txExecutionResultName?: string;
  error?: unknown;
  executionError?: unknown;
  data?: { error?: unknown; executionError?: unknown };
  messages?: unknown[];
  consensus_data?: {
    leader_receipt?: Array<{ genvm_result?: unknown }>;
  };
};
type ReceiptClient = {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    status: "ACCEPTED" | "FINALIZED";
  }): Promise<Receipt>;
};

function normalizedStatus(receipt: Receipt): string {
  return String(receipt.statusName ?? receipt.status_name ?? receipt.status ?? "");
}
const VALIDATOR_TIMEOUT_STATUSES = new Set([
  "VALIDATORS_TIMEOUT",
  "LEADER_TIMEOUT",
  "CANCELED",
  "UNDETERMINED",
]);
// These are the pinned genlayer-js result-name literals.  Consensus disagreement
// is not itself the SDK's deterministic-execution result.
const DETERMINISTIC_RESULT_NAMES = new Set(["DETERMINISTIC_VIOLATION"]);
const ACCESS_SEAL_ROLE_ERRORS = [
  "only the vendor can accept terms",
  "only the buyer can fund",
  "only the vendor can open evidence",
  "only the vendor can append evidence",
  "only the buyer can close evidence",
  "only the vendor can start a cure",
] as const;

function matchesExactRoleError(value: unknown, expected: string): boolean {
  let current = value;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (matchesExactUserError(current, expected)) return true;
    if (current instanceof Error) {
      if (current.message === `gen_call failed: ${expected}`) return true;
      current = current.cause;
    } else if (typeof current === "object" && "cause" in current)
      current = (current as { cause?: unknown }).cause;
    else break;
  }
  return false;
}
function isKnownRoleFailure(value: unknown): boolean {
  return ACCESS_SEAL_ROLE_ERRORS.some((expected) =>
    matchesExactRoleError(value, expected),
  );
}
function exactGenVmUserErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as { stderr?: unknown; kind?: unknown; message?: unknown };
  if (result.kind === "UserError" && typeof result.message === "string")
    return result.message;
  if (typeof result.stderr !== "string") return;
  const match = /^UserError\(message='([^']+)'\)$/.exec(result.stderr);
  return match?.[1];
}
function receiptRoleFailure(receipt: Receipt): boolean {
  const conventionalFailures = [
    receipt.error,
    receipt.executionError,
    receipt.data?.error,
    receipt.data?.executionError,
    ...(receipt.messages ?? []),
  ];
  if (conventionalFailures.some(isKnownRoleFailure)) return true;
  return (receipt.consensus_data?.leader_receipt ?? []).some((leader) => {
    const message = exactGenVmUserErrorMessage(leader.genvm_result);
    return message !== undefined && ACCESS_SEAL_ROLE_ERRORS.includes(message as never);
  });
}
function state(
  hash: `0x${string}` | null,
  phase: TransactionPhase,
  message: string,
): TransactionState {
  return { hash, phase, message };
}
export function waitingForWallet(): TransactionState {
  return state(null, "WAITING_FOR_WALLET", "Waiting for wallet confirmation. No transaction has been submitted.");
}
function failureFor(
  hash: `0x${string}` | null,
  kind: TransactionFailureKind,
): TransactionState {
  const messages: Record<TransactionFailureKind, string> = {
    WALLET_REJECTED: "Wallet confirmation was rejected. No transaction was sent.",
    WRONG_ROLE: "The connected wallet is not authorized for this action.",
    RPC_ERROR: "Transaction status could not be read from the RPC.",
    VALIDATORS_TIMEOUT: "Validators reported an undetermined transaction status.",
    DETERMINISTIC_VIOLATION: "Validators rejected the transaction deterministically.",
    EXECUTION_ERROR: "The transaction finalized with an execution error.",
    READBACK_MISMATCH: "Authoritative contract readback did not confirm this action.",
  };
  return state(hash, kind, messages[kind]);
}
export function classifyTransactionFailure(
  error: unknown,
  hash: `0x${string}` | null = null,
): TransactionState {
  if (isKnownRoleFailure(error)) return failureFor(hash, "WRONG_ROLE");
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 4001) return failureFor(hash, "WALLET_REJECTED");
  }
  return failureFor(hash, "RPC_ERROR");
}

export async function trackTransaction(
  client: ReceiptClient,
  hash: `0x${string}`,
  onState: (value: TransactionState) => void,
  reconcile?: (action?: PendingAction) => Promise<boolean>,
  action?: PendingAction,
): Promise<TransactionState> {
  onState(state(hash, "SUBMITTED", "Transaction submitted; waiting for validator consensus."));
  let accepted: Receipt;
  try {
    accepted = await client.waitForTransactionReceipt({ hash, status: "ACCEPTED" });
  } catch (error) {
    const result = classifyTransactionFailure(error, hash);
    onState(result);
    return result;
  }
  const acceptedStatus = normalizedStatus(accepted);
  if (VALIDATOR_TIMEOUT_STATUSES.has(acceptedStatus)) {
    const result = failureFor(hash, "VALIDATORS_TIMEOUT");
    onState(result);
    return result;
  }
  if (receiptRoleFailure(accepted)) {
    const result = failureFor(hash, "WRONG_ROLE");
    onState(result);
    return result;
  }
  if (DETERMINISTIC_RESULT_NAMES.has(String(accepted.resultName ?? ""))) {
    const result = failureFor(hash, "DETERMINISTIC_VIOLATION");
    onState(result);
    return result;
  }
  if (accepted.txExecutionResultName === "FINISHED_WITH_ERROR") {
    const result = state(
      hash,
      "EXECUTION_ERROR",
      "The transaction finalized with an execution error.",
    );
    onState(result);
    return result;
  }
  if (acceptedStatus !== "ACCEPTED" && acceptedStatus !== "FINALIZED") {
    const result = failureFor(hash, "RPC_ERROR");
    onState(result);
    return result;
  }
  onState(state(hash, "CONSENSUS_PENDING", "Validators accepted the transaction; protocol finality is pending."));
  let finalized: Receipt;
  try {
    finalized = acceptedStatus === "FINALIZED" ? accepted : await client.waitForTransactionReceipt({ hash, status: "FINALIZED" });
  } catch (error) {
    const result = classifyTransactionFailure(error, hash);
    onState(result);
    return result;
  }
  if (VALIDATOR_TIMEOUT_STATUSES.has(normalizedStatus(finalized))) {
    const result = failureFor(hash, "VALIDATORS_TIMEOUT");
    onState(result);
    return result;
  }
  if (receiptRoleFailure(finalized)) {
    const result = failureFor(hash, "WRONG_ROLE");
    onState(result);
    return result;
  }
  if (DETERMINISTIC_RESULT_NAMES.has(String(finalized.resultName ?? ""))) {
    const result = failureFor(hash, "DETERMINISTIC_VIOLATION");
    onState(result);
    return result;
  }
  if (normalizedStatus(finalized) !== "FINALIZED") {
    const result = failureFor(hash, "RPC_ERROR");
    onState(result);
    return result;
  }
  onState(state(hash, "PROTOCOL_FINALIZED", "Protocol finality was observed."));
  if (finalized.txExecutionResultName !== "FINISHED_WITH_RETURN") {
    const result = failureFor(hash, "EXECUTION_ERROR");
    onState(result);
    return result;
  }
  onState(state(hash, "EXECUTION_SUCCESS", "Finalized execution succeeded; verifying contract readback."));
  try {
    if (!reconcile || (await reconcile(action)) !== true) {
      const result = failureFor(hash, "READBACK_MISMATCH");
      onState(result);
      return result;
    }
  } catch {
    const result = failureFor(hash, "RPC_ERROR");
    onState(result);
    return result;
  }
  const result = state(hash, "READBACK_CONFIRMED", "Finalized execution and authoritative readback confirmed.");
  onState(result);
  return result;
}

type ReconcileSource = {
  readCase(caseId: string): Promise<CaseRecord>;
  readReview(caseId: string, epoch: number): Promise<ReviewRecord>;
  readReviewFinality(caseId: string): Promise<ReviewFinality>;
  readReviewAttempt(
    caseId: string,
    epoch: number,
    attempt: number,
  ): Promise<ReviewAttempt>;
  readAccounting(): Promise<Accounting>;
  readSettlement(caseId: string): Promise<Settlement>;
};
export type ActionReadback = {
  case: Pick<
    CaseRecord,
    | "lifecycle"
    | "epoch"
    | "vendorAccepted"
    | "escrowAmount"
    | "reserved"
    | "evidenceSealed"
  >;
  review: Pick<ReviewRecord, "verdict"> | null;
  reviewFinality: Pick<ReviewFinality, "epoch" | "attempt" | "status"> | null;
  reviewAttempt: Pick<ReviewAttempt, "epoch" | "attempt"> | null;
  settlement: Pick<Settlement, "kind" | "reason" | "status"> | null;
  accounting: Accounting;
  evidence: { epoch: number; envelopes: unknown[] } | null;
  appealRound: bigint | null;
};

export function actionReadbackConfirmed(
  action: PendingAction | undefined,
  before: ActionReadback,
  after: ActionReadback,
  options: { recoveredPersistedCloseEvidence?: boolean } = {},
): boolean {
  switch (action) {
    case "accept_terms":
      return !before.case.vendorAccepted && after.case.vendorAccepted;
    case "fund":
      return (
        before.case.lifecycle === "DRAFT" &&
        after.case.lifecycle === "FUNDED" &&
        after.case.reserved === after.case.escrowAmount
      );
    case "open_evidence":
    case "append_evidence":
      return (
        after.case.lifecycle === "EVIDENCE_OPEN" &&
        after.evidence !== null &&
        after.evidence.epoch === after.case.epoch &&
        after.evidence.envelopes.length > (before.evidence?.envelopes.length ?? 0)
      );
    case "close_evidence":
      return (
        after.case.evidenceSealed &&
        (!before.case.evidenceSealed || options.recoveredPersistedCloseEvidence === true)
      );
    case "request_review":
      return (
        before.review === null &&
        before.reviewFinality === null &&
        after.review !== null &&
        after.reviewFinality !== null &&
        after.reviewFinality.epoch === after.case.epoch
      );
    case "start_cure":
      return (
        after.case.lifecycle === "EVIDENCE_OPEN" &&
        after.case.epoch === before.case.epoch + 1 &&
        after.review === null &&
        after.reviewFinality === null
      );
    case "retry_review":
      return (
        before.reviewFinality !== null &&
        after.review !== null &&
        after.reviewFinality !== null &&
        after.reviewFinality.epoch === before.reviewFinality.epoch &&
        after.reviewFinality.attempt === before.reviewFinality.attempt + 1
      );
    case "expire_unresolved":
      return (
        before.settlement === null &&
        after.case.lifecycle === "SETTLEMENT_PENDING" &&
        after.settlement !== null &&
        after.settlement.kind === "REFUND" &&
        after.settlement.status === "PREPARED" &&
        ["UNRESOLVED_EXHAUSTED", "CURE_EXHAUSTED"].includes(
          after.settlement.reason,
        )
      );
    case "timeout_refund":
      return (
        before.settlement === null &&
        after.case.lifecycle === "SETTLEMENT_PENDING" &&
        after.settlement?.kind === "REFUND" &&
        after.settlement.reason === "HARD_TIMEOUT" &&
        after.settlement.status === "PREPARED"
      );
    case "prepare_settlement":
      return (
        before.settlement === null &&
        after.case.lifecycle === "SETTLEMENT_PENDING" &&
        after.settlement?.status === "PREPARED" &&
        ((before.review?.verdict === "APPROVED" && after.settlement.kind === "PAYOUT") ||
          (before.review?.verdict === "REJECTED" && after.settlement.kind === "REFUND"))
      );
    case "execute_settlement":
      return (
        before.settlement?.status === "PREPARED" &&
        after.case.lifecycle === "DISPATCHED_FINALIZED" &&
        after.settlement?.status === "DISPATCHED_FINALIZED"
      );
    case "appeal":
      return (
        before.appealRound !== null &&
        after.appealRound === before.appealRound + 1n
      );
    default:
      return false;
  }
}
export type ReconciledCase = {
  case: CaseRecord;
  review: ReviewRecord | null;
  reviewFinality: ReviewFinality | null;
  reviewAttempt: ReviewAttempt | null;
  settlement: Settlement | null;
  accounting: Accounting;
  localStateWasReplaced: boolean;
};

async function optional<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const absent = new Set([
      "review does not exist",
      "review finality proof does not exist",
      "settlement intent does not exist",
    ]);
    if ([...absent].some((message) => matchesExactUserError(error, message)))
      return null;
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current instanceof Error) {
        const viemUserError = current.message.match(
          /^An internal error was received\.\s+Details: UserError\(message='([^']+)'\)\s+Version: viem@\d+\.\d+\.\d+$/,
        );
        const message = current.message.startsWith("gen_call failed: ")
          ? current.message.slice("gen_call failed: ".length)
          : (viemUserError?.[1] ?? current.message);
        if (absent.has(message)) return null;
        current = current.cause;
      } else if (typeof current === "object" && "cause" in current)
        current = (current as { cause?: unknown }).cause;
      else break;
    }
    throw error;
  }
}
export async function reconcileCase(
  source: ReconcileSource,
  caseId: string,
  localCase?: Partial<CaseRecord>,
): Promise<ReconciledCase> {
  const authoritativeCase = await source.readCase(caseId);
  const [review, reviewFinality, settlement, accounting] = await Promise.all([
    optional(() => source.readReview(caseId, authoritativeCase.epoch)),
    optional(() => source.readReviewFinality(caseId)),
    optional(() => source.readSettlement(caseId)),
    source.readAccounting(),
  ]);
  const reviewAttempt = reviewFinality
    ? await source.readReviewAttempt(
        caseId,
        reviewFinality.epoch,
        reviewFinality.attempt,
      )
    : null;
  if (review && review.profileHash !== authoritativeCase.profileHash)
    throw new Error("Review readback profile binding is invalid.");
  if (
    review?.contextHash &&
    review.contextHash !== authoritativeCase.reviewContextHash
  )
    throw new Error("Review readback context binding is invalid.");
  if (reviewFinality && reviewFinality.epoch !== authoritativeCase.epoch)
    throw new Error("Review finality epoch binding is invalid.");
  if (
    settlement &&
    (settlement.epoch !== authoritativeCase.epoch ||
      settlement.amount !== authoritativeCase.escrowAmount)
  )
    throw new Error("Settlement readback binding is invalid.");
  return {
    case: authoritativeCase,
    review,
    reviewFinality,
    reviewAttempt,
    settlement,
    accounting,
    localStateWasReplaced:
      !!localCase &&
      JSON.stringify(localCase) !== JSON.stringify(authoritativeCase),
  };
}

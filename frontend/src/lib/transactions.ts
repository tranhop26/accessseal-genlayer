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
  | "PENDING"
  | "ACCEPTED"
  | "RECONCILING"
  | "FINALIZED_SUCCESS"
  | "UNDETERMINED"
  | "EXECUTION_ERROR"
  | "REJECTED";
export type TransactionState = {
  phase: TransactionPhase;
  hash: `0x${string}`;
  message: string;
};
type Receipt = {
  statusName?: string;
  status_name?: string;
  status?: string | number;
  txExecutionResultName?: string;
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
function state(
  hash: `0x${string}`,
  phase: TransactionPhase,
  message: string,
): TransactionState {
  return { hash, phase, message };
}

export async function trackTransaction(
  client: ReceiptClient,
  hash: `0x${string}`,
  onState: (value: TransactionState) => void,
  reconcile?: () => Promise<void>,
): Promise<TransactionState> {
  onState(
    state(
      hash,
      "PENDING",
      "Transaction submitted; waiting for validator acceptance.",
    ),
  );
  const accepted = await client.waitForTransactionReceipt({
    hash,
    status: "ACCEPTED",
  });
  const acceptedStatus = normalizedStatus(accepted);
  if (acceptedStatus === "UNDETERMINED") {
    const result = state(
      hash,
      "UNDETERMINED",
      "Validators did not determine this transaction. No success is claimed.",
    );
    onState(result);
    return result;
  }
  if (accepted.txExecutionResultName === "FINISHED_WITH_ERROR") {
    const result = state(
      hash,
      "EXECUTION_ERROR",
      "The accepted transaction execution failed; contract state did not advance.",
    );
    onState(result);
    return result;
  }
  if (acceptedStatus !== "ACCEPTED" && acceptedStatus !== "FINALIZED") {
    const result = state(
      hash,
      "REJECTED",
      `Transaction stopped at ${acceptedStatus || "an unknown state"}.`,
    );
    onState(result);
    return result;
  }
  onState(
    state(
      hash,
      "ACCEPTED",
      "Accepted by validators. It remains appealable and is not final.",
    ),
  );
  const finalized =
    acceptedStatus === "FINALIZED"
      ? accepted
      : await client.waitForTransactionReceipt({ hash, status: "FINALIZED" });
  if (normalizedStatus(finalized) === "UNDETERMINED") {
    const result = state(
      hash,
      "UNDETERMINED",
      "Finality was undetermined. No success is claimed.",
    );
    onState(result);
    return result;
  }
  if (
    normalizedStatus(finalized) !== "FINALIZED" ||
    finalized.txExecutionResultName !== "FINISHED_WITH_RETURN"
  ) {
    const result = state(
      hash,
      "EXECUTION_ERROR",
      "The transaction did not finalize with successful execution.",
    );
    onState(result);
    return result;
  }
  const reconciling = state(
    hash,
    "RECONCILING",
    "Execution finalized; verifying authoritative contract readback.",
  );
  onState(reconciling);
  if (!reconcile) return reconciling;
  await reconcile();
  const result = state(
    hash,
    "FINALIZED_SUCCESS",
    "Finalized execution and authoritative readback confirmed.",
  );
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

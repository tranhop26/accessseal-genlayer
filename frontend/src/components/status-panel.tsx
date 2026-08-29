import type { TransactionPhase, TransactionState } from "@/lib/transactions";
import styles from "./cases/case-detail.module.css";

export const transactionProgress = [
  "WAITING_FOR_WALLET",
  "SUBMITTED",
  "CONSENSUS_PENDING",
  "PROTOCOL_FINALIZED",
  "EXECUTION_SUCCESS",
  "READBACK_CONFIRMED",
] as const;

type VisibleTransactionStep = (typeof transactionProgress)[number];

export function visibleTransactionStep(
  phase: TransactionPhase,
): VisibleTransactionStep {
  if (phase === "WAITING_FOR_WALLET") return "WAITING_FOR_WALLET";
  if (phase === "SUBMITTED" || phase === "PENDING") return "SUBMITTED";
  if (phase === "CONSENSUS_PENDING" || phase === "ACCEPTED") return "CONSENSUS_PENDING";
  if (phase === "PROTOCOL_FINALIZED" || phase === "RECONCILING") return "PROTOCOL_FINALIZED";
  if (phase === "EXECUTION_SUCCESS") return "EXECUTION_SUCCESS";
  if (phase === "READBACK_CONFIRMED" || phase === "FINALIZED_SUCCESS") return "READBACK_CONFIRMED";
  return "SUBMITTED";
}

function stepLabel(step: VisibleTransactionStep) {
  if (step === "READBACK_CONFIRMED") return "Readback confirmed";
  return `${step[0]}${step.slice(1).toLowerCase()}`.replaceAll("_", " ");
}

function transactionTitle(phase: TransactionPhase) {
  if (["UNDETERMINED", "EXECUTION_ERROR", "REJECTED", "WALLET_REJECTED", "WRONG_ROLE", "RPC_ERROR", "VALIDATORS_TIMEOUT", "DETERMINISTIC_VIOLATION", "READBACK_MISMATCH"].includes(phase))
    return phase.replaceAll("_", " ").toLowerCase();
  return visibleTransactionStep(phase).replaceAll("_", " ").toLowerCase();
}

export function TransactionProgress({ phase }: { phase: TransactionPhase }) {
  const current = visibleTransactionStep(phase);
  const currentIndex = transactionProgress.indexOf(current);
  return (
    <ol
      aria-label="Transaction progress"
      className={styles.transactionProgress}
    >
      {transactionProgress.map((step, index) => (
        <li
          aria-current={step === current ? "step" : undefined}
          data-state={
            index < currentIndex
              ? "complete"
              : step === current
                ? "current"
                : "upcoming"
          }
          key={step}
        >
          <span aria-hidden="true" />
          {stepLabel(step)}
        </li>
      ))}
    </ol>
  );
}

const TONES = {
  WAITING_FOR_WALLET: "pending",
  SUBMITTED: "pending",
  CONSENSUS_PENDING: "warning",
  PROTOCOL_FINALIZED: "pending",
  EXECUTION_SUCCESS: "pending",
  READBACK_CONFIRMED: "success",
  WALLET_REJECTED: "danger",
  WRONG_ROLE: "danger",
  RPC_ERROR: "danger",
  VALIDATORS_TIMEOUT: "danger",
  DETERMINISTIC_VIOLATION: "danger",
  READBACK_MISMATCH: "danger",
  PENDING: "pending",
  ACCEPTED: "warning",
  RECONCILING: "pending",
  FINALIZED_SUCCESS: "success",
  UNDETERMINED: "danger",
  EXECUTION_ERROR: "danger",
  REJECTED: "danger",
} as const;

export function StatusPanel({ state }: { state: TransactionState }) {
  const failed = ["UNDETERMINED", "EXECUTION_ERROR", "REJECTED", "WALLET_REJECTED", "WRONG_ROLE", "RPC_ERROR", "VALIDATORS_TIMEOUT", "DETERMINISTIC_VIOLATION", "READBACK_MISMATCH"].includes(
    state.phase,
  );
  return (
    <section
      className={styles.statusPanel}
      role="status"
      aria-live="polite"
      data-tone={TONES[state.phase]}
    >
      <div className={styles.statusIcon} aria-hidden="true">
        {state.phase === "READBACK_CONFIRMED" || state.phase === "FINALIZED_SUCCESS"
          ? "✓"
          : state.phase === "CONSENSUS_PENDING" || state.phase === "ACCEPTED"
            ? "▷"
            : "•"}
      </div>
      <div className={styles.statusBody}>
        <span className={styles.eyebrow}>Transaction</span>
        <h2>Transaction {transactionTitle(state.phase)}</h2>
        <p>{state.message}</p>
        {(state.phase === "CONSENSUS_PENDING" || state.phase === "ACCEPTED") && (
          <p className={styles.statusCaution}>
            Accepted is not final. Appeal and finality can still change the
            protocol state.
          </p>
        )}
        {!failed && <TransactionProgress phase={state.phase} />}
        <code className={styles.hashCode}>{state.hash ?? "Not submitted"}</code>
      </div>
    </section>
  );
}

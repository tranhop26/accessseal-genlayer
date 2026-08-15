import type { TransactionState } from "@/lib/transactions";
const TONES = {
  PENDING: "pending",
  ACCEPTED: "pending",
  RECONCILING: "pending",
  FINALIZED_SUCCESS: "success",
  UNDETERMINED: "danger",
  EXECUTION_ERROR: "danger",
  REJECTED: "danger",
} as const;
export function StatusPanel({ state }: { state: TransactionState }) {
  return (
    <section
      className="status-panel"
      role="status"
      aria-live="polite"
      data-tone={TONES[state.phase]}
    >
      <div className="status-icon" aria-hidden="true">
        {state.phase === "FINALIZED_SUCCESS"
          ? "✓"
          : state.phase === "ACCEPTED"
            ? "◷"
            : "•"}
      </div>
      <div>
        <span className="eyebrow">Transaction</span>
        <h3>{state.phase.replaceAll("_", " ")}</h3>
        <p>{state.message}</p>
        {state.phase === "ACCEPTED" && (
          <p className="status-caution">
            Accepted is not final. Appeal and finality can still change the
            protocol state.
          </p>
        )}
        <code>
          {state.hash.slice(0, 18)}…{state.hash.slice(-8)}
        </code>
      </div>
    </section>
  );
}

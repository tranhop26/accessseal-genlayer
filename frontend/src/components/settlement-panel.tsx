import type { Accounting, Settlement } from "@/lib/access-seal";
export type DispatchConfirmation = {
  status: "PENDING" | "CONFIRMED" | "FAILED";
  childTransaction: string | null;
  recipientBalanceConfirmed: boolean;
};
export function SettlementPanel({
  canPrepare,
  settlement,
  accounting,
  confirmation,
  onPrepare,
  onExecute,
  busy = false,
}: {
  canPrepare: boolean;
  settlement: Settlement | null;
  accounting: Accounting;
  confirmation?: DispatchConfirmation;
  onPrepare: () => void;
  onExecute: () => void;
  busy?: boolean;
}) {
  const dispatched = settlement?.status === "DISPATCHED_FINALIZED";
  const executable =
    settlement?.status === "PREPARED" &&
    ((settlement.kind === "PAYOUT" && settlement.reason === "APPROVED") ||
      (settlement.kind === "REFUND" &&
        [
          "REJECTED",
          "UNRESOLVED_EXHAUSTED",
          "CURE_EXHAUSTED",
          "HARD_TIMEOUT",
        ].includes(settlement.reason)));
  const confirmed =
    dispatched &&
    confirmation?.status === "CONFIRMED" &&
    confirmation.recipientBalanceConfirmed;
  return (
    <section className="workflow-card settlement-card">
      <div className="section-heading">
        <span className="step-number">04</span>
        <div>
          <span className="eyebrow">Finality-only transfer</span>
          <h2>Settlement dispatch</h2>
        </div>
      </div>
      {settlement ? (
        <>
          <div
            className={dispatched ? "dispatch-state amber" : "dispatch-state"}
          >
            <span>{dispatched ? "Dispatch finalized" : "Intent prepared"}</span>
            <strong>
              {settlement.kind} · {settlement.amount.toString()} wei
            </strong>
          </div>
          <dl className="compact-dl">
            <div>
              <dt>Recipient</dt>
              <dd>
                <code>{settlement.recipient}</code>
              </dd>
            </div>
            <div>
              <dt>Intent ID</dt>
              <dd>
                <code>{settlement.settlementId}</code>
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{settlement.reason}</dd>
            </div>
            <div>
              <dt>Contract status</dt>
              <dd>{settlement.status}</dd>
            </div>
          </dl>
          {dispatched && (
            <div
              className={
                confirmed ? "confirmation success" : "confirmation pending"
              }
            >
              <strong>
                {confirmed ? "Confirmed" : "Recipient confirmation pending"}
              </strong>
              <p>
                {confirmed
                  ? "The application verified the child transaction and recipient balance."
                  : "The contract proves finalized message dispatch only. Child receipt or recipient balance has not yet been confirmed."}
              </p>
              {confirmation?.childTransaction && (
                <code>{confirmation.childTransaction}</code>
              )}
            </div>
          )}
          <button
            className="primary-button"
            disabled={!executable || dispatched || busy}
            onClick={onExecute}
          >
            {busy ? "Dispatching…" : "Execute prepared settlement"}
          </button>
        </>
      ) : (
        <>
          <p>
            Finalized APPROVED or REJECTED review readback is required before an
            immutable payout or refund intent can be prepared.
          </p>
          <button
            className="primary-button"
            disabled={!canPrepare || busy}
            onClick={onPrepare}
          >
            Prepare settlement
          </button>
        </>
      )}
      <div className="accounting-strip">
        <span>
          <small>Reserved</small>
          {accounting.reserved.toString()}
        </span>
        <span>
          <small>Pending dispatch</small>
          {accounting.pendingDispatch.toString()}
        </span>
        <span>
          <small>Dispatched</small>
          {(
            accounting.dispatchedPayouts + accounting.dispatchedRefunds
          ).toString()}
        </span>
      </div>
    </section>
  );
}

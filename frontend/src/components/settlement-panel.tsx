import type { Accounting, Settlement } from "@/lib/access-seal";
import { Button } from "./ui/button";
import styles from "./cases/case-detail.module.css";

export type DispatchConfirmation = {
  status: "PENDING" | "CONFIRMED" | "FAILED";
  childTransaction: string | null;
  recipientBalanceConfirmed: boolean;
};

export function isSettlementExecutable(settlement: Settlement | null) {
  return (
    settlement?.status === "PREPARED" &&
    ((settlement.kind === "PAYOUT" && settlement.reason === "APPROVED") ||
      (settlement.kind === "REFUND" &&
        [
          "REJECTED",
          "UNRESOLVED_EXHAUSTED",
          "CURE_EXHAUSTED",
          "HARD_TIMEOUT",
        ].includes(settlement.reason)))
  );
}

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
  const executable = isSettlementExecutable(settlement);
  const confirmed =
    dispatched &&
    confirmation?.status === "CONFIRMED" &&
    confirmation.recipientBalanceConfirmed;
  return (
    <section className={styles.card}>
      <div className={styles.sectionHeading}>
        <span className={styles.stepNumber}>04</span>
        <div>
          <span className={styles.eyebrow}>Finality-only transfer</span>
          <h3>Settlement dispatch</h3>
        </div>
      </div>
      {settlement ? (
        <>
          <div className={styles.dispatchState} data-dispatched={dispatched}>
            <span>{dispatched ? "Dispatch finalized" : "Intent prepared"}</span>
            <strong>
              {settlement.kind} · {settlement.amount.toString()} wei
            </strong>
          </div>
          <dl className={styles.compactDl}>
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
            <div className={styles.confirmation} data-confirmed={confirmed}>
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
          <Button
            disabled={!executable || dispatched || busy}
            onClick={onExecute}
          >
            {busy ? "Dispatching…" : "Execute prepared settlement"}
          </Button>
        </>
      ) : (
        <>
          <p>
            Finalized APPROVED or REJECTED review readback is required before an
            immutable payout or refund intent can be prepared.
          </p>
          <Button disabled={!canPrepare || busy} onClick={onPrepare}>
            Prepare settlement
          </Button>
        </>
      )}
      <div className={styles.accountingStrip}>
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

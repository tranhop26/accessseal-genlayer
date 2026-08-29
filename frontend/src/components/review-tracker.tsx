import type { ReviewFinality, ReviewRecord } from "@/lib/access-seal";
import type { TransactionPhase } from "@/lib/transactions";
import { TransactionProgress } from "./status-panel";
import styles from "./cases/case-detail.module.css";
export function ReviewTracker({
  review,
  finality,
  transactionPhase,
  cureDeadline,
  retryAvailableAt,
}: {
  review: ReviewRecord;
  finality: ReviewFinality;
  transactionPhase: TransactionPhase;
  cureDeadline?: number;
  retryAvailableAt?: number;
}) {
  const final =
    finality.status === "FINALIZED" && transactionPhase === "READBACK_CONFIRMED";
  return (
    <section className={styles.card} aria-labelledby="review-title">
      <div className={styles.sectionHeading}>
        <span className={styles.stepNumber}>03</span>
        <div>
          <span className={styles.eyebrow}>Validator consensus</span>
          <h3 id="review-title">Review decision</h3>
        </div>
      </div>
      <TransactionProgress phase={transactionPhase} />
      {!final && (
        <div className={styles.pendingCallout}>
          Accepted is appealable and is not final. Settlement remains locked
          until protocol finality and successful execution.
        </div>
      )}
      <div className={styles.verdict} data-verdict={review.verdict}>
        <span>Verdict</span>
        <strong>{review.verdict.replaceAll("_", " ")}</strong>
        <p>
          Validator rationale commitment: <code>{review.rationaleHash}</code>
        </p>
      </div>
      {review.verdict === "REQUEST_MORE_INFO" && (
        <div className={styles.cureCallout}>
          <strong>Cure attempt 1 of 1</strong>
          <p>
            Missing: {review.missingEvidence.join(", ") || "specified evidence"}
          </p>
          {cureDeadline && (
            <time dateTime={new Date(cureDeadline * 1000).toISOString()}>
              Deadline: {new Date(cureDeadline * 1000).toLocaleString()}
            </time>
          )}
        </div>
      )}
      {review.verdict === "UNRESOLVED" && (
        <div className={styles.unresolvedCallout}>
          <strong>No payout or refund is authorized.</strong>
          <p>
            Consensus was insufficient. Retry cooldown protects against rapid
            replay.
          </p>
          {retryAvailableAt && (
            <time dateTime={new Date(retryAvailableAt * 1000).toISOString()}>
              Retry cooldown ends{" "}
              {new Date(retryAvailableAt * 1000).toLocaleString()}
            </time>
          )}
        </div>
      )}
      <div
        className={styles.evidenceRefs}
        aria-label="Review evidence references"
      >
        {review.evidenceRefs.map((ref) => (
          <a href={`#evidence-${ref}`} key={ref}>
            {ref}
          </a>
        ))}
      </div>
      <dl className={styles.compactDl}>
        <div>
          <dt>Protocol finality</dt>
          <dd>{finality.status.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{finality.attempt + 1}</dd>
        </div>
        <div>
          <dt>Proof ID</dt>
          <dd>
            <code>{finality.proofId}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}

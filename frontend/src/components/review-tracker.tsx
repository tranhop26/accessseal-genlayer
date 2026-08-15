import type { ReviewFinality, ReviewRecord } from "@/lib/access-seal";
import type { TransactionPhase } from "@/lib/transactions";
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
    finality.status === "FINALIZED" && transactionPhase === "FINALIZED_SUCCESS";
  return (
    <section className="workflow-card" aria-labelledby="review-title">
      <div className="section-heading">
        <span className="step-number">03</span>
        <div>
          <span className="eyebrow">Validator consensus</span>
          <h2 id="review-title">Review decision</h2>
        </div>
      </div>
      {!final && (
        <div className="pending-callout">
          Accepted is appealable and is not final. Settlement remains locked
          until protocol finality and successful execution.
        </div>
      )}
      <div className={`verdict verdict-${review.verdict.toLowerCase()}`}>
        <span>Verdict</span>
        <strong>{review.verdict.replaceAll("_", " ")}</strong>
        <p>
          Validator rationale commitment: <code>{review.rationaleHash}</code>
        </p>
      </div>
      {review.verdict === "REQUEST_MORE_INFO" && (
        <div className="cure-callout">
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
        <div className="unresolved-callout">
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
      <div className="evidence-refs" aria-label="Review evidence references">
        {review.evidenceRefs.map((ref) => (
          <a href={`#evidence-${ref}`} key={ref}>
            {ref}
          </a>
        ))}
      </div>
      <dl className="compact-dl">
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

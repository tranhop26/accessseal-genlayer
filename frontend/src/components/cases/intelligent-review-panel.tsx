import type {
  CaseRecord,
  ReviewContextRecord,
  ReviewFinality,
  ReviewRecord,
} from "@/lib/access-seal";
import type { CaseWorkspaceModel } from "./case-dashboard-model";
import styles from "./case-detail.module.css";

const verdictMeaning: Record<ReviewRecord["verdict"], string> = {
  APPROVED: "The finalized review authorizes payout preparation.",
  REJECTED: "The finalized review authorizes refund preparation.",
  REQUEST_MORE_INFO: "The finalized review requires a bounded evidence cure.",
  UNRESOLVED: "No payout or refund is authorized; retry or expiry rules apply.",
};

export function IntelligentReviewPanel({
  caseRecord,
  context,
  review,
  finality,
  verdictTone,
  controls,
}: {
  caseRecord: CaseRecord;
  context: ReviewContextRecord | null;
  review: ReviewRecord | null;
  finality: ReviewFinality | null;
  verdictTone: CaseWorkspaceModel["verdictTone"];
  controls?: React.ReactNode;
}) {
  const finalized = finality?.status === "FINALIZED" && !!review;
  const contextBound =
    context?.ready === true &&
    caseRecord.reviewContextReady === true &&
    context.contextHash === caseRecord.reviewContextHash &&
    context.caseId === caseRecord.caseId &&
    context.epoch === caseRecord.epoch;
  return (
    <section className={styles.commandPanel} id="proofs" aria-labelledby="intelligent-review-title" tabIndex={-1}>
      <header className={styles.commandPanelHeader}>
        <div>
          <span className={styles.eyebrow}>Bounded validator review</span>
          <h2 id="intelligent-review-title">Intelligent review</h2>
        </div>
        <span className={contextBound ? styles.semanticSuccess : styles.semanticWarning}>
          <span aria-hidden="true">{contextBound ? "✓" : "!"}</span>
          {contextBound ? "Context ready" : "Context not ready"}
        </span>
      </header>
      <dl className={styles.reviewFacts}>
        <div><dt>Context binding</dt><dd><code>{context?.contextHash || caseRecord.reviewContextHash || "Not available"}</code></dd></div>
        <div><dt>Readiness</dt><dd>{contextBound ? "Exact context and case binding verified" : "Awaiting exact authoritative context readback"}</dd></div>
        <div><dt>Fixed-rubric signals</dt><dd>Profile, flow, release, image, blocker, and evidence-completeness commitments</dd></div>
        <div><dt>Profile commitment</dt><dd><code>{caseRecord.profileHash}</code></dd></div>
      </dl>
      {finalized ? (
        <div className={styles.verdictCard} data-tone={verdictTone}>
          <span className={styles.verdictIcon} aria-hidden="true">
            {review.verdict === "APPROVED" ? "✓" : review.verdict === "REJECTED" ? "×" : "!"}
          </span>
          <div>
            <span>Finalized verdict</span>
            <h3>{review.verdict.replaceAll("_", " ")}</h3>
            <p>{verdictMeaning[review.verdict]}</p>
          </div>
        </div>
      ) : (
        <div className={styles.pendingVerdict} role="status">
          <span aria-hidden="true">○</span>
          <div><strong>Verdict withheld</strong><p>A verdict is shown only after finalized review readback.</p></div>
        </div>
      )}
      <dl className={styles.reviewFacts}>
        <div><dt>Material blockers</dt><dd>{finalized ? review.materialBlockers.join(", ") || "None" : "Available after finality"}</dd></div>
        <div><dt>Missing evidence</dt><dd>{finalized ? review.missingEvidence.join(", ") || "None" : "Available after finality"}</dd></div>
        <div><dt>Decision rationale</dt><dd><code>{finalized ? review.rationaleHash : "Commitment withheld until finality"}</code></dd></div>
        <div><dt>Proof ID</dt><dd><code>{finalized ? finality.proofId : "Not finalized"}</code></dd></div>
        <div><dt>Finality</dt><dd>{finality?.status.replaceAll("_", " ") ?? "No review submitted"}</dd></div>
      </dl>
      {controls}
    </section>
  );
}

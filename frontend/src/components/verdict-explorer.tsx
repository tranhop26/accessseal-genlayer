import type { ReviewRecord } from "@/lib/access-seal";
export function VerdictExplorer({ review }: { review: ReviewRecord }) {
  return (
    <section className="action-card">
      <span className="eyebrow">Decision anatomy</span>
      <h2>Why validators decided this</h2>
      <p>
        The contract stores the bounded rationale commitment, not unverified
        explanatory prose.
      </p>
      {review.materialBlockers.length > 0 && (
        <ul className="blocker-list">
          {review.materialBlockers.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      )}
      <div className="hash-box">
        <span>Rationale hash</span>
        <code>{review.rationaleHash}</code>
      </div>
      <div className="hash-box">
        <span>Release digest</span>
        <code>{review.releaseDigest}</code>
      </div>
      <div className="hash-box">
        <span>Profile hash</span>
        <code>{review.profileHash}</code>
      </div>
    </section>
  );
}

import type { EvidenceRecord } from "@/lib/access-seal";
import styles from "./cases/case-detail.module.css";
export function EvidenceInspector({
  evidence,
  now,
}: {
  evidence: EvidenceRecord;
  now: number;
}) {
  return (
    <section className={styles.card} aria-labelledby="evidence-title">
      <div className={styles.sectionHeading}>
        <span className={styles.stepNumber}>02</span>
        <div>
          <span className={styles.eyebrow}>Bound artifacts</span>
          <h3 id="evidence-title">Evidence trail</h3>
        </div>
      </div>
      <p className={styles.trustNote}>
        Vendor-submitted envelopes bind claims and payload locations.{" "}
        <strong>Validators independently fetch and hash payloads</strong> before
        semantic review.
      </p>
      <div className={styles.evidenceList}>
        {evidence.envelopes.map((item, index) => {
          const hash = evidence.hashes[index] ?? "unavailable";
          const stale = item.expiresAt <= now;
          return (
            <article
              className={styles.evidenceItem}
              id={`evidence-${hash}`}
              key={hash}
            >
              <div className={styles.evidenceTop}>
                <span className={styles.typeChip}>
                  {item.evidenceType.replaceAll("_", " ")}
                </span>
                <span className={stale ? styles.staleChip : styles.freshChip}>
                  {stale ? "Expired" : "Fresh"}
                </span>
              </div>
              <h4>Vendor-submitted envelope</h4>
              <a href={item.payloadUri} target="_blank" rel="noreferrer">
                {item.payloadUri}
              </a>
              <dl className={styles.compactDl}>
                <div>
                  <dt>Issuer</dt>
                  <dd>
                    <code>{item.issuer}</code>
                  </dd>
                </div>
                <div>
                  <dt>Subject</dt>
                  <dd>{item.subjectOrigin}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{new Date(item.submittedAt * 1000).toISOString()}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{new Date(item.expiresAt * 1000).toISOString()}</dd>
                </div>
                <div>
                  <dt>Nonce</dt>
                  <dd>
                    <code>{item.nonce}</code>
                  </dd>
                </div>
                <div>
                  <dt>Canonical hash</dt>
                  <dd>
                    <code>{hash}</code>
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

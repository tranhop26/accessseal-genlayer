import type { EvidenceRecord } from "@/lib/access-seal";
export function EvidenceInspector({
  evidence,
  now,
}: {
  evidence: EvidenceRecord;
  now: number;
}) {
  return (
    <section className="workflow-card" aria-labelledby="evidence-title">
      <div className="section-heading">
        <span className="step-number">02</span>
        <div>
          <span className="eyebrow">Bound artifacts</span>
          <h2 id="evidence-title">Evidence trail</h2>
        </div>
      </div>
      <p className="trust-note">
        Vendor-submitted envelopes bind claims and payload locations.{" "}
        <strong>Validators independently fetch and hash payloads</strong> before
        semantic review.
      </p>
      <div className="evidence-list">
        {evidence.envelopes.map((item, index) => {
          const hash = evidence.hashes[index] ?? "unavailable";
          const stale = item.expiresAt <= now;
          return (
            <article
              className="evidence-item"
              id={`evidence-${hash}`}
              key={hash}
            >
              <div className="evidence-top">
                <span className="type-chip">
                  {item.evidenceType.replaceAll("_", " ")}
                </span>
                <span className={stale ? "stale-chip" : "fresh-chip"}>
                  {stale ? "Expired" : "Fresh"}
                </span>
              </div>
              <h3>Vendor-submitted envelope</h3>
              <a href={item.payloadUri} target="_blank" rel="noreferrer">
                {item.payloadUri}
              </a>
              <dl className="compact-dl">
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

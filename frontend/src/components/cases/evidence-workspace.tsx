import type { CaseRecord, EvidenceRecord } from "@/lib/access-seal";
import { restrictedOrigin } from "@/lib/evidence";
import styles from "./case-detail.module.css";

function title(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part, index) =>
      part === "html" || part === "dom"
        ? part.toUpperCase()
        : index === 0
          ? part[0]?.toUpperCase() + part.slice(1)
          : part,
    )
    .join(" ");
}

function safePreview(item: EvidenceRecord["envelopes"][number]) {
  try {
    const payload = new URL(item.payloadUri);
    if (
      payload.protocol !== "https:" ||
      restrictedOrigin(item.payloadUri) !== item.subjectOrigin
    )
      return null;
    if (item.mediaType.startsWith("image/"))
      return (
        // The contract-bound URL is shown only when it shares the exact subject origin.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt={`${title(item.evidenceType)} evidence preview`} src={item.payloadUri} />
      );
    if (item.mediaType.startsWith("text/"))
      return (
        <iframe
          sandbox=""
          src={item.payloadUri}
          title={`${title(item.evidenceType)} evidence preview`}
        />
      );
  } catch {
    return null;
  }
  return null;
}

export function EvidenceWorkspace({
  caseRecord,
  evidence,
  now,
  controls,
}: {
  caseRecord: CaseRecord;
  evidence: EvidenceRecord | null;
  now: number;
  controls?: React.ReactNode;
}) {
  return (
    <section className={styles.commandPanel} id="evidence" aria-labelledby="evidence-workspace-title" tabIndex={-1}>
      <header className={styles.commandPanelHeader}>
        <div>
          <span className={styles.eyebrow}>Bound release artifacts</span>
          <h2 id="evidence-workspace-title">Evidence workspace</h2>
        </div>
        <span className={styles.recordCount}>{evidence?.envelopes.length ?? 0} records</span>
      </header>
      {controls}
      {!evidence || evidence.envelopes.length === 0 ? (
        <p className={styles.inlineState}>No evidence envelope exists for the authoritative case epoch.</p>
      ) : (
        <div className={styles.evidenceWorkspaceList}>
          {evidence.envelopes.map((item, index) => {
            const envelopeHash = evidence.hashes[index] ?? "Not exposed";
            const fresh = item.expiresAt > now;
            const preview = safePreview(item);
            return (
              <article className={styles.evidenceWorkspaceItem} id={`evidence-${envelopeHash}`} key={`${item.payloadSha256}-${index}`}>
                <header>
                  <div>
                    <span className={styles.evidenceTypeLabel}>{title(item.evidenceType)}</span>
                    <h3>{item.mediaType}</h3>
                  </div>
                  <span className={fresh ? styles.semanticSuccess : styles.semanticDanger}>
                    <span aria-hidden="true">{fresh ? "✓" : "!"}</span>
                    {caseRecord.evidenceSealed ? "Sealed · " : "Open · "}
                    {fresh ? "Fresh" : "Expired"}
                  </span>
                </header>
                {preview && <div className={styles.safePreview}>{preview}</div>}
                {!preview && (
                  <p className={styles.metadataOnly}>Metadata only — this media type or origin is not eligible for an embedded preview.</p>
                )}
                <dl className={styles.evidenceMetadata}>
                  <div><dt>Exact envelope hash</dt><dd><code>{envelopeHash}</code></dd></div>
                  <div><dt>Exact payload hash</dt><dd><code>{item.payloadSha256}</code></dd></div>
                  <div><dt>Media type</dt><dd>{item.mediaType}</dd></div>
                  <div><dt>Size</dt><dd>Not provided by envelope</dd></div>
                  <div><dt>Issuer</dt><dd><code>{item.issuer}</code></dd></div>
                  <div><dt>Observed</dt><dd><time dateTime={new Date(item.observedAt * 1000).toISOString()}>{new Date(item.observedAt * 1000).toISOString()}</time></dd></div>
                  <div><dt>Submitted</dt><dd><time dateTime={new Date(item.submittedAt * 1000).toISOString()}>{new Date(item.submittedAt * 1000).toISOString()}</time></dd></div>
                  <div><dt>Expires</dt><dd><time dateTime={new Date(item.expiresAt * 1000).toISOString()}>{new Date(item.expiresAt * 1000).toISOString()}</time></dd></div>
                  <div><dt>Origin</dt><dd>{item.subjectOrigin}</dd></div>
                  <div><dt>Manifest relationship</dt><dd>{item.evidenceType === "RELEASE_MANIFEST" ? "Root manifest for this release digest" : `Bound to ${item.releaseDigest}`}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

import type { CaseActivityRow } from "./case-dashboard-model";
import styles from "./case-detail.module.css";

export function CaseActivity({ rows }: { rows: readonly CaseActivityRow[] }) {
  return (
    <section className={styles.activityPanel} id="activity" aria-labelledby="activity-title" tabIndex={-1}>
      <header className={styles.commandPanelHeader}>
        <div>
          <span className={styles.eyebrow}>Contract-derived history</span>
          <h2 id="activity-title">Immutable activity</h2>
        </div>
        <span className={styles.recordCount}>{rows.length} confirmed events</span>
      </header>
      {rows.length === 0 ? (
        <p className={styles.inlineState}>No timestamped or proof-bound contract activity is available yet.</p>
      ) : (
        <ol className={styles.activityList}>
          {rows.map((row) => (
            <li key={row.id}>
              <span className={styles.activityMarker} aria-hidden="true">✓</span>
              <div>
                <header><h3>{row.label}</h3>{row.timestamp !== null && <time dateTime={new Date(row.timestamp * 1000).toISOString()}>{new Date(row.timestamp * 1000).toISOString()}</time>}</header>
                <p>{row.detail}</p>
                {(row.actor || row.proof) && <dl>{row.actor && <div><dt>Actor</dt><dd><code>{row.actor}</code></dd></div>}{row.proof && <div><dt>Proof</dt><dd><code>{row.proof}</code></dd></div>}</dl>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

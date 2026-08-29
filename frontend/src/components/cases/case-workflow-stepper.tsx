import type { CaseWorkspaceModel } from "./case-dashboard-model";
import styles from "./case-detail.module.css";

export function CaseWorkflowStepper({
  stages,
  actorRole,
  roleWarning,
}: Pick<CaseWorkspaceModel, "stages" | "actorRole" | "roleWarning">) {
  return (
    <section className={styles.workflowOverview} aria-labelledby="workflow-title">
      <div className={styles.workflowOverviewHeader}>
        <div>
          <span className={styles.eyebrow}>Authoritative workflow</span>
          <h2 id="workflow-title">Case progression</h2>
        </div>
        <div className={styles.activeRole}>
          <span>Active wallet role</span>
          <strong>{actorRole}</strong>
        </div>
      </div>
      <ol className={styles.workflowStepper} aria-label="Case lifecycle" tabIndex={0}>
        {stages.map((stage, index) => (
          <li
            aria-current={stage.state === "current" ? "step" : undefined}
            data-state={stage.state}
            key={stage.id}
          >
            <span className={styles.stageIcon} aria-hidden="true">
              {stage.state === "complete" ? "✓" : index + 1}
            </span>
            <span className={styles.stageCopy}>
              <strong>{stage.label}</strong>
              <small>
                {stage.state === "complete"
                  ? "Confirmed by contract readback"
                  : `${stage.nextActor}: ${stage.nextAction}`}
              </small>
            </span>
          </li>
        ))}
      </ol>
      {roleWarning && (
        <p className={styles.roleWarning} role="status">
          <span aria-hidden="true">!</span> {roleWarning}
        </p>
      )}
    </section>
  );
}

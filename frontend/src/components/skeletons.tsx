import type { ReactNode } from "react";
import styles from "./ui/ui.module.css";

export function CaseSkeleton() {
  return (
    <div className={styles.skeletonStack} role="status" aria-label="Loading case">
      <span className="sr-only">Loading case</span>
      <div className={`${styles.skeleton} ${styles.skeletonWide}`} />
      <div className={styles.skeletonGrid}>
        <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
        <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
        <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className={styles.emptyState}>
      <span className={styles.emptyMark} aria-hidden="true">
        ◇
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <section className={styles.errorState} role="alert">
      <span aria-hidden="true">!</span>
      <div>
        <h2>Readback unavailable</h2>
        <p>{message}</p>
        {onRetry && <button onClick={onRetry}>Try again</button>}
      </div>
    </section>
  );
}

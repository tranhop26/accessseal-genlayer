export function CaseSkeleton() {
  return (
    <div className="skeleton-stack" role="status" aria-label="Loading case">
      <span className="sr-only">Loading case</span>
      <div className="skeleton wide" />
      <div className="skeleton-grid">
        <div className="skeleton card" />
        <div className="skeleton card" />
        <div className="skeleton card" />
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
  action?: React.ReactNode;
}) {
  return (
    <section className="empty-state">
      <span className="empty-orbit" aria-hidden="true">
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
    <section className="error-state" role="alert">
      <span aria-hidden="true">!</span>
      <div>
        <h2>Readback unavailable</h2>
        <p>{message}</p>
        {onRetry && <button onClick={onRetry}>Try again</button>}
      </div>
    </section>
  );
}

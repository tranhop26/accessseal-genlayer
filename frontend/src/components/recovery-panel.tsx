export function RecoveryPanel({
  verdict,
  canCure,
  canRetry,
  canExpire,
  canTimeout,
  retryAvailableAt,
  onCure,
  onRetry,
  onExpire,
  onTimeout,
}: {
  verdict?: string;
  canCure: boolean;
  canRetry: boolean;
  canExpire: boolean;
  canTimeout: boolean;
  retryAvailableAt?: number;
  onCure: () => void;
  onRetry: () => void;
  onExpire: () => void;
  onTimeout: () => void;
}) {
  return (
    <section className="action-card">
      <span className="eyebrow">Safe recovery</span>
      <h3>Cure, retry, expiry or timeout</h3>
      <p>
        Vendor cure is actor-restricted. Unresolved retry and exhausted expiry
        are permissionless only when the finalized attempt readback proves
        eligibility.
      </p>
      {retryAvailableAt && (
        <p>
          Retry cooldown ends{" "}
          <time dateTime={new Date(retryAvailableAt * 1000).toISOString()}>
            {new Date(retryAvailableAt * 1000).toLocaleString()}
          </time>
          .
        </p>
      )}
      <div className="button-row">
        <button
          className="secondary-button"
          disabled={verdict !== "REQUEST_MORE_INFO" || !canCure}
          onClick={onCure}
        >
          Vendor: start cure
        </button>
        <button
          className="secondary-button"
          disabled={verdict !== "UNRESOLVED" || !canRetry}
          onClick={onRetry}
        >
          Permissionless: retry review
        </button>
        <button
          className="secondary-button"
          disabled={!canExpire}
          onClick={onExpire}
        >
          Permissionless: expire unresolved
        </button>
        <button
          className="ghost-button"
          disabled={!canTimeout}
          onClick={onTimeout}
        >
          Permissionless: timeout refund
        </button>
      </div>
      {!canTimeout && (
        <p className="inline-warning">
          Timeout recovery is disabled until the finalized contract
          createdAt/readAt clock confirms that the hard deadline has passed.
        </p>
      )}
    </section>
  );
}

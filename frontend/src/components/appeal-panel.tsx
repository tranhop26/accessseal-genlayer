export type AppealEligibility = {
  available: boolean;
  reason: string | null;
  round: bigint | null;
  bond: bigint | null;
  roundData: unknown;
};
export function AppealPanel({
  eligibility,
  onAppeal,
  busy = false,
}: {
  eligibility: AppealEligibility;
  onAppeal: () => void;
  busy?: boolean;
}) {
  return (
    <section className="action-card">
      <span className="eyebrow">Protocol appeal</span>
      <h3>Challenge the accepted transaction</h3>
      <p>
        Eligibility, active round and minimum bond are read directly from the
        GenLayer protocol using the review transaction ID.
      </p>
      <dl className="compact-dl">
        <div>
          <dt>Round</dt>
          <dd>{eligibility.round?.toString() ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Minimum bond</dt>
          <dd>
            {eligibility.bond === null
              ? "Unavailable"
              : `${eligibility.bond} wei`}
          </dd>
        </div>
      </dl>
      {eligibility.reason && (
        <p className="inline-warning">{eligibility.reason}</p>
      )}
      <button
        className="secondary-button"
        disabled={!eligibility.available || busy}
        onClick={onAppeal}
      >
        {busy ? "Appeal pending…" : "Appeal review"}
      </button>
    </section>
  );
}

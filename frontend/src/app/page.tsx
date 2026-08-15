import Link from "next/link";
export default function HomePage() {
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Proof before payout</span>
          <h1>
            Accessibility acceptance that neither side can quietly rewrite.
          </h1>
          <p>
            Lock a release profile, bind the exact evidence, and let GenLayer
            validators reach a semantic decision before simulated escrow
            dispatch.
          </p>
          <div className="button-row">
            <Link className="primary-button" href="/cases/new">
              Create an acceptance case
            </Link>
            <Link className="secondary-button" href="/cases">
              Open dashboard
            </Link>
          </div>
          <div className="trust-row">
            <span>Intelligent Contract authority</span>
            <span>Independent evidence fetch</span>
            <span>Finality-aware settlement</span>
          </div>
        </div>
        <div className="hero-orbit" aria-label="AccessSeal trust workflow">
          <div className="orbit-core">
            <span>GENLAYER</span>
            <strong>
              Semantic
              <br />
              consensus
            </strong>
          </div>
          <span className="orbit-node node-a">Terms locked</span>
          <span className="orbit-node node-b">Evidence bound</span>
          <span className="orbit-node node-c">Dispatch verified</span>
        </div>
      </section>
      <section className="feature-grid" aria-labelledby="how-title">
        <div className="section-intro">
          <span className="eyebrow">A stricter workflow</span>
          <h2 id="how-title">
            The contract—not the dashboard—decides what happens next.
          </h2>
        </div>
        <article>
          <span>01</span>
          <h3>Freeze the acceptance target</h3>
          <p>
            Buyer and vendor consent to immutable profile, flow, deadline, and
            release terms.
          </p>
        </article>
        <article>
          <span>02</span>
          <h3>Bind retrievable proof</h3>
          <p>
            Hashes, origin, freshness, manifest membership and exact payload
            locations travel together.
          </p>
        </article>
        <article>
          <span>03</span>
          <h3>Wait for real finality</h3>
          <p>
            Accepted, appealable, finalized, executed and recipient-confirmed
            are never collapsed into one green badge.
          </p>
        </article>
      </section>
    </div>
  );
}

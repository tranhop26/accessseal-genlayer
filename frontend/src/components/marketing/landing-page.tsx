import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Metric, Panel } from "@/components/ui/panel";
import { Timeline } from "@/components/ui/timeline";
import styles from "./marketing.module.css";

const transactionPhases = [
  "Terms locked",
  "Evidence fetched by validators",
  "Validator decision",
  "Finalized readback",
] as const;

export function LandingPage() {
  return (
    <div className={styles.landing}>
      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Proof before payout</p>
          <h1 id="landing-title">
            Accessibility acceptance with a record neither side can quietly
            rewrite.
          </h1>
          <p className={styles.lede}>
            AccessSeal locks the acceptance terms, gives validators the evidence
            they need, and dispatches simulated settlement only after a
            finalized decision is available to read back.
          </p>
          <div className={styles.actions}>
            <Button href="/cases/new">Create case</Button>
            <Button href="/cases" variant="secondary">
              View cases
            </Button>
          </div>
        </div>
        <div className={styles.preview}>
          <Panel title="AccessSeal workflow preview">
            <div className={styles.previewHeader}>
              <Badge tone="info">SIMULATED ESCROW</Badge>
              <span>Case AS-1048</span>
            </div>
            <div className={styles.metrics}>
              <Metric label="Release amount" value="2,400 GEN" />
              <Metric label="Acceptance target" value="WCAG evidence bundle" />
            </div>
            <div className={styles.evidence}>
              <span>Evidence bundle</span>
              <strong>
                Audit report, route recording, and signed manifest
              </strong>
            </div>
            <div className={styles.decision}>
              <Badge tone="warning">ACCEPTED</Badge>
              <span>Validator decision awaiting protocol finality</span>
            </div>
            <Timeline
              label="Transaction phases"
              items={transactionPhases}
              current="Validator decision"
            />
          </Panel>
        </div>
      </section>
      <section className={styles.trustStrip} aria-label="Workflow safeguards">
        <p>
          <strong>Immutable terms</strong> keep the agreed acceptance target in
          view.
        </p>
        <p>
          <strong>Independent validator fetch</strong> checks the submitted
          evidence at its source.
        </p>
        <p>
          <strong>Finalized settlement dispatch</strong> waits for a readable
          outcome before release.
        </p>
      </section>
      <section className={styles.section} aria-labelledby="workflow-title">
        <div className={styles.sectionIntro}>
          <p className={styles.eyebrow}>A clear operating sequence</p>
          <h2 id="workflow-title">
            Lock, verify, then settle from the same record.
          </h2>
        </div>
        <ol className={styles.stepGrid}>
          <li>
            <span>01</span>
            <h3>Lock</h3>
            <p>
              Set the acceptance profile, evidence references, deadline, and
              release amount before work is reviewed.
            </p>
          </li>
          <li>
            <span>02</span>
            <h3>Verify</h3>
            <p>
              Validators retrieve the evidence bundle and issue a decision
              against the terms both parties accepted.
            </p>
          </li>
          <li>
            <span>03</span>
            <h3>Settle</h3>
            <p>
              Dispatch simulated escrow only after the finalized result can be
              independently read back.
            </p>
          </li>
        </ol>
      </section>
      <section className={styles.section} aria-labelledby="comparison-title">
        <div className={styles.sectionIntro}>
          <p className={styles.eyebrow}>Acceptance that holds up</p>
          <h2 id="comparison-title">
            Replace a mutable handoff with an authoritative acceptance record.
          </h2>
        </div>
        <div className={styles.comparison}>
          <article className={styles.comparisonCard}>
            <p className={styles.cardLabel}>Manual acceptance</p>
            <h3>Messages and attachments can drift.</h3>
            <p>
              Terms, proof, and payout status live in separate places and may
              change after review begins.
            </p>
          </article>
          <article
            className={`${styles.comparisonCard} ${styles.authoritative}`}
          >
            <p className={styles.cardLabel}>AccessSeal acceptance</p>
            <h3>One decision path stays accountable.</h3>
            <p>
              Locked terms, validator-fetched evidence, and finalized settlement
              readback remain connected.
            </p>
          </article>
        </div>
      </section>
      <section className={styles.finalCta} aria-labelledby="cta-title">
        <div>
          <p className={styles.eyebrow}>Start with the agreement</p>
          <h2 id="cta-title">
            Make acceptance clear before the release is at stake.
          </h2>
        </div>
        <div className={styles.finalCtaAction}>
          <Button href="/cases/new">Start a case</Button>
        </div>
      </section>
    </div>
  );
}

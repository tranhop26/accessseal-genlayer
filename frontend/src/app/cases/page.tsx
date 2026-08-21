import { CasesDashboard } from "@/components/cases/cases-dashboard";
import { Button } from "@/components/ui/button";
import styles from "./cases-page.module.css";

export default function CasesPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.eyebrow}>Authoritative readbacks</span>
          <h1>Acceptance cases</h1>
          <p>
            The frozen contract has no public enumeration method. Import a known
            case ID; every displayed field is then reconciled from finalized
            contract state.
          </p>
        </div>
        <Button href="/cases/new">New case</Button>
      </header>
      <CasesDashboard />
    </div>
  );
}

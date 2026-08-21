import type { ReactNode } from "react";
import type { BadgeTone } from "./badge";
import styles from "./ui.module.css";

export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={styles.panel}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {children}
    </section>
  );
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <dl className={styles.metric}>
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    </dl>
  );
}

export function InlineNotice({
  tone = "info",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <aside
      className={styles.inlineNotice}
      data-tone={tone}
      role={tone === "danger" ? "alert" : "note"}
    >
      {children}
    </aside>
  );
}

import type { ReactNode } from "react";
import styles from "./ui.module.css";

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}

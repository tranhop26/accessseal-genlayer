"use client";

import { useEffect } from "react";
import styles from "./transaction-toast.module.css";

export function TransactionToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span>{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss notification" type="button">
        ×
      </button>
    </div>
  );
}

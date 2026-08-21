"use client";

import { useWallet } from "@/providers/wallet-provider";
import buttonStyles from "./ui/ui.module.css";
import styles from "./navigation/navigation.module.css";

export function WalletButton() {
  const wallet = useWallet();
  const connected = wallet.status === "connected" && !!wallet.address;
  const connecting = !connected && wallet.status === "connecting";

  return (
    <div className={styles.walletStack}>
      <button
        aria-busy={connecting}
        aria-disabled={connecting}
        aria-label={connected ? `Disconnect wallet ${wallet.address}` : undefined}
        className={`${buttonStyles.button} ${buttonStyles.buttonsecondary}${connected ? ` ${styles.walletButtonConnected}` : ""}`}
        data-wallet-address={wallet.address ?? ""}
        data-wallet-network={wallet.config?.network ?? ""}
        data-wallet-status={wallet.status}
        onClick={connected ? wallet.disconnect : connecting ? undefined : wallet.connect}
        type="button"
      >
        {connected
          ? `${wallet.address!.slice(0, 6)}…${wallet.address!.slice(-4)}`
          : connecting
            ? "Connecting…"
            : wallet.status === "wrong-network"
              ? "Switch network"
              : "Connect wallet"}
      </button>
      {wallet.error && <span className={styles.walletError} role="alert">{wallet.error}</span>}
    </div>
  );
}

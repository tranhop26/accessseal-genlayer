"use client";
import { useWallet } from "@/providers/wallet-provider";

export function WalletButton() {
  const wallet = useWallet();
  const connected = wallet.status === "connected" && !!wallet.address;
  return (
    <div className="wallet-stack">
      <button
        className={`wallet-button${connected ? " connected" : ""}`}
        onClick={
          connected
            ? wallet.disconnect
            : wallet.status === "connecting"
              ? undefined
              : wallet.connect
        }
        aria-disabled={!connected && wallet.status === "connecting"}
        aria-busy={!connected && wallet.status === "connecting"}
        aria-label={connected ? `Disconnect wallet ${wallet.address}` : undefined}
        data-wallet-status={wallet.status}
        data-wallet-address={wallet.address ?? ""}
        data-wallet-network={wallet.config?.network ?? ""}
      >
        {connected ? (
          <>
            <span className="wallet-dot" />
            {wallet.address!.slice(0, 6)}…{wallet.address!.slice(-4)}
          </>
        ) : wallet.status === "connecting" ? (
          "Connecting…"
        ) : wallet.status === "wrong-network" ? (
          "Switch network"
        ) : (
          "Connect wallet"
        )}
      </button>
      {wallet.error && (
        <span className="wallet-error" role="alert">
          {wallet.error}
        </span>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CaseComposer, type CaseDraft } from "@/components/case-composer";
import { StatusPanel } from "@/components/status-panel";
import { useWallet } from "@/providers/wallet-provider";
import { trackTransaction, type TransactionState } from "@/lib/transactions";
import { finalizeCreatedCase } from "@/lib/case-cache";
import { InlineNotice } from "@/components/ui/panel";
import styles from "../cases-page.module.css";
export default function NewCasePage() {
  const wallet = useWallet();
  const router = useRouter();
  const [tx, setTx] = useState<TransactionState | null>(null);
  const [error, setError] = useState("");
  async function create(draft: CaseDraft) {
    if (!wallet.contract || !wallet.sdk) {
      setError(
        "Connect a wallet on the configured GenLayer network before creating a case.",
      );
      return;
    }
    if (
      !wallet.address ||
      !wallet.config ||
      draft.authority.buyer !== wallet.address ||
      draft.authority.chainId !== wallet.config.chainId ||
      draft.authority.network !== wallet.config.network ||
      draft.authority.contractAddress !== wallet.config.contractAddress
    ) {
      setError("Wallet or network changed; regenerate the canonical preview.");
      return;
    }
    setError("");
    try {
      const hash = await wallet.contract.createCase({
        salt: draft.salt,
        vendor: draft.vendor,
        profileHash: draft.profileHash,
        flowsHash: draft.flowsHash,
        subjectOrigin: draft.subjectOrigin,
        evidenceDeadline: draft.evidenceDeadline,
        hardDeadline: draft.hardDeadline,
        maxUnresolvedRetries: draft.maxUnresolvedRetries,
        escrowAmount: draft.escrowAmount,
      });
      const result = await trackTransaction(
        wallet.sdk as never,
        hash,
        setTx,
        async () => {
          if (!wallet.readContract)
            throw new Error("Public contract reader is unavailable.");
          await finalizeCreatedCase(
            wallet.readContract,
            localStorage,
            draft.caseId,
            draft.termsHash,
            hash,
          );
        },
      );
      if (result.phase === "FINALIZED_SUCCESS")
        router.push(`/cases/${encodeURIComponent(draft.caseId)}`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Wallet transaction failed.",
      );
    }
  }
  return (
    <div className={`${styles.shell} ${styles.narrow}`}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.eyebrow}>Three-step case creation</span>
          <h1>Define what “accessible” means before work begins.</h1>
          <p>
            These terms become immutable contract state. Review every hash
            before your wallet signs.
          </p>
        </div>
      </header>
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      {tx && <StatusPanel state={tx} />}
      <CaseComposer
        onCreate={create}
        authority={
          wallet.address && wallet.config
            ? {
                buyer: wallet.address,
                chainId: wallet.config.chainId,
                network: wallet.config.network,
                contractAddress: wallet.config.contractAddress,
              }
            : null
        }
      />
    </div>
  );
}

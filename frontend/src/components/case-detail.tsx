"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/providers/wallet-provider";
import {
  reconcileCase,
  trackTransaction,
  type ReconciledCase,
  type TransactionState,
} from "@/lib/transactions";
import {
  canonicalizeEvidence,
  hashEvidence,
  validateEvidenceForCase,
  type EvidenceEnvelopeV1,
} from "@/lib/evidence";
import { CaseSkeleton, ErrorState } from "./skeletons";
import { StatusPanel } from "./status-panel";
import { EvidenceInspector } from "./evidence-inspector";
import { ReviewTracker } from "./review-tracker";
import { VerdictExplorer } from "./verdict-explorer";
import { RecoveryPanel } from "./recovery-panel";
import { AppealPanel, type AppealEligibility } from "./appeal-panel";
import { SettlementPanel, type DispatchConfirmation } from "./settlement-panel";
import {
  parseReviewTxBinding,
  matchesExactUserError,
  validateReviewTxBinding,
  type EvidenceRecord,
  type Hash,
} from "@/lib/access-seal";

const REVIEW_TX_PREFIX = "accessseal.review-tx.v1:";
export function CaseDetail({ caseId }: { caseId: string }) {
  const wallet = useWallet();
  const [data, setData] = useState<ReconciledCase | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tx, setTx] = useState<TransactionState | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const writeLock = useRef(false);
  const [evidenceJson, setEvidenceJson] = useState("");
  const [previewHash, setPreviewHash] = useState("");
  const [eligibility, setEligibility] = useState<AppealEligibility>({
    available: false,
    reason:
      "Review transaction ID is unavailable; eligibility cannot be proven.",
    round: null,
    bond: null,
    roundData: null,
  });
  const [confirmation] = useState<DispatchConfirmation>({
    status: "PENDING",
    childTransaction: null,
    recipientBalanceConfirmed: false,
  });
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (!wallet.readContract)
        throw new Error("Public contract reader is unavailable.");
      const next = await reconcileCase(wallet.readContract, caseId);
      setData(next);
      try {
        setEvidence(
          await wallet.readContract.readEvidence(caseId, next.case.epoch),
        );
      } catch (cause) {
        if (
          matchesExactUserError(cause, "evidence epoch does not exist")
        )
          setEvidence(null);
        else throw cause;
      }
      const stored = parseReviewTxBinding(
        localStorage.getItem(`${REVIEW_TX_PREFIX}${caseId}`),
      );
      const expected =
        next.review && next.reviewFinality && wallet.config
          ? {
              chainId: next.case.chainId,
              network: wallet.config.network,
              contract: next.case.contractAddress,
              caseId,
              epoch: next.case.epoch,
              releaseDigest: next.review.releaseDigest,
              proofId: next.reviewFinality.proofId,
            }
          : null;
      const valid =
        !!expected &&
        validateReviewTxBinding(stored, expected) &&
        (await wallet.readContract.verifyReviewTransaction(
          stored!.txId,
          caseId,
        ));
      if (!valid) {
        localStorage.removeItem(`${REVIEW_TX_PREFIX}${caseId}`);
        setEligibility(await wallet.readContract.appealEligibility());
      } else
        setEligibility(
          await wallet.readContract.appealEligibility(stored!.txId),
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Finalized readback failed.",
      );
    } finally {
      setLoading(false);
    }
  }, [caseId, wallet.readContract, wallet.config]);
  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);
  const actor = wallet.address?.toLowerCase();
  const isBuyer = actor === data?.case.buyer.toLowerCase();
  const isVendor = actor === data?.case.vendor.toLowerCase();
  const finalized = data?.reviewFinality?.status === "FINALIZED";
  async function run(operation: () => Promise<Hash>, rememberReview = false) {
    if (writeLock.current) return;
    if (!wallet.sdk) {
      setError("Connect a wallet before sending a transaction.");
      return;
    }
    setError("");
    writeLock.current = true;
    setWriteBusy(true);
    try {
      const hash = await operation();
      const reconciled: { value: ReconciledCase | null } = { value: null };
      const result = await trackTransaction(
        wallet.sdk as never,
        hash,
        setTx,
        async () => {
          if (!wallet.readContract)
            throw new Error("Public contract reader is unavailable.");
          reconciled.value = await reconcileCase(wallet.readContract, caseId);
          setData(reconciled.value);
        },
      );
      const current = reconciled.value;
      if (
        result.phase === "FINALIZED_SUCCESS" &&
        rememberReview &&
        current?.review &&
        current.reviewFinality &&
        wallet.config
      ) {
        localStorage.setItem(
          `${REVIEW_TX_PREFIX}${caseId}`,
          JSON.stringify({
            txId: hash,
            chainId: current.case.chainId,
            network: wallet.config.network,
            contract: current.case.contractAddress,
            method: "request_review",
            caseId,
            epoch: current.case.epoch,
            releaseDigest: current.review.releaseDigest,
            proofId: current.reviewFinality.proofId,
          }),
        );
      }
      if (result.phase === "FINALIZED_SUCCESS") await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Transaction was rejected.",
      );
    } finally {
      writeLock.current = false;
      setWriteBusy(false);
    }
  }
  async function inspectEnvelope() {
    try {
      const parsed = JSON.parse(evidenceJson) as EvidenceEnvelopeV1;
      const validation = validateEvidenceForCase(parsed, {
        caseId,
        epoch: data?.case.epoch ?? -1,
        subjectOrigin: data?.case.subjectOrigin ?? "",
        profileHash: data?.case.profileHash ?? "",
          currentTimestamp: Math.floor(Date.now() / 1000),
        chainId: data?.case.chainId ?? -1,
        contract: data?.case.contractAddress ?? "",
        issuer: data?.case.vendor ?? "",
        action: evidence ? "APPEND_EVIDENCE" : "OPEN_RELEASE",
        releaseDigest: (!evidence
          ? parsed.releaseDigest
          : evidence.releaseDigest) as `sha256:${string}`,
        evidenceWindow: data?.case.evidenceDeadline ?? 0,
      });
      if (!validation.ok) throw new Error(validation.issues.join(" "));
      canonicalizeEvidence(parsed);
      setPreviewHash(await hashEvidence(parsed));
      setError("");
    } catch (cause) {
      setPreviewHash("");
      setError(
        cause instanceof Error ? cause.message : "Evidence JSON is malformed.",
      );
    }
  }
  async function submitEvidence() {
    if (!wallet.contract || !data) return;
    const envelope = JSON.parse(evidenceJson) as EvidenceEnvelopeV1;
    const operation =
      !evidence
        ? () => wallet.contract!.openEvidence(caseId, envelope)
        : () => wallet.contract!.appendEvidence(caseId, envelope);
    await run(operation);
  }
  const timeline = useMemo(
    () => [
      "DRAFT",
      "FUNDED",
      "EVIDENCE_OPEN",
      "REVIEW_PENDING",
      "DECIDED",
      "SETTLEMENT_PENDING",
      "DISPATCHED_FINALIZED",
    ],
    [],
  );
  if (loading && !data)
    return (
      <div className="page-shell">
        <CaseSkeleton />
      </div>
    );
  if (error && !data)
    return (
      <div className="page-shell">
        <ErrorState message={error} onRetry={() => void refresh()} />
      </div>
    );
  if (!data) return null;
  return (
    <div className="page-shell">
      <header className="case-hero">
        <div>
          <span className="eyebrow">Case {caseId.slice(0, 12)}…</span>
          <h1>{data.case.subjectOrigin}</h1>
          <p>Epoch {data.case.epoch} · Finalized contract readback</p>
        </div>
        <button
          className="ghost-button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "Reconciling…" : "Refresh readback"}
        </button>
      </header>
      {error && (
        <div className="error-state" role="alert">
          {error}
        </div>
      )}
      {tx && <StatusPanel state={tx} />}
      <ol className="lifecycle" aria-label="Case lifecycle" tabIndex={0}>
        {timeline.map((stage) => {
          const current = stage === data.case.lifecycle;
          const reached =
            timeline.indexOf(stage) <= timeline.indexOf(data.case.lifecycle);
          return (
            <li
              className={current ? "current" : reached ? "reached" : ""}
              aria-current={current ? "step" : undefined}
              key={stage}
            >
              <span />
              {stage.replaceAll("_", " ")}
            </li>
          );
        })}
      </ol>
      <div className="detail-grid">
        <section className="workflow-card">
          <span className="eyebrow">Immutable agreement</span>
          <h2>Locked terms</h2>
          <dl className="compact-dl">
            <div>
              <dt>Buyer</dt>
              <dd>
                <code>{data.case.buyer}</code>
              </dd>
            </div>
            <div>
              <dt>Vendor</dt>
              <dd>
                <code>{data.case.vendor}</code>
              </dd>
            </div>
            <div>
              <dt>Profile hash</dt>
              <dd>
                <code>{data.case.profileHash}</code>
              </dd>
            </div>
            <div>
              <dt>Flows hash</dt>
              <dd>
                <code>{data.case.flowsHash}</code>
              </dd>
            </div>
            <div>
              <dt>Simulated escrow</dt>
              <dd>{data.case.escrowAmount.toString()} wei</dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd>{data.case.reserved.toString()} wei</dd>
            </div>
          </dl>
          <div className="button-row">
            {isVendor &&
              data.case.lifecycle === "DRAFT" &&
              !data.case.vendorAccepted && (
                <button
                  className="secondary-button"
                  disabled={writeBusy}
                  onClick={() =>
                    wallet.contract &&
                    void run(() =>
                      wallet.contract!.acceptTerms(caseId, data.case.termsHash),
                    )
                  }
                >
                  Accept exact terms
                </button>
              )}
            {isBuyer && data.case.lifecycle === "DRAFT" && (
              <button
                className="primary-button"
                disabled={!data.case.vendorAccepted || writeBusy}
                onClick={() =>
                  wallet.contract &&
                  void run(() =>
                    wallet.contract!.fund(
                      caseId,
                      BigInt(data.case.escrowAmount),
                    ),
                  )
                }
              >
                Fund simulated escrow
              </button>
            )}
          </div>
        </section>
        <section className="workflow-card">
          <span className="eyebrow">Accounting invariant</span>
          <h2>Conservation readback</h2>
          <div className="metric-grid">
            <div>
              <span>Total deposits</span>
              <strong>{data.accounting.totalDeposits.toString()}</strong>
            </div>
            <div>
              <span>Reserved</span>
              <strong>{data.accounting.reserved.toString()}</strong>
            </div>
            <div>
              <span>Pending</span>
              <strong>{data.accounting.pendingDispatch.toString()}</strong>
            </div>
            <div>
              <span>Dispatched</span>
              <strong>
                {(
                  data.accounting.dispatchedPayouts +
                  data.accounting.dispatchedRefunds
                ).toString()}
              </strong>
            </div>
          </div>
        </section>
      </div>
      {isVendor &&
        ["FUNDED", "EVIDENCE_OPEN"].includes(data.case.lifecycle) && (
          <section className="workflow-card">
            <span className="eyebrow">Canonical envelope</span>
            <h2>
              {!evidence
                ? "Open release evidence"
                : "Append supporting evidence"}
            </h2>
            <p>
              Paste an exact AccessSeal evidence/1 envelope. The preview
              validates origin, epoch, freshness, media type and canonical
              digest before signing.
            </p>
            <label>
              Evidence envelope JSON
              <textarea
                rows={9}
                value={evidenceJson}
                onChange={(event) => {
                  setEvidenceJson(event.target.value);
                  setPreviewHash("");
                }}
              />
            </label>
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={writeBusy}
                onClick={() => void inspectEnvelope()}
              >
                Validate canonical preview
              </button>
              <button
                className="primary-button"
                disabled={!previewHash || writeBusy}
                onClick={() => void submitEvidence()}
              >
                Sign and submit evidence
              </button>
            </div>
            {previewHash && (
              <div className="hash-box success">
                <span>Canonical hash</span>
                <code>{previewHash}</code>
              </div>
            )}
          </section>
        )}
      {evidence && <EvidenceInspector evidence={evidence} now={now} />}
      {data.case.lifecycle === "EVIDENCE_OPEN" && (
        <section className="action-card">
          <span className="eyebrow">Semantic review</span>
          <h2>Request validator consensus</h2>
          <p>
            The request becomes eligible only after the contract evidence
            cutoff; failed eligibility leaves state unchanged.
          </p>
          <button
            className="primary-button"
            disabled={writeBusy}
            onClick={() =>
              wallet.contract &&
              void run(() => wallet.contract!.requestReview(caseId), true)
            }
          >
            Request intelligent review
          </button>
        </section>
      )}
      {data.review && data.reviewFinality && (
        <>
          <ReviewTracker
            review={data.review}
            finality={data.reviewFinality}
            transactionPhase={
              data.reviewFinality.status === "FINALIZED"
                ? "FINALIZED_SUCCESS"
                : "ACCEPTED"
            }
            cureDeadline={undefined}
            retryAvailableAt={
              data.reviewAttempt
                ? data.reviewAttempt.decidedAt + 300
                : undefined
            }
          />
          <div className="detail-grid">
            <VerdictExplorer review={data.review} />
            <AppealPanel
              eligibility={eligibility}
              onAppeal={() => {
                const reviewTx = parseReviewTxBinding(
                  localStorage.getItem(`${REVIEW_TX_PREFIX}${caseId}`),
                )?.txId;
                if (wallet.contract && reviewTx && eligibility.bond !== null)
                  void run(() =>
                    wallet.contract!.appeal(reviewTx, eligibility.bond!),
                  );
              }}
            />
          </div>
          <RecoveryPanel
            verdict={data.review.verdict}
            canCure={
              !!isVendor &&
              finalized &&
              data.review.verdict === "REQUEST_MORE_INFO" &&
              data.case.epoch === 0
            }
            canRetry={
              !!finalized &&
              data.review.verdict === "UNRESOLVED" &&
              !!data.reviewAttempt &&
              data.reviewAttempt.attempt < data.case.maxUnresolvedRetries &&
              now >= data.reviewAttempt.decidedAt + 300
            }
            canExpire={
              !!finalized &&
              ((data.review.verdict === "UNRESOLVED" &&
                !!data.reviewAttempt &&
                data.reviewAttempt.attempt >= data.case.maxUnresolvedRetries) ||
                (data.review.verdict === "REQUEST_MORE_INFO" &&
                  data.case.epoch > 0))
            }
            canTimeout={false}
            retryAvailableAt={
              data.reviewAttempt
                ? data.reviewAttempt.decidedAt + 300
                : undefined
            }
            onCure={() =>
              wallet.contract &&
              void run(() => wallet.contract!.startCure(caseId))
            }
            onRetry={() =>
              wallet.contract &&
              void run(() =>
                wallet.contract!.retryReview(caseId, crypto.randomUUID()),
              )
            }
            onExpire={() =>
              wallet.contract &&
              void run(() => wallet.contract!.expireUnresolved(caseId))
            }
            onTimeout={() =>
              wallet.contract &&
              void run(() => wallet.contract!.timeoutRefund(caseId))
            }
          />
        </>
      )}
      <SettlementPanel
        canPrepare={
          !!finalized &&
          ["APPROVED", "REJECTED"].includes(data.review?.verdict ?? "")
        }
        settlement={data.settlement}
        accounting={data.accounting}
        confirmation={confirmation}
        busy={writeBusy}
        onPrepare={() => {
          if (!wallet.contract || !data.review) return;
          void run(
            data.review.verdict === "APPROVED"
              ? () => wallet.contract!.preparePayout(caseId)
              : () => wallet.contract!.prepareRefund(caseId),
          );
        }}
        onExecute={() => {
          if (wallet.contract && data.settlement)
            void run(() =>
              wallet.contract!.executeSettlement(
                caseId,
                data.settlement!.settlementId,
              ),
            );
        }}
      />
    </div>
  );
}

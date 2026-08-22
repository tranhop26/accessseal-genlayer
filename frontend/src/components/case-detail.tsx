"use client";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  isSettlementExecutable,
  SettlementPanel,
  type DispatchConfirmation,
} from "./settlement-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import styles from "./cases/case-detail.module.css";
import {
  parseReviewTxBinding,
  matchesExactUserError,
  validateReviewTxBinding,
  type EvidenceRecord,
  type Hash,
} from "@/lib/access-seal";

const REVIEW_TX_PREFIX = "accessseal.review-tx.v1:";

type PriorityAction =
  | "ACCEPT_TERMS"
  | "FUND"
  | "SUBMIT_EVIDENCE"
  | "REQUEST_REVIEW"
  | "CURE"
  | "RETRY"
  | "EXPIRE"
  | "TIMEOUT"
  | "PREPARE_SETTLEMENT"
  | "EXECUTE_SETTLEMENT";

function selectPriorityAction(flags: {
  canAcceptTerms: boolean;
  canFund: boolean;
  canSubmitEvidence: boolean;
  canRequestReview: boolean;
  canCure: boolean;
  canRetry: boolean;
  canExpire: boolean;
  canTimeout: boolean;
  canPrepareSettlement: boolean;
  canExecuteSettlement: boolean;
}): PriorityAction | null {
  if (flags.canAcceptTerms) return "ACCEPT_TERMS";
  if (flags.canFund) return "FUND";
  if (flags.canSubmitEvidence) return "SUBMIT_EVIDENCE";
  if (flags.canRequestReview) return "REQUEST_REVIEW";
  if (flags.canCure) return "CURE";
  if (flags.canRetry) return "RETRY";
  if (flags.canExpire) return "EXPIRE";
  if (flags.canTimeout) return "TIMEOUT";
  if (flags.canPrepareSettlement) return "PREPARE_SETTLEMENT";
  if (flags.canExecuteSettlement) return "EXECUTE_SETTLEMENT";
  return null;
}

const priorityActionLabels: Record<PriorityAction, string> = {
  ACCEPT_TERMS: "Accept exact terms",
  FUND: "Fund simulated escrow",
  SUBMIT_EVIDENCE: "Submit evidence",
  REQUEST_REVIEW: "Request intelligent review",
  CURE: "Start cure",
  RETRY: "Retry review",
  EXPIRE: "Expire unresolved",
  TIMEOUT: "Timeout refund",
  PREPARE_SETTLEMENT: "Prepare settlement",
  EXECUTE_SETTLEMENT: "Execute prepared settlement",
};

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
        if (matchesExactUserError(cause, "evidence epoch does not exist"))
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
    const operation = !evidence
      ? () => wallet.contract!.openEvidence(caseId, envelope)
      : () => wallet.contract!.appendEvidence(caseId, envelope);
    await run(operation);
  }
  const canAcceptTerms =
    !!isVendor && data?.case.lifecycle === "DRAFT" && !data.case.vendorAccepted;
  const canFund =
    !!isBuyer && data?.case.lifecycle === "DRAFT" && data.case.vendorAccepted;
  const canSubmitEvidence =
    !!isVendor &&
    !!data &&
    ["FUNDED", "EVIDENCE_OPEN"].includes(data.case.lifecycle);
  const canRequestReview = data?.case.lifecycle === "EVIDENCE_OPEN";
  const canCure =
    !!isVendor &&
    finalized &&
    data?.review?.verdict === "REQUEST_MORE_INFO" &&
    data.case.epoch === 0;
  const canRetry =
    !!finalized &&
    data?.review?.verdict === "UNRESOLVED" &&
    !!data.reviewAttempt &&
    data.reviewAttempt.attempt < data.case.maxUnresolvedRetries &&
    now >= data.reviewAttempt.decidedAt + 300;
  const canExpire =
    !!finalized &&
    !!data &&
    ((data.review?.verdict === "UNRESOLVED" &&
      !!data.reviewAttempt &&
      data.reviewAttempt.attempt >= data.case.maxUnresolvedRetries) ||
      (data.review?.verdict === "REQUEST_MORE_INFO" && data.case.epoch > 0));
  const canTimeout = false;
  const canPrepareSettlement =
    !data?.settlement &&
    !!finalized &&
    ["APPROVED", "REJECTED"].includes(data?.review?.verdict ?? "");
  const canExecuteSettlement = isSettlementExecutable(data?.settlement ?? null);
  const priorityAction = selectPriorityAction({
    canAcceptTerms,
    canFund,
    canSubmitEvidence,
    canRequestReview,
    canCure,
    canRetry,
    canExpire,
    canTimeout,
    canPrepareSettlement,
    canExecuteSettlement,
  });

  function focusSectionAfterPrimaryActivation(
    event: MouseEvent<HTMLAnchorElement>,
  ) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const target = document.getElementById(event.currentTarget.hash.slice(1));
    window.requestAnimationFrame(() => target?.focus());
  }

  function acceptTerms() {
    if (wallet.contract && data)
      void run(() => wallet.contract!.acceptTerms(caseId, data.case.termsHash));
  }
  function fundCase() {
    if (wallet.contract && data)
      void run(() =>
        wallet.contract!.fund(caseId, BigInt(data.case.escrowAmount)),
      );
  }
  function requestReview() {
    if (wallet.contract)
      void run(() => wallet.contract!.requestReview(caseId), true);
  }
  function startCure() {
    if (wallet.contract) void run(() => wallet.contract!.startCure(caseId));
  }
  function retryReview() {
    if (wallet.contract)
      void run(() => wallet.contract!.retryReview(caseId, crypto.randomUUID()));
  }
  function expireUnresolved() {
    if (wallet.contract)
      void run(() => wallet.contract!.expireUnresolved(caseId));
  }
  function timeoutRefund() {
    if (wallet.contract) void run(() => wallet.contract!.timeoutRefund(caseId));
  }
  function prepareSettlement() {
    if (!wallet.contract || !data?.review) return;
    void run(
      data.review.verdict === "APPROVED"
        ? () => wallet.contract!.preparePayout(caseId)
        : () => wallet.contract!.prepareRefund(caseId),
    );
  }
  function executeSettlement() {
    if (wallet.contract && data?.settlement)
      void run(() =>
        wallet.contract!.executeSettlement(
          caseId,
          data.settlement!.settlementId,
        ),
      );
  }
  function runPriorityAction() {
    if (priorityAction === "ACCEPT_TERMS") return acceptTerms();
    if (priorityAction === "FUND") return fundCase();
    if (priorityAction === "SUBMIT_EVIDENCE") return void submitEvidence();
    if (priorityAction === "REQUEST_REVIEW") return requestReview();
    if (priorityAction === "CURE") return startCure();
    if (priorityAction === "RETRY") return retryReview();
    if (priorityAction === "EXPIRE") return expireUnresolved();
    if (priorityAction === "TIMEOUT") return timeoutRefund();
    if (priorityAction === "PREPARE_SETTLEMENT") return prepareSettlement();
    if (priorityAction === "EXECUTE_SETTLEMENT") return executeSettlement();
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
      <div className={styles.page}>
        <CaseSkeleton />
      </div>
    );
  if (error && !data)
    return (
      <div className={styles.page}>
        <h1 className={styles.errorPageTitle}>Case readback</h1>
        <ErrorState message={error} onRetry={() => void refresh()} />
      </div>
    );
  if (!data) return null;
  return (
    <div className={styles.page}>
      <section className={styles.summary} aria-labelledby="case-summary-title">
        <header className={styles.summaryHeader}>
          <div>
            <span className={styles.eyebrow}>Authoritative case readback</span>
            <h1 id="case-summary-title">Case summary</h1>
            <p>
              {data.case.subjectOrigin} · Epoch {data.case.epoch}
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "Reconciling…" : "Refresh readback"}
          </Button>
        </header>
        <dl className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <dt>Case ID</dt>
            <dd>
              <code title={caseId}>{caseId}</code>
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Lifecycle</dt>
            <dd>
              <Badge tone="info">
                {data.case.lifecycle.replaceAll("_", " ")}
              </Badge>
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Amount</dt>
            <dd>{data.case.escrowAmount.toString()} wei</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Buyer</dt>
            <dd>
              <code title={data.case.buyer}>{data.case.buyer}</code>
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Vendor</dt>
            <dd>
              <code title={data.case.vendor}>{data.case.vendor}</code>
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt>Verdict</dt>
            <dd>
              {data.review?.verdict.replaceAll("_", " ") ?? "Not available"}
            </dd>
          </div>
        </dl>
        <div className={styles.summaryAction}>
          <div>
            <strong>Priority action</strong>
            <p>
              Selected from the currently valid authoritative controls below.
            </p>
          </div>
          {priorityAction ? (
            <Button
              disabled={
                writeBusy ||
                (priorityAction === "SUBMIT_EVIDENCE" && !previewHash)
              }
              onClick={runPriorityAction}
            >
              {priorityActionLabels[priorityAction]}
            </Button>
          ) : (
            <Badge tone="neutral">No action currently available</Badge>
          )}
        </div>
      </section>
      {error && (
        <div className={styles.errorNotice} role="alert">
          {error}
        </div>
      )}
      {tx && <StatusPanel state={tx} />}
      <ol className={styles.lifecycle} aria-label="Case lifecycle" tabIndex={0}>
        {timeline.map((stage) => {
          const current = stage === data.case.lifecycle;
          const reached =
            timeline.indexOf(stage) <= timeline.indexOf(data.case.lifecycle);
          return (
            <li
              aria-current={current ? "step" : undefined}
              data-state={
                current ? "current" : reached ? "complete" : "upcoming"
              }
              key={stage}
            >
              <span aria-hidden="true" />
              {stage.replaceAll("_", " ").toLowerCase()}
            </li>
          );
        })}
      </ol>
      <nav className={styles.sectionNav} aria-label="Case sections">
        <ul>
          <li>
            <a href="#terms" onClick={focusSectionAfterPrimaryActivation}>
              Terms
            </a>
          </li>
          <li>
            <a href="#evidence" onClick={focusSectionAfterPrimaryActivation}>
              Evidence
            </a>
          </li>
          <li>
            <a href="#decision" onClick={focusSectionAfterPrimaryActivation}>
              AI decision
            </a>
          </li>
          <li>
            <a
              href="#settlement"
              onClick={focusSectionAfterPrimaryActivation}
            >
              Settlement
            </a>
          </li>
        </ul>
      </nav>
      <section
        className={styles.workflowSection}
        id="terms"
        aria-labelledby="terms-heading"
        tabIndex={-1}
      >
        <header className={styles.workflowHeading}>
          <span className={styles.stepNumber}>01</span>
          <div>
            <h2 id="terms-heading">Terms</h2>
            <p>Immutable agreement and accounting readback.</p>
          </div>
        </header>
        <div className={styles.twoColumn}>
          <section className={styles.card}>
            <span className={styles.eyebrow}>Immutable agreement</span>
            <h3>Locked terms</h3>
            <dl className={styles.compactDl}>
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
            <div className={styles.buttonRow}>
              {canAcceptTerms && (
                <Button
                  variant="secondary"
                  disabled={writeBusy}
                  onClick={acceptTerms}
                >
                  Accept exact terms
                </Button>
              )}
              {isBuyer && data.case.lifecycle === "DRAFT" && (
                <Button
                  disabled={!data.case.vendorAccepted || writeBusy}
                  onClick={fundCase}
                >
                  Fund simulated escrow
                </Button>
              )}
              {!canAcceptTerms &&
                !(isBuyer && data.case.lifecycle === "DRAFT") && (
                  <p className={styles.inlineState}>
                    No actor-restricted terms action is available to this
                    wallet.
                  </p>
                )}
            </div>
          </section>
          <section className={styles.card}>
            <span className={styles.eyebrow}>Accounting invariant</span>
            <h3>Conservation readback</h3>
            <div className={styles.metricGrid}>
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
      </section>
      <section
        className={styles.workflowSection}
        id="evidence"
        aria-labelledby="evidence-heading"
        tabIndex={-1}
      >
        <header className={styles.workflowHeading}>
          <span className={styles.stepNumber}>02</span>
          <div>
            <h2 id="evidence-heading">Evidence</h2>
            <p>
              Canonical vendor submission and validator-fetchable artifacts.
            </p>
          </div>
        </header>
        {canSubmitEvidence && (
          <section className={`${styles.card} ${styles.formStack}`}>
            <span className={styles.eyebrow}>Canonical envelope</span>
            <h3>
              {!evidence
                ? "Open release evidence"
                : "Append supporting evidence"}
            </h3>
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
            <div className={styles.buttonRow}>
              <Button
                variant="secondary"
                disabled={writeBusy}
                onClick={() => void inspectEnvelope()}
              >
                Validate canonical preview
              </Button>
              <Button
                disabled={!previewHash || writeBusy}
                onClick={() => void submitEvidence()}
              >
                Sign and submit evidence
              </Button>
            </div>
            {previewHash && (
              <div className={styles.hashBox}>
                <span>Canonical hash</span>
                <code>{previewHash}</code>
              </div>
            )}
          </section>
        )}
        {!canSubmitEvidence && (
          <p className={styles.inlineState}>
            Evidence submission is not available for this wallet and lifecycle.
            Existing evidence remains visible below.
          </p>
        )}
        {evidence && <EvidenceInspector evidence={evidence} now={now} />}
        {!evidence && (
          <p className={styles.inlineState}>
            No evidence envelope exists for the authoritative case epoch.
          </p>
        )}
      </section>
      <section
        className={styles.workflowSection}
        id="decision"
        aria-labelledby="decision-heading"
        tabIndex={-1}
      >
        <header className={styles.workflowHeading}>
          <span className={styles.stepNumber}>03</span>
          <div>
            <h2 id="decision-heading">AI decision</h2>
            <p>Review finality, appeal provenance, and guarded recovery.</p>
          </div>
        </header>
        {canRequestReview && (
          <section className={styles.actionCard}>
            <span className={styles.eyebrow}>Semantic review</span>
            <h3>Request validator consensus</h3>
            <p>
              The request becomes eligible only after the contract evidence
              cutoff; failed eligibility leaves state unchanged.
            </p>
            <Button disabled={writeBusy} onClick={requestReview}>
              Request intelligent review
            </Button>
          </section>
        )}
        {!data.review && !canRequestReview && (
          <p className={styles.inlineState}>
            No review decision is available for the authoritative case epoch.
          </p>
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
            <div className={styles.decisionLayout}>
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
            <div className={styles.decisionLayout}>
              <RecoveryPanel
                verdict={data.review.verdict}
                canCure={canCure}
                canRetry={canRetry}
                canExpire={canExpire}
                canTimeout={canTimeout}
                retryAvailableAt={
                  data.reviewAttempt
                    ? data.reviewAttempt.decidedAt + 300
                    : undefined
                }
                onCure={startCure}
                onRetry={retryReview}
                onExpire={expireUnresolved}
                onTimeout={timeoutRefund}
              />
            </div>
          </>
        )}
        {data.review && !data.reviewFinality && (
          <p className={styles.inlineState}>
            Review data exists, but protocol finality is not available.
            Settlement remains locked.
          </p>
        )}
      </section>
      <section
        className={styles.workflowSection}
        id="settlement"
        aria-labelledby="settlement-heading"
        tabIndex={-1}
      >
        <header className={styles.workflowHeading}>
          <span className={styles.stepNumber}>04</span>
          <div>
            <h2 id="settlement-heading">Settlement</h2>
            <p>
              Preparation, execution, conservation, and recipient confirmation.
            </p>
          </div>
        </header>
        <SettlementPanel
          canPrepare={canPrepareSettlement}
          settlement={data.settlement}
          accounting={data.accounting}
          confirmation={confirmation}
          busy={writeBusy}
          onPrepare={prepareSettlement}
          onExecute={executeSettlement}
        />
      </section>
    </div>
  );
}

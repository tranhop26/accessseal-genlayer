"use client";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWallet } from "@/providers/wallet-provider";
import {
  reconcileCase,
  trackTransaction,
  actionReadbackConfirmed,
  classifyTransactionFailure,
  waitingForWallet,
  type ActionReadback,
  type PendingAction,
  type ReconciledCase,
  type TransactionState,
} from "@/lib/transactions";
import {
  canonicalizeEvidence,
  hashEvidence,
  validateEvidenceForCase,
  type EvidenceEnvelopeV1,
  type EvidenceType,
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
  hasAuthoritativeEvidenceSeal,
  isImmediatelyReviewableEvidenceSeal,
  matchesPendingCloseEvidenceContext,
  parseReviewTxBinding,
  parsePendingCloseEvidenceBinding,
  pendingCloseEvidenceStorageKey,
  matchesExactUserError,
  validatePendingCloseEvidenceBinding,
  validateReviewTxBinding,
  type PendingCloseEvidenceBinding,
  type EvidenceRecord,
  type Hash,
} from "@/lib/access-seal";

const REVIEW_TX_PREFIX = "accessseal.review-tx.v1:";
const REQUIRED_EARLY_SEAL_EVIDENCE_TYPES: readonly EvidenceType[] = [
  "RELEASE_MANIFEST",
  "HTML_BUNDLE",
  "SCREENSHOT",
  "DOM_FACTS",
  "SCANNER_REPORT",
  "CRITICAL_FLOW_TRACE",
];

function actionReadback(
  value: ReconciledCase,
  evidence: EvidenceRecord | null,
  appealRound: bigint | null,
): ActionReadback {
  return {
    case: value.case,
    review: value.review,
    reviewFinality: value.reviewFinality,
    reviewAttempt: value.reviewAttempt,
    settlement: value.settlement,
    accounting: value.accounting,
    evidence,
    appealRound,
  };
}

function currentUnixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

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
  const [walletConfirmation, setWalletConfirmation] =
    useState<PendingAction | null>(null);
  const [awaitingSealReadback, setAwaitingSealReadback] = useState<Hash | null>(
    null,
  );
  const awaitingSealReadbackRef = useRef<Hash | null>(null);
  const pendingSealHashRef = useRef<Hash | null>(null);
  const monitoredSealHashRef = useRef<Hash | null>(null);
  const restoredSealIdentityRef = useRef<string | null>(null);
  const refreshGeneration = useRef(0);
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
  const [now, setNow] = useState(currentUnixTimestamp);
  const pendingSealExpectedFor = useCallback(
    (caseRecord: ReconciledCase["case"]) => {
      if (wallet.status !== "connected" || !wallet.address) return null;
      return {
        account:
          wallet.address.toLowerCase() as PendingCloseEvidenceBinding["account"],
        caseId,
        chainId: caseRecord.chainId,
        contract:
          caseRecord.contractAddress.toLowerCase() as PendingCloseEvidenceBinding["contract"],
        epoch: caseRecord.epoch,
      };
    },
    [caseId, wallet.address, wallet.status],
  );
  const storedPendingSeal = useCallback(
    () =>
      parsePendingCloseEvidenceBinding(
        localStorage.getItem(pendingCloseEvidenceStorageKey(caseId)),
      ),
    [caseId],
  );
  const clearPendingSeal = useCallback(
    (hash: Hash) => {
      if (pendingSealHashRef.current !== hash) return;
      pendingSealHashRef.current = null;
      awaitingSealReadbackRef.current = null;
      setAwaitingSealReadback(null);
      const stored = storedPendingSeal();
      if (stored?.hash === hash)
        localStorage.removeItem(pendingCloseEvidenceStorageKey(caseId));
    },
    [caseId, storedPendingSeal],
  );
  const isPendingSealForCurrentEpoch = useCallback(
    (hash: Hash, caseRecord: ReconciledCase["case"]) => {
      const expected = pendingSealExpectedFor(caseRecord);
      const stored = storedPendingSeal();
      if (!expected || !stored || stored.hash !== hash) return false;
      if (!matchesPendingCloseEvidenceContext(stored, expected)) return false;
      if (!validatePendingCloseEvidenceBinding(stored, expected)) {
        clearPendingSeal(hash);
        return false;
      }
      return true;
    },
    [clearPendingSeal, pendingSealExpectedFor, storedPendingSeal],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setError("");
    try {
      if (!wallet.readContract)
        throw new Error("Public contract reader is unavailable.");
      const next = await reconcileCase(wallet.readContract, caseId);
      if (generation !== refreshGeneration.current) return;
      setData(next);
      const pendingHash = awaitingSealReadbackRef.current;
      if (
        pendingHash &&
        hasAuthoritativeEvidenceSeal(next.case) &&
        isPendingSealForCurrentEpoch(pendingHash, next.case)
      ) {
        setTx((current) =>
          current?.hash === pendingHash
            ? {
                hash: pendingHash,
                phase: "READBACK_CONFIRMED",
                message:
                  "Finalized execution and sealed authoritative readback confirmed.",
              }
            : current,
        );
        awaitingSealReadbackRef.current = null;
        setAwaitingSealReadback(null);
        pendingSealHashRef.current = null;
        const stored = parsePendingCloseEvidenceBinding(
          localStorage.getItem(pendingCloseEvidenceStorageKey(caseId)),
        );
        if (stored?.hash === pendingHash)
          localStorage.removeItem(pendingCloseEvidenceStorageKey(caseId));
      }
      try {
        const readEvidence = await wallet.readContract.readEvidence(
          caseId,
          next.case.epoch,
        );
        if (generation !== refreshGeneration.current) return;
        setEvidence(readEvidence);
      } catch (cause) {
        if (generation !== refreshGeneration.current) return;
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
      if (generation !== refreshGeneration.current) return;
      if (!valid) {
        localStorage.removeItem(`${REVIEW_TX_PREFIX}${caseId}`);
        const nextEligibility = await wallet.readContract.appealEligibility();
        if (generation !== refreshGeneration.current) return;
        setEligibility(nextEligibility);
      } else {
        const nextEligibility = await wallet.readContract.appealEligibility(
          stored!.txId,
        );
        if (generation !== refreshGeneration.current) return;
        setEligibility(nextEligibility);
      }
    } catch (cause) {
      if (generation === refreshGeneration.current)
        setError(
          cause instanceof Error ? cause.message : "Finalized readback failed.",
        );
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [
    caseId,
    isPendingSealForCurrentEpoch,
    wallet.config,
    wallet.readContract,
  ]);
  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(task);
      refreshGeneration.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(currentUnixTimestamp()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      !data ||
      data.case.lifecycle !== "EVIDENCE_OPEN" ||
      data.case.evidenceSealed ||
      data.case.evidenceCutoff === null ||
      data.case.readAt === null
    )
      return;
    const secondsUntilRefresh = Math.max(
      1,
      Math.min(60, data.case.evidenceCutoff - data.case.readAt + 1),
    );
    const timer = window.setTimeout(
      () => void refresh(),
      secondsUntilRefresh * 1_000,
    );
    return () => window.clearTimeout(timer);
  }, [data, refresh]);
  const actor = wallet.address?.toLowerCase();
  const isBuyer = actor === data?.case.buyer.toLowerCase();
  const isConnectedBuyer = wallet.status === "connected" && isBuyer;
  const isVendor = actor === data?.case.vendor.toLowerCase();
  const finalized = data?.reviewFinality?.status === "FINALIZED";
  function persistPendingSeal(hash: Hash) {
    if (!data || !wallet.address)
      throw new Error("Connected buyer binding is unavailable for the seal.");
    const binding: PendingCloseEvidenceBinding = {
      action: "close_evidence",
      account:
        wallet.address.toLowerCase() as PendingCloseEvidenceBinding["account"],
      caseId,
      chainId: data.case.chainId,
      contract:
        data.case.contractAddress.toLowerCase() as PendingCloseEvidenceBinding["contract"],
      epoch: data.case.epoch,
      hash,
    };
    localStorage.setItem(
      pendingCloseEvidenceStorageKey(caseId),
      JSON.stringify(binding),
    );
    restoredSealIdentityRef.current = `${caseId}:${hash}:${Boolean(wallet.sdk)}`;
    pendingSealHashRef.current = hash;
  }
  async function monitorTransaction(
    hash: Hash,
    rememberReview: boolean,
    action?: PendingAction,
    before?: ActionReadback,
  ) {
    const reconciled: { value: ReconciledCase | null } = { value: null };
    let result: TransactionState;
    try {
      result = await trackTransaction(
        wallet.sdk as never,
        hash,
        (nextState) => {
          setTx(nextState);
        },
        async () => {
          if (!wallet.readContract)
            throw new Error("Public contract reader is unavailable.");
          if (action === "close_evidence") {
            awaitingSealReadbackRef.current = hash;
            setAwaitingSealReadback(hash);
          }
          const generation = ++refreshGeneration.current;
          reconciled.value = await reconcileCase(wallet.readContract, caseId);
          if (generation !== refreshGeneration.current) return false;
          setData(reconciled.value);
          let readbackEvidence = evidence;
          if (action === "open_evidence" || action === "append_evidence") {
            try {
              readbackEvidence = await wallet.readContract.readEvidence(
                caseId,
                reconciled.value.case.epoch,
              );
            } catch (cause) {
              if (!matchesExactUserError(cause, "evidence epoch does not exist"))
                throw cause;
              readbackEvidence = null;
            }
            if (generation !== refreshGeneration.current) return false;
            setEvidence(readbackEvidence);
          }
          let readbackAppealRound = eligibility.round;
          if (action === "appeal") {
            const reviewTx = parseReviewTxBinding(
              localStorage.getItem(`${REVIEW_TX_PREFIX}${caseId}`),
            )?.txId;
            if (!reviewTx) return false;
            const nextEligibility = await wallet.readContract.appealEligibility(
              reviewTx,
            );
            if (generation !== refreshGeneration.current) return false;
            setEligibility(nextEligibility);
            readbackAppealRound = nextEligibility.round;
          }
          if (
            !before ||
            !actionReadbackConfirmed(
              action,
              before,
              actionReadback(
                reconciled.value,
                readbackEvidence,
                readbackAppealRound,
              ),
            )
          )
            return false;
          if (
            action === "close_evidence" &&
            (!isPendingSealForCurrentEpoch(hash, reconciled.value.case) ||
              !hasAuthoritativeEvidenceSeal(reconciled.value.case))
          )
            return false;
          if (action === "close_evidence") clearPendingSeal(hash);
          return true;
        },
        action,
      );
    } catch (cause) {
      result = classifyTransactionFailure(cause, hash);
      setTx(result);
    }
    const current = reconciled.value;
    if (
      result.phase === "READBACK_CONFIRMED" &&
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
    if (
      action === "close_evidence" &&
      [
        "WALLET_REJECTED",
        "WRONG_ROLE",
        "DETERMINISTIC_VIOLATION",
        "EXECUTION_ERROR",
      ].includes(result.phase)
    )
      clearPendingSeal(hash);
    if (result.phase === "READBACK_CONFIRMED") await refresh();
    return result;
  }
  async function resumePendingSeal(hash: Hash) {
    if (
      writeLock.current ||
      monitoredSealHashRef.current === hash ||
      !wallet.sdk
    )
      return;
    monitoredSealHashRef.current = hash;
    writeLock.current = true;
    setWriteBusy(true);
    setError("");
    try {
      if (!data) return;
      await monitorTransaction(
        hash,
        false,
        "close_evidence",
        actionReadback(data, evidence, eligibility.round),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Finalized readback failed.",
      );
    } finally {
      monitoredSealHashRef.current = null;
      writeLock.current = false;
      setWriteBusy(false);
    }
  }
  const resumePendingSealEvent = useEffectEvent((hash: Hash) => {
    void resumePendingSeal(hash);
  });
  async function run(
    operation: () => Promise<Hash>,
    rememberReview = false,
    action?: PendingAction,
  ) {
    if (writeLock.current) return;
    if (!wallet.sdk) {
      setError("Connect a wallet before sending a transaction.");
      return;
    }
    setError("");
    setTx(waitingForWallet());
    if (action) setWalletConfirmation(action);
    writeLock.current = true;
    setWriteBusy(true);
    try {
      const hash = await operation();
      if (action === "close_evidence") persistPendingSeal(hash);
      monitoredSealHashRef.current = action === "close_evidence" ? hash : null;
      if (!data) throw new Error("Authoritative case readback is unavailable.");
      await monitorTransaction(
        hash,
        rememberReview,
        action,
        actionReadback(data, evidence, eligibility.round),
      );
    } catch (cause) {
      setTx(classifyTransactionFailure(cause));
      setError(
        cause instanceof Error ? cause.message : "Transaction was rejected.",
      );
    } finally {
      setWalletConfirmation(null);
      monitoredSealHashRef.current = null;
      writeLock.current = false;
      setWriteBusy(false);
    }
  }
  useEffect(() => {
    if (!data || wallet.status !== "connected" || !wallet.address) return;
    const expected = pendingSealExpectedFor(data.case);
    if (!expected) return;
    const storageKey = pendingCloseEvidenceStorageKey(caseId);
    const raw = localStorage.getItem(storageKey);
    const stored = parsePendingCloseEvidenceBinding(raw);
    if (!stored) {
      if (raw !== null) localStorage.removeItem(storageKey);
      return;
    }
    if (!matchesPendingCloseEvidenceContext(stored, expected)) return;
    if (!validatePendingCloseEvidenceBinding(stored, expected)) {
      localStorage.removeItem(storageKey);
      return;
    }
    const identity = `${caseId}:${stored.hash}:${Boolean(wallet.sdk)}`;
    if (restoredSealIdentityRef.current === identity) return;
    restoredSealIdentityRef.current = identity;
    pendingSealHashRef.current = stored.hash;
    resumePendingSealEvent(stored.hash);
  }, [
    caseId,
    data,
    pendingSealExpectedFor,
    wallet.address,
    wallet.sdk,
    wallet.status,
  ]);
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
    await run(operation, false, evidence ? "append_evidence" : "open_evidence");
  }
  const canAcceptTerms =
    !!isVendor && data?.case.lifecycle === "DRAFT" && !data.case.vendorAccepted;
  const canFund =
    !!isBuyer && data?.case.lifecycle === "DRAFT" && data.case.vendorAccepted;
  const canSubmitEvidence =
    !!isVendor &&
    !!data &&
    ["FUNDED", "EVIDENCE_OPEN"].includes(data.case.lifecycle);
  const currentEpochEvidence = (evidence?.envelopes ?? []).filter(
    (envelope) => envelope.epoch === data?.case.epoch,
  );
  function currentSealEvidenceTypes(timestamp: number) {
    return currentEpochEvidence
      .filter((envelope) => envelope.expiresAt > timestamp)
      .map((envelope) => envelope.evidenceType);
  }
  function hasCompleteSealEvidenceAt(timestamp: number) {
    const types = currentSealEvidenceTypes(timestamp);
    const missing = REQUIRED_EARLY_SEAL_EVIDENCE_TYPES.filter(
      (type) => !types.includes(type),
    );
    return (
      types.length === REQUIRED_EARLY_SEAL_EVIDENCE_TYPES.length &&
      new Set(types).size === REQUIRED_EARLY_SEAL_EVIDENCE_TYPES.length &&
      missing.length === 0
    );
  }
  const currentEpochEvidenceTypes = currentSealEvidenceTypes(now);
  const missingSealEvidenceTypes = REQUIRED_EARLY_SEAL_EVIDENCE_TYPES.filter(
    (type) => !currentEpochEvidenceTypes.includes(type),
  );
  const hasCompleteSealEvidence = hasCompleteSealEvidenceAt(now);
  const expiredSealEvidenceTypes = REQUIRED_EARLY_SEAL_EVIDENCE_TYPES.filter(
    (type) =>
      currentEpochEvidence.some(
        (envelope) =>
          envelope.evidenceType === type && envelope.expiresAt <= now,
      ),
  );
  const buyerCanSeeSealAction =
    !!isConnectedBuyer && data?.case.lifecycle === "EVIDENCE_OPEN";
  const pendingSealExpected = data ? pendingSealExpectedFor(data.case) : null;
  const pendingSealInStorage =
    typeof window === "undefined"
      ? null
      : parsePendingCloseEvidenceBinding(
          localStorage.getItem(pendingCloseEvidenceStorageKey(caseId)),
        );
  const hasMatchingPendingSeal =
    !!pendingSealExpected &&
    validatePendingCloseEvidenceBinding(
      pendingSealInStorage,
      pendingSealExpected,
    );
  const canRetryPendingSeal =
    ["UNDETERMINED", "RPC_ERROR", "VALIDATORS_TIMEOUT", "READBACK_MISMATCH"].includes(
      tx?.phase ?? "",
    ) &&
    !!pendingSealExpected &&
    hasMatchingPendingSeal &&
    pendingSealInStorage?.hash === tx?.hash;
  const canCloseEvidence =
    buyerCanSeeSealAction &&
    hasCompleteSealEvidence &&
    !!wallet.contract &&
    !hasMatchingPendingSeal;
  const historicalEvidenceSeal =
    !!data && hasAuthoritativeEvidenceSeal(data.case);
  const hardDeadlineReached =
    !!data &&
    data.case.createdAt !== null &&
    data.case.readAt !== null &&
    data.case.readAt >= data.case.createdAt + data.case.hardDeadline;
  const immediateReviewEligible =
    !!data && isImmediatelyReviewableEvidenceSeal(data.case) && !hardDeadlineReached;
  const fallbackReviewEligible =
    data?.case.lifecycle === "EVIDENCE_OPEN" &&
    !data.case.evidenceSealed &&
    data.case.evidenceCutoff !== null &&
    data.case.readAt !== null &&
    data.case.readAt > data.case.evidenceCutoff &&
    !hardDeadlineReached;
  const canRequestReview = immediateReviewEligible || fallbackReviewEligible;
  const reviewActionAvailable =
    (data?.case.lifecycle === "EVIDENCE_OPEN" && !data.case.evidenceSealed) ||
    (data?.case.lifecycle === "EVIDENCE_SEALED" && historicalEvidenceSeal);
  const fallbackReviewStatus = (() => {
    if (hardDeadlineReached)
      return "Finalized contract time confirms the case hard deadline has expired; review is unavailable and timeout recovery may apply.";
    if (!data || data.case.lifecycle !== "EVIDENCE_OPEN" || data.case.evidenceSealed)
      return null;
    if (data.case.evidenceCutoff === null || data.case.readAt === null)
      return "The contract did not provide an authoritative cutoff clock. Refresh finalized readback before requesting the fallback review path.";
    const remaining = data.case.evidenceCutoff - data.case.readAt;
    if (remaining > 0)
      return `${remaining} second${remaining === 1 ? "" : "s"} until the evidence cutoff. Refresh readback when it elapses; the fallback review path remains disabled until a finalized contract time confirms time after the cutoff.`;
    if (remaining === 0)
      return "Evidence cutoff reached; confirming with a finalized contract time after the cutoff before enabling the fallback review path.";
    return "Finalized contract time confirms the evidence cutoff has passed; the fallback review path is available.";
  })();
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
  const canTimeout =
    !!data &&
    data.case.createdAt !== null &&
    data.case.readAt !== null &&
    data.case.readAt > data.case.createdAt + data.case.hardDeadline &&
    ["FUNDED", "EVIDENCE_OPEN", "EVIDENCE_SEALED"].includes(
      data.case.lifecycle,
    );
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
      void run(
        () => wallet.contract!.acceptTerms(caseId, data.case.termsHash),
        false,
        "accept_terms",
      );
  }
  function fundCase() {
    if (wallet.contract && data)
      void run(
        () => wallet.contract!.fund(caseId, BigInt(data.case.escrowAmount)),
        false,
        "fund",
      );
  }
  function requestReview() {
    if (wallet.contract && canRequestReview)
      void run(() => wallet.contract!.requestReview(caseId), true, "request_review");
  }
  function closeEvidence() {
    if (hasMatchingPendingSeal || pendingSealHashRef.current) return;
    if (!hasCompleteSealEvidenceAt(currentUnixTimestamp())) {
      setError("Evidence is no longer complete and current for sealing.");
      return;
    }
    if (wallet.contract)
      void run(
        () => wallet.contract!.closeEvidence(caseId),
        false,
        "close_evidence",
      );
  }
  function retryPendingSeal() {
    if (
      !pendingSealExpected ||
      !hasMatchingPendingSeal ||
      !pendingSealInStorage
    ) {
      setError(
        "The original seal transaction is no longer bound to this evidence epoch.",
      );
      return;
    }
    void resumePendingSeal(pendingSealInStorage.hash);
  }
  function startCure() {
    if (wallet.contract)
      void run(() => wallet.contract!.startCure(caseId), false, "start_cure");
  }
  function retryReview() {
    if (wallet.contract)
      void run(
        () => wallet.contract!.retryReview(caseId, crypto.randomUUID()),
        false,
        "retry_review",
      );
  }
  function expireUnresolved() {
    if (wallet.contract)
      void run(() => wallet.contract!.expireUnresolved(caseId), false, "expire_unresolved");
  }
  function timeoutRefund() {
    if (wallet.contract)
      void run(() => wallet.contract!.timeoutRefund(caseId), false, "timeout_refund");
  }
  function prepareSettlement() {
    if (!wallet.contract || !data?.review) return;
    void run(
      data.review.verdict === "APPROVED"
        ? () => wallet.contract!.preparePayout(caseId)
        : () => wallet.contract!.prepareRefund(caseId),
      false,
      "prepare_settlement",
    );
  }
  function executeSettlement() {
    if (wallet.contract && data?.settlement)
      void run(() =>
        wallet.contract!.executeSettlement(
          caseId,
          data.settlement!.settlementId,
        ),
        false,
        "execute_settlement",
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
      "EVIDENCE_SEALED",
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
          <span>{error}</span>
          <Button
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Retry readback
          </Button>
        </div>
      )}
      {walletConfirmation === "close_evidence" && (
        <section
          className={styles.pendingCallout}
          role="status"
          aria-live="polite"
        >
          Confirm the seal in your wallet. No lifecycle change is shown until
          final execution and contract readback both succeed.
        </section>
      )}
      {tx && <StatusPanel state={tx} />}
      {canRetryPendingSeal && (
        <section
          className={styles.actionCard}
          aria-labelledby="retry-seal-status-title"
        >
          <span className={styles.eyebrow}>Transaction monitor</span>
          <h2 id="retry-seal-status-title">Receipt status needs a retry</h2>
          <p>
            Recheck the original submitted hash. This never sends
            <code> close_evidence</code> again.
          </p>
          <Button disabled={writeBusy} onClick={retryPendingSeal}>
            Retry transaction status
          </Button>
        </section>
      )}
      {awaitingSealReadback && (
        <section
          className={styles.pendingCallout}
          role="status"
          aria-live="polite"
        >
          Finalized execution is waiting for sealed evidence readback. Refresh
          readback before requesting review.
        </section>
      )}
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
            <a href="#settlement" onClick={focusSectionAfterPrimaryActivation}>
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
        {data.case.lifecycle === "EVIDENCE_OPEN" && buyerCanSeeSealAction && (
          <section
            className={styles.actionCard}
            aria-labelledby="seal-evidence-title"
          >
            <span className={styles.eyebrow}>
              Buyer-controlled evidence seal
            </span>
            <h3 id="seal-evidence-title">Close complete evidence</h3>
            <p>
              Closing requires six exact current-epoch evidence types. The
              lifecycle remains unchanged until finalized execution and
              authoritative sealed readback agree.
            </p>
            <Button
              disabled={
                !canCloseEvidence || writeBusy || !!awaitingSealReadback
              }
              onClick={closeEvidence}
            >
              Close evidence &amp; enable review
            </Button>
            {!hasCompleteSealEvidence && (
              <p className={styles.inlineState}>
                Missing evidence types: {missingSealEvidenceTypes.join(", ")}.
                Submit all six exact current-epoch evidence types before the
                buyer can close evidence.
              </p>
            )}
            {expiredSealEvidenceTypes.length > 0 && (
              <p className={styles.inlineState}>
                Expired evidence types: {expiredSealEvidenceTypes.join(", ")}.
                They cannot be replaced in this epoch because duplicate evidence
                types are rejected. Wait for cutoff review; if review requests
                more information, use the bounded cure/new epoch. Use timeout
                recovery only when the hard-deadline path applies.
              </p>
            )}
            {hasCompleteSealEvidence && !wallet.contract && (
              <p className={styles.inlineState}>
                The buyer wallet is connected for reading, but a transaction
                signer is unavailable. Reconnect the wallet before sealing.
              </p>
            )}
          </section>
        )}
        {data.case.lifecycle === "EVIDENCE_OPEN" && !isConnectedBuyer && (
          <section
            className={styles.actionCard}
            aria-labelledby="buyer-wallet-title"
          >
            <span className={styles.eyebrow}>
              Buyer-controlled evidence seal
            </span>
            <h3 id="buyer-wallet-title">Buyer wallet required</h3>
            <p>
              Connect the buyer wallet to close evidence. The vendor and other
              wallets cannot end the evidence period.
            </p>
            {wallet.status === "connected" ? (
              <Button onClick={() => void wallet.changeAccount()}>
                Change wallet
              </Button>
            ) : (
              <Button onClick={() => void wallet.connect()}>
                Connect buyer wallet
              </Button>
            )}
          </section>
        )}
        {historicalEvidenceSeal && (
          <section
            className={styles.actionCard}
            aria-labelledby="sealed-evidence-title"
          >
            <span className={styles.eyebrow}>Authoritative readback</span>
            <h3 id="sealed-evidence-title">Evidence sealed</h3>
            <p>
              The buyer sealed this epoch at{" "}
              {new Date(data.case.evidenceSealedAt * 1000).toISOString()}. A
              {immediateReviewEligible
                ? " A review may now be requested without waiting for the cutoff."
                : " The sealed evidence remains part of this case's authoritative history."}
            </p>
            <dl className={styles.compactDl}>
              <div>
                <dt>Sealed by</dt>
                <dd>
                  <code>{data.case.evidenceSealedBy}</code>
                </dd>
              </div>
            </dl>
          </section>
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
        {reviewActionAvailable && (
          <section className={styles.actionCard}>
            <span className={styles.eyebrow}>Semantic review</span>
            <h3>Request validator consensus</h3>
            <p>
              {immediateReviewEligible
                ? "The authoritative seal makes review eligible now."
                : fallbackReviewStatus}
            </p>
            <Button disabled={writeBusy || !canRequestReview} onClick={requestReview}>
              Request intelligent review
            </Button>
          </section>
        )}
        {!data.review && !canRequestReview && (
          <p className={styles.inlineState}>
            No review decision is available for the authoritative case epoch.
          </p>
        )}
        {!data.review && canTimeout && (
          <RecoveryPanel
            canCure={false}
            canExpire={false}
            canRetry={false}
            canTimeout={canTimeout}
            onCure={startCure}
            onExpire={expireUnresolved}
            onRetry={retryReview}
            onTimeout={timeoutRefund}
          />
        )}
        {data.review && data.reviewFinality && (
          <>
            <ReviewTracker
              review={data.review}
              finality={data.reviewFinality}
              transactionPhase={
                data.reviewFinality.status === "FINALIZED"
                  ? "READBACK_CONFIRMED"
                  : "CONSENSUS_PENDING"
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
                    void run(
                      () => wallet.contract!.appeal(reviewTx, eligibility.bond!),
                      false,
                      "appeal",
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

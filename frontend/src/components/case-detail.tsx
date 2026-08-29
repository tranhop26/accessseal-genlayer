"use client";
import {
  useCallback,
  useEffect,
  useEffectEvent,
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
import { AppealPanel, type AppealEligibility } from "./appeal-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import styles from "./cases/case-detail.module.css";
import { deriveCaseWorkspaceModel } from "./cases/case-dashboard-model";
import { CaseWorkflowStepper } from "./cases/case-workflow-stepper";
import { EvidenceWorkspace } from "./cases/evidence-workspace";
import { IntelligentReviewPanel } from "./cases/intelligent-review-panel";
import { CaseActivity } from "./cases/case-activity";
import {
  hasAuthoritativeEvidenceSeal,
  matchesPendingCloseEvidenceContext,
  parseReviewTxBinding,
  parsePendingCloseEvidenceBinding,
  pendingCloseEvidenceStorageKey,
  matchesExactUserError,
  validatePendingCloseEvidenceBinding,
  validateReviewTxBinding,
  type PendingCloseEvidenceBinding,
  type EvidenceRecord,
  type ReviewContextRecord,
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

export function CaseDetail({ caseId }: { caseId: string }) {
  const wallet = useWallet();
  const [data, setData] = useState<ReconciledCase | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(null);
  const [reviewContext, setReviewContext] =
    useState<ReviewContextRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tx, setTx] = useState<TransactionState | null>(null);
  const [walletConfirmation, setWalletConfirmation] =
    useState<PendingAction | null>(null);
  const [walletPromptDismissed, setWalletPromptDismissed] = useState(false);
  const walletPromptRef = useRef<HTMLDivElement>(null);
  const walletPromptReturnFocusRef = useRef<HTMLElement | null>(null);
  const restoreWalletPromptFocus = useCallback(() => {
    const target = walletPromptReturnFocusRef.current;
    if (target && !target.matches(":disabled, [aria-disabled='true']")) {
      target.focus();
      return;
    }
    document.getElementById("main-content")?.focus();
  }, []);
  const closeWalletPrompt = useCallback(() => {
    const shouldRestoreFocus =
      walletPromptRef.current?.contains(document.activeElement) ?? false;
    setWalletConfirmation(null);
    if (shouldRestoreFocus) restoreWalletPromptFocus();
  }, [restoreWalletPromptFocus]);
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
      if (next.case.reviewContextReady) {
        try {
          const context = await wallet.readContract.readReviewContext(
            caseId,
            next.case.epoch,
          );
          if (generation !== refreshGeneration.current) return;
          setReviewContext(context);
        } catch {
          if (generation !== refreshGeneration.current) return;
          setReviewContext(null);
        }
      } else setReviewContext(null);
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
  const isVendor = actor === data?.case.vendor.toLowerCase();
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
    recoveredPersistedCloseEvidence = false,
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
            { recoveredPersistedCloseEvidence },
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
      if (!isPendingSealForCurrentEpoch(hash, data.case)) return;
      const configuredRecoveryProof =
        data.case.evidenceSealed &&
        wallet.config?.chainId === data.case.chainId &&
        wallet.config.contractAddress.toLowerCase() ===
          data.case.contractAddress.toLowerCase() &&
        wallet.address?.toLowerCase() === data.case.buyer.toLowerCase() &&
        (await wallet.readContract?.verifyCloseEvidenceTransaction(hash, {
          account: wallet.address,
          caseId,
          chainId: data.case.chainId,
          contract: data.case.contractAddress,
          epoch: data.case.epoch,
        })) === true;
      await monitorTransaction(
        hash,
        false,
        "close_evidence",
        actionReadback(data, evidence, eligibility.round),
        configuredRecoveryProof,
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
    if (action) {
      walletPromptReturnFocusRef.current = document.activeElement as HTMLElement;
      setWalletPromptDismissed(false);
      setWalletConfirmation(action);
    }
    writeLock.current = true;
    setWriteBusy(true);
    try {
      const hash = await operation();
      if (action) closeWalletPrompt();
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
      closeWalletPrompt();
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
  useEffect(() => {
    if (walletConfirmation !== "close_evidence" || walletPromptDismissed)
      return;
    const prompt = walletPromptRef.current;
    if (!prompt) return;
    const dismiss = prompt.querySelector<HTMLButtonElement>("button");
    dismiss?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setWalletPromptDismissed(true);
        restoreWalletPromptFocus();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        dismiss?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [restoreWalletPromptFocus, walletConfirmation, walletPromptDismissed]);
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
  const canRetry =
    data?.reviewFinality?.status === "FINALIZED" &&
    data?.review?.verdict === "UNRESOLVED" &&
    !!data.reviewAttempt &&
    data.reviewAttempt.attempt < data.case.maxUnresolvedRetries &&
    now >= data.reviewAttempt.decidedAt + 300;
  const workspaceModel = data
    ? deriveCaseWorkspaceModel({
        reconciledCase: data,
        evidence,
        reviewContext,
        actorAddress: wallet.address,
        walletStatus: wallet.status,
        hasSigner: !!wallet.contract,
        transaction: tx,
        now,
        retryEligible: canRetry,
        evidenceSubmissionReady: !!previewHash,
        sealRecoveryPending:
          hasMatchingPendingSeal || !!awaitingSealReadback,
      })
    : null;
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
    if (
      wallet.contract &&
      workspaceModel?.primaryAction.id === "REQUEST_REVIEW" &&
      workspaceModel.primaryAction.enabled
    )
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
    const actionId = workspaceModel?.primaryAction.id;
    if (actionId === "ACCEPT_TERMS") return acceptTerms();
    if (actionId === "FUND") return fundCase();
    if (actionId === "SUBMIT_EVIDENCE") return void submitEvidence();
    if (actionId === "CLOSE_EVIDENCE") return closeEvidence();
    if (actionId === "REQUEST_REVIEW") return requestReview();
    if (actionId === "START_CURE") return startCure();
    if (actionId === "RETRY_REVIEW") return retryReview();
    if (actionId === "EXPIRE_UNRESOLVED") return expireUnresolved();
    if (actionId === "TIMEOUT_REFUND") return timeoutRefund();
    if (actionId === "PREPARE_SETTLEMENT") return prepareSettlement();
    if (actionId === "EXECUTE_SETTLEMENT") return executeSettlement();
  }
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
              {workspaceModel?.finalizedVerdict?.replaceAll("_", " ") ??
                "Withheld until finality"}
            </dd>
          </div>
        </dl>
        {workspaceModel && (
          <CaseWorkflowStepper
            stages={workspaceModel.stages}
            actorRole={workspaceModel.actorRole}
            roleWarning={workspaceModel.roleWarning}
          />
        )}
        <div className={styles.summaryAction}>
          <div>
            <strong>Authoritative action</strong>
            <p>
              {workspaceModel?.primaryActionReason ??
                "This is the single contract-authorized next action."}
            </p>
          </div>
          {workspaceModel && (
            <Button
              disabled={
                writeBusy ||
                !workspaceModel.primaryAction.enabled
              }
              onClick={runPriorityAction}
            >
              {workspaceModel.primaryAction.label}
            </Button>
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
      {walletConfirmation === "close_evidence" && !walletPromptDismissed && (
        <div className={styles.walletPromptBackdrop}>
          <div
            aria-labelledby="wallet-prompt-title"
            aria-modal="true"
            className={styles.walletPrompt}
            ref={walletPromptRef}
            role="dialog"
          >
            <span className={styles.eyebrow}>Wallet confirmation</span>
            <h2 id="wallet-prompt-title">Confirm evidence seal</h2>
            <p>
              Confirm the seal in your wallet. No lifecycle change is shown
              until final execution and contract readback both succeed.
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                setWalletPromptDismissed(true);
                restoreWalletPromptFocus();
              }}
            >
              Dismiss wallet prompt
            </Button>
          </div>
        </div>
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
      <div className={styles.evidenceReviewSplit}>
        <EvidenceWorkspace
          caseRecord={data.case}
          evidence={evidence}
          now={now}
          controls={
            <>
              {canSubmitEvidence && (
                <div className={styles.evidenceControls}>
                  <label>
                    Evidence envelope JSON
                    <textarea
                      rows={7}
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
                  </div>
                  {previewHash && (
                    <div className={styles.hashBox}>
                      <span>Canonical hash ready for submission</span>
                      <code>{previewHash}</code>
                    </div>
                  )}
                </div>
              )}
              {data.case.lifecycle === "EVIDENCE_OPEN" &&
                !hasCompleteSealEvidence && (
                  <p className={styles.inlineState}>
                    Missing evidence types: {missingSealEvidenceTypes.join(", ")}.
                    The buyer needs all six exact current-epoch evidence types
                    before sealing.
                  </p>
                )}
              {expiredSealEvidenceTypes.length > 0 && (
                <p className={styles.inlineState}>
                  Expired evidence types: {expiredSealEvidenceTypes.join(", ")}.
                  They remain immutable in this epoch; bounded recovery follows
                  the contract lifecycle.
                </p>
              )}
            </>
          }
        />
        <IntelligentReviewPanel
          caseRecord={data.case}
          context={reviewContext}
          review={data.review}
          finality={data.reviewFinality}
          verdictTone={workspaceModel?.verdictTone ?? "neutral"}
          controls={
            data.review && data.reviewFinality?.status === "FINALIZED" ? (
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
            ) : undefined
          }
        />
      </div>
      <section
        className={styles.accountingPanel}
        id="settlement"
        aria-labelledby="simulated-escrow-title"
        tabIndex={-1}
      >
        <header className={styles.commandPanelHeader}>
          <div>
            <span className={styles.eyebrow}>Conservation readback</span>
            <h2 id="simulated-escrow-title">Simulated escrow</h2>
          </div>
          <Badge tone={data.settlement?.status === "DISPATCHED_FINALIZED" ? "success" : "info"}>
            {data.settlement?.status.replaceAll("_", " ") ?? "Reserved"}
          </Badge>
        </header>
        <div className={styles.accountingMetrics}>
          <div><span>Total deposits</span><strong>{data.accounting.totalDeposits.toString()}</strong></div>
          <div><span>Reserved</span><strong>{data.accounting.reserved.toString()}</strong></div>
          <div><span>Pending dispatch</span><strong>{data.accounting.pendingDispatch.toString()}</strong></div>
          <div><span>Dispatched</span><strong>{(data.accounting.dispatchedPayouts + data.accounting.dispatchedRefunds).toString()}</strong></div>
        </div>
        {data.settlement && (
          <>
            <div
              className={styles.dispatchState}
              data-dispatched={data.settlement.status === "DISPATCHED_FINALIZED"}
            >
              <span>Contract dispatch</span>
              <strong>
                {data.settlement.kind} · {data.settlement.amount.toString()} wei
              </strong>
            </div>
            <dl className={styles.reviewFacts}>
              <div><dt>Intent ID</dt><dd><code>{data.settlement.settlementId}</code></dd></div>
              <div><dt>Recipient</dt><dd><code>{data.settlement.recipient}</code></dd></div>
              <div><dt>Kind</dt><dd>{data.settlement.kind}</dd></div>
              <div><dt>Reason</dt><dd>{data.settlement.reason}</dd></div>
              <div><dt>Review proof</dt><dd><code>{data.settlement.reviewProofId}</code></dd></div>
            </dl>
            {data.settlement.status === "DISPATCHED_FINALIZED" && (
              <div className={styles.confirmation} data-confirmed="false">
                <strong>Recipient confirmation pending</strong>
                <p>
                  The contract proves finalized message dispatch only. Child
                  receipt or recipient balance has not yet been confirmed.
                </p>
              </div>
            )}
          </>
        )}
      </section>
      <CaseActivity rows={workspaceModel?.activityRows ?? []} />
    </div>
  );
}

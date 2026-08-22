import { abi } from "genlayer-js";
import { hexToBytes, keccak256, stringToHex } from "viem";
import type { PublicNetwork, SdkNetwork } from "./config";
import { canonicalizeEvidence, type EvidenceEnvelopeV1 } from "./evidence";

export type CaseRecord = {
  buyer: string;
  caseId: string;
  chainId: number;
  contractAddress: string;
  escrowAmount: bigint;
  evidenceDeadline: number;
  flowsHash: string;
  hardDeadline: number;
  lifecycle: string;
  epoch: number;
  maxUnresolvedRetries: number;
  profileHash: string;
  reserved: bigint;
  salt: string;
  subjectOrigin: string;
  termsHash: string;
  vendor: string;
  vendorAccepted: boolean;
};
export type ReviewRecord = {
  schemaVersion: string;
  verdict: "APPROVED" | "REJECTED" | "REQUEST_MORE_INFO" | "UNRESOLVED";
  releaseDigest: string;
  profileHash: string;
  materialBlockers: string[];
  missingEvidence: string[];
  evidenceRefs: string[];
  rationaleHash: string;
};
export type ReviewFinality = {
  attempt: number;
  epoch: number;
  proofId: string;
  status: "PENDING_PROTOCOL_FINALITY" | "FINALIZED";
};
export type ReviewAttempt = ReviewFinality & {
  caseId: string;
  decidedAt: number;
  finalizedAt: number;
  review: ReviewRecord;
};
export type Accounting = {
  dispatchedPayouts: bigint;
  dispatchedRefunds: bigint;
  pendingDispatch: bigint;
  reserved: bigint;
  totalDeposits: bigint;
};
export type Settlement = {
  amount: bigint;
  caseId: string;
  epoch: number;
  executor: string;
  kind: "PAYOUT" | "REFUND";
  reason: string;
  recipient: string;
  reviewProofId: string;
  settlementId: string;
  status: "PREPARED" | "DISPATCHED_FINALIZED";
};
export type EvidenceRecord = {
  caseId: string;
  epoch: number;
  envelopes: EvidenceEnvelopeV1[];
  hashes: string[];
  releaseDigest: string;
};
export type Hash = `0x${string}`;

type SdkClient = {
  connect(network?: string): Promise<void>;
  readContract(args: {
    address: `0x${string}`;
    functionName: string;
    args: unknown[];
    transactionHashVariant: "latest-final";
  }): Promise<unknown>;
  writeContract(args: {
    address: `0x${string}`;
    functionName: string;
    args: unknown[];
    value: bigint;
  }): Promise<Hash>;
  canAppeal(args: { txId: Hash }): Promise<boolean>;
  getRoundNumber(args: { txId: Hash }): Promise<bigint>;
  getLastRoundData(args: { txId: Hash }): Promise<unknown>;
  getMinAppealBond(args: { txId: Hash }): Promise<bigint>;
  appealTransaction(args: { txId: Hash; value?: bigint }): Promise<Hash>;
  getTransaction?(args: { hash: Hash }): Promise<unknown>;
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const CASE_KEYS = [
  "buyer",
  "caseId",
  "chainId",
  "contractAddress",
  "epoch",
  "escrowAmount",
  "evidenceDeadline",
  "flowsHash",
  "hardDeadline",
  "lifecycle",
  "maxUnresolvedRetries",
  "profileHash",
  "reserved",
  "salt",
  "subjectOrigin",
  "termsHash",
  "vendor",
  "vendorAccepted",
].sort();
const REVIEW_KEYS = [
  "evidenceRefs",
  "materialBlockers",
  "missingEvidence",
  "profileHash",
  "rationaleHash",
  "releaseDigest",
  "schemaVersion",
  "verdict",
].sort();
const FINALITY_KEYS = ["attempt", "epoch", "proofId", "status"].sort();
const SETTLEMENT_KEYS = [
  "amount",
  "caseId",
  "epoch",
  "executor",
  "kind",
  "reason",
  "recipient",
  "reviewProofId",
  "settlementId",
  "status",
].sort();
const ACCOUNTING_KEYS = [
  "dispatchedPayouts",
  "dispatchedRefunds",
  "pendingDispatch",
  "reserved",
  "totalDeposits",
].sort();

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} readback schema is invalid.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys))
    throw new Error(`${label} readback schema is invalid.`);
}
function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value)))
    throw new Error(`${label} readback field is invalid.`);
  return value;
}
function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${label} readback counter is invalid.`);
  return Number(value);
}
function amount(value: unknown, label: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${label} must be a lossless integer token.`);
  return BigInt(value);
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} readback field is invalid.`);
  return value;
}
function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string")
    throw new Error(`${label} readback is not JSON text.`);
  try {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < value.length;) {
      const ch = value[i]!;
      if (inString) {
        output += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        output += ch;
        i += 1;
        continue;
      }
      if (ch === "-" || (ch >= "0" && ch <= "9")) {
        const match = value.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?![.eE0-9])/);
        if (match) {
          const token = match[0];
          const numeric = BigInt(token);
          output +=
            numeric > BigInt(Number.MAX_SAFE_INTEGER) ||
            numeric < BigInt(Number.MIN_SAFE_INTEGER)
              ? JSON.stringify(token)
              : token;
          i += token.length;
          continue;
        }
      }
      output += ch;
      i += 1;
    }
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${label} readback is malformed.`);
  }
}

export function matchesExactUserError(
  error: unknown,
  expected: string,
): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (decodeGenVmUserError(current) === expected) return true;
    if (current instanceof Error) {
      if (current.message === expected) return true;
      const match = current.message.match(
        /^An internal error was received\.\s+Details: UserError\(message='([^']+)'\)\s+Version: viem@2\.55\.16$/,
      );
      if (match?.[1] === expected) return true;
      current = current.cause;
    } else if (typeof current === "object" && "cause" in current)
      current = (current as { cause?: unknown }).cause;
    else break;
  }
  return false;
}

function decodeGenVmUserError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("data" in value)) return;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "string" || !/^[0-9a-f]+$/i.test(data) || data.length % 2)
    return;
  try {
    const decoded = abi.calldata.decode(hexToBytes(`0x${data}`));
    if (!(decoded instanceof Map) || decoded.get("kind") !== "UserError") return;
    const message = decoded.get("data");
    return typeof message === "string" ? message : undefined;
  } catch {
    return;
  }
}
function parseReview(value: unknown): ReviewRecord {
  const r = object(value, "Review");
  exact(r, REVIEW_KEYS, "Review");
  const verdict = text(r.verdict, "Review verdict") as ReviewRecord["verdict"];
  if (
    !["APPROVED", "REJECTED", "REQUEST_MORE_INFO", "UNRESOLVED"].includes(
      verdict,
    )
  )
    throw new Error("Review verdict is invalid.");
  const schemaVersion = text(r.schemaVersion, "Review schema");
  if (schemaVersion !== "accessseal-review/1")
    throw new Error("Review schema version is invalid.");
  return {
    schemaVersion,
    verdict,
    releaseDigest: text(r.releaseDigest, "Release digest", SHA),
    profileHash: text(r.profileHash, "Profile hash", HASH),
    materialBlockers: stringArray(r.materialBlockers, "Blockers"),
    missingEvidence: stringArray(r.missingEvidence, "Missing evidence"),
    evidenceRefs: stringArray(r.evidenceRefs, "Evidence refs"),
    rationaleHash: text(r.rationaleHash, "Review rationale hash", SHA),
  };
}

export class AccessSealClient {
  constructor(
    private readonly sdk: SdkClient,
    private readonly address: `0x${string}`,
    private readonly network?: SdkNetwork,
  ) {}
  private async raw(functionName: string, args: unknown[], label: string) {
    return parseJson(
      await this.sdk.readContract({
        address: this.address,
        functionName,
        args,
        transactionHashVariant: "latest-final",
      }),
      label,
    );
  }
  private async write(
    functionName: string,
    args: unknown[],
    value = 0n,
  ): Promise<Hash> {
    if (!this.network)
      throw new Error("A wallet network is required for writes.");
    await this.sdk.connect(this.network);
    return this.sdk.writeContract({
      address: this.address,
      functionName,
      args,
      value,
    });
  }
  async readCase(caseId: string): Promise<CaseRecord> {
    const r = object(await this.raw("get_case", [caseId], "Case"), "Case");
    exact(r, CASE_KEYS, "Case");
    const result: CaseRecord = {
      buyer: text(r.buyer, "Buyer", ADDRESS),
      caseId: text(r.caseId, "Case ID", HASH),
      chainId: count(r.chainId, "Chain ID"),
      contractAddress: text(r.contractAddress, "Contract", ADDRESS),
      escrowAmount: amount(r.escrowAmount, "Escrow amount"),
      evidenceDeadline: count(r.evidenceDeadline, "Evidence deadline"),
      flowsHash: text(r.flowsHash, "Flows hash", HASH),
      hardDeadline: count(r.hardDeadline, "Hard deadline"),
      lifecycle: text(r.lifecycle, "Lifecycle"),
      epoch: count(r.epoch, "Epoch"),
      maxUnresolvedRetries: count(r.maxUnresolvedRetries, "Retry budget"),
      profileHash: text(r.profileHash, "Profile hash", HASH),
      reserved: amount(r.reserved, "Reserved"),
      salt: text(r.salt, "Salt"),
      subjectOrigin: text(r.subjectOrigin, "Origin"),
      termsHash: text(r.termsHash, "Terms hash", HASH),
      vendor: text(r.vendor, "Vendor", ADDRESS),
      vendorAccepted: r.vendorAccepted as boolean,
    };
    if (
      typeof r.vendorAccepted !== "boolean" ||
      ![
        "DRAFT",
        "FUNDED",
        "EVIDENCE_OPEN",
        "REVIEW_PENDING",
        "DECIDED",
        "SETTLEMENT_PENDING",
        "DISPATCHED_FINALIZED",
        "CANCELLED",
      ].includes(result.lifecycle) ||
      result.caseId !== caseId ||
      result.contractAddress !== this.address.toLowerCase()
    )
      throw new Error("Case readback binding is invalid.");
    return result;
  }
  async readReview(caseId: string, epoch: number) {
    return parseReview(await this.raw("get_review", [caseId, epoch], "Review"));
  }
  async readReviewFinality(caseId: string): Promise<ReviewFinality> {
    const r = object(
      await this.raw("get_review_finality", [caseId], "Review finality"),
      "Review finality",
    );
    exact(r, FINALITY_KEYS, "Review finality");
    const status = text(
      r.status,
      "Finality status",
    ) as ReviewFinality["status"];
    if (!["PENDING_PROTOCOL_FINALITY", "FINALIZED"].includes(status))
      throw new Error("Review finality status is invalid.");
    return {
      attempt: count(r.attempt, "Attempt"),
      epoch: count(r.epoch, "Epoch"),
      proofId: text(r.proofId, "Proof ID"),
      status,
    };
  }
  async readReviewAttempt(
    caseId: string,
    epoch: number,
    attempt: number,
  ): Promise<ReviewAttempt> {
    const r = object(
      await this.raw(
        "get_review_attempt",
        [caseId, epoch, attempt],
        "Review attempt",
      ),
      "Review attempt",
    );
    exact(
      r,
      [
        "attempt",
        "caseId",
        "decidedAt",
        "epoch",
        "finalizedAt",
        "proofId",
        "review",
        "status",
      ],
      "Review attempt",
    );
    if (r.caseId !== caseId || r.epoch !== epoch || r.attempt !== attempt)
      throw new Error("Review attempt binding is invalid.");
    return {
      caseId,
      epoch,
      attempt,
      decidedAt: count(r.decidedAt, "Decided time"),
      finalizedAt: count(r.finalizedAt, "Finalized time"),
      proofId: text(r.proofId, "Proof ID"),
      status: text(r.status, "Finality status") as ReviewFinality["status"],
      review: parseReview(r.review),
    };
  }
  async readEvidence(caseId: string, epoch: number): Promise<EvidenceRecord> {
    const r = object(
      await this.raw("get_evidence", [caseId, epoch], "Evidence"),
      "Evidence",
    );
    exact(
      r,
      ["caseId", "envelopes", "epoch", "hashes", "releaseDigest"],
      "Evidence",
    );
    if (r.caseId !== caseId || r.epoch !== epoch || !Array.isArray(r.envelopes))
      throw new Error("Evidence readback binding is invalid.");
    const envelopes = r.envelopes as EvidenceEnvelopeV1[];
    envelopes.forEach(canonicalizeEvidence);
    const hashes = stringArray(r.hashes, "Evidence hashes");
    if (
      hashes.length !== envelopes.length ||
      hashes.some((hash) => !SHA.test(hash))
    )
      throw new Error("Evidence hash readback is invalid.");
    return {
      caseId,
      epoch,
      envelopes,
      hashes,
      releaseDigest: text(r.releaseDigest, "Release digest", SHA),
    };
  }
  async readSettlement(caseId: string): Promise<Settlement> {
    const r = object(
      await this.raw("get_settlement", [caseId], "Settlement"),
      "Settlement",
    );
    exact(r, SETTLEMENT_KEYS, "Settlement");
    if (r.caseId !== caseId)
      throw new Error("Settlement readback binding is invalid.");
    const kind = text(r.kind, "Settlement kind") as Settlement["kind"];
    const status = text(r.status, "Settlement status") as Settlement["status"];
    if (
      !["PAYOUT", "REFUND"].includes(kind) ||
      !["PREPARED", "DISPATCHED_FINALIZED"].includes(status)
    )
      throw new Error("Settlement status is invalid.");
    return {
      amount: amount(r.amount, "Settlement amount"),
      caseId,
      epoch: count(r.epoch, "Settlement epoch"),
      executor: text(r.executor, "Executor"),
      kind,
      reason: text(r.reason, "Settlement reason"),
      recipient: text(r.recipient, "Recipient", ADDRESS),
      reviewProofId: text(r.reviewProofId, "Review proof"),
      settlementId: text(r.settlementId, "Settlement ID"),
      status,
    };
  }
  async readAccounting(): Promise<Accounting> {
    const r = object(
      await this.raw("get_accounting", [], "Accounting"),
      "Accounting",
    );
    exact(r, ACCOUNTING_KEYS, "Accounting");
    const a = {
      dispatchedPayouts: amount(r.dispatchedPayouts, "Dispatched payouts"),
      dispatchedRefunds: amount(r.dispatchedRefunds, "Dispatched refunds"),
      pendingDispatch: amount(r.pendingDispatch, "Pending dispatch"),
      reserved: amount(r.reserved, "Reserved"),
      totalDeposits: amount(r.totalDeposits, "Total deposits"),
    };
    if (
      a.totalDeposits !==
      a.reserved + a.pendingDispatch + a.dispatchedPayouts + a.dispatchedRefunds
    )
      throw new Error("Accounting readback violates conservation.");
    return a;
  }
  createCase(input: {
    salt: string;
    vendor: string;
    profileHash: string;
    flowsHash: string;
    subjectOrigin: string;
    evidenceDeadline: number;
    hardDeadline: number;
    maxUnresolvedRetries: number;
    escrowAmount: bigint;
  }) {
    return this.write("create_case", [
      input.salt,
      input.vendor,
      input.profileHash,
      input.flowsHash,
      input.subjectOrigin,
      input.evidenceDeadline,
      input.hardDeadline,
      input.maxUnresolvedRetries,
      input.escrowAmount,
    ]);
  }
  acceptTerms(caseId: string, termsHash: string) {
    return this.write("accept_terms", [caseId, termsHash]);
  }
  fund(caseId: string, value: bigint) {
    return this.write("fund", [caseId], value);
  }
  async openEvidence(caseId: string, e: EvidenceEnvelopeV1) {
    return this.write("open_evidence", [caseId, canonicalizeEvidence(e)]);
  }
  async appendEvidence(caseId: string, e: EvidenceEnvelopeV1) {
    return this.write("append_evidence", [caseId, canonicalizeEvidence(e)]);
  }
  requestReview(caseId: string) {
    return this.write("request_review", [caseId]);
  }
  startCure(caseId: string) {
    return this.write("start_cure", [caseId]);
  }
  retryReview(caseId: string, id: string) {
    return this.write("retry_review", [caseId, id]);
  }
  expireUnresolved(caseId: string) {
    return this.write("expire_unresolved", [caseId]);
  }
  timeoutRefund(caseId: string) {
    return this.write("timeout_refund", [caseId]);
  }
  preparePayout(caseId: string) {
    return this.write("prepare_payout", [caseId]);
  }
  prepareRefund(caseId: string) {
    return this.write("prepare_refund", [caseId]);
  }
  executeSettlement(caseId: string, id: string) {
    return this.write("execute_settlement", [caseId, id]);
  }
  async appealEligibility(txId?: Hash) {
    if (!txId)
      return {
        available: false,
        reason:
          "Review transaction ID is unavailable; eligibility cannot be proven.",
        round: null,
        bond: null,
        roundData: null,
      };
    const [available, round, bond, roundData] = await Promise.all([
      this.sdk.canAppeal({ txId }),
      this.sdk.getRoundNumber({ txId }),
      this.sdk.getMinAppealBond({ txId }),
      this.sdk.getLastRoundData({ txId }),
    ]);
    return {
      available,
      reason: available
        ? null
        : "The protocol reports that this transaction cannot be appealed.",
      round,
      bond,
      roundData,
    };
  }
  async verifyReviewTransaction(txId: Hash, caseId: string): Promise<boolean> {
    if (!this.sdk.getTransaction) return false;
    const tx = object(
      await this.sdk.getTransaction({ hash: txId }),
      "Transaction",
    );
    const recipient = String(tx.to_address ?? tx.recipient ?? "").toLowerCase();
    const decoded = tx.txDataDecoded as
      { type?: unknown; callData?: unknown } | undefined;
    const call = decoded?.callData;
    const method =
      call instanceof Map
        ? call.get("method")
        : (call as Record<string, unknown> | undefined)?.method;
    const args =
      call instanceof Map
        ? call.get("args")
        : (call as Record<string, unknown> | undefined)?.args;
    return (
      recipient === this.address.toLowerCase() &&
      decoded?.type === "call" &&
      method === "request_review" &&
      Array.isArray(args) &&
      args.length === 1 &&
      args[0] === caseId
    );
  }
  async appeal(txId: Hash, bond: bigint) {
    if (!this.network)
      throw new Error("A wallet network is required for writes.");
    await this.sdk.connect(this.network);
    return this.sdk.appealTransaction({ txId, value: bond });
  }
}

function canonicalValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function canonical(value: Record<string, unknown>): string {
  return canonicalValue(value);
}
export async function deriveCaseBindings(input: {
  buyer: string;
  chainId: number;
  contractAddress: string;
  salt: string;
  vendor: string;
  profileHash: string;
  flows: [string, string, string];
  subjectOrigin: string;
  evidenceDeadline: number;
  hardDeadline: number;
  maxUnresolvedRetries: number;
  escrowAmount: bigint;
}) {
  const flowsHash = keccak256(stringToHex(JSON.stringify(input.flows)));
  const caseId = keccak256(
    stringToHex(
      canonical({
        buyer: input.buyer.toLowerCase(),
        chainId: input.chainId,
        contractAddress: input.contractAddress.toLowerCase(),
        salt: input.salt,
        schemaVersion: "accessseal-case-v1",
      }),
    ),
  );
  const termsHash = keccak256(
    stringToHex(
      canonical({
        buyer: input.buyer.toLowerCase(),
        caseId,
        chainId: input.chainId,
        contractAddress: input.contractAddress.toLowerCase(),
        escrowAmount: input.escrowAmount,
        evidenceDeadline: input.evidenceDeadline,
        flowsHash,
        hardDeadline: input.hardDeadline,
        maxUnresolvedRetries: input.maxUnresolvedRetries,
        profileHash: input.profileHash,
        salt: input.salt,
        schemaVersion: "accessseal-terms-v1",
        subjectOrigin: input.subjectOrigin,
        vendor: input.vendor.toLowerCase(),
      }),
    ),
  );
  return { caseId, flowsHash, termsHash };
}

export type ReviewTxBinding = {
  txId: Hash;
  chainId: number;
  network: PublicNetwork;
  contract: string;
  method: "request_review";
  caseId: string;
  epoch: number;
  releaseDigest: string;
  proofId: string;
};
export function parseReviewTxBinding(
  value: string | null,
): ReviewTxBinding | null {
  if (!value) return null;
  try {
    const r = JSON.parse(value) as ReviewTxBinding;
    if (
      !/^0x[0-9a-f]{64}$/.test(r.txId) ||
      r.method !== "request_review" ||
      !Number.isSafeInteger(r.chainId) ||
      !Number.isSafeInteger(r.epoch) ||
      !ADDRESS.test(r.contract) ||
      !SHA.test(r.releaseDigest) ||
      !r.proofId
    )
      return null;
    return r;
  } catch {
    return null;
  }
}
export function validateReviewTxBinding(
  binding: ReviewTxBinding | null,
  expected: Omit<ReviewTxBinding, "txId" | "method">,
): binding is ReviewTxBinding {
  return (
    !!binding &&
    binding.chainId === expected.chainId &&
    binding.network === expected.network &&
    binding.contract === expected.contract &&
    binding.caseId === expected.caseId &&
    binding.epoch === expected.epoch &&
    binding.releaseDigest === expected.releaseDigest &&
    binding.proofId === expected.proofId
  );
}

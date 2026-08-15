import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvidenceInspector } from "@/components/evidence-inspector";
import { ReviewTracker } from "@/components/review-tracker";
import { AppealPanel } from "@/components/appeal-panel";
import { SettlementPanel } from "@/components/settlement-panel";
import { RecoveryPanel } from "@/components/recovery-panel";
import type { EvidenceEnvelopeV1 } from "@/lib/evidence";

const envelope: EvidenceEnvelopeV1 = {
  schemaVersion: "accessseal-evidence/1",
  chainId: "studionet",
  contract: "0x1234567890abcdef1234567890abcdef12345678",
  caseId: "case-1",
  epoch: 1,
  action: "APPEND_EVIDENCE",
  subjectOrigin: "https://audit.example",
  profileVersion: "accessseal-static/1",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  evidenceType: "DOM_FACTS",
  issuer: "0x876543210fedcba9876543210fedcba987654321",
  payloadUri: "https://audit.example/dom.json",
  payloadSha256: `sha256:${"b".repeat(64)}`,
  mediaType: "application/json",
  observedAt: 1000,
  submittedAt: 1010,
  expiresAt: 2000,
  nonce: "dom-1",
};

describe("evidence-to-settlement truth", () => {
  it("labels vendor declarations separately from validator-fetched verification and blocks stale evidence", () => {
    render(
      <EvidenceInspector
        evidence={{
          caseId: "case-1",
          epoch: 1,
          envelopes: [envelope],
          hashes: [`sha256:${"c".repeat(64)}`],
          releaseDigest: envelope.releaseDigest,
        }}
        now={2001}
      />,
    );
    expect(screen.getByText("Vendor-submitted envelope")).toBeInTheDocument();
    expect(
      screen.getByText(/Validators independently fetch/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Expired/i)).toBeInTheDocument();
    expect(screen.getByText(envelope.payloadUri)).toHaveAttribute(
      "href",
      envelope.payloadUri,
    );
  });

  it("renders accepted finality warning and evidence-linked criteria", () => {
    render(
      <ReviewTracker
        transactionPhase="ACCEPTED"
        finality={{
          attempt: 0,
          epoch: 1,
          proofId: "sha256:proof",
          status: "PENDING_PROTOCOL_FINALITY",
        }}
        review={{
          schemaVersion: "accessseal-review/1",
          verdict: "APPROVED",
          releaseDigest: envelope.releaseDigest,
          profileHash: "0xprofile",
          materialBlockers: [],
          missingEvidence: [],
          evidenceRefs: [`sha256:${"c".repeat(64)}`],
          rationaleHash: `sha256:${"d".repeat(64)}`,
        }}
      />,
    );
    expect(
      screen.getByText(/Accepted is appealable and is not final/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sha256:ccc/i })).toHaveAttribute(
      "href",
      `#evidence-sha256:${"c".repeat(64)}`,
    );
    expect(
      screen.queryByText(/settlement authorized/i),
    ).not.toBeInTheDocument();
  });

  it("shows RMI cure and unresolved retry information without favorable defaults", () => {
    const base = {
      schemaVersion: "accessseal-review/1",
      releaseDigest: envelope.releaseDigest,
      profileHash: "0xprofile",
      materialBlockers: [],
      evidenceRefs: [],
      rationaleHash: `sha256:${"d".repeat(64)}`,
    };
    const { rerender } = render(
      <ReviewTracker
        transactionPhase="FINALIZED_SUCCESS"
        finality={{
          attempt: 0,
          epoch: 1,
          proofId: "proof",
          status: "FINALIZED",
        }}
        review={{
          ...base,
          verdict: "REQUEST_MORE_INFO",
          missingEvidence: ["SCREENSHOT"],
        }}
        cureDeadline={3000}
      />,
    );
    expect(screen.getByText(/Cure attempt 1 of 1/i)).toBeInTheDocument();
    expect(screen.getByText(/SCREENSHOT/i)).toBeInTheDocument();
    rerender(
      <ReviewTracker
        transactionPhase="FINALIZED_SUCCESS"
        finality={{
          attempt: 1,
          epoch: 1,
          proofId: "proof",
          status: "FINALIZED",
        }}
        review={{ ...base, verdict: "UNRESOLVED", missingEvidence: [] }}
        retryAvailableAt={4000}
      />,
    );
    expect(
      screen.getByText(/No payout or refund is authorized/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Retry cooldown/i)).toHaveLength(2);
  });

  it("fail-closes appeal controls when the authoritative tx ID is absent", () => {
    render(
      <AppealPanel
        eligibility={{
          available: false,
          reason:
            "Review transaction ID is unavailable; eligibility cannot be proven.",
          round: null,
          bond: null,
          roundData: null,
        }}
        onAppeal={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /appeal review/i }),
    ).toBeDisabled();
    expect(screen.getByText(/cannot be proven/i)).toBeInTheDocument();
  });

  it("separates vendor cure, permissionless retry, expiry, and unavailable timeout", () => {
    render(
      <RecoveryPanel
        verdict="UNRESOLVED"
        canCure={false}
        canRetry={false}
        canExpire
        canTimeout={false}
        retryAvailableAt={1600}
        onCure={vi.fn()}
        onRetry={vi.fn()}
        onExpire={vi.fn()}
        onTimeout={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /vendor: start cure/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /retry review/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /expire unresolved/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /timeout refund/i }),
    ).toBeDisabled();
    expect(screen.getByText(/createdAt/i)).toBeInTheDocument();
  });

  it("keeps settlement unavailable before finality and distinguishes dispatch from recipient confirmation", () => {
    const { rerender } = render(
      <SettlementPanel
        canPrepare={false}
        settlement={null}
        accounting={{
          totalDeposits: 10n,
          reserved: 10n,
          pendingDispatch: 0n,
          dispatchedPayouts: 0n,
          dispatchedRefunds: 0n,
        }}
        onPrepare={vi.fn()}
        onExecute={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /prepare settlement/i }),
    ).toBeDisabled();
    rerender(
      <SettlementPanel
        canPrepare
        settlement={{
          amount: 10n,
          caseId: "case-1",
          epoch: 1,
          executor: "0xexecutor",
          kind: "PAYOUT",
          reason: "APPROVED",
          recipient: "0xrecipient",
          reviewProofId: "proof",
          settlementId: "settlement-1",
          status: "DISPATCHED_FINALIZED",
        }}
        accounting={{
          totalDeposits: 10n,
          reserved: 0n,
          pendingDispatch: 0n,
          dispatchedPayouts: 10n,
          dispatchedRefunds: 0n,
        }}
        confirmation={{
          status: "PENDING",
          childTransaction: null,
          recipientBalanceConfirmed: false,
        }}
        onPrepare={vi.fn()}
        onExecute={vi.fn()}
      />,
    );
    expect(screen.getByText("Dispatch finalized")).toBeInTheDocument();
    expect(
      screen.getByText(/Recipient confirmation pending/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Confirmed$/i)).not.toBeInTheDocument();
  });

  it.each([
    ["UNRESOLVED_EXHAUSTED", "REFUND"],
    ["CURE_EXHAUSTED", "REFUND"],
    ["HARD_TIMEOUT", "REFUND"],
    ["APPROVED", "PAYOUT"],
    ["REJECTED", "REFUND"],
  ] as const)(
    "enables authoritative PREPARED %s settlement without review finality",
    (reason, kind) => {
      render(
        <SettlementPanel
          canPrepare={false}
          settlement={{
            amount: 10n,
            caseId: "case-1",
            epoch: 1,
            executor: "",
            kind,
            reason,
            recipient: "0x1234567890abcdef1234567890abcdef12345678",
            reviewProofId: "proof",
            settlementId: "settlement-1",
            status: "PREPARED",
          }}
          accounting={{
            totalDeposits: 10n,
            reserved: 0n,
            pendingDispatch: 10n,
            dispatchedPayouts: 0n,
            dispatchedRefunds: 0n,
          }}
          onPrepare={vi.fn()}
          onExecute={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", { name: /execute prepared settlement/i }),
      ).toBeEnabled();
    },
  );

  it.each([
    ["APPROVED", "REFUND"],
    ["HARD_TIMEOUT", "PAYOUT"],
  ] as const)("blocks mismatched PREPARED %s/%s settlement", (reason, kind) => {
    render(
      <SettlementPanel
        canPrepare
        settlement={{
          amount: 10n,
          caseId: "case-1",
          epoch: 1,
          executor: "",
          kind,
          reason,
          recipient: "0x1234567890abcdef1234567890abcdef12345678",
          reviewProofId: "proof",
          settlementId: "settlement-1",
          status: "PREPARED",
        }}
        accounting={{
          totalDeposits: 10n,
          reserved: 0n,
          pendingDispatch: 10n,
          dispatchedPayouts: 0n,
          dispatchedRefunds: 0n,
        }}
        onPrepare={vi.fn()}
        onExecute={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /execute prepared settlement/i }),
    ).toBeDisabled();
  });
});

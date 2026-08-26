import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import {
  deriveDashboardMetrics,
  filterDashboardCases,
  type DashboardCase,
} from "@/components/cases/case-dashboard-model";
import {
  CasesDashboard,
  loadKnownCase,
} from "@/components/cases/cases-dashboard";
import styles from "@/components/cases/cases.module.css";
import {
  AccessSealClient,
  type CaseRecord,
  EvidenceRecord,
  ReviewFinality,
  ReviewRecord,
} from "@/lib/access-seal";
import { useWallet } from "@/providers/wallet-provider";

vi.mock("@/providers/wallet-provider", () => ({ useWallet: vi.fn() }));

const address = `0x${"1".repeat(40)}` as `0x${string}`;
const vendor = `0x${"2".repeat(40)}`;
const profileHash = `0x${"3".repeat(64)}`;
const caseIds = {
  funded: `sha256:${"a".repeat(64)}`,
  pending: `sha256:${"b".repeat(64)}`,
  decided: `sha256:${"c".repeat(64)}`,
  error: `sha256:${"d".repeat(64)}`,
};
const evidenceCaseIds = {
  absent: `sha256:${"e".repeat(64)}`,
  present: `sha256:${"f".repeat(64)}`,
  error: `sha256:${"0".repeat(64)}`,
};
const sealedCaseId = `sha256:${"9".repeat(64)}`;

function caseRecord(
  caseId: string,
  lifecycle: string,
  escrowAmount = 25n,
): CaseRecord {
  return {
    buyer: address,
    caseId,
    chainId: 61999,
    contractAddress: `0x${"4".repeat(40)}`,
    createdAt: 1_701_230_000,
    escrowAmount,
    evidenceDeadline: 2_000,
    evidenceCutoff: 1_701_232_000,
    evidenceSealed: false,
    evidenceSealedAt: 0,
    evidenceSealedBy: `0x${"0".repeat(40)}`,
    flowsHash: `0x${"5".repeat(64)}`,
    hardDeadline: 3_000,
    lifecycle,
    epoch: 2,
    maxUnresolvedRetries: 1,
    profileHash,
    readAt: 1_701_232_001,
    reserved: escrowAmount,
    salt: "case-salt",
    subjectOrigin: "https://merchant.example",
    termsHash: `0x${"6".repeat(64)}`,
    vendor,
    vendorAccepted: true,
  };
}

function sealedCaseRecord(caseId: string): CaseRecord {
  return {
    ...caseRecord(caseId, "EVIDENCE_SEALED"),
    evidenceSealed: true,
    evidenceSealedAt: 1_701_234_567,
    evidenceSealedBy: address,
  };
}

function serializedCaseRecord(record: CaseRecord, legacyV2 = false): string {
  const value: Record<string, unknown> = {
    ...record,
    escrowAmount: record.escrowAmount.toString(),
    reserved: record.reserved.toString(),
  };
  if (legacyV2) {
    for (const key of [
      "createdAt",
      "evidenceCutoff",
      "evidenceSealed",
      "evidenceSealedAt",
      "evidenceSealedBy",
      "readAt",
    ])
      delete value[key];
  }
  return JSON.stringify(value);
}

const approvedReview: ReviewRecord = {
  schemaVersion: "accessseal-review/1",
  verdict: "APPROVED",
  releaseDigest: `sha256:${"7".repeat(64)}`,
  profileHash,
  materialBlockers: [],
  missingEvidence: [],
  evidenceRefs: [`sha256:${"8".repeat(64)}`],
  rationaleHash: `sha256:${"9".repeat(64)}`,
};

const finalizedReview: ReviewFinality = {
  attempt: 0,
  epoch: 2,
  proofId: "review-proof",
  status: "FINALIZED",
};

function evidenceRecord(caseId: string): EvidenceRecord {
  const releaseDigest: `sha256:${string}` = `sha256:${"7".repeat(64)}`;
  return {
    caseId,
    epoch: 2,
    envelopes: [
      {
        schemaVersion: "accessseal-evidence/1",
        chainId: "61999",
        contract: `0x${"4".repeat(40)}`,
        caseId,
        epoch: 2,
        action: "OPEN_RELEASE",
        subjectOrigin: "https://merchant.example",
        profileVersion: "accessseal-static/1",
        releaseDigest,
        evidenceType: "RELEASE_MANIFEST",
        issuer: vendor,
        payloadUri: "https://merchant.example/release.json",
        payloadSha256: `sha256:${"8".repeat(64)}`,
        mediaType: "application/json",
        observedAt: 1_000,
        submittedAt: 1_010,
        expiresAt: 2_000,
        nonce: "release-2",
      },
    ],
    hashes: [`sha256:${"9".repeat(64)}`],
    releaseDigest,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function row(
  caseId: string,
  lifecycle: string,
  options: Partial<DashboardCase> = {},
): DashboardCase {
  return {
    caseId,
    case: caseRecord(caseId, lifecycle),
    evidence: null,
    review: null,
    finality: null,
    settlement: null,
    readError: null,
    ...options,
  };
}

function mockReader() {
  return {
    readCase: vi.fn(async (caseId: string) => {
      if (caseId === caseIds.error)
        throw new Error("Finalized RPC unavailable");
      if (Object.values(evidenceCaseIds).includes(caseId))
        return caseRecord(caseId, "EVIDENCE_OPEN");
      if (caseId === sealedCaseId) return sealedCaseRecord(caseId);
      if (caseId === caseIds.funded)
        return caseRecord(caseId, "FUNDED", 9_007_199_254_740_993_123_456_789n);
      if (caseId === caseIds.pending)
        return caseRecord(caseId, "REVIEW_PENDING");
      return caseRecord(caseId, "DECIDED");
    }),
    readEvidence: vi.fn(async (caseId: string) => {
      if (caseId === evidenceCaseIds.present) return evidenceRecord(caseId);
      if (caseId === sealedCaseId) return evidenceRecord(caseId);
      if (caseId === evidenceCaseIds.absent)
        throw new Error("evidence epoch does not exist");
      if (caseId === evidenceCaseIds.error)
        throw new Error("Evidence RPC unavailable");
      throw new Error("evidence epoch does not exist");
    }),
    readReview: vi.fn(async (caseId: string) => {
      if (caseId === caseIds.decided) return approvedReview;
      throw new Error("gen_call failed: review does not exist");
    }),
    readReviewFinality: vi.fn(async (caseId: string) => {
      if (caseId === caseIds.decided) return finalizedReview;
      throw new Error("gen_call failed: review finality proof does not exist");
    }),
    readReviewAttempt: vi.fn(async () => ({
      caseId: caseIds.decided,
      decidedAt: 2_100,
      finalizedAt: 2_200,
      ...finalizedReview,
      review: approvedReview,
    })),
    readSettlement: vi
      .fn()
      .mockRejectedValue(
        new Error("gen_call failed: settlement intent does not exist"),
      ),
    readAccounting: vi.fn().mockResolvedValue({
      totalDeposits: 25n,
      reserved: 25n,
      pendingDispatch: 0n,
      dispatchedPayouts: 0n,
      dispatchedRefunds: 0n,
    }),
  };
}

describe("authoritative cases dashboard model", () => {
  it("derives semantic metrics only from authoritative successful rows", () => {
    const rows: DashboardCase[] = [
      row(caseIds.funded, "FUNDED"),
      row(caseIds.pending, "REVIEW_PENDING"),
      row(caseIds.decided, "DECIDED", {
        review: approvedReview,
        finality: finalizedReview,
      }),
      {
        caseId: caseIds.error,
        case: null,
        evidence: null,
        review: null,
        finality: null,
        settlement: null,
        readError: "Finalized RPC unavailable",
      },
    ];

    expect(deriveDashboardMetrics(rows)).toEqual({
      total: 4,
      awaitingEvidence: 1,
      underReview: 1,
      readyToSettle: 1,
    });
  });

  it("filters by authoritative lifecycle and verdict without hiding error rows", () => {
    const rows: DashboardCase[] = [
      row(caseIds.funded, "FUNDED"),
      row(caseIds.decided, "DECIDED", {
        review: approvedReview,
        finality: finalizedReview,
      }),
      {
        caseId: caseIds.error,
        case: null,
        evidence: null,
        review: null,
        finality: null,
        settlement: null,
        readError: "Finalized RPC unavailable",
      },
    ];

    expect(
      filterDashboardCases(rows, {
        lifecycle: "DECIDED",
        verdict: "APPROVED",
      }).map(({ caseId }) => caseId),
    ).toEqual([caseIds.decided, caseIds.error]);
  });

  it("counts evidence-open epochs only when authoritative evidence is absent", () => {
    const rows: DashboardCase[] = [
      row(evidenceCaseIds.absent, "EVIDENCE_OPEN"),
      row(evidenceCaseIds.present, "EVIDENCE_OPEN", {
        evidence: evidenceRecord(evidenceCaseIds.present),
      }),
      {
        caseId: evidenceCaseIds.error,
        case: null,
        evidence: null,
        review: null,
        finality: null,
        settlement: null,
        readError: "Evidence RPC unavailable",
      },
    ];

    expect(deriveDashboardMetrics(rows)).toEqual({
      total: 3,
      awaitingEvidence: 1,
      underReview: 0,
      readyToSettle: 0,
    });
  });

  it("classifies V3 sealed evidence as review-ready while retaining legacy V2 review rows", () => {
    const sealed = {
      ...row(sealedCaseId, "EVIDENCE_SEALED"),
      case: sealedCaseRecord(sealedCaseId),
      evidence: evidenceRecord(sealedCaseId),
    };
    const legacy = row(caseIds.pending, "REVIEW_PENDING");

    expect(deriveDashboardMetrics([sealed, legacy])).toEqual({
      total: 2,
      awaitingEvidence: 0,
      underReview: 2,
      readyToSettle: 0,
    });
    expect(
      filterDashboardCases([sealed, legacy], {
        lifecycle: "EVIDENCE_SEALED",
        verdict: "ALL",
      }).map(({ caseId }) => caseId),
    ).toEqual([sealedCaseId]);
  });

  it("loads V3 seals and legacy V2 lifecycle rows through the production client adapter", async () => {
    const contract = `0x${"4".repeat(40)}` as `0x${string}`;
    const v3CaseId = `0x${"a".repeat(64)}`;
    const legacyCaseId = `0x${"b".repeat(64)}`;
    const makeClient = (record: CaseRecord, legacyV2 = false) => {
      const raw = vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "get_case")
          return serializedCaseRecord(record, legacyV2);
        if (functionName === "get_evidence") {
          const evidence = evidenceRecord(record.caseId);
          return JSON.stringify({
            ...evidence,
            envelopes: evidence.envelopes.map((envelope) => ({
              ...envelope,
              caseId: record.caseId,
              payloadSha256: evidence.releaseDigest,
            })),
          });
        }
        if (functionName === "get_accounting")
          return JSON.stringify({
            dispatchedPayouts: "0",
            dispatchedRefunds: "0",
            pendingDispatch: "0",
            reserved: "25",
            totalDeposits: "25",
          });
        if (functionName === "get_review")
          throw new Error("gen_call failed: review does not exist");
        if (functionName === "get_review_finality")
          throw new Error(
            "gen_call failed: review finality proof does not exist",
          );
        throw new Error("gen_call failed: settlement intent does not exist");
      });
      return {
        raw,
        client: new AccessSealClient({ readContract: raw } as never, contract),
      };
    };

    const v3 = makeClient(sealedCaseRecord(v3CaseId));
    const loadedV3 = await loadKnownCase(v3.client, v3CaseId);
    expect(loadedV3).toMatchObject({
      caseId: v3CaseId,
      case: expect.objectContaining({ lifecycle: "EVIDENCE_SEALED" }),
      evidence: expect.objectContaining({ caseId: v3CaseId }),
      readError: null,
    });
    expect(v3.raw).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "get_evidence",
        args: [v3CaseId, 2],
      }),
    );

    const legacy = makeClient(caseRecord(legacyCaseId, "REVIEW_PENDING"), true);
    const loadedLegacy = await loadKnownCase(legacy.client, legacyCaseId);
    expect(loadedLegacy).toMatchObject({
      caseId: legacyCaseId,
      case: expect.objectContaining({ lifecycle: "REVIEW_PENDING" }),
      evidence: null,
      readError: null,
    });
  });
});

describe("authoritative cases dashboard", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(useWallet).mockReturnValue({
      readContract: mockReader(),
    } as never);
  });

  it("renders metrics, equivalent desktop/mobile fields, filters, and visible readback errors", async () => {
    localStorage.setItem(
      "accessseal.case-ids.v1",
      JSON.stringify(Object.values(caseIds)),
    );
    const user = userEvent.setup();

    render(<CasesDashboard />);

    await waitFor(() =>
      expect(
        screen.getAllByText("9,007,199,254,740,993,123,456,789"),
      ).toHaveLength(2),
    );
    expect(
      screen.getByText("Total cases").nextElementSibling,
    ).toHaveTextContent("4");
    expect(
      screen.getByText("Awaiting evidence").nextElementSibling,
    ).toHaveTextContent("1");
    expect(
      screen.getByText("Under review").nextElementSibling,
    ).toHaveTextContent("1");
    expect(
      screen.getByText("Ready to settle").nextElementSibling,
    ).toHaveTextContent("1");
    expect(screen.getByText("Based on locally known case IDs")).toBeVisible();

    for (const header of [
      "Case ID",
      "Buyer / vendor",
      "Simulated amount",
      "Lifecycle",
      "Verdict",
      "Authoritative state",
      "Action",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeVisible();
      expect(screen.getAllByText(header).length).toBeGreaterThan(1);
    }
    expect(
      screen.getAllByText("Finalized RPC unavailable").length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText("Lifecycle filter")).toBeVisible();
    expect(screen.getByLabelText("Verdict filter")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Read from contract" }),
    ).toBeVisible();

    await user.selectOptions(
      screen.getByLabelText("Lifecycle filter"),
      "DECIDED",
    );
    await user.selectOptions(
      screen.getByLabelText("Verdict filter"),
      "APPROVED",
    );
    expect(screen.queryByText(caseIds.pending)).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Finalized RPC unavailable").length,
    ).toBeGreaterThan(0);
  });

  it("reads and filters V3 sealed evidence without omitting the case", async () => {
    localStorage.setItem(
      "accessseal.case-ids.v1",
      JSON.stringify([sealedCaseId]),
    );
    const reader = mockReader();
    vi.mocked(useWallet).mockReturnValue({ readContract: reader } as never);
    const user = userEvent.setup();

    render(<CasesDashboard />);

    await waitFor(() =>
      expect(
        within(screen.getByRole("table")).getByText("EVIDENCE_SEALED"),
      ).toBeVisible(),
    );
    expect(reader.readEvidence).toHaveBeenCalledWith(sealedCaseId, 2);
    await user.selectOptions(
      screen.getByLabelText("Lifecycle filter"),
      "EVIDENCE_SEALED",
    );
    expect(
      within(screen.getByRole("table")).getByText(sealedCaseId),
    ).toBeVisible();
    expect(
      screen.getByText("Under review").nextElementSibling,
    ).toHaveTextContent("1");
  });

  it("explains empty discovery without implying contract enumeration", async () => {
    render(<CasesDashboard />);

    expect(await screen.findByText("No locally known cases")).toBeVisible();
    expect(screen.getByText(/contract cannot enumerate cases/i)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Create a case" }).parentElement,
    ).toHaveClass(styles.emptyCaseAction);
  });

  it("hydrates from an empty server shell before loading valid stored IDs", async () => {
    localStorage.setItem(
      "accessseal.case-ids.v1",
      JSON.stringify([caseIds.funded, "not-a-case-id", caseIds.funded]),
    );
    const clientWindow = window;
    vi.stubGlobal("window", undefined);
    const serverHtml = renderToString(<CasesDashboard />);
    vi.stubGlobal("window", clientWindow);
    expect(serverHtml).toContain("Loading locally known case IDs…");
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <CasesDashboard />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(
      /hydration|did not match/i,
    );
    await waitFor(() =>
      expect(
        within(container).getByText("Total cases").nextElementSibling,
      ).toHaveTextContent("1"),
    );
    expect(localStorage.getItem("accessseal.case-ids.v1")).toContain(
      "not-a-case-id",
    );
    await act(async () => root?.unmount());
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows the locally known total while authoritative reads are pending", async () => {
    localStorage.setItem(
      "accessseal.case-ids.v1",
      JSON.stringify([caseIds.funded, caseIds.pending]),
    );
    vi.mocked(useWallet).mockReturnValue({
      readContract: {
        ...mockReader(),
        readCase: vi.fn(() => new Promise<CaseRecord>(() => undefined)),
      },
    } as never);

    render(<CasesDashboard />);

    expect(
      (await screen.findByText("Total cases")).nextElementSibling,
    ).toHaveTextContent("2");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading finalized contract readbacks…",
    );
  });

  it("does not let an older reader generation overwrite a newer readback", async () => {
    localStorage.setItem(
      "accessseal.case-ids.v1",
      JSON.stringify([caseIds.funded]),
    );
    const firstCase = deferred<CaseRecord>();
    const firstStarted = deferred<void>();
    vi.mocked(useWallet).mockReturnValue({
      readContract: {
        ...mockReader(),
        readCase: vi.fn(() => {
          firstStarted.resolve();
          return firstCase.promise;
        }),
      },
    } as never);
    const { rerender } = render(<CasesDashboard />);
    await firstStarted.promise;

    vi.mocked(useWallet).mockReturnValue({
      readContract: {
        ...mockReader(),
        readCase: vi.fn(async (caseId: string) =>
          caseRecord(caseId, "REVIEW_PENDING"),
        ),
      },
    } as never);
    rerender(<CasesDashboard />);

    await waitFor(() =>
      expect(
        within(screen.getByRole("table")).getByText("REVIEW_PENDING"),
      ).toBeVisible(),
    );
    await act(async () => {
      firstCase.resolve(caseRecord(caseIds.funded, "FUNDED"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const table = within(screen.getByRole("table"));
    expect(table.getByText("REVIEW_PENDING")).toBeVisible();
    expect(table.queryByText("FUNDED")).not.toBeInTheDocument();
  });

  it("fails closed when current-epoch evidence readback is not exactly absent", async () => {
    localStorage.setItem(
      "accessseal.case-ids.v1",
      JSON.stringify(Object.values(evidenceCaseIds)),
    );

    render(<CasesDashboard />);

    await waitFor(() =>
      expect(
        screen.getAllByText("Evidence RPC unavailable").length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.getByText("Awaiting evidence").nextElementSibling,
    ).toHaveTextContent("1");
    expect(screen.getAllByText(evidenceCaseIds.present).length).toBeGreaterThan(
      0,
    );
  });

  it("accepts only exact lowercase SHA-256 imports and keeps storage deduplicated", async () => {
    const user = userEvent.setup();
    render(<CasesDashboard />);
    const input = screen.getByLabelText("Import case ID");

    fireEvent.change(input, {
      target: { value: `sha256:${"A".repeat(64)}` },
    });
    await user.click(
      screen.getByRole("button", { name: "Read from contract" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a case ID in the form sha256: followed by 64 lowercase hexadecimal characters.",
    );
    expect(localStorage.getItem("accessseal.case-ids.v1")).toBeNull();

    fireEvent.change(input, { target: { value: caseIds.funded } });
    await user.click(
      screen.getByRole("button", { name: "Read from contract" }),
    );
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("accessseal.case-ids.v1")!),
      ).toEqual([caseIds.funded]),
    );

    fireEvent.change(input, { target: { value: caseIds.funded } });
    await user.click(
      screen.getByRole("button", { name: "Read from contract" }),
    );
    expect(JSON.parse(localStorage.getItem("accessseal.case-ids.v1")!)).toEqual(
      [caseIds.funded],
    );
  });
});

import type {
  CaseRecord,
  EvidenceRecord,
  ReviewFinality,
  ReviewRecord,
  Settlement,
} from "@/lib/access-seal";

export type DashboardCase = {
  caseId: string;
  case: CaseRecord | null;
  evidence: EvidenceRecord | null;
  review: ReviewRecord | null;
  finality: ReviewFinality | null;
  settlement: Settlement | null;
  readError: string | null;
};

export type DashboardFilters = {
  lifecycle: string;
  verdict: string;
};

export function deriveDashboardMetrics(
  rows: readonly DashboardCase[],
  knownCaseCount = rows.length,
) {
  let awaitingEvidence = 0;
  let underReview = 0;
  let readyToSettle = 0;

  for (const row of rows) {
    if (row.readError || !row.case) continue;

    if (
      row.case.lifecycle === "FUNDED" ||
      (row.case.lifecycle === "EVIDENCE_OPEN" && row.evidence === null)
    )
      awaitingEvidence += 1;
    if (
      row.case.lifecycle === "REVIEW_PENDING" ||
      row.case.lifecycle === "EVIDENCE_SEALED"
    )
      underReview += 1;
    if (
      row.finality?.status === "FINALIZED" &&
      (row.review?.verdict === "APPROVED" ||
        row.review?.verdict === "REJECTED") &&
      row.settlement?.status !== "DISPATCHED_FINALIZED"
    )
      readyToSettle += 1;
  }

  return {
    total: knownCaseCount,
    awaitingEvidence,
    underReview,
    readyToSettle,
  };
}

export function filterDashboardCases(
  rows: readonly DashboardCase[],
  filters: DashboardFilters,
) {
  return rows.filter((row) => {
    if (row.readError) return true;
    if (!row.case) return false;
    const lifecycleMatches =
      filters.lifecycle === "ALL" || row.case.lifecycle === filters.lifecycle;
    const verdictMatches =
      filters.verdict === "ALL" || row.review?.verdict === filters.verdict;
    return lifecycleMatches && verdictMatches;
  });
}

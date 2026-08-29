"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  matchesExactUserError,
  type AccessSealClient,
  type EvidenceRecord,
} from "@/lib/access-seal";
import { reconcileCase } from "@/lib/transactions";
import { useWallet } from "@/providers/wallet-provider";
import { EmptyState } from "@/components/skeletons";
import { TransactionToast } from "@/components/transaction-toast";
import { DataTable, MobileDataRow } from "@/components/ui/data-table";
import { Metric } from "@/components/ui/panel";
import {
  deriveDashboardMetrics,
  filterDashboardCases,
  type DashboardCase,
} from "./case-dashboard-model";
import styles from "./cases.module.css";

const STORAGE_KEY = "accessseal.case-ids.v1";
const CASE_ID = /^(?:sha256:|0x)[0-9a-f]{64}$/;
const IMPORT_ERROR =
  "Enter a lowercase 0x or sha256: case ID followed by 64 hexadecimal characters.";

function readKnownIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    )
      return [];
    return parsed.filter(
      (id, index) => CASE_ID.test(id) && parsed.indexOf(id) === index,
    );
  } catch {
    return [];
  }
}

export async function loadKnownCase(
  reader: AccessSealClient,
  caseId: string,
): Promise<DashboardCase> {
  try {
    const reconciled = await reconcileCase(reader, caseId);
    let evidence: EvidenceRecord | null = null;
    if (
      reconciled.case.lifecycle === "EVIDENCE_OPEN" ||
      reconciled.case.lifecycle === "EVIDENCE_SEALED"
    ) {
      try {
        evidence = await reader.readEvidence(caseId, reconciled.case.epoch);
      } catch (cause) {
        if (!matchesExactUserError(cause, "evidence epoch does not exist"))
          throw cause;
      }
    }
    return {
      caseId,
      case: reconciled.case,
      evidence,
      review: reconciled.review,
      finality: reconciled.reviewFinality,
      settlement: reconciled.settlement,
      readError: null,
    };
  } catch (cause) {
    return {
      caseId,
      case: null,
      evidence: null,
      review: null,
      finality: null,
      settlement: null,
      readError:
        cause instanceof Error ? cause.message : "Finalized readback failed.",
    };
  }
}

function formatAmount(value: bigint | null) {
  return value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US").format(value);
}

function authoritativeState(row: DashboardCase) {
  if (row.readError) return "Readback error";
  if (row.settlement?.status === "DISPATCHED_FINALIZED")
    return "Settlement dispatched";
  if (row.settlement?.status === "PREPARED") return "Settlement prepared";
  if (row.finality?.status === "FINALIZED") return "Review finalized";
  if (row.finality?.status === "PENDING_PROTOCOL_FINALITY")
    return "Review finality pending";
  return "Finalized contract readback";
}

function parties(row: DashboardCase) {
  if (!row.case) return "Unavailable";
  return (
    <span className={styles.parties}>
      <span>{row.case.buyer}</span>
      <span>{row.case.vendor}</span>
    </span>
  );
}

function stateValue(row: DashboardCase) {
  return (
    <span className={row.readError ? styles.readError : undefined}>
      {authoritativeState(row)}
      {row.readError && <small role="alert">{row.readError}</small>}
    </span>
  );
}

type TableRow = Record<string, ReactNode> & { rowKey: string };

const columns = [
  { key: "caseId", label: "Case ID" },
  { key: "parties", label: "Buyer / vendor" },
  { key: "amount", label: "Simulated amount" },
  { key: "lifecycle", label: "Lifecycle" },
  { key: "verdict", label: "Verdict" },
  { key: "state", label: "Authoritative state" },
  { key: "action", label: "Action" },
] as const;

export function CasesDashboard() {
  const { readContract } = useWallet();
  const [ids, setIds] = useState<string[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [rows, setRows] = useState<DashboardCase[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState("ALL");
  const [verdict, setVerdict] = useState("ALL");
  const refreshGeneration = useRef(0);

  useEffect(() => {
    const task = window.setTimeout(() => {
      const knownIds = readKnownIds();
      setIds(knownIds);
      setLoading(knownIds.length > 0);
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (ids.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (!readContract) {
      setRows(
        ids.map((caseId) => ({
          caseId,
          case: null,
          evidence: null,
          review: null,
          finality: null,
          settlement: null,
          readError: "Finalized contract reader is unavailable.",
        })),
      );
      setLoading(false);
      return;
    }
    const next = await Promise.all(
      ids.map((caseId) => loadKnownCase(readContract, caseId)),
    );
    if (generation !== refreshGeneration.current) return;
    setRows(next);
    setLoading(false);
  }, [ids, readContract]);

  useEffect(() => {
    if (!storageReady) return;
    const task = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(task);
      refreshGeneration.current += 1;
    };
  }, [refresh, storageReady]);

  function importCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const caseId = value.trim();
    if (!CASE_ID.test(caseId)) {
      setImportError(IMPORT_ERROR);
      return;
    }
    setImportError(null);
    const next = [caseId, ...ids.filter((id) => id !== caseId)];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setIds(next);
    setValue("");
    setToastMessage("Case ID imported for finalized readback.");
  }

  const metrics = useMemo(
    () => deriveDashboardMetrics(rows, ids.length),
    [ids.length, rows],
  );
  const filteredRows = useMemo(
    () => filterDashboardCases(rows, { lifecycle, verdict }),
    [lifecycle, rows, verdict],
  );
  const tableRows: TableRow[] = filteredRows.map((row) => ({
    rowKey: row.caseId,
    caseId: row.caseId,
    parties: parties(row),
    amount: formatAmount(row.case?.escrowAmount ?? null),
    lifecycle: row.case?.lifecycle ?? "Unavailable",
    verdict: row.review?.verdict ?? "Unavailable",
    state: stateValue(row),
    action: (
      <Link href={`/cases/${encodeURIComponent(row.caseId)}`}>Inspect</Link>
    ),
  }));

  return (
    <section className={styles.dashboard} aria-label="Cases dashboard">
      <form className={styles.importForm} onSubmit={importCase}>
        <label htmlFor="case-id">Import case ID</label>
        <div className={styles.importControls}>
          <input
            id="case-id"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sha256:…"
          />
          <button className={styles.secondaryButton} type="submit">
            Read from contract
          </button>
        </div>
        {importError && <p role="alert">{importError}</p>}
      </form>
      {toastMessage && (
        <TransactionToast
          message={toastMessage}
          onDismiss={() => setToastMessage(null)}
        />
      )}

      {!storageReady ? (
        <p role="status">Loading locally known case IDs…</p>
      ) : ids.length === 0 ? (
        <EmptyState
          title="No locally known cases"
          body="The contract cannot enumerate cases. Import a locally known case ID to request an authoritative finalized readback."
          action={
            <div className={styles.emptyCaseAction}>
              <Link className={styles.primaryLink} href="/cases/new">
                Create a case
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <div className={styles.metrics}>
            <Metric label="Total cases" value={metrics.total} />
            <Metric
              label="Awaiting evidence"
              value={metrics.awaitingEvidence}
            />
            <Metric label="Under review" value={metrics.underReview} />
            <Metric label="Ready to settle" value={metrics.readyToSettle} />
          </div>
          <p className={styles.disclosure}>Based on locally known case IDs</p>

          <div className={styles.filters}>
            <label>
              Lifecycle filter
              <select
                value={lifecycle}
                onChange={(event) => setLifecycle(event.target.value)}
              >
                <option value="ALL">All lifecycles</option>
                <option value="DRAFT">DRAFT</option>
                <option value="FUNDED">FUNDED</option>
                <option value="EVIDENCE_OPEN">EVIDENCE_OPEN</option>
                <option value="EVIDENCE_SEALED">EVIDENCE_SEALED</option>
                <option value="REVIEW_PENDING">REVIEW_PENDING</option>
                <option value="DECIDED">DECIDED</option>
                <option value="SETTLEMENT_PENDING">SETTLEMENT_PENDING</option>
                <option value="DISPATCHED_FINALIZED">
                  DISPATCHED_FINALIZED
                </option>
                <option value="CANCELLED">CANCELLED</option>
              </select>
            </label>
            <label>
              Verdict filter
              <select
                value={verdict}
                onChange={(event) => setVerdict(event.target.value)}
              >
                <option value="ALL">All verdicts</option>
                <option value="APPROVED">APPROVED</option>
                <option value="REJECTED">REJECTED</option>
                <option value="REQUEST_MORE_INFO">REQUEST_MORE_INFO</option>
                <option value="UNRESOLVED">UNRESOLVED</option>
              </select>
            </label>
          </div>

          {loading ? (
            <p role="status">Loading finalized contract readbacks…</p>
          ) : (
            <>
              <div className={styles.desktopTable}>
                <DataTable
                  columns={columns}
                  rows={tableRows}
                  getRowKey={(row) => row.rowKey as string}
                />
              </div>
              <div className={styles.mobileRows} aria-label="Mobile case rows">
                {filteredRows.map((row) => (
                  <article className={styles.mobileCard} key={row.caseId}>
                    <MobileDataRow label="Case ID" value={row.caseId} />
                    <MobileDataRow
                      label="Buyer / vendor"
                      value={parties(row)}
                    />
                    <MobileDataRow
                      label="Simulated amount"
                      value={formatAmount(row.case?.escrowAmount ?? null)}
                    />
                    <MobileDataRow
                      label="Lifecycle"
                      value={row.case?.lifecycle ?? "Unavailable"}
                    />
                    <MobileDataRow
                      label="Verdict"
                      value={row.review?.verdict ?? "Unavailable"}
                    />
                    <MobileDataRow
                      label="Authoritative state"
                      value={stateValue(row)}
                    />
                    <MobileDataRow
                      label="Action"
                      value={
                        <Link href={`/cases/${encodeURIComponent(row.caseId)}`}>
                          Inspect
                        </Link>
                      }
                    />
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

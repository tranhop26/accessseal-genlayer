"use client";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/skeletons";
const STORAGE_KEY = "accessseal.case-ids.v1";
export default function CasesPage() {
  const [ids, setIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [value, setValue] = useState("");
  function add(event: React.FormEvent) {
    event.preventDefault();
    const id = value.trim();
    if (!id || ids.includes(id)) return;
    const next = [id, ...ids];
    setIds(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setValue("");
  }
  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <span className="eyebrow">Authoritative readbacks</span>
          <h1>Acceptance cases</h1>
          <p>
            The frozen contract has no public enumeration method. Import a known
            case ID; every displayed field is then reconciled from finalized
            contract state.
          </p>
        </div>
        <Link className="primary-button" href="/cases/new">
          New case
        </Link>
      </header>
      <form className="case-import" onSubmit={add}>
        <label htmlFor="case-id">Import case ID</label>
        <div>
          <input
            id="case-id"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sha256:…"
          />
          <button className="secondary-button">Read from contract</button>
        </div>
      </form>
      {ids.length === 0 ? (
        <EmptyState
          title="No cases imported"
          body="Create a case or paste a known ID to begin finalized readback."
          action={
            <Link className="primary-button" href="/cases/new">
              Create your first case
            </Link>
          }
        />
      ) : (
        <div className="case-grid">
          {ids.map((id) => (
            <Link
              className="case-card"
              href={`/cases/${encodeURIComponent(id)}`}
              key={id}
            >
              <span className="status-pill pending">Readback required</span>
              <h2>{id.slice(0, 18)}…</h2>
              <p>
                Open case to reconcile lifecycle, evidence, review and
                accounting.
              </p>
              <span className="text-link">Inspect case →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

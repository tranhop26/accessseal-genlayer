"use client";
import { useRef, useState } from "react";
import { deriveCaseBindings } from "@/lib/access-seal";
import { restrictedOrigin } from "@/lib/evidence";
import type { PublicNetwork } from "@/lib/config";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_U256 = (1n << 256n) - 1n;
export type CaseAuthority = {
  buyer: string;
  chainId: number;
  network: PublicNetwork;
  contractAddress: string;
};

export type CaseDraft = {
  vendor: string;
  subjectOrigin: string;
  profileHash: string;
  flows: [string, string, string];
  flowsHash: string;
  caseId: string;
  termsHash: string;
  evidenceDeadline: number;
  hardDeadline: number;
  maxUnresolvedRetries: number;
  escrowAmount: bigint;
  salt: string;
  authority: CaseAuthority;
};
export function CaseComposer({
  onCreate,
  authority,
}: {
  onCreate: (draft: CaseDraft) => void | Promise<void>;
  authority: CaseAuthority | null;
}) {
  const [preview, setPreview] = useState<CaseDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const currentPreview =
    preview &&
    authority &&
    preview.authority.buyer === authority.buyer &&
    preview.authority.chainId === authority.chainId &&
    preview.authority.network === authority.network &&
    preview.authority.contractAddress === authority.contractAddress
      ? preview
      : null;
  async function previewTerms(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const vendor = String(data.get("vendor") ?? "")
      .trim()
      .toLowerCase();
    const subjectOrigin = String(data.get("origin") ?? "").trim();
    const profileHash = String(data.get("profile") ?? "").trim();
    const flows = ["flow1", "flow2", "flow3"].map((k) =>
      String(data.get(k) ?? "").trim(),
    ) as [string, string, string];
    const escrow = String(data.get("escrow") ?? "");
    try {
      if (
        !/^0x[0-9a-f]{40}$/.test(vendor) ||
        !/^0x[0-9a-f]{64}$/.test(profileHash) ||
        flows.some((f) => !f) ||
        !/^[1-9][0-9]*$/.test(escrow)
      )
        throw new Error(
          "Complete the required fields with valid contract-safe values.",
        );
      if (!authority)
        throw new Error(
          "Connect the signing buyer wallet before creating a canonical preview.",
        );
      const escrowAmount = BigInt(escrow);
      if (
        vendor === ZERO_ADDRESS ||
        vendor === authority.buyer ||
        escrowAmount === 0n ||
        escrowAmount > MAX_U256
      )
        throw new Error(
          "Vendor and escrow violate the contract counterparty or u256 constraints.",
        );
      if (restrictedOrigin(`${subjectOrigin}/`) !== subjectOrigin)
        throw new Error(
          "Website origin must use the contract restricted HTTPS origin profile.",
        );
      const base = {
        vendor,
        subjectOrigin,
        profileHash,
        flows,
        evidenceDeadline: 86400,
        hardDeadline: 604800,
        maxUnresolvedRetries: 2,
        escrowAmount,
        salt: crypto.randomUUID(),
        authority: { ...authority },
      };
      const bindings = await deriveCaseBindings({ ...base, ...authority });
      setPreview({ ...base, ...bindings });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid terms.");
      setPreview(null);
      first.current?.focus();
    }
  }
  async function create() {
    if (!currentPreview || busy) return;
    if (
      !authority ||
      currentPreview.authority.buyer !== authority.buyer ||
      currentPreview.authority.chainId !== authority.chainId ||
      currentPreview.authority.network !== authority.network ||
      currentPreview.authority.contractAddress !== authority.contractAddress
    ) {
      setPreview(null);
      setError("Wallet or network changed; regenerate the canonical preview.");
      return;
    }
    setBusy(true);
    try {
      await onCreate(currentPreview);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="composer-layout">
      <form
        className="composer"
        onSubmit={previewTerms}
        onChange={() => {
          setPreview(null);
          setError("");
        }}
        noValidate
      >
        <div className="section-heading">
          <span className="step-number">01</span>
          <div>
            <span className="eyebrow">Counterparty</span>
            <h2>Lock the release agreement</h2>
          </div>
        </div>
        {error && (
          <div id="form-error" className="form-error" role="alert">
            {error}
          </div>
        )}
        <label>
          Vendor wallet
          <input
            ref={first}
            name="vendor"
            placeholder="0x…"
            aria-invalid={!!error}
            aria-describedby={error ? "form-error" : undefined}
            required
          />
        </label>
        <label>
          Website origin
          <input
            name="origin"
            type="url"
            placeholder="https://product.example"
            required
          />
        </label>
        <label>
          Accessibility profile hash
          <input name="profile" placeholder="0x + 64 hex characters" required />
        </label>
        <fieldset>
          <legend>Three critical user flows</legend>
          {[1, 2, 3].map((i) => (
            <input
              key={i}
              name={`flow${i}`}
              aria-label={`Critical flow ${i}`}
              placeholder="Describe a locked accessible flow"
              required
            />
          ))}
        </fieldset>
        <label>
          Simulated escrow (wei)
          <input
            name="escrow"
            inputMode="numeric"
            placeholder="1000000000000000000"
            required
          />
        </label>
        <button className="primary-button" type="submit">
          Preview locked terms
        </button>
      </form>
      <aside className="terms-preview" aria-live="polite">
        <span className="eyebrow">Canonical preview</span>
        {currentPreview ? (
          <>
            <h2>Ready for wallet signature</h2>
            <dl>
              <div>
                <dt>Case ID</dt>
                <dd>
                  <code>{currentPreview.caseId}</code>
                </dd>
              </div>
              <div>
                <dt>Origin</dt>
                <dd>{currentPreview.subjectOrigin}</dd>
              </div>
              <div>
                <dt>Flows hash</dt>
                <dd>
                  <code>{currentPreview.flowsHash}</code>
                </dd>
              </div>
              <div>
                <dt>Terms hash</dt>
                <dd>
                  <code>{currentPreview.termsHash}</code>
                </dd>
              </div>
              <div>
                <dt>Escrow</dt>
                <dd>{currentPreview.escrowAmount.toString()} wei</dd>
              </div>
            </dl>
            <div className="hash-box">
              <span>Profile binding</span>
              <code>{currentPreview.profileHash}</code>
            </div>
            <button className="primary-button" onClick={create} disabled={busy}>
              {busy ? "Awaiting wallet…" : "Create case on GenLayer"}
            </button>
          </>
        ) : (
          <>
            <h2>Nothing signed yet</h2>
            <p>
              Complete the agreement to inspect every immutable term before your
              wallet is asked to sign.
            </p>
            <div className="preview-placeholder" aria-hidden="true" />
          </>
        )}
      </aside>
    </div>
  );
}

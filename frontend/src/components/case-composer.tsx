"use client";

import { useRef, useState } from "react";
import { deriveCaseBindings } from "@/lib/access-seal";
import { restrictedOrigin } from "@/lib/evidence";
import type { PublicNetwork } from "@/lib/config";
import styles from "./cases/case-composer.module.css";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_U256 = (1n << 256n) - 1n;

type ComposerStep = "parties" | "terms" | "review";
type ComposerField =
  "vendor" | "origin" | "profile" | "flow0" | "flow1" | "flow2" | "escrow";

const STEPS = [
  { id: "parties", label: "Parties" },
  { id: "terms", label: "Acceptance terms" },
  { id: "review", label: "Review and sign" },
] as const;

type ComposerValues = {
  vendor: string;
  subjectOrigin: string;
  profileHash: string;
  flows: [string, string, string];
  escrow: string;
};

const EMPTY_VALUES: ComposerValues = {
  vendor: "",
  subjectOrigin: "",
  profileHash: "",
  flows: ["", "", ""],
  escrow: "",
};

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

function networkLabel(network: PublicNetwork | undefined) {
  if (network === "testnet_bradbury") return "Bradbury Testnet";
  if (network === "studionet") return "Studionet";
  if (network === "localnet") return "Localnet";
  return "Network unavailable";
}

function sameAuthority(
  draft: CaseDraft | null,
  authority: CaseAuthority | null,
) {
  return !!(
    draft &&
    authority &&
    draft.authority.buyer === authority.buyer &&
    draft.authority.chainId === authority.chainId &&
    draft.authority.network === authority.network &&
    draft.authority.contractAddress === authority.contractAddress
  );
}

function authorityFingerprint(authority: CaseAuthority | null) {
  return authority
    ? [
        authority.buyer,
        authority.chainId,
        authority.network,
        authority.contractAddress,
      ].join(":")
    : "disconnected";
}

function SplitAddress({ address }: { address: string }) {
  const midpoint = Math.ceil(address.length / 2);
  return (
    <code className={styles.breakableCode}>
      <span>{address.slice(0, midpoint)}</span>
      <span>{address.slice(midpoint)}</span>
    </code>
  );
}

export function CaseComposer({
  onCreate,
  authority,
}: {
  onCreate: (draft: CaseDraft) => void | Promise<void>;
  authority: CaseAuthority | null;
}) {
  const [step, setStep] = useState<ComposerStep>("parties");
  const [values, setValues] = useState<ComposerValues>(EMPTY_VALUES);
  const [preview, setPreview] = useState<CaseDraft | null>(null);
  const fingerprint = authorityFingerprint(authority);
  const [observedAuthority, setObservedAuthority] = useState(fingerprint);
  if (observedAuthority !== fingerprint) {
    setObservedAuthority(fingerprint);
    if (preview) setPreview(null);
  }
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<ComposerField | null>(null);
  const [busy, setBusy] = useState(false);
  const vendorRef = useRef<HTMLInputElement>(null);
  const originRef = useRef<HTMLInputElement>(null);
  const profileRef = useRef<HTMLInputElement>(null);
  const flowRefs = useRef<Array<HTMLInputElement | null>>([]);
  const escrowRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const currentPreview = sameAuthority(preview, authority) ? preview : null;

  function invalidatePreview() {
    setPreview(null);
    setError("");
    setErrorField(null);
  }

  function focusField(field: ComposerField | null) {
    window.requestAnimationFrame(() => {
      if (field === "vendor") vendorRef.current?.focus();
      else if (field === "origin") originRef.current?.focus();
      else if (field === "profile") profileRef.current?.focus();
      else if (field === "escrow") escrowRef.current?.focus();
      else if (field?.startsWith("flow"))
        flowRefs.current[Number(field.slice(-1))]?.focus();
    });
  }

  function goToStep(nextStep: ComposerStep) {
    setStep(nextStep);
    window.requestAnimationFrame(() => {
      if (nextStep === "parties") vendorRef.current?.focus();
      if (nextStep === "terms") originRef.current?.focus();
      if (nextStep === "review") createRef.current?.focus();
    });
  }

  function updateValue<Key extends Exclude<keyof ComposerValues, "flows">>(
    key: Key,
    value: ComposerValues[Key],
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    invalidatePreview();
  }

  function updateFlow(index: number, value: string) {
    setValues((current) => {
      const flows = [...current.flows] as [string, string, string];
      flows[index] = value;
      return { ...current, flows };
    });
    invalidatePreview();
  }

  async function previewTerms(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step !== "terms") return;
    const vendor = values.vendor.trim().toLowerCase();
    const subjectOrigin = values.subjectOrigin.trim();
    const profileHash = values.profileHash.trim();
    const flows = values.flows.map((flow) => flow.trim()) as [
      string,
      string,
      string,
    ];
    const escrow = values.escrow;
    let invalidField: ComposerField | null = null;

    try {
      if (!/^0x[0-9a-f]{40}$/.test(vendor)) {
        invalidField = "vendor";
        throw new Error(
          "Complete the required fields with valid contract-safe values.",
        );
      }
      if (!/^0x[0-9a-f]{64}$/.test(profileHash)) {
        invalidField = "profile";
        throw new Error(
          "Complete the required fields with valid contract-safe values.",
        );
      }
      const emptyFlow = flows.findIndex((flow) => !flow);
      if (emptyFlow >= 0) {
        invalidField = `flow${emptyFlow}` as ComposerField;
        throw new Error(
          "Complete the required fields with valid contract-safe values.",
        );
      }
      if (!/^[1-9][0-9]*$/.test(escrow)) {
        invalidField = "escrow";
        throw new Error(
          "Complete the required fields with valid contract-safe values.",
        );
      }
      if (!authority)
        throw new Error(
          "Connect the signing buyer wallet before creating a canonical preview.",
        );
      const escrowAmount = BigInt(escrow);
      if (vendor === ZERO_ADDRESS || vendor === authority.buyer) {
        invalidField = "vendor";
        throw new Error(
          "Vendor and escrow violate the contract counterparty or u256 constraints.",
        );
      }
      if (escrowAmount === 0n || escrowAmount > MAX_U256) {
        invalidField = "escrow";
        throw new Error(
          "Vendor and escrow violate the contract counterparty or u256 constraints.",
        );
      }
      invalidField = "origin";
      if (restrictedOrigin(`${subjectOrigin}/`) !== subjectOrigin)
        throw new Error(
          "Website origin must use the contract restricted HTTPS origin profile.",
        );
      invalidField = null;
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
      setErrorField(null);
      goToStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid terms.");
      setErrorField(invalidField);
      setPreview(null);
      setStep(invalidField === "vendor" ? "parties" : "terms");
      focusField(invalidField);
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
      setErrorField(null);
      return;
    }
    setBusy(true);
    try {
      await onCreate(currentPreview);
    } finally {
      setBusy(false);
    }
  }

  const summaryVendor = currentPreview?.vendor ?? values.vendor.trim();
  const summaryEscrow =
    currentPreview?.escrowAmount.toString() ?? values.escrow;

  return (
    <div className={styles.composerLayout} data-step={step}>
      <nav
        aria-label="Case creation progress"
        className={styles.stepNavigation}
      >
        <ol>
          {STEPS.map((item, index) => (
            <li key={item.id}>
              <span
                aria-current={step === item.id ? "step" : undefined}
                className={step === item.id ? styles.activeStep : styles.step}
              >
                <span aria-hidden="true" className={styles.stepNumber}>
                  {index + 1}
                </span>
                {item.label}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <aside
        aria-labelledby="case-signature-scope-title"
        className={styles.liveSummary}
      >
        <p className={styles.eyebrow}>Live authority summary</p>
        <h2 id="case-signature-scope-title">Case signature scope</h2>
        <dl className={styles.summaryList}>
          <div>
            <dt>Buyer</dt>
            <dd>
              <code>{authority?.buyer || "Wallet not connected"}</code>
            </dd>
          </div>
          <div>
            <dt>Vendor</dt>
            <dd>
              <code>{summaryVendor || "Not entered"}</code>
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{summaryEscrow ? `${summaryEscrow} wei` : "Not entered"}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{networkLabel(authority?.network)}</dd>
          </div>
          <div>
            <dt>Chain ID</dt>
            <dd>{authority?.chainId ?? "Not configured"}</dd>
          </div>
          <div>
            <dt>Contract</dt>
            <dd>
              <code>{authority?.contractAddress || "Not configured"}</code>
            </dd>
          </div>
        </dl>
        {currentPreview ? (
          <p
            aria-live="polite"
            className={styles.summaryStatus}
            data-ready="true"
            role="status"
          >
            Canonical bindings generated
          </p>
        ) : (
          <p className={styles.summaryStatus} data-ready="false">
            Complete review to generate canonical bindings
          </p>
        )}
      </aside>

      <form className={styles.composer} noValidate onSubmit={previewTerms}>
        {error && (
          <div className={styles.formError} id="form-error" role="alert">
            {error}
          </div>
        )}

        <section
          aria-labelledby="composer-step-title"
          className={styles.stepSection}
        >
          {step === "parties" && (
            <>
              <p className={styles.eyebrow}>Step 1 of 3</p>
              <h2 id="composer-step-title">Confirm the signing parties</h2>
              <p className={styles.intro}>
                Lock the vendor and the exact HTTPS origin covered by this case.
              </p>
              <div className={styles.fields}>
                <label>
                  Vendor wallet
                  <input
                    aria-describedby={
                      errorField === "vendor" ? "form-error" : undefined
                    }
                    aria-invalid={errorField === "vendor"}
                    onChange={(event) =>
                      updateValue("vendor", event.currentTarget.value)
                    }
                    placeholder="0x…"
                    ref={vendorRef}
                    required
                    value={values.vendor}
                  />
                </label>
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.primaryButton}
                  onClick={() => goToStep("terms")}
                  type="button"
                >
                  Continue to terms
                </button>
              </div>
            </>
          )}

          {step === "terms" && (
            <>
              <p className={styles.eyebrow}>Step 2 of 3</p>
              <h2 id="composer-step-title">
                Define immutable acceptance terms
              </h2>
              <p className={styles.intro}>
                These values feed the canonical hashes generated for signature.
              </p>
              <div className={styles.fields}>
                <label>
                  Website origin
                  <input
                    aria-describedby={
                      errorField === "origin" ? "form-error" : undefined
                    }
                    aria-invalid={errorField === "origin"}
                    onChange={(event) =>
                      updateValue("subjectOrigin", event.currentTarget.value)
                    }
                    placeholder="https://product.example"
                    ref={originRef}
                    required
                    type="url"
                    value={values.subjectOrigin}
                  />
                </label>
                <label>
                  Accessibility profile hash
                  <input
                    aria-describedby={
                      errorField === "profile" ? "form-error" : undefined
                    }
                    aria-invalid={errorField === "profile"}
                    onChange={(event) =>
                      updateValue("profileHash", event.currentTarget.value)
                    }
                    placeholder="0x + 64 hex characters"
                    ref={profileRef}
                    required
                    value={values.profileHash}
                  />
                </label>
                <fieldset>
                  <legend>Three critical user flows</legend>
                  {values.flows.map((flow, index) => (
                    <input
                      aria-describedby={
                        errorField === `flow${index}` ? "form-error" : undefined
                      }
                      aria-invalid={errorField === `flow${index}`}
                      aria-label={`Critical flow ${index + 1}`}
                      key={index}
                      onChange={(event) =>
                        updateFlow(index, event.currentTarget.value)
                      }
                      placeholder="Describe a locked accessible flow"
                      ref={(node) => {
                        flowRefs.current[index] = node;
                      }}
                      required
                      value={flow}
                    />
                  ))}
                </fieldset>
                <label>
                  Simulated escrow (wei)
                  <input
                    aria-describedby={
                      errorField === "escrow" ? "form-error" : undefined
                    }
                    aria-invalid={errorField === "escrow"}
                    inputMode="numeric"
                    onChange={(event) =>
                      updateValue("escrow", event.currentTarget.value)
                    }
                    placeholder="1000000000000000000"
                    ref={escrowRef}
                    required
                    value={values.escrow}
                  />
                </label>
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.secondaryButton}
                  onClick={() => goToStep("parties")}
                  type="button"
                >
                  Back to parties
                </button>
                <button className={styles.primaryButton} type="submit">
                  Review locked terms
                </button>
              </div>
            </>
          )}

          {step === "review" && (
            <>
              <p className={styles.eyebrow}>Step 3 of 3</p>
              <h2 id="composer-step-title">Verify immutable bindings</h2>
              {currentPreview ? (
                <>
                  <p className={styles.ready}>Ready for wallet signature</p>
                  <p className={styles.intro}>
                    Check the live authority and immutable bindings before your
                    wallet creates the case.
                  </p>
                  <details className={styles.details}>
                    <summary>Advanced contract details</summary>
                    <dl>
                      <div>
                        <dt>Case ID</dt>
                        <dd>
                          <code>{currentPreview.caseId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Terms hash</dt>
                        <dd>
                          <code>{currentPreview.termsHash}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Flows hash</dt>
                        <dd>
                          <code>{currentPreview.flowsHash}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Profile hash</dt>
                        <dd>
                          <code>{currentPreview.profileHash}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Network</dt>
                        <dd>{currentPreview.authority.network}</dd>
                      </div>
                      <div>
                        <dt>Chain ID</dt>
                        <dd>{currentPreview.authority.chainId}</dd>
                      </div>
                      <div>
                        <dt>Full contract address</dt>
                        <dd>
                          <SplitAddress
                            address={currentPreview.authority.contractAddress}
                          />
                        </dd>
                      </div>
                    </dl>
                  </details>
                  <div className={styles.actions}>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => goToStep("terms")}
                      type="button"
                    >
                      Back to terms
                    </button>
                    <button
                      className={styles.primaryButton}
                      disabled={busy}
                      onClick={create}
                      ref={createRef}
                      type="button"
                    >
                      {busy ? "Awaiting wallet…" : "Create case on GenLayer"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className={styles.intro}>
                    Wallet or network changed. Return to the terms and generate
                    a new authority-bound preview.
                  </p>
                  <div className={styles.actions}>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setStep("terms")}
                      type="button"
                    >
                      Back to terms
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </form>
    </div>
  );
}

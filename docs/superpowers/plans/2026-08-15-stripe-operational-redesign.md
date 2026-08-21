# AccessSeal Stripe Operational Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the complete AccessSeal frontend as a light, responsive Stripe-inspired operational product while preserving every existing GenLayer contract, wallet, evidence, finality, recovery, and settlement invariant.

**Architecture:** Keep all contract-facing logic in the existing clients and workflow components, then add a route-aware presentation shell and a small reusable UI layer. Split the current 1,116-line global stylesheet into one global token/reset entry plus scoped CSS Modules, derive dashboard data only from locally known case IDs and authoritative contract readbacks, and treat finalized readback—not transaction acceptance—as the success boundary.

**Tech Stack:** Next.js 16.3.1 App Router, React 19.2.8, TypeScript 5.9.3, CSS Modules plus one root global stylesheet, Vitest/Testing Library, Playwright 1.62.1, axe-core 4.13.0, existing GenLayerJS 1.1.8 integration.

## Global Constraints

- Preserve the deployed Bradbury contract `0x814726d7a3a2CbC52C8ea622b49aF1d6FDa300A7`; do not modify or redeploy the Intelligent Contract.
- Do not change transaction semantics, evidence schema, custody rules, recovery rules, finality rules, or authoritative readback behavior.
- Use `#f6f9fc` for the app background, white primary surfaces, `#e6ebf1` borders, and `#635bff` for primary actions.
- Display `Bradbury Testnet · Simulated GEN`; never describe simulated GEN as real money.
- Do not add a backend, indexer, remote font, UI framework, icon dependency, analytics dependency, or copied Stripe asset/source/layout.
- Metrics and rows may use only locally created/imported case IDs and their contract readbacks; never imply global contract enumeration.
- Never advance the interface beyond finalized contract readback; ACCEPTED remains non-terminal and non-green.
- Preserve fail-closed behavior for wallet rejection, wrong network, stale provenance, missing readback, invalid evidence, and invalid authority bindings.
- Meet WCAG AA, keep visible focus, reduced-motion behavior, keyboard navigation, semantic headings, table headers, accessible mobile equivalents, and non-color status labels.
- Use local system fonts; do not introduce a build-time font download.
- External GitHub push or Vercel redeployment requires a separate action-time confirmation after local completion.
- Run focused tests within Tasks 1–7; run the full root/direct/integration/browser gate only once in Task 8.

---

## File Structure

### Create

- `frontend/src/components/ui/button.tsx` — shared link/button variants without owning workflow rules.
- `frontend/src/components/ui/badge.tsx` — semantic lifecycle, verdict, network, and neutral badges.
- `frontend/src/components/ui/panel.tsx` — panel, metric, inline notice, and empty/error presentation primitives.
- `frontend/src/components/ui/data-table.tsx` — semantic desktop table and labeled mobile row boundary.
- `frontend/src/components/ui/timeline.tsx` — accessible lifecycle and transaction phase sequences.
- `frontend/src/components/ui/ui.module.css` — scoped primitive styles.
- `frontend/src/components/navigation/app-navigation.tsx` — desktop sidebar, tablet rail, and mobile bottom navigation.
- `frontend/src/components/navigation/navigation.module.css` — operational navigation styling.
- `frontend/src/components/marketing/landing-page.tsx` — landing hero, workflow preview, trust strip, comparison, and CTA.
- `frontend/src/components/marketing/marketing.module.css` — landing-only responsive styles.
- `frontend/src/components/cases/cases-dashboard.tsx` — known-ID import, readback loading, filters, metrics, table/list, and row errors.
- `frontend/src/components/cases/case-dashboard-model.ts` — pure lifecycle/verdict filtering and metric derivation.
- `frontend/src/components/cases/cases.module.css` — dashboard table/list/metric layout.
- `frontend/src/components/cases/case-composer.module.css` — three-step composer and summary layout.
- `frontend/src/components/cases/case-detail.module.css` — invoice summary, anchor navigation, and four-section detail document.
- `frontend/src/components/transaction-toast.tsx` — ephemeral confirmation toast that never replaces durable inline state.
- `frontend/tests/components/ui.test.tsx` — shared component semantics and variants.
- `frontend/tests/components/navigation.test.tsx` — route shell, Bradbury identity, and responsive navigation semantics.
- `frontend/tests/components/landing.test.tsx` — landing hierarchy and workflow preview.
- `frontend/tests/components/dashboard.test.tsx` — locally scoped metrics, filtering, readback failures, table/list labels.
- `frontend/tests/components/composer-steps.test.tsx` — three-step progression and preview invalidation.
- `frontend/tests/components/case-detail-layout.test.tsx` — section/anchor/status presentation with mocked authoritative readbacks.

### Modify

- `frontend/src/app/globals.css` — retain only reset, tokens, body defaults, focus, utilities, and reduced-motion rules.
- `frontend/src/app/layout.tsx` — retain root config/provider and attach light system typography metadata.
- `frontend/src/app/page.tsx` — render `LandingPage`.
- `frontend/src/app/cases/page.tsx` — render `CasesDashboard`.
- `frontend/src/app/cases/new/page.tsx` — use the new page framing and transaction presentation without changing `create()`.
- `frontend/src/components/app-shell.tsx` — choose marketing or operational shell from the current pathname.
- `frontend/src/components/case-composer.tsx` — add visual steps while preserving `CaseDraft`, validation, binding, and `onCreate`.
- `frontend/src/components/case-detail.tsx` — reorganize existing actions into four visible anchor sections without changing eligibility or writes.
- `frontend/src/components/status-panel.tsx` — render the four-phase transaction sequence.
- `frontend/src/components/skeletons.tsx` — replace orbit/glyph presentation with shared empty/error/panel primitives.
- `frontend/src/components/wallet-button.tsx` — adopt shared button/status styling while retaining provider event handling.
- `frontend/tests/components/core.test.tsx` — update shell assertions from Studionet to Bradbury and preserve fail-closed checks.
- `frontend/tests/components/workflow.test.tsx` — preserve all domain assertions while adapting semantic markup.
- `frontend/e2e/happy-path.spec.ts` — assert finalized readback presentation in the redesigned detail document.
- `frontend/e2e/recovery.spec.ts` — assert recovery actions remain discoverable and dispatchable.
- `frontend/e2e/responsive-accessibility.spec.ts` — cover marketing, dashboard, composer, detail, navigation, focus, overflow, reduced motion, and axe.

### Preserve Unchanged

- `contracts/**`, `tests/direct/**`, `tests/integration/**` — no contract or protocol changes.
- `frontend/src/lib/access-seal.ts`, `evidence.ts`, `transactions.ts`, `case-cache.ts`, `config.ts` — existing validation and reconciliation authority.
- `frontend/src/providers/wallet-provider.tsx` — existing account/network/signer binding logic.

---

### Task 1: Light Design Tokens and Shared Operational Primitives

**Files:**
- Create: `frontend/src/components/ui/button.tsx`
- Create: `frontend/src/components/ui/badge.tsx`
- Create: `frontend/src/components/ui/panel.tsx`
- Create: `frontend/src/components/ui/data-table.tsx`
- Create: `frontend/src/components/ui/timeline.tsx`
- Create: `frontend/src/components/ui/ui.module.css`
- Create: `frontend/tests/components/ui.test.tsx`
- Modify: `frontend/src/app/globals.css`
- Modify: `frontend/src/components/skeletons.tsx`

**Interfaces:**
- Consumes: React nodes and existing lifecycle/verdict/transaction strings; no contract client.
- Produces: `Button`, `Badge`, `Panel`, `Metric`, `InlineNotice`, `DataTable`, `MobileDataRow`, `Timeline`, `EmptyState`, and `ErrorState` presentation boundaries used by Tasks 2–7.

- [ ] **Step 1: Write shared-component RED tests**

```tsx
it("renders status with text and exposes labeled mobile data", () => {
  render(
    <>
      <Badge tone="success">APPROVED</Badge>
      <MobileDataRow label="Case ID" value="sha256:abc" />
      <Timeline
        label="Transaction progress"
        current="ACCEPTED"
        items={["SUBMITTED", "ACCEPTED", "FINALIZED", "READBACK_CONFIRMED"]}
      />
    </>,
  );
  expect(screen.getByText("APPROVED")).toHaveAttribute("data-tone", "success");
  expect(screen.getByText("Case ID")).toBeVisible();
  expect(screen.getByText("ACCEPTED")).toHaveAttribute("aria-current", "step");
});

it("uses links for navigation and buttons for actions", () => {
  render(<Button href="/cases/new">Create case</Button>);
  expect(screen.getByRole("link", { name: "Create case" })).toHaveAttribute(
    "href",
    "/cases/new",
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --prefix frontend run test -- tests/components/ui.test.tsx`

Expected: FAIL because the `components/ui/*` modules do not exist.

- [ ] **Step 3: Implement typed primitives**

```tsx
// frontend/src/components/ui/badge.tsx
import styles from "./ui.module.css";

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger";

export function Badge({ tone = "neutral", children }: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return <span className={styles.badge} data-tone={tone}>{children}</span>;
}
```

```tsx
// frontend/src/components/ui/timeline.tsx
export function Timeline({ label, items, current }: {
  label: string;
  items: readonly string[];
  current: string;
}) {
  const currentIndex = items.indexOf(current);
  return (
    <ol aria-label={label} className={styles.timeline} tabIndex={0}>
      {items.map((item, index) => (
        <li
          key={item}
          aria-current={item === current ? "step" : undefined}
          data-state={index < currentIndex ? "complete" : item === current ? "current" : "upcoming"}
        >
          <span aria-hidden="true" />{item.replaceAll("_", " ")}
        </li>
      ))}
    </ol>
  );
}
```

Implement `Button` as a discriminated union (`href` renders `next/link`; `onClick` renders `button`), `Panel`/`Metric` as semantic wrappers, and `DataTable` with real `<table>`, `<thead>`, `<th scope="col">`, and `<tbody>` markup. Keep classes scoped in `ui.module.css`.

- [ ] **Step 4: Reduce global CSS to tokens and global behavior**

```css
:root {
  --as-bg: #f6f9fc;
  --as-surface: #ffffff;
  --as-border: #e6ebf1;
  --as-primary: #635bff;
  --as-primary-hover: #5147e5;
  --as-text: #0a2540;
  --as-muted: #536477;
  --as-success: #08795c;
  --as-warning: #9a6700;
  --as-danger: #b42318;
  --as-info: #175cd3;
  --as-radius-sm: 8px;
  --as-radius-md: 12px;
  --as-shadow: 0 1px 2px rgb(10 37 64 / 6%), 0 8px 24px rgb(10 37 64 / 5%);
}

html { color-scheme: light; background: var(--as-bg); }
body {
  margin: 0;
  background: var(--as-bg);
  color: var(--as-text);
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:focus-visible { outline: 3px solid rgb(99 91 255 / 45%); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

Move component selectors out of `globals.css`; retain `.sr-only` and the skip-link global utility only.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `npm --prefix frontend run test -- tests/components/ui.test.tsx tests/components/core.test.tsx`

Expected: PASS with semantic badges, table headers, timeline current step, loading label, and error alert.

Run: `npm --prefix frontend run lint && npm --prefix frontend run typecheck`

Expected: both exit 0.

- [ ] **Step 6: Commit the primitive layer**

```bash
git add frontend/src/app/globals.css frontend/src/components/ui frontend/src/components/skeletons.tsx frontend/tests/components/ui.test.tsx frontend/tests/components/core.test.tsx
git commit -m "feat: add light operational design system"
```

---

### Task 2: Route-Aware Marketing and Operational Shell

**Files:**
- Create: `frontend/src/components/navigation/app-navigation.tsx`
- Create: `frontend/src/components/navigation/navigation.module.css`
- Create: `frontend/tests/components/navigation.test.tsx`
- Modify: `frontend/src/components/app-shell.tsx`
- Modify: `frontend/src/components/wallet-button.tsx`
- Modify: `frontend/src/app/layout.tsx`
- Modify: `frontend/tests/components/core.test.tsx`

**Interfaces:**
- Consumes: `PublicConfig` and `useWallet()` for current Bradbury contract/network identity; `Button` and `Badge` from Task 1.
- Produces: route-aware `AppShell`, `AppNavigation`, and `ContractIdentity` used on every application route.

- [ ] **Step 1: Write navigation RED tests**

```tsx
it("shows a marketing header on home and the operational shell on cases", () => {
  mockPathname.mockReturnValue("/cases");
  render(<AppShell><div>Cases content</div></AppShell>);
  expect(screen.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Cases" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByText("Bradbury Testnet · Simulated GEN")).toBeVisible();
  expect(screen.getByText("0x8147…00A7")).toBeVisible();
});

it("provides labeled mobile navigation without duplicating current-page semantics", () => {
  render(<AppNavigation pathname="/cases/new" contractAddress={ADDRESS} />);
  expect(screen.getByRole("navigation", { name: "Mobile workspace" })).toBeVisible();
  expect(
    screen
      .getAllByRole("link", { name: "Create case" })
      .some((link) => link.getAttribute("aria-current") === "page"),
  ).toBe(true);
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm --prefix frontend run test -- tests/components/navigation.test.tsx tests/components/core.test.tsx`

Expected: FAIL because `AppNavigation` and the Bradbury operational shell do not exist.

- [ ] **Step 3: Implement route-aware shell and navigation**

```tsx
// frontend/src/components/app-shell.tsx
"use client";
import { usePathname } from "next/navigation";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const operational = pathname.startsWith("/cases");
  return operational ? (
    <div className={styles.operationalFrame}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <AppNavigation pathname={pathname} />
      <div className={styles.workspace}>
        <WorkspaceHeader pathname={pathname} />
        <main id="main-content">{children}</main>
      </div>
    </div>
  ) : (
    <div className={styles.marketingFrame}>
      <MarketingHeader />
      <main id="main-content">{children}</main>
    </div>
  );
}
```

Navigation items are exactly `Overview` (`/cases`), `Cases` (`/cases` with the current subsection label), `Create case` (`/cases/new`), and `Contract status` (lower utility anchor to the contract identity). Render text labels on desktop, icon-plus-tooltip labels on the tablet rail, and a three-item mobile bottom nav. Implement icons as small inline SVG components with `aria-hidden="true"`; do not use emoji.

- [ ] **Step 4: Bind real Bradbury configuration**

Read network and contract address from `useWallet().config`, render `Bradbury Testnet · Simulated GEN`, shorten the visible address, and retain the full address in accessible copy/explorer controls. Do not hardcode Studionet or an alternate address.

- [ ] **Step 5: Run focused tests and production build**

Run: `npm --prefix frontend run test -- tests/components/navigation.test.tsx tests/components/core.test.tsx`

Expected: PASS.

Run with the existing public build variables:

```powershell
$env:NEXT_PUBLIC_GENLAYER_NETWORK='testnet_bradbury'
$env:NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS='0x814726d7a3a2CbC52C8ea622b49aF1d6FDa300A7'
npm --prefix frontend run build
```

Expected: PASS; `/`, `/cases`, `/cases/new`, case detail, and `/.well-known/accessseal/config.json` build successfully.

- [ ] **Step 6: Commit the shell**

```bash
git add frontend/src/app/layout.tsx frontend/src/components/app-shell.tsx frontend/src/components/wallet-button.tsx frontend/src/components/navigation frontend/tests/components/navigation.test.tsx frontend/tests/components/core.test.tsx
git commit -m "feat: add Bradbury operational application shell"
```

---

### Task 3: Stripe-Operational Landing Page

**Files:**
- Create: `frontend/src/components/marketing/landing-page.tsx`
- Create: `frontend/src/components/marketing/marketing.module.css`
- Create: `frontend/tests/components/landing.test.tsx`
- Modify: `frontend/src/app/page.tsx`

**Interfaces:**
- Consumes: `Button`, `Badge`, `Panel`, and `Timeline` from Task 1.
- Produces: static `LandingPage`; it performs no wallet or contract writes.

- [ ] **Step 1: Write landing RED tests**

```tsx
it("explains the actual lock-verify-settle workflow without crypto spectacle", () => {
  render(<LandingPage />);
  expect(screen.getByRole("heading", { level: 1, name: /accessibility acceptance/i })).toBeVisible();
  expect(screen.getByRole("link", { name: /create case/i })).toHaveAttribute("href", "/cases/new");
  expect(screen.getByRole("region", { name: "AccessSeal workflow preview" })).toBeVisible();
  expect(screen.getByText("Evidence fetched by validators")).toBeVisible();
  expect(screen.getByText("Finalized readback")).toBeVisible();
  expect(screen.queryByText(/orbit/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix frontend run test -- tests/components/landing.test.tsx`

Expected: FAIL because `LandingPage` is missing and the old orbit remains.

- [ ] **Step 3: Implement the landing hierarchy**

Create these semantic sections in order:

1. Hero with H1, concise paragraph, `Create case` and `View cases` actions.
2. Realistic right-hand workflow preview showing simulated escrow, evidence bundle, validator decision, and four transaction phases.
3. Trust strip: immutable terms, independent validator fetch, finalized settlement dispatch.
4. Three-step `Lock`, `Verify`, `Settle` explanation.
5. Two-column comparison of mutable manual acceptance versus AccessSeal authoritative acceptance.
6. Final CTA.

Use a restrained hero gradient only behind the editorial area. The preview must reuse `Panel`, `Badge`, and `Timeline`; it must not look like a separate fake product.

- [ ] **Step 4: Implement responsive landing CSS**

Desktop uses a `minmax(0, 1.05fr) minmax(420px, .95fr)` hero grid. At `max-width: 900px`, stack preview below copy. At `max-width: 640px`, buttons become full width, comparison columns stack, and no element causes horizontal overflow.

- [ ] **Step 5: Run focused test and lint**

Run: `npm --prefix frontend run test -- tests/components/landing.test.tsx && npm --prefix frontend run lint`

Expected: PASS with one H1, ordered section headings, real links, and no old orbit markup.

- [ ] **Step 6: Commit landing page**

```bash
git add frontend/src/app/page.tsx frontend/src/components/marketing frontend/tests/components/landing.test.tsx
git commit -m "feat: redesign AccessSeal landing experience"
```

---

### Task 4: Authoritative Cases Dashboard

**Files:**
- Create: `frontend/src/components/cases/case-dashboard-model.ts`
- Create: `frontend/src/components/cases/cases-dashboard.tsx`
- Create: `frontend/src/components/cases/cases.module.css`
- Create: `frontend/tests/components/dashboard.test.tsx`
- Modify: `frontend/src/app/cases/page.tsx`

**Interfaces:**
- Consumes: `useWallet().readContract`, `CaseRecord`, `ReviewRecord`, local key `accessseal.case-ids.v1`, and Task 1 primitives.
- Produces: `DashboardCase`, `deriveDashboardMetrics(rows)`, `filterDashboardCases(rows, filters)`, and `CasesDashboard`.

- [ ] **Step 1: Define pure model RED tests**

```ts
const rows: DashboardCase[] = [
  { caseId: "sha256:a", case: fundedCase, review: null, readError: null },
  { caseId: "sha256:b", case: evidenceCase, review: null, readError: null },
  { caseId: "sha256:c", case: decidedCase, review: approvedReview, readError: null },
];

expect(deriveDashboardMetrics(rows)).toEqual({
  total: 3,
  awaitingEvidence: 1,
  underReview: 1,
  readyToSettle: 1,
});
expect(filterDashboardCases(rows, { lifecycle: "DECIDED", verdict: "APPROVED" }))
  .toHaveLength(1);
```

Define `awaitingEvidence` as `FUNDED` or an evidence-open cure epoch without an evidence record, `underReview` as `REVIEW_PENDING`, and `readyToSettle` as finalized `APPROVED`/`REJECTED` with no dispatched settlement. A read error contributes to `total` because the ID is locally known, but never to a semantic metric.

- [ ] **Step 2: Write component RED tests**

Mock `readContract.readCase`, `readReview`, `readFinality`, and `readSettlement`. Assert a populated dashboard has four metrics, semantic desktop headers, accessible mobile labels, lifecycle/verdict filters, an import action, and a visible per-row readback error. Assert the empty state states that the contract cannot enumerate cases.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm --prefix frontend run test -- tests/components/dashboard.test.tsx`

Expected: FAIL because the dashboard model/component do not exist.

- [ ] **Step 4: Implement lossless readback loading**

```tsx
type DashboardCase = {
  caseId: string;
  case: CaseRecord | null;
  review: ReviewRecord | null;
  finality: ReviewFinality | null;
  settlement: Settlement | null;
  readError: string | null;
};

async function loadKnownCase(reader: AccessSealClient, caseId: string): Promise<DashboardCase> {
  try {
    const reconciled = await reconcileCase(reader, caseId);
    return { caseId, ...reconciled, readError: null };
  } catch (cause) {
    return {
      caseId,
      case: null,
      review: null,
      finality: null,
      settlement: null,
      readError: cause instanceof Error ? cause.message : "Finalized readback failed.",
    };
  }
}
```

Load IDs from the existing cache and refresh with `Promise.all(ids.map(loadKnownCase))`. Keep `bigint` as `bigint` through render and formatting. Never aggregate an error row into an inferred state.

- [ ] **Step 5: Render metrics, filters, table, mobile rows, and empty/error states**

Desktop columns: case ID, buyer/vendor, simulated amount, lifecycle, verdict, authoritative state, action. Mobile rows expose the same values using visible labels. Add lifecycle and verdict `<select>` controls with explicit labels. Keep import deduplicated and persist only validated `sha256:<64 lowercase hex>` IDs; invalid input gets an inline alert.

Label the four metric cards exactly `Total cases`, `Awaiting evidence`, `Under review`, and `Ready to settle`, followed by the disclosure `Based on locally known case IDs`.

- [ ] **Step 6: Run dashboard and existing reconciliation tests**

Run: `npm --prefix frontend run test -- tests/components/dashboard.test.tsx tests/lib/transactions.test.ts tests/lib/case-cache.test.ts`

Expected: PASS; no swallowed readback errors and no loss of `bigint` precision.

- [ ] **Step 7: Commit dashboard**

```bash
git add frontend/src/app/cases/page.tsx frontend/src/components/cases frontend/tests/components/dashboard.test.tsx
git commit -m "feat: add authoritative cases dashboard"
```

---

### Task 5: Three-Step Create-Case Workflow

**Files:**
- Create: `frontend/src/components/cases/case-composer.module.css`
- Create: `frontend/tests/components/composer-steps.test.tsx`
- Modify: `frontend/src/components/case-composer.tsx`
- Modify: `frontend/src/app/cases/new/page.tsx`
- Modify: `frontend/tests/components/core.test.tsx`

**Interfaces:**
- Consumes: existing `CaseAuthority`, `CaseDraft`, `deriveCaseBindings`, `restrictedOrigin`, and `onCreate(draft)`.
- Produces: the same exported `CaseAuthority`, `CaseDraft`, and `CaseComposer` signatures; only presentation/state progression changes.

- [ ] **Step 1: Write step-flow RED tests**

```tsx
it("moves Parties → Terms → Review and only signs a live authority-bound preview", async () => {
  const user = userEvent.setup();
  render(<CaseComposer authority={authority} onCreate={onCreate} />);
  expect(screen.getByText("Parties")).toHaveAttribute("aria-current", "step");
  await fillParties(user);
  await user.click(screen.getByRole("button", { name: "Continue to terms" }));
  await fillTerms(user);
  await user.click(screen.getByRole("button", { name: "Review locked terms" }));
  expect(screen.getByText("Review and sign")).toHaveAttribute("aria-current", "step");
  expect(screen.getByText(authority.contractAddress)).toBeVisible();
  expect(screen.getByText("Bradbury Testnet")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create case on GenLayer" }));
  expect(onCreate).toHaveBeenCalledTimes(1);
});
```

Retain the existing mutation test: changing form, wallet, chain, network, or contract removes the signable preview and requires regeneration.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm --prefix frontend run test -- tests/components/composer-steps.test.tsx tests/components/core.test.tsx`

Expected: FAIL because the composer has no three-step navigation.

- [ ] **Step 3: Add presentation-only step state**

Use `type ComposerStep = "parties" | "terms" | "review"`. Store parties/terms field values in controlled state so Back preserves data. Execute the current validation and `deriveCaseBindings()` only on `Review locked terms`. Do not change `CaseDraft` fields, salt generation, u256 checks, zero/same-vendor checks, origin grammar, or authority matching.

```tsx
const STEPS = [
  { id: "parties", label: "Parties" },
  { id: "terms", label: "Acceptance terms" },
  { id: "review", label: "Review and sign" },
] as const;
```

Render the current step in a `<section aria-labelledby="composer-step-title">`; use real Back/Continue buttons. A compact live summary appears beside steps on desktop and inside review on mobile.

- [ ] **Step 4: Add advanced contract disclosure**

Use `<details><summary>Advanced contract details</summary>…</details>` to show case ID, terms hash, flows hash, profile hash, network, chain ID, and full contract address before signing. Buyer, vendor, amount, network, and contract remain visible outside the disclosure.

- [ ] **Step 5: Run composer/domain tests**

Run: `npm --prefix frontend run test -- tests/components/composer-steps.test.tsx tests/components/core.test.tsx tests/lib/access-seal.test.ts`

Expected: PASS, including invalid authority, invalid origin, zero/same vendor, >u256 amount, and mutation invalidation.

- [ ] **Step 6: Commit composer**

```bash
git add frontend/src/app/cases/new/page.tsx frontend/src/components/case-composer.tsx frontend/src/components/cases/case-composer.module.css frontend/tests/components/composer-steps.test.tsx frontend/tests/components/core.test.tsx
git commit -m "feat: add guided case creation workflow"
```

---

### Task 6: Invoice-Style Case Detail and Stable Workflow Sections

**Files:**
- Create: `frontend/src/components/cases/case-detail.module.css`
- Create: `frontend/tests/components/case-detail-layout.test.tsx`
- Modify: `frontend/src/components/case-detail.tsx`
- Modify: `frontend/src/components/status-panel.tsx`
- Modify: `frontend/src/components/evidence-inspector.tsx`
- Modify: `frontend/src/components/review-tracker.tsx`
- Modify: `frontend/src/components/settlement-panel.tsx`
- Modify: `frontend/tests/components/workflow.test.tsx`

**Interfaces:**
- Consumes: unchanged `reconcileCase()`, evidence validation, appeal provenance, recovery eligibility, settlement guards, and `run()` transaction wrapper.
- Produces: four visible anchors `#terms`, `#evidence`, `#decision`, `#settlement` and a single invoice summary with the highest-priority currently valid action.

- [ ] **Step 1: Write layout RED tests around mocked authoritative readbacks**

```tsx
it("renders invoice summary and four visible workflow sections", async () => {
  render(<CaseDetail caseId={CASE_ID} />);
  expect(await screen.findByRole("heading", { name: /case summary/i })).toBeVisible();
  expect(screen.getByRole("navigation", { name: "Case sections" })).toBeVisible();
  for (const name of ["Terms", "Evidence", "AI decision", "Settlement"]) {
    expect(screen.getByRole("link", { name })).toBeVisible();
    expect(screen.getByRole("region", { name })).toBeVisible();
  }
  expect(screen.getByText("Submitted")).toBeVisible();
  expect(screen.getByText("Readback confirmed")).toBeVisible();
});
```

Add a case for `ACCEPTED` where success styling is absent, and a finalized case where `Readback confirmed` is current. Preserve existing permission and recovery assertions from `workflow.test.tsx`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm --prefix frontend run test -- tests/components/case-detail-layout.test.tsx tests/components/workflow.test.tsx`

Expected: FAIL because the current page has cards but no stable section document or four-phase transaction presentation.

- [ ] **Step 3: Build the summary and priority-action selector**

Create a pure local selector inside `case-detail.tsx` that chooses one action in this order: safe required actor action (accept/fund/submit evidence), request review, cure/retry/expire/timeout, prepare settlement, execute settlement, otherwise no primary action. The selector may only use booleans already computed from authoritative `data`, `isBuyer`, `isVendor`, `finalized`, and existing deadline checks; it must not recreate protocol rules.

Render case ID, lifecycle badge, amount, buyer, vendor, verdict, and that action in the summary. Shorten hashes visually but keep a full `<code>` value and existing explorer/copy controls where available.

- [ ] **Step 4: Reorganize—not rewrite—the four sections**

- `Terms`: immutable agreement and accounting readback.
- `Evidence`: vendor evidence form or read-only inspector, with exact canonical validation.
- `AI decision`: request review, finalized review, verdict, appeal, cure/retry/expiry/timeout.
- `Settlement`: prepare, execute, conservation, and `DISPATCHED_FINALIZED` versus recipient confirmation.

Every section remains in the DOM; unavailable content gets an explicit inline state rather than an inactive tab. Use sticky anchor navigation below the lifecycle timeline.

- [ ] **Step 5: Normalize transaction status**

Map existing phases without changing the tracker:

```ts
const transactionProgress = ["SUBMITTED", "ACCEPTED", "FINALIZED", "READBACK_CONFIRMED"] as const;

function visibleTransactionStep(phase: TransactionPhase) {
  if (phase === "PENDING") return "SUBMITTED";
  if (phase === "ACCEPTED") return "ACCEPTED";
  if (phase === "RECONCILING") return "FINALIZED";
  if (phase === "FINALIZED_SUCCESS") return "READBACK_CONFIRMED";
  return "SUBMITTED";
}
```

Error phases remain explicit danger notices with the transaction hash; they do not receive a completed timeline.

- [ ] **Step 6: Run workflow and transaction tests**

Run: `npm --prefix frontend run test -- tests/components/case-detail-layout.test.tsx tests/components/workflow.test.tsx tests/lib/transactions.test.ts`

Expected: PASS for ACCEPTED warning, finalized readback, RMI cure, unresolved retry/expiry, timeout refund, payout/refund dispatch, and pending recipient confirmation.

- [ ] **Step 7: Commit case detail**

```bash
git add frontend/src/components/case-detail.tsx frontend/src/components/cases/case-detail.module.css frontend/src/components/status-panel.tsx frontend/src/components/evidence-inspector.tsx frontend/src/components/review-tracker.tsx frontend/src/components/settlement-panel.tsx frontend/tests/components/case-detail-layout.test.tsx frontend/tests/components/workflow.test.tsx
git commit -m "feat: reorganize case operations around authoritative state"
```

---

### Task 7: Responsive, Toast, Error, and Accessibility Completion

**Files:**
- Create: `frontend/src/components/transaction-toast.tsx`
- Modify: `frontend/src/components/navigation/navigation.module.css`
- Modify: `frontend/src/components/marketing/marketing.module.css`
- Modify: `frontend/src/components/cases/cases.module.css`
- Modify: `frontend/src/components/cases/case-composer.module.css`
- Modify: `frontend/src/components/cases/case-detail.module.css`
- Modify: `frontend/src/components/status-panel.tsx`
- Modify: `frontend/e2e/happy-path.spec.ts`
- Modify: `frontend/e2e/recovery.spec.ts`
- Modify: `frontend/e2e/responsive-accessibility.spec.ts`

**Interfaces:**
- Consumes: all presentation components from Tasks 1–6 and the existing owned GLSim/Bradbury browser fixture.
- Produces: complete desktop/tablet/mobile behavior and browser-level acceptance evidence.

- [ ] **Step 1: Add browser assertions before presentation fixes**

Extend the existing production-browser specs with these exact checks:

```ts
await expect(page.getByText("Bradbury Testnet · Simulated GEN")).toBeVisible();
await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
await expect(page.getByRole("navigation", { name: "Case sections" })).toBeVisible();
await expect(page.getByText("Readback confirmed")).toHaveAttribute("aria-current", "step");
expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
```

On mobile, assert bottom navigation, structured case labels, visible current action, wrapped address/origin, and no desktop data table. On desktop, assert sidebar and semantic table headers. Add screenshots only as test artifacts on failure; do not commit generated images.

- [ ] **Step 2: Run the responsive spec and verify RED**

Run: `npm --prefix frontend run test:e2e -- e2e/responsive-accessibility.spec.ts`

Expected: FAIL on at least the new shell, table/list, case-section, or light-theme assertion before final CSS wiring.

- [ ] **Step 3: Add ephemeral toast without replacing durable state**

```tsx
export function TransactionToast({ message, onDismiss }: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span>{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss notification">×</button>
    </div>
  );
}
```

Use it only for ephemeral confirmations such as copying a hash or successfully importing an ID. Contract lifecycle, errors, transaction phase, settlement dispatch, and recipient confirmation remain inline and durable.

- [ ] **Step 4: Finish responsive breakpoints**

- `>= 1100px`: full 240px sidebar and desktop dashboard table.
- `768px–1099px`: 72px icon rail, compact header, desktop table where it fits.
- `< 768px`: small top header, fixed bottom navigation with safe-area padding, list rows instead of dashboard table, stacked composer/detail, no sticky sidebar.
- `< 480px`: full-width primary buttons, wrapped code/origin fields, and `min-width: 0` on every grid child.

Use `@media (prefers-reduced-motion: reduce)` from Task 1; add no auto-playing animation.

- [ ] **Step 5: Verify keyboard, heading order, and axe**

In Playwright, navigate with `Tab`/`Shift+Tab`, create a case through the three steps, verify focus stays on the active/re-rendered control, and verify skip-link focus enters main content. Collect headings and assert one H1 and no skipped heading level. Run axe on landing, empty dashboard, populated dashboard, create review, case error, pending transaction, and finalized detail at desktop and mobile sizes; assert zero serious/critical violations.

- [ ] **Step 6: Run focused browser coverage twice only if the first run exposes a race**

Run once: `npm --prefix frontend run test:e2e -- e2e/responsive-accessibility.spec.ts`

Expected: PASS. If it fails from deterministic product behavior, fix and rerun the focused file. Do not run the full suite in this task; Task 8 owns the single consolidated full gate.

- [ ] **Step 7: Commit responsive/accessibility completion**

```bash
git add frontend/src/components/transaction-toast.tsx frontend/src/components/navigation/navigation.module.css frontend/src/components/marketing/marketing.module.css frontend/src/components/cases frontend/src/components/status-panel.tsx frontend/e2e/happy-path.spec.ts frontend/e2e/recovery.spec.ts frontend/e2e/responsive-accessibility.spec.ts
git commit -m "test: complete responsive operational experience"
```

---

### Task 8: Consolidated Verification and Local Release Readiness

**Files:**
- Modify only if a gate identifies a concrete regression in files changed by Tasks 1–7.

**Interfaces:**
- Consumes: completed UI redesign and the existing project verification scripts.
- Produces: one clean local commit with verified UI, unchanged contract behavior, and no external publication side effects.

- [ ] **Step 1: Confirm scope and clean diff**

Run:

```bash
git status --short
git diff --check
git diff --name-only HEAD~7..HEAD
```

Expected: only frontend presentation/tests and the approved design/plan documents appear; no `contracts/**`, deployment manifest, secret, generated browser artifact, or `.env` change.

- [ ] **Step 2: Run the single consolidated static/unit gate**

Run:

```powershell
npm run lint
npm run typecheck
npm run test
npm --prefix frontend audit --omit=dev
```

Expected: lint/typecheck exit 0; root script and frontend unit totals are all passing; production audit reports 0 vulnerabilities.

- [ ] **Step 3: Run contract regression suites once**

Run:

```powershell
npm run test:direct
npm run test:integration
```

Expected: direct suite passes; integration passes with only the existing explicitly documented GLSim external-recipient-delivery skip. Any new contract or integration failure blocks completion.

- [ ] **Step 4: Run the production build with exact public configuration**

```powershell
$env:NEXT_PUBLIC_GENLAYER_NETWORK='testnet_bradbury'
$env:NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS='0x814726d7a3a2CbC52C8ea622b49aF1d6FDa300A7'
npm run build
```

Expected: PASS; the public config marker serializes `testnet_bradbury` and the exact deployed address.

- [ ] **Step 5: Run the full browser suite once**

Run:

```powershell
$env:NEXT_PUBLIC_GENLAYER_NETWORK='testnet_bradbury'
$env:NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS='0x814726d7a3a2CbC52C8ea622b49aF1d6FDa300A7'
npm --prefix frontend run test:e2e
```

Expected: all landing/dashboard/create/detail/happy/recovery/error/pending/finalized/responsive/accessibility cases pass; no unexplained skip or signer-binding race.

- [ ] **Step 6: Run publication hygiene checks**

Run:

```powershell
git diff --check
git status --short
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' '(VERCEL_TOKEN\s*=|PRIVATE_KEY\s*=|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' .
```

Expected: diff/status clean after any final commit; scan finds no credential value or private key. Documentation may name an environment variable without containing its value.

- [ ] **Step 7: Commit only concrete gate fixes, then report local readiness**

If a gate required a scoped fix:

```bash
git add frontend/src frontend/tests frontend/e2e
git commit -m "fix: close Stripe operational verification"
```

Report the exact commit, test totals, build result, browser result, and unchanged contract address. Do not push GitHub or redeploy Vercel in this task. Ask for a separate confirmation naming the GitHub repository and Vercel project before those external actions.

# AccessSeal Stripe Operational Redesign

## Objective

Redesign the complete AccessSeal frontend as a light, premium operational product inspired by Stripe's clarity and information hierarchy. The redesign must make the product feel production-ready while preserving every Intelligent Contract, wallet, evidence, finality, recovery, and settlement behavior already implemented.

This is a frontend presentation and interaction redesign. It does not change the deployed contract, contract address, transaction semantics, evidence schema, custody rules, or authoritative readback behavior.

## Design principles

1. **Operational clarity over crypto spectacle.** Use restrained surfaces, precise typography, and visible workflow state instead of neon effects or decorative Web3 motifs.
2. **Contract state remains authoritative.** The interface never advances ahead of finalized contract readback.
3. **Progressive disclosure.** Show the decision and next valid action first; move hashes, replay domains, and low-level bindings into accessible detail sections.
4. **One visual language.** Buttons, panels, tables, badges, transaction states, alerts, and empty states use shared tokens and components.
5. **Dense when useful, spacious when persuasive.** The landing page is editorial and open; operational screens are compact and scannable.

## Visual system

### Color

- App background: `#f6f9fc`.
- Primary surface: white.
- Subtle border: `#e6ebf1`.
- Primary action: indigo `#635bff`, with a darker hover state.
- Primary text: deep navy-charcoal.
- Secondary text: cool gray.
- Success, warning, danger, and information colors are reserved for semantic status.
- Gradients appear only in the landing hero and selected promotional accents.

Every semantic state includes text or an icon in addition to color. Contrast must meet WCAG AA.

### Typography and shape

- Strong, tightly tracked display headings.
- Compact, highly readable operational body text.
- Moderate corner radius and very light shadows.
- Line icons replace emoji and decorative glyphs.
- Focus rings use a clearly visible indigo outline.

### Responsive behavior

- Desktop: persistent sidebar and data tables.
- Tablet: compact icon rail where space requires it.
- Mobile: small header plus bottom navigation; tables become structured list rows.
- Mobile primary actions may be sticky when they remain valid for the current authoritative state.
- Addresses and hashes may be visually shortened but always retain copy and explorer actions.

## Application shell

The public landing page retains a horizontal marketing header. Authenticated-style application routes under `/cases` use a Stripe-like operational shell.

The desktop sidebar contains:

- AccessSeal identity and workspace context.
- Overview.
- Cases.
- Create case.
- Contract status.
- Bradbury network identity and deployed contract address in the lower utility area.

The application header contains the current breadcrumb, contextual search or case import control, and wallet state. The current full-width simulation warning becomes a compact badge reading `Bradbury Testnet · Simulated GEN`.

On mobile, the sidebar becomes bottom navigation or a compact drawer. All existing keyboard access and skip navigation remain available.

## Landing page

The landing page uses a two-column hero:

- Left: value proposition, supporting explanation, and primary/secondary actions.
- Right: a realistic AccessSeal workflow preview showing escrow, evidence, validator decision, lifecycle, and finality.

The abstract orbit graphic is removed. The next sections contain:

- A short trust strip.
- A three-step explanation of lock, verify, and settle.
- A comparison between traditional acceptance and AccessSeal.
- A final CTA tied to creating or viewing a case.

The hero can use a restrained purple-to-warm gradient, but the interface mockup itself must use the same real component language as the dashboard.

## Cases dashboard

The dashboard begins with four compact metrics:

- Total cases.
- Awaiting evidence.
- Under review.
- Ready to settle.

Cases are displayed in a table on desktop with columns for case ID, counterparties, amount, lifecycle, verdict, current authoritative state, and contextual action. Filters cover lifecycle and verdict. Case-ID import remains available because the frozen contract does not enumerate all cases.

On mobile, table rows become compact structured list items. The empty state explains why case IDs must be created or imported and offers the appropriate action.

Metrics must be derived only from locally known/imported case IDs and their contract readbacks. They must not imply global contract enumeration.

## Create-case workflow

The composer becomes a three-step workflow:

1. Parties.
2. Acceptance terms.
3. Review and sign.

Desktop shows a live summary alongside the form. Mobile presents the same summary as the final review step. Before signing, the UI displays buyer, vendor, amount, network, contract, and deterministic bindings.

Technical hashes and flow bindings live under `Advanced contract details`, but remain accessible before signing. Existing preview invalidation rules remain unchanged: any form, account, network, or contract mutation invalidates the signable preview.

## Case detail

The page opens with an invoice-style summary containing:

- Case ID and lifecycle badge.
- Simulated escrow amount.
- Buyer and vendor.
- Current verdict where available.
- The single highest-priority valid action.

A lifecycle timeline sits directly below the summary. The content is organized into four stable sections:

1. Terms.
2. Evidence.
3. AI decision.
4. Settlement.

The four sections remain visible in one document and are linked by sticky anchor navigation; authoritative warnings and required actions are never hidden behind inactive tabs. Transaction progress is represented as:

`Submitted → Accepted → Finalized → Readback confirmed`

Success styling is applied only after the last required authoritative state. Recovery, cure, retry, expiry, and refund actions appear under contextual secondary actions, with urgent conditions surfaced prominently.

## Shared components

The redesign introduces or normalizes these presentation boundaries:

- `Button`.
- `Badge`.
- `Panel`.
- `DataTable` and responsive list row.
- `Metric`.
- `Timeline`.
- `TransactionStatus`.
- `EmptyState`.
- `Toast` for ephemeral confirmations and inline notification for durable contract state.
- Form field, help text, and error presentation.

Existing domain components keep their contract-facing behavior. Presentation refactoring must not duplicate reconciliation, authorization, evidence validation, or settlement rules.

## State and error behavior

- Loading uses skeletons shaped like the content being loaded.
- Pending transactions use indigo or amber and explicitly state the current transaction phase.
- Errors use a concise title, actionable explanation, and retry only where retry is safe.
- `APPROVED`, `REJECTED`, `REQUEST_MORE_INFO`, and `UNRESOLVED` each receive distinct labels, explanations, and next-action guidance.
- Read failures remain visible and are never swallowed into empty or successful states.
- Wallet rejection, wrong network, stale provenance, and missing readback retain their existing fail-closed behavior.

## Accessibility

- WCAG AA color contrast.
- Visible keyboard focus.
- Correct heading order.
- Form errors connected with `aria-describedby`.
- No status communicated by color alone.
- Reduced-motion support remains enabled.
- Tables preserve meaningful headers; mobile list equivalents retain accessible labels.
- Timeline and navigation remain fully keyboard operable.

## Testing and acceptance

Existing wallet, evidence parity, transaction reconciliation, recovery, and settlement tests remain mandatory. The redesign adds regression coverage for:

- The Bradbury testnet label and contract identity.
- Shared component variants and semantic states.
- Desktop table to mobile list behavior.
- Sidebar, icon rail, and mobile navigation accessibility.
- Create-case step transitions and preview invalidation.
- Transaction status presentation through finalized readback.
- Keyboard workflow, heading order, overflow, reduced motion, and axe serious/critical findings.

Browser verification must cover landing, empty dashboard, populated dashboard, create-case workflow, case detail, error state, pending transaction, and finalized state on desktop and mobile sizes.

## Non-goals

- No Intelligent Contract changes.
- No new contract deployment.
- No contract address change.
- No custody or settlement semantic change.
- No backend or case-indexing service.
- No optimistic state that outruns contract readback.
- No copying Stripe assets, illustrations, source code, or proprietary layouts.

## Delivery boundary

Implementation is complete only when lint, typecheck, frontend unit tests, root script tests, production build, and browser coverage pass; the deployed frontend displays the Bradbury network and current contract correctly; and the user separately confirms the exact GitHub and Vercel identities before any external push or redeployment.

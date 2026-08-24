# Hire modular packaging review — validated product direction

Date: 2026-08-23
Validated against: `959f95b4234f98b472384d0dc9c7f042e18902c2`

## Decision

The August 2026 canvas is a useful historical critique of the retired Hire v1
surface, not an implementation specification for the current product. Its
literal evidence references the deleted `app/(hire)/hire` application and the
old `modules/b2b` organization model. The current `/workspace` Hire v2 already
implements the job-centric product that much of the canvas proposed.

We will preserve the current v2 product thesis:

- the decision is backed by separately labelled evidence;
- jobs/requisitions are the operating root;
- HR members use the authenticated workspace;
- occasional hiring managers, interviewers, and stakeholders use expiring,
  candidate-scoped guest capabilities;
- AI can present evidence and recommendations but never move a candidate;
- legal/privacy access is part of Workspace Core and is never paywalled.

We will not recreate the old Invite/Templates/Dashboard navigation, introduce
persona accounts only to mirror the canvas, or market unfinished screens as
standalone modules.

## Finding-by-finding validation

| Canvas area | Current verdict | Current evidence | Product action |
| --- | --- | --- | --- |
| Commercial packaging | Confirmed gap | `HireWorkspace` has no Hire plan, capability, credit, renewal, or billing state. The B2C plan exposed by `composeHireApiRoute` is not a Hire commercial contract. | Add a separate Hire commercial boundary in compatibility-first shadow mode. Define Core, Screen, Decide, and Operate capabilities; do not enforce until existing workspaces are proven compatible. |
| Information architecture | Old claim invalid; residual gap confirmed | Global navigation is Overview, Audit, Reports, Jobs, Departments, Candidates, and Team. Invite/Templates/Usage no longer exist. Job Pipeline, Decision, and Performance are separate URLs without persistent contextual navigation. | Group global navigation by Work, Insights, and Company. Add a reusable per-job Pipeline/Decisions/Performance sub-navigation. |
| Screen | Old defects largely resolved | Job-scoped invitations, durable 50-file intake, deterministic screening gates, explicit confirmation, staggered delivery, retry, and honest email states exist. | Preserve the flow. Fix the unsafe opaque-ID review rows and expose recipient-level delivery state at authenticated read time. Treat CSV contact import as a separately specified workflow. |
| Decide | Old claim largely invalid; trust gap confirmed | Candidate identity, human scorecards, external verdicts, comparison, share packets, PDF export, and explicit stage actions exist. | Remove pass/fail colour anchoring and “Pass probability” from the decision header. Lead with human-review readiness and separately labelled AI evidence. Provide a continuation from comparison to the candidate decision surface. |
| Standardize | Literal Templates critique is stale; sellable module gap confirmed | Jobs persist immutable requirement versions and can be duplicated without candidates/history. Human scorecards intentionally use a fixed rubric. There is no organization-owned rubric/template lifecycle. | Reframe Duplicate Job as “Use as a starting point” and expose version provenance. Do not sell Standardize until rubric ownership, preview, versioning, attachment, and historical rendering are designed together. |
| Operate | Mostly resolved | Overview KPIs, action inbox, job health, funnel, ageing, performance, reports, CSV/PDF/XLSX exports, and audit exist. | Make action counts drill into work. Later add owner/openings/SLA only with reliable operational authority. |
| Roles | Canvas target misaligned | The deliberate model is one admin plus identical HR members; interviewers and stakeholders use candidate-scoped guest kits/share packets. | Keep the security boundary. Improve guest workflows and admin information architecture. Do not casually widen membership roles. |
| Employer brand | Partially resolved | Company name/logo appear in the private workspace. Guest surfaces show the workspace name, but the private logo does not cross that boundary and share packets omit employer identity. | Design a capability-scoped, lifecycle-fenced public brand projection for apply/interview/kit/share. Do not reuse the member-only logo route or expose arbitrary theme colours without contrast governance. |
| Connect | Future enterprise gap | Retention/privacy/audit and baseline private branding exist. SSO, ATS, procurement/GSTIN, and connector administration do not. | Keep Connect as a later enterprise rider, not a navigation page or standalone SKU. |
| Scale/density | Confirmed gap | Workspace candidate reads are unbounded and major lists remain card-heavy with limited filtering. | Add safe search/filter first, then cursor pagination with complete-population rank semantics. Keep mobile cards and denser desktop tables. |
| Settings | Confirmed gap | Team currently mixes people, candidate verification, admin transfer, workspace deletion, and personal deletion. | Separate Team from Company settings, Candidate experience, and Data/privacy without changing existing server authority. |
| Accessibility/localization | Targeted residual gaps | Current controls are semantic and status text is not colour-only, but global nav lacks `aria-current`; the mobile drawer lacks complete expanded/focus/Escape semantics; date formatting is inconsistent and scheduling timezone is implicit. | Fix navigation semantics now. Add workspace locale/IANA timezone only as a coherent data-contract tranche; never hardcode IST globally. |

## Commercial capability model

Commercial capabilities represent purchasable value, not pages:

- **Workspace Core:** jobs, candidates, basic status/evidence, team/privacy,
  audit, and baseline employer identity.
- **Screen:** AI screening rounds, screening gates, invitation delivery,
  reminders/retries, and completed assessment evidence.
- **Decide:** human kits/scorecards, comparison, share packets, assessment PDF,
  and the human decision trail.
- **Operate:** advanced funnel, ageing/TAT, job health, breakdowns, and
  management exports.
- **Standardize:** deferred until a real versioned rubric product exists.
- **Connect:** deferred enterprise rider for SSO, ATS, and procurement needs.

Rules:

1. Existing workspaces retain every current capability during migration.
2. Evidence, audit, privacy, and data export remain accessible after a paid
   capability lapses.
3. The current shadow count is a non-billable, read-only aggregate of existing
   authoritative results after a versioned epoch. It creates no second
   candidate-linked ledger and cannot affect result ingestion availability.
4. Any future billable event authority, correction policy, and idempotency
   coordinate require a separate ADR and reconciliation rollout.
5. A missing capability eventually returns a structured entitlement response
   and a Request pilot/upgrade path, never a 404.
6. Shadow evaluation and reconciliation must pass before enforcement.

## Implementation sequence

### Tranche A — decision safety and navigation

- grouped global navigation with active-state and mobile drawer semantics;
- persistent job sub-navigation for Pipeline, Decisions, and Performance;
- screening identity enrichment and recipient delivery visibility;
- AI-neutral candidate decision header;
- stale Team copy and high-risk narrow-row responsive fixes.

### Tranche B — shadow commercial foundation

- isolated Hire commercial account/capability metadata;
- versioned Core/Screen/Decide/Operate catalog;
- compatibility-first, non-enforcing module projection;
- read-only completed-assessment shadow aggregate from authoritative results;
- admin-only Modules & usage view with Request pilot, no checkout;
- explicit account/result-read index preparation before scale validation.

### Tranche C — employer identity and scale

- capability-scoped employer header across guest surfaces;
- search/filter and cursor pagination for jobs/candidates/pipeline;
- action-inbox deep links;
- Company settings separation and explicit scheduling timezone.

### Deferred product decisions

- configurable rubric/Standardize lifecycle;
- persistent hiring-manager membership and seat pricing;
- CSV contact import and vendor/ATS ingestion;
- requisition owner/openings/SLA/band fields;
- SSO/ATS/procurement Connect rider;
- public self-serve checkout and final SKU prices.

These items are deferred because they alter product authority, privacy,
historical rendering, or commercial policy—not because the canvas is being
ignored.

## Verification standard

Every implementation tranche must include:

- GitNexus upstream impact before production symbol edits and
  `detect_changes` before commit;
- tenant-isolation and safe-DTO tests for new Hire reads;
- deterministic aggregate-boundary and index-preflight tests for commercial
  shadow measurement;
- keyboard/focus/200% reflow checks for navigation changes;
- focused tests, full TypeScript, changed-file lint, module budgets, build, and
  diff checks;
- Playwright verification against a deterministic local or deployed test
  surface, including keyboard navigation, responsive layouts, console errors,
  and screenshots; authenticated flows require an explicit test session or
  fixture and must not be claimed otherwise.

# Domain Taxonomy & Setup Redesign — Implementation Plan

**Status:** Phases 0-4 merged. The new picker is the **default** setup selector
(no feature flag).
**Owner:** TBD
**Supersedes:** the domain-selection sections of `REDESIGN-PLAN-v2.md` and the
`CmsTaxonomy` design in `CMS_PLAN.md §4.6` (both March 2026, never fully
implemented). This doc is the single source of truth for the taxonomy work.

> **Progress (2026-06-09)**
> - ✅ **Phase 0** — `Category` collection + `categorySlug` re-cut (PR #436).
> - ✅ **Phase 1** — de-gated `/api/domains` + new `/api/categories` (PR #437).
>   Over a 7-round review cycle, Phase 1 **absorbed Phase 3's domain-form
>   taxonomy work** (dynamic category dropdown, `categorySlug` writes, the shared
>   legacy↔new maps, and fully live-set-validated read resolution). **Net effect:
>   Phase 3 is now reduced to the Category *CRUD* surface only** — see the Phase 1
>   and Phase 3 notes below.
> - ✅ **Phase 2** — `CategoryDomainPicker` two-screen UI (PR #439).
> - ✅ **Phase 3** — CMS Category CRUD + write-time `categorySlug` 400 (PR #440).
> - ✅ **Phase 4** — 17 freshers' roles seeded + category-aware depths (PR #441).
> - ✅ **Flag removed + selector unified** — `CategoryDomainPicker` is the **only**
>   domain selector. There is no `NEXT_PUBLIC_FEATURE_TAXONOMY_V2`; it's a
>   non-breaking drop-in (same props, `config.role` unchanged), so the flag added
>   only complexity. The legacy flat `DomainSelector` (and its `CATEGORY_TABS`) was
>   **deleted** — the authenticated home uses the picker too.
>   The legacy `category` field stays only as a `resolveCategorySlug` fallback for
>   pre-`categorySlug` rows. **Deploy = merge; no env flag.** Optional: `POST
>   /api/db/seed` (platform_admin) so `/api/domains` lists the new roles — until then
>   the picker uses `STATIC_DOMAINS` and the AI uses `FALLBACK_DOMAINS` (both carry them).

---

## 1. Problem

Users — increasingly **college freshers** — can't find their domain in the
interview setup. Today's setup shows a flat-ish grid where, even with a
category tab selected, the buckets are mis-cut: `engineering` actually means
*software* (Frontend/Backend/SDET/Data-Science), so a mechanical-engineering
student who picks "Engineering" sees React and APIs. The default tab is "All",
which dumps every role together. As we expand to ~30–40 roles for the freshman
audience, this collapses.

### Root causes (verified in code)

1. **Categories are mis-cut and conflated** — software is filed under
   "engineering"; PM + Design under "product".
2. **No category storage bucket.** "Category" is a `string` field on each
   domain, constrained by **four hardcoded lists that disagree**:
   - Mongoose enum `['engineering','business','design','operations']`
     ([InterviewDomain.ts:46](../../../shared/db/models/InterviewDomain.ts#L46))
   - seed strings `engineering/product/business/general`
     ([seed.ts](../../../shared/db/seed.ts))
   - `CATEGORY_TABS` (formerly in `DomainSelector.tsx`, now deleted)
   - the CMS form `<option>` list ([domains/new/page.tsx:162](<../../../app/(cms)/cms/domains/new/page.tsx#L162>))
   The enum allows `design`/`operations` (used by no domain) but **not**
   `product`/`general` (used by real domains) → a **latent data bug**: those
   domains would fail Mongoose enum validation if written to Mongo; the app
   only works today because it leans on hardcoded `STATIC`/`FALLBACK` copies.
3. **The domain "bucket" is gated to the hardcoded seed.** The public
   `/api/domains` ([route.ts:9-29](../../../app/api/domains/route.ts#L9))
   filters DB results to `ACTIVE_DOMAIN_SLUGS` (derived from `FALLBACK_DOMAINS`)
   and only trusts the DB if it contains **every** seed slug. **A CMS-created
   role with a new slug is silently dropped** — so adding a role today requires
   editing `seed.ts` + `staticData.ts` and redeploying. The DB is a *cache of
   the seed*, not a source of truth.

## 2. Goals

- **Two-screen** Category → Domain selection so a user never sees roles outside
  their field. (Two *screens inside the existing first wizard step* — the wizard
  stays at 4 steps; see §4.)
- **Data-driven via CMS**: an admin adds a category or role with no code deploy.
- **Scale to ~40 roles** without UI confusion; **freshers-first** but preserve
  professional depth where it exists.
- **Breadth-first content**: new roles launch on generic/universal interview
  content + their own `systemPromptContext`, backfilled by demand.
- **Do not break the live interview, retakes, feedback, or analytics.**

## 3. Locked product/design decisions

| Decision | Choice |
|---|---|
| Top-level categories | `💻 Programming · 📊 Data & AI · ⚙️ Core Engineering · 📈 Business · 🎯 Product · 🎨 Design` |
| "General / Other" | Search-fallback escape, **not** a 7th card |
| Engineering naming | "**Core Engineering**" |
| Step shape | Two **screens** inside the existing first wizard step (stays 4 steps) |
| Step-A layout | **Icon-card grid** (3×2) + a one-line descriptor per card |
| Search | Persistent on Step-A; **bypasses** categories (jumps straight to the role) |
| Known-domain entries | **Skip** the category step; deep-link pre-selected with "← change role" |
| "Can't find your role?" | Free-text capture → General interview now + build-signal for CMS |
| New-role labeling | **No label** (→ makes per-domain `systemPromptContext` the quality floor) |
| Governance | **Data-driven**: a `Category` collection; CMS-managed |
| Content strategy | **Breadth-first**, backfill quality by demand |
| Audience | Both, **freshers-first** |

## 4. Architecture: what changes vs. what is invariant

### Invariant — the interview contract (gitnexus-validated, do NOT touch)

The live pipeline keys **only** off `config.role` (domain slug) and
`config.interviewType` (depth slug). **`category` never enters the interview
config or any AI prompt** — confirmed: a graph query for any `category` symbol
inside `generate-question`/`evaluate-answer` returns **empty**. Therefore the
state machine (`useInterview`), `generate-question`, `evaluate-answer`,
`InterviewSession.config`, and the retake flow are **out of scope** — the
taxonomy work lives entirely *above* the contract in the selection + data
layers.

### Design constraints surfaced by impact analysis

- **`getDomainLabel` is CRITICAL** (16 direct callers across 10 processes /
  12 modules — answer routes, feedback page, drill context, home). It maps
  known slugs → labels and **title-cases unknown slugs**. **Constraint:** keep
  its signature stable; let new domain slugs title-case gracefully (acceptable),
  or have it consult cached domain-label data *without changing its signature*.
  Any change to it requires regression across all 16 callers.
- **String-keyed maps degrade gracefully** but silently: `DOMAIN_COMPETENCIES`
  ([competencyService.ts:15](../../learn/services/competencyService.ts#L15)),
  the 36–60 flow-template files ([flow/templates/index.ts](../flow/templates/index.ts)),
  skill `.md` files, and `REQUIREMENT_TO_SLOT`
  ([jdOverlayBuilder.ts:10](../flow/jdOverlayBuilder.ts#L10)). A new slug with no
  entry falls back to universal content — **this is the breadth-first trade-off,
  accepted by design.** Each phase that adds slugs must `log()`/document the
  generic fallback so it never reads as "fully covered."

### The five things that actually change

1. **New `Category` bucket** (collection) — the genuinely missing storage.
2. **`InterviewDomain.category` enum → `categorySlug` reference** + migration.
3. **De-gate `/api/domains`** (remove `ACTIVE_DOMAIN_SLUGS`/`hasAll`) so the DB
   is the source of truth; add `/api/categories`.
4. **Category-aware depth applicability** (so adding a role doesn't mean editing
   every depth's `applicableDomains`).
5. **Two-screen setup UI** + homepage taxonomy alignment.

---

## 5. Phased plan

Each phase is independently shippable and reversible. Feature flags gate
user-visible changes. Test commands: `npm run test:run` (vitest),
`npm run build`, and the Playwright e2e specs under `e2e/`.

### Phase 0 — Data foundation (no user-visible change) ✅ MERGED (PR #436)

**Goal:** Introduce the `Category` bucket and make `category` consistent across
the codebase, fixing the latent enum mismatch. Behavior identical for users.

**Changes**
- New model `shared/db/models/Category.ts`: `{ slug, label, icon, description,
  order, isActive, isBuiltIn }` (CmsTaxonomy-style; flat for now, `parentId?`
  reserved for future sub-categories).
- `InterviewDomain`: add `categorySlug: string` (indexed, references
  `Category.slug`); **keep the legacy `category` field temporarily** (dual-write)
  to avoid breaking readers mid-migration; **drop the `enum` constraint** on
  `category` (it's the source of the bug).
- Seed: add `BUILT_IN_CATEGORIES` (the 6 + `general`); re-cut the 8 existing
  domains onto the new categories (software → `programming`; data-science → `data-ai`;
  pm → `product`; design → `design`; business → `business`; general → `general`).
- **Single source of truth**: generate `staticData.ts` + `FALLBACK_DOMAINS` from
  one canonical list (or a build step) so the three copies can't drift again.
- Migration script `scripts/migrations/2026-xx-categories.ts`: backfill
  `categorySlug` on existing `InterviewSession`-referenced domains; upsert
  categories; idempotent.

**Blast radius (gitnexus):** `InterviewDomain` model = LOW (no call-graph
dependents; consumers are field reads). `FALLBACK_DOMAINS` imported by 3 routes
(`api/domains`, `learn/practice-sets`, `generate-question`) — verify each still
compiles against the reconciled shape.

**Tests**
- `Category` model unit tests (slug uniqueness, defaults).
- Seed idempotency test (run twice → no dupes; re-cut categories applied).
- Migration test: fixture DB with old `category` values → asserts `categorySlug`
  backfilled, no domain orphaned, `general` fallback assigned for unknowns.
- Regression: existing domain/depth tests still green; `getDomainLabel`
  snapshot unchanged for the 8 known slugs.

**Acceptance:** `npm run test:run` green; seeding a fresh DB yields 6 categories
+ correctly-categorized domains; no enum-validation errors.

**Backout:** drop `Category` collection + `categorySlug` column; legacy
`category` field still present → instant revert.

---

### Phase 1 — De-gate the read path + categories API ✅ MERGED (PR #437)

**Goal:** Make the DB the source of truth so CMS-added roles reach users; expose
categories to clients.

> **As shipped, Phase 1 grew beyond this plan.** During review (7 Codex rounds,
> each a valid consequence of de-gating exposing the CMS path) it also took on the
> **domain-form taxonomy work originally slated for Phase 3**:
> - both CMS domain forms source the category dropdown from `/api/categories` and
>   write `categorySlug` (+ a legacy-compatible `category` for the current tabs);
> - `CreateDomainSchema` / `UpdateDomainSchema` accept `categorySlug`, persisted
>   on create/update;
> - new client-safe `shared/taxonomy/categoryMaps.ts` holds the legacy↔new
>   translation as one source of truth (shared by the seed and the CMS forms);
> - the read path (`resolveCategorySlug`) validates **every** candidate — stored,
>   built-in-derived, legacy-derived, and the final fallback — against the **live
>   `Category` set** (`/api/domains` passes it in), so no code path can emit a
>   bucket `/api/categories` doesn't return.

**Changes**
- `/api/domains`: **remove** the `ACTIVE_DOMAIN_SLUGS` filter and the `hasAll`
  staleness gate ([route.ts:9-29](../../../app/api/domains/route.ts#L9)). New
  logic: return all `isActive` domains from DB; **fall back to `FALLBACK_DOMAINS`
  only on DB error/empty**. Include `categorySlug` in the projection.
- New `app/api/categories/route.ts`: returns active categories (slug, label,
  icon, order), cached `s-maxage=300, stale-while-revalidate=3600` (mirror the
  domains route).
- Keep a thin `FALLBACK_CATEGORIES` for DB-down resilience.

**Blast radius:** route handlers are framework-invoked (no in-code callers);
the setup domain picker consumes `/api/domains` and must tolerate unknown slugs
(labels come from the API). The **only behavioral change** is that the response
can now contain roles beyond the seed set — intended.

**Tests**
- API route tests (vitest): (a) DB has a non-seed slug → it now appears
  (previously dropped); (b) DB empty/throws → fallback served; (c)
  `/api/categories` returns seeded categories + cache headers.
- Contract test: response shape unchanged except added `categorySlug`.

**Rollout:** safe to ship without a flag (additive). Watch: a stale/empty DB now
serves fallback instead of silently filtering — acceptable and clearer.

**Acceptance:** create a throwaway `test-role` domain in Mongo → it appears in
`/api/domains` (would have been filtered out before).

---

### Phase 2 — Two-screen setup UI (the visible win)

**Goal:** Category-grid → role-list as two screens inside the existing first
wizard step. Hides irrelevant roles; adds search + escape hatch.

**Changes** — shipped as PR #439. **No feature flag**: `CategoryDomainPicker` is the
default setup selector. (As shipped this added a *new* `CategoryDomainPicker` rather
than refactoring `DomainSelector`; the home surface was later moved onto the
picker too and `DomainSelector` + `CATEGORY_TABS` were deleted.) Original plan:
- New `CategoryGrid.tsx` (icon cards 3×2 + one-line descriptor, role counts) and
  refactor `DomainSelector.tsx` into the **role-list screen** (filtered to the
  chosen category; no category tabs; no "All").
- Step-1 sub-state machine in `InterviewSetupFormView`: `category` screen →
  `role` screen, with a "← change field" back affordance. **Wizard step count
  and indices unchanged** (the drill is intra-step), so `canGoNext`/step logic
  is barely touched — confirmed low-blast by impact analysis (`InterviewSetupForm`,
  `DomainSelector`, `DepthSelector` all LOW / 0 dependents).
- **Global search** on the category screen: matches across all roles → jumps to
  the role screen with the match pre-selected (bypasses category).
- **Skip-for-known**: if `role` is resolvable from pathway/retake/last-session
  config, mount directly on the role screen pre-selected with "← change role".
- **"Can't find your role?"** link → free-text modal → POST to a capture
  endpoint (Phase 6) + proceed with `general`.
- Derive category tabs/labels from `/api/categories`, not `CATEGORY_TABS`
  (delete the hardcoded array).

**Blast radius:** purely the setup UI (LOW). Downstream still receives
`config.role = slug` — contract intact.

**Tests**
- Component tests (RTL): category grid renders from API; selecting a category
  filters roles; search jumps across categories; "can't find" path sets
  `general`; skip-for-known pre-selects.
- Update e2e `e2e/setup-wizard.spec.ts` + `e2e/lobby-config.spec.ts` for the
  two-screen flow (these currently assert the single-grid flow — they WILL fail
  until updated; that's the canary).
- (No flag, so no flag-off test. `DomainSelector` was deleted — every surface
  uses `CategoryDomainPicker`.)
- Manual: complete a full interview start from the new flow (per CLAUDE.md
  hot-path discipline, since setup feeds the live pipeline).

**Rollout (as shipped):** no flag — `CategoryDomainPicker` shipped as the default
selector and `DomainSelector` was deleted once all surfaces moved onto it.

**Acceptance:** a "Business" user never sees Frontend; search finds "mechanical"
in <1 keystroke-burst; known users skip the grid.

---

### Phase 3 — CMS **category** management (reduced — domain-form half shipped in Phase 1)

**Goal:** Admin creates/edits **categories** through the CMS; no code change.

> **Scope reduced by Phase 1.** The *domain-form* half of the original Phase 3 —
> the dynamic category `<select>` from `/api/categories` and `categorySlug` on
> `CreateDomainSchema`/`UpdateDomainSchema` — **already shipped in Phase 1**.
> What remains here is the **Category CRUD** surface itself.

**Changes (remaining)**
- New `app/(cms)/cms/categories/` pages (list / new / edit) + `app/api/cms/categories/`
  routes (CRUD, `platform_admin`-gated, mirroring the domains CMS).
- `CreateCategorySchema` / `UpdateCategorySchema` validators.
- **Write-time `categorySlug` validation (NOT yet shipped):** the domain
  create/update path currently checks only slug *shape* and persists. Add a
  server-side check that `categorySlug` references an existing **active**
  `Category` and return a clear **400** on mismatch. Today an unknown/stale slug
  is silently re-bucketed by `/api/domains` at read time, not rejected at write —
  so this acceptance test (valid-vs-invalid `categorySlug` → clear error) still
  belongs to Phase 3.
- Cache invalidation: `revalidate`/bust on category & domain writes so new
  entries surface immediately (today there's no invalidation — 5-min staleness).

**Already shipped in Phase 1 (was Phase 3):**
- ✅ Domain form dynamic category `<select>` sourced from `/api/categories` (new + edit).
- ✅ `categorySlug` accepted (slug-*shape* only) by `CreateDomainSchema` /
  `UpdateDomainSchema` and persisted on create/update.
- ✅ Read-path **resolution**: `/api/domains` validates each `categorySlug` against
  the live `Category` set and emits a valid bucket — honoring admin-created custom
  categories and silently re-bucketing unknown/stale ones. This is *resolution*,
  **not** write-time *rejection* (the clear-400 check above is still pending).

**Blast radius:** CMS routes (`platform_admin` only). Public read path already
de-gated (Phase 1), so CMS writes reach users.

**Tests**
- CMS route tests: create/update/delete category; create domain with a valid vs
  invalid `categorySlug` (latter rejected with a clear error — fixes today's
  silent Mongoose 500).
- Validator unit tests.
- Integration: create category + domain via CMS API → assert it appears in
  `/api/categories` and `/api/domains` after invalidation.

**Acceptance:** an admin adds "Core Engineering → Mechanical" entirely in the CMS
and it shows up in setup without a deploy.

---

### Phase 4 — Category-aware depths + seed freshers' roles

**Goal:** New roles inherit sensible interview types; seed the freshman rosters.

**Changes**
- `InterviewDepth`: add `applicableCategories?: string[]` alongside
  `applicableDomains`. `DepthSelector` + `/api/interview-types` resolve a depth
  as applicable if the domain's `categorySlug` ∈ `applicableCategories` **or**
  the slug ∈ `applicableDomains` (or both empty = all). This lets "all
  Programming roles get coding + system-design" without per-slug edits.
- Seed/author the freshers' roles as **data** (slug + label + `categorySlug` +
  `systemPromptContext` + 3–5 `sampleQuestions`) — Core Engineering (Mechanical,
  Civil, Electrical, Electronics…), Business (Strategy, Finance, Operations,
  Marketing), Data & AI (ML, Analyst), Programming (Full-stack, DevOps, Mobile).
  **`systemPromptContext` is mandatory per role** (the no-label quality floor).
- **No template/competency/skill files required** — they degrade to universal
  content (breadth-first). Track the gap (Phase 6 queue).

**Blast radius:** `DepthSelector` (LOW); `/api/interview-types` filtering logic.
The string-keyed downstream maps remain un-extended → generic interviews for new
roles (intended). `getDomainLabel` title-cases any new slug (no change to it).

**Tests**
- Depth-resolution unit tests: category-level applicability matches; empty =
  all; domain-level still works.
- "New role smoke" test: a seeded Mechanical role generates an on-topic Q1 from
  `systemPromptContext` alone (mock LLM; assert prompt contains the context).
- Coverage log test: assert the system reports which new roles run on generic
  content (no silent "fully covered").

**Acceptance:** Mechanical/Marketing roles are selectable and produce on-topic
(if generic) interviews end-to-end.

---

### Phase 5 — Homepage taxonomy alignment

**Goal:** One taxonomy across surfaces; homepage catalog deep-links into setup.

**Changes**
- `MarketingHomepage.tsx` domain catalog reads `/api/categories` + `/api/domains`
  (same source as setup); category tabs mirror the new set.
- Clicking a role deep-links to `/interview/setup?role=<slug>` → with skip-for-known
  (Phase 2) the user lands on that role pre-selected.

**Tests**
- Homepage component test: tabs render from API; role click navigates with
  `?role=`; setup honors the param (pre-select).
- Regression: existing MarketingHomepage tests (none today → add a minimal one).

**Acceptance:** homepage and setup never disagree on categories; deep-link
pre-selects.

---

### Phase 6 — Content backfill loop (ongoing)

**Goal:** Turn "generic" roles into deep ones, prioritized by real demand.

**Changes**
- `app/api/interview/role-request/route.ts` + a small `RoleRequest` collection
  (or reuse an existing feedback channel): stores "can't find your role"
  free-text + counts; surfaced in a CMS dashboard.
- Backfill authoring per role, prioritized by request volume + analytics:
  `DOMAIN_COMPETENCIES` entry, flow templates, skill `.md` files,
  `REQUIREMENT_TO_SLOT` keywords. Where feasible, migrate these maps toward
  data-driven (CMS `InterviewSkill`/competency records already exist as DB
  fallbacks).
- Add `category` to the `interview_started` analytics payload
  ([events.ts](../../../shared/analytics/events.ts)) so dashboards group by
  category without re-deriving.

**Tests**
- Role-request endpoint test (capture + dedupe/count).
- Per-backfilled-role: template-resolution test (`resolveFlow` returns a
  template), competency-coverage test.

**Acceptance:** demand is visible in CMS; top-requested roles get full content;
analytics group by category.

---

## 6. Cross-cutting concerns

### Blast-radius checklist (every hardcoded "category" site to retire)

- [x] Mongoose enum on `InterviewDomain.category` → dropped (Phase 0 ✅)
- [x] `seed.ts` category strings → re-cut + single-source (Phase 0 ✅)
- [x] `staticData.ts` `STATIC_DOMAINS` categories → `categorySlug` added (Phase 0 ✅)
- [x] `FALLBACK_DOMAINS` + `/api/domains` whitelist → de-gated (Phase 1 ✅)
- [x] `CATEGORY_TABS` in `DomainSelector.tsx` → retired (DomainSelector deleted; all surfaces use CategoryDomainPicker)
- [x] CMS form `<option>` list (new + edit pages) → dynamic select (Phase 1 ✅, was Phase 3)
- [x] `cms.ts` validators → `categorySlug` accepted/persisted (Phase 1 ✅, was Phase 3)

### Unrelated "category" namespaces — DO NOT touch

Graph audit found 4 independent `category` concepts. Only the **domain**
category is in scope. Leave these alone: JD-requirement category
(`SavedJobDescription`/`jdParserService.validateCategory`), coaching-tip category
(`CoachingTipsTabBody`/`categorizeTip`), feedback red-flag category, resume-skill
category, learn/hire content categories.

### Test strategy summary

| Layer | Tooling | Phases |
|---|---|---|
| Model/migration | vitest | 0 |
| API routes | vitest | 1, 3, 6 |
| Components | RTL + vitest | 2, 5 |
| Depth/flow resolution | vitest | 4 |
| End-to-end wizard | Playwright (`e2e/`) | 2, 5 |
| Manual full-interview | DevTools (per CLAUDE.md hot-path) | 2, 4 |

### Migration & backout

- Phase 0 dual-writes `category` + `categorySlug`; legacy field retained until
  all readers move to `categorySlug` (then a cleanup phase drops it).
- Each user-visible phase (2, 5) is flag-gated → instant revert.
- Existing `InterviewSession.config.role` slugs are **unchanged** by this work;
  no session migration needed (the contract is invariant).

### Sequencing / dependencies

```
Phase 0 (data) ──► Phase 1 (de-gate + categories API) ──► Phase 3 (CMS mgmt)
       └──────────► Phase 2 (two-screen UI) ──► Phase 5 (homepage)
Phase 1 + 0 ──────► Phase 4 (category depths + seed roles) ──► Phase 6 (backfill)
```

Phase 0 → 1 are the unblockers. Phase 2 is the shippable UX win and can proceed
in parallel with Phase 3/4. Phase 6 is continuous.

---

## 7. Open items to confirm before coding

- ✅ Roster → shipped (Phase 4, §8.3). ✅ `Category` collection → built.
- ✅ **No feature flag** — `CategoryDomainPicker` is the default (non-breaking drop-in).
- Legacy `category` field → **kept (no UI reads it)**: now only a
  `resolveCategorySlug` fallback for rows that predate `categorySlug` + the
  schema-required value. Fully retiring it is a separate data migration.

---

## 8. Category set & role rosters

### 8.1 Phase 0 — re-cut of the existing 8 domains (`categorySlug`)

The legacy `category` field is left untouched (so the current UI is unaffected);
each domain gains a new `categorySlug` under the 6-category cut:

| Existing slug | legacy `category` | new `categorySlug` |
|---|---|---|
| `frontend` | engineering | **programming** |
| `backend` | engineering | **programming** |
| `sdet` | engineering | **programming** |
| `data-science` | engineering | **data-ai** |
| `pm` | product | **product** |
| `design` | product | **design** |
| `business` | business | **business** |
| `general` | general | **general** |

`core-engineering` is seeded but **empty** until Phase 4; the category grid hides
any category with 0 active domains, so it won't show until it has roles.

### 8.2 Categories (seeded in Phase 0)

| slug | label | icon | descriptor (one-liner under the card) | order |
|---|---|---|---|---|
| `programming` | Programming | 💻 | Software & web engineering roles | 1 |
| `data-ai` | Data & AI | 📊 | Data science, ML, and analytics | 2 |
| `core-engineering` | Core Engineering | ⚙️ | Mechanical, civil, electrical & more | 3 |
| `business` | Business | 📈 | Strategy, finance, ops, marketing | 4 |
| `product` | Product | 🎯 | Product management & analytics | 5 |
| `design` | Design | 🎨 | UX, UI, and product design | 6 |
| `general` | General / Other | 🧭 | Any role — versatile practice | 99 (escape, not a card) |

### 8.3 Phase 4 — proposed starter rosters (new roles, breadth-first)

Each new role ships with **slug + label + categorySlug + a `systemPromptContext`
(mandatory) + 3–5 sample questions**; templates/competencies/skill-files are
backfilled by demand (Phase 6). Start lean per category; let the "request a role"
capture pull the long tail.

- **Programming** (+): `fullstack` (Full-stack), `devops` (DevOps / SRE), `mobile` (Mobile Engineer)
- **Data & AI** (+): `ml-engineer` (ML Engineer), `data-analyst` (Data Analyst)
- **Core Engineering** (new): `mechanical` (Mechanical), `civil` (Civil), `electrical` (Electrical), `electronics` (Electronics & Communication) — extend (Chemical, Aerospace…) on demand
- **Business** (+): `strategy` (Strategy / Consulting), `finance` (Finance), `operations` (Operations), `marketing` (Marketing), `sales` (Sales)
- **Product** (+): `product-analyst` (Product Analyst)
- **Design** (+): `ui-designer` (UI Designer), `product-designer` (Product Designer)

Existing `business` (broad) stays as an umbrella; the new `strategy/finance/…`
roles are the granular options freshers search for. Existing `design` umbrella
likewise coexists with `ui-designer`/`product-designer`.

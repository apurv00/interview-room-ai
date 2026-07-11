# Jobs Ingestion Layer — Specification of Record

**Status:** Design of record, pre-build (v1.1, 2026-07-11).
**Scope:** Source acquisition, normalization, canonical identity, storage, scheduling, quality gating, ops. Product flow is specced separately in [PRODUCT_FLOW.md](./PRODUCT_FLOW.md); standing rulings and open decisions in [DECISIONS.md](./DECISIONS.md).
**Provenance:** Produced by a multi-agent design workflow (exhaustive source sweep with ~110 live endpoint probes on 2026-07-11) plus an adversarial critique pass that re-verified every load-bearing claim. Critique amendments are folded in below and marked **[AMENDED]** where they changed the original synthesis.

Two product-flow dependencies are first-class here:
- **Apply-link fidelity per source** (the product's Apply step is a link-out; link quality is an ingestion concern).
- **Stable canonical job identity across sources** (application tracking references canonical `_id`s forever).

---

## 1. Source matrix

All probe numbers are live from 2026-07-11. Scores: strong / ok / weak / none.

### Backbone

| Source | Notes |
|---|---|
| **JSearch** (OpenWeb Ninja via RapidAPI) | Google-for-Jobs aggregate — carries Naukri + LinkedIn + Indeed + Shine content. Full JD text confirmed. `apply_options[].is_direct` flag. Pricing verified from RapidAPI plan JSON: Basic $0/200 · **Pro $25/10k req (overage $0.003/req)** · Ultra $75/50k · Mega $150/200k. Brushing Pro's cap is a ~$3 event, not an outage. ToS posture: GREY (unofficial Google aggregation, industry-normal). Mitigations: provider-agnostic adapter, SerpAPI as interface-compatible fallback, TheirStack as Naukri-named escape hatch. Never trust `job_id` as permanent (Google-encoded, rotates) — treat as rotating alias. |

### Build-now ($0, official or robots-sanctioned)

| Source | Probe data | Notes |
|---|---|---|
| **Unified ATS-board adapter** — Greenhouse, Lever, **SmartRecruiters**, Ashby (+ Workable/BambooHR later) | ~780 India jobs verified: Bosch (SR) 546, Continental (SR) 107, PhonePe (GH) 48→53, Meesho (Lever) 44, Groww 15, Postman ~15 India | The sweep's big find is SmartRecruiters: `GET api.smartrecruiters.com/v1/companies/{slug}/postings?country=in` returns full JD, `experienceLevel` (fresher filter), `function` (non-SWE domains). Skews toward under-served electrical/manufacturing/PM/business. Official, unauthenticated, direct-apply, clean 404-expiry. One adapter + per-company config rows `{platform, slug, minIndiaPostings}` + weekly liveness re-probe. **Board liveness is a config invariant, never an assumption** — Paytm 404s and CRED has 5 postings (dead logos); probe Zepto/Swiggy/Zomato/Flipkart-class tokens as replacements. |
| **apna** (sitemap → JSON-LD) | **[AMENDED]** ~31.5k active (not 40k); **~43% of JDs are sub-100-char stubs** (measured distribution: 29, 28, 52, 898, 1466, 2897, 9064 chars); `external-job-listings` shard (higher apply fidelity) is only ~900 URLs | Permissive robots that advertise the sitemap; NCS MoU legitimacy (syndicates 1M jobs/yr to the govt portal). Metro + non-metro, fresher/grey-collar → white-collar. **Only ≥400-char JDs enter the matching corpus**; stub rows metadata-only or dropped. Filter `validThrough` at ingest (verified: expired jobs stay served on-site). Sub-cap recomputed from post-stub yield after the probe. |
| **Unstop** (public JSON API) | robots.txt explicitly `Allow: /api/public/*` and allows AI crawlers by name (GPTBot, Claude-Web, anthropic-ai) while blocking Wget/HTTrack | Cleanest programmatic wedge into campus/early-career India. Structured JSON, full JD HTML in `details`, `regn_open` liveness flag, `updated_at`, stable IDs. |

### Fast-follow (each gated on telemetry, not calendar)

| Source | Gate |
|---|---|
| **Freshersworld** **[AMENDED — demoted from build-now]** | 32,231 active jobs (reproduced exactly), best-structured JSON-LD (baseSalary, validThrough), genuinely non-metro. BUT its robots.txt itself 403s non-browser UAs (CDN WAF) — adapter would require UA-spoofing = grey-scraping in practice, and live-sampled consultancy share >20% (2 of first 3 orgs). Enable only behind a WAF-liveness probe + honest ToS restatement. |
| Shine | Verify one detail page's JSON-LD first; enable if non-SWE metro buckets run under gate G1 on JSearch alone. |
| foundit (ex-Monster) | Verified junk in feed — junk filter proven on another corpus first. |
| freejobalert / sarkariresult RSS | Live-verified, official-notification links (highest apply authority) — but notification-shaped, not JD-shaped. Ships as a separate "govt notification" content type (Open Decision I-3). |

### Dormant (activation conditions on file)

| Source | Condition |
|---|---|
| Fantastic.jobs ($95/mo, 54 ATS incl. Workday/SuccessFactors/Oracle) | Buy-not-build path to TCS/Infosys-class MNC postings — activate when dashboard shows demand for enterprise brands JSearch under-serves. Explicitly instead of building grey Workday/SF scrapers. |
| SerpAPI google_jobs ($75/5k–$150/15k) | Contracted, interface-compatible JSearch fallback. **[AMENDED]** Note: "contracted fallback" is currently a stub, not a contract — a JSearch quarantine means days of corpus decay (14d age-out) while a human signs up; pre-create the account. |
| TheirStack ($169/mo, 10k job **credits** — cost cliff) | Escape hatch on JSearch quality/legal failure or probe FAIL verdict. Credit-per-job pricing does not cover our ingest volume — a swap is a cost event, not an ingestion-only change. |
| Internshala | robots-CLOSED (`Disallow: /api/`, AI-bot blocklist). Founder-to-founder partnership only. Outreach email recommended now (months of lead time). |
| NCS / data.gov.in | No outbound API — NCS is a sink that pulls FROM apna/foundit via MoUs. Long-game MoU; content largely redundant with apna. |
| Enterprise-grey tenant JSON (Workday CXS, SuccessFactors, Oracle, iCIMS) | Rejected in favor of Fantastic.jobs. Site-ToS-hostile + per-tenant maintenance tax. |
| JSON-LD careers harvest of Indian ATS long tail (Keka/Darwinbox/Zoho Recruit) | Probed: SPA shells, zero server-side JSON-LD — this is a crawler company's job, not an adapter. JSearch captures this tier via Google anyway. |

### Never

- **Adzuna / Jooble / Careerjet** — official APIs but snippet-only JD text (probed). Every free *official* aggregator monetizes the click → withholds the JD and owns the redirect. Snippets kill Fit matching and the practice hand-off.
- **Naukri direct** — robots hard-blocks AI crawlers (updated 2026-05); no API/RSS/affiliate (re-verified). Its content reaches us via JSearch.
- **Indeed** — publisher API dead since 2023; XML feeds terminated 2026-03. **LinkedIn** — prohibited. **TimesJobs** — RSS dead.
- **Coresignal / Bright Data / RapidAPI LinkedIn wrappers** — wrong cost class ($250–$1k+) and/or prohibited.
- **Telegram/WhatsApp harvesting** — scam-dense (documented task-scam pipeline). Defensive use only: scam-pattern blocklist + trust marketing.

---

## 2. Segment serviceability

| Segment | Verdict | Basis |
|---|---|---|
| Metro professionals (incl. non-SWE majority) | **Serviceable at launch** | JSearch 90-bucket matrix (13 measured domains × 6 metros + remote) + ATS anchor. Gated on probe confirming marketing/sales bucket depth (G1). |
| Freshers (54% measured majority) | **[AMENDED] "Promising, unmeasured"** (downgraded from "yes") | Raw volume real (apna+FW ≈ 64k) but three unmeasured conversions: slug-filter yield per fresher domain, apna's 43% JD-stub rate, consultancy share (>20% live-sampled on FW). Most fresher applies are tier-4 platform-funnel. The probe measures fresher-domain-matched × full-JD × post-spam counts per source per week. |
| Govt aspirants | **Partial** | Free verified RSS, notification-shaped. Separate content type, fast-follow, own card UI. UPSC/SSC calendars are a different product; out of scope. |
| Tech/startup | Well served | ATS boards + JSearch as a side effect. All remote-tech niche feeds rejected (zero India inventory, probed). |

---

## 3. Legal posture (scraping vs data servicing)

Verified 2026-07-11: apna robots = permissive default (only `*.infra.apna.co/` disallowed) + advertised sitemap; Unstop robots = explicit `Allow: /api/public/*` + named AI-crawler allows. Four-layer analysis:

1. **Technical permission (robots):** clean on apna/Unstop provided we crawl politely — honest branded User-Agent with contact URL, ~1×/day cadence, always obey robots. FW fails this layer (WAF); Naukri prohibits (→ NEVER).
2. **Contract (ToS):** UNVERIFIED — apna's reachable terms doc governs consultants (Order-Form contract), not visitors; Unstop's ToS is an SPA that won't render to a crawler. Browsewrap weakly enforceable against a polite public reader, but continuing after explicit objection = real breach exposure. **Pre-launch action: read both ToS in a browser (10 min) + 30-min counsel skim.**
3. **Content use:** full JD stored internally for matching/practice (transformative); public cards show facts + derived attributes and **link out** for full text and apply — never republish JD verbatim. Strip recruiter contact details from JD text at normalize time (postings aren't personal data under DPDP; embedded recruiter phone numbers are).
4. **Business reality:** value exchange runs toward the sources (login-funnel applies mean they capture the candidate; same bargain that makes boards feed Google-for-Jobs, which is what their JSON-LD exists for). Health machine gains a `revoked` state — any objection → adapter dark same-day. Roster survives without either source.

**Convert grey → white:** send apna + Unstop + Internshala the same short partnership email (attribution + direct link-outs driving candidates to them; ask for a blessed feed).

**Consistency standard (the defensibility):** invited access (ATS APIs, robots Allows, advertised sitemaps) = build; technical barriers (WAF, robots blocks) = never circumvent.

---

## 4. Architecture

### 4.0 Module layout

```
modules/jobs/
  adapters/       # jsearchAdapter, atsBoardAdapter (GH/Lever/SR/Ashby/Workable/BambooHR),
                  # apnaAdapter (sitemapJsonLd base), unstopAdapter,
                  # stubs: freshersworldAdapter, theirStackAdapter, serpApiAdapter (enabled:false)
  services/       # identityResolver, qualityGate, ingestPipeline, healthService
  jobs/           # Inngest: ingestSchedulerJob, sourceSyncJob, boardProbeJob, retentionSweepJob
  config/         # metros.ts, domains.ts, bucketMatrix.ts, spamRules.ts, slugFilters.ts
  index.ts        # barrel (@jobs/*)
```

Models in `shared/db/models/` (repo convention): `JobPosting`, `JobSourceConfig`, `JobIngestCursor`, `JobIngestCycle`.

New shared helper required: **`fetchJSONWithRetry<T>`** — the existing `shared/fetchWithRetry.ts` returns `Promise<boolean>` and discards the body; `cachedFetch` is client-side promise dedup, not Redis (verified).

### 4.1 Adapter contract

```ts
type FetchTarget =
  | { kind: 'bucket';  bucketId: string; query: string; datePostedWindow: 'day'|'3days'|'week'; page: number }
  | { kind: 'board';   boardId: string; slug: string; atsKind: 'greenhouse'|'lever'|'smartrecruiters'|'ashby'|'workable'|'bamboohr' }
  | { kind: 'sitemap'; shardUrl: string; slugFilter: { metros: string[]; domainPatterns: RegExp[]; maxDetailFetches: number } }
  | { kind: 'feed';    feedId: string; page: number; perPage: number }

type ApplyTier = 'direct-ats' | 'employer' | 'aggregator-deep' | 'platform-funnel' | 'aggregator-redirect'

interface JobSourceAdapter {
  readonly sourceId: string
  readonly kind: 'aggregator' | 'ats-board' | 'sitemap-jsonld' | 'public-api'
  buildTargets(config: IJobSourceConfig, cursors: IJobIngestCursor[]): FetchTarget[]  // sitemap adapters slug-filter HERE, before detail fetch
  fetch(target: FetchTarget): Promise<FetchResult>   // one round-trip; never throws on HTTP errors — encodes status in result
  normalize(raw: RawPosting): NormalizedJob | null   // pure; nulls counted as schema drift
  classifyApplyUrl(url: string): ApplyTier
}
```

### 4.2 Canonical identity + apply-fidelity ranking — **[AMENDED: false-merge fixes are build-blockers]**

Two-tier identity: source identity `(sourceId, externalId)` as provenance rows (`sourceKey` unique multikey index); canonical `fingerprint = sha256(companyKey|titleKey|locationKey)` unique index. Canonical `_id`s are never reused and never hard-deleted while user-referenced.

Key normalization: companyKey strips legal suffixes only (pvt/ltd/llp/inc) — **never** "solutions"/"technologies"/"consulting" (half of India's consultancy namespace); titleKey drops parenthesized junk + stopwords, keeps seniority tokens, sorts tokens; locationKey via metro alias table (gurgaon|gurugram|noida|delhi → delhi-ncr).

Resolution ladder: sourceKey hit → refresh; fingerprint hit → merge; fuzzy tier (companyKey + location overlap + token-set Jaccard ≥ 0.85 on titleTokens, company-scoped only) → merge; else insert.

**Mandatory amendments (must land before the first canonical `_id` is minted — retro-splitting after apply-tracking ships is a data-corruption migration):**
1. **Never merge two open postings sharing `sourceId` with different `externalId`s** — mass recruiters (and Bosch's own 546) hold N simultaneous identical-title reqs per city; salt the fingerprint with refNumber/ordinal.
2. **Exempt `confidentialCompany` rows from fingerprint and fuzzy merging entirely** — degenerate companyKey merges *different employers*.
3. Evict provenance (cap 8) by `lastSeenAt` **preserving source diversity** — JSearch's rotating `job_id` must not churn out genuine cross-source entries.
4. Order merge ops delete-before-insert (or transaction) — provenance moves can transiently violate the unique sourceKey index mid-`bulkWrite`.

Merge policy: canonical `applyUrl` = highest tier across all provenance options (`direct-ats > employer > aggregator-deep > platform-funnel > aggregator-redirect`), ties by lastSeenAt then source priority (ats-board > jsearch > india-native). All options retained — rot on the winner promotes the next rung. `jdText` = longest full body; salary conflicts >25% midpoint → `flags.salaryConflict` + range union, never an invented midpoint; `postedAt` = earliest non-null.

### 4.3 Storage budget + Atlas — **[AMENDED]**

~4 KB/doc avg (base+keys ~1.2 KB, provenance ~0.7 KB, gzipped JD ~1.5 KB, amortized lazy `parsedJD` ~0.25 KB). Launch cap **25k canonical ≈ 125 MB incl. indexes**. Sub-caps tuned post-probe. Index budget (complete): `{fingerprint}` unique · `{'provenance.sourceKey'}` unique · `{companyKey, status}` · `{domain, locationKeys, status, postedAt:-1}` · `{purgeAt}` TTL. No text index.

Expiry: ATS missing 2 consecutive polls → closed(`board-poll-miss`); JSON-LD `validThrough` past → closed (and never ingested if already past); aggregator `lastSeenAt` > 14d → closed(`aged-out`); purge = closedAt + 7d via TTL. **User-referenced jobs never purge** — sweep strips `jdCompressed`, keeps slim identity + `parsedJD` (~1.5 KB) so apply-tracking keeps a stable `_id` forever.

Amendments: publish the measured `db.stats()` baseline before trusting the 350 MB alert trigger (existing tenants — transcripts, MultimodalAnalysis, ScoreTelemetry — consume an unmeasured share of M0's 512 MB); **M2 ($9/mo) is storage insurance only** — all shared tiers (M0/M2/M5) cap at 500 connections, so the QA connection-exhaustion risk is carried by the concurrency-2 design, not the upgrade; add a hard stop-ingesting-new-canonicals guard at ~27k.

### 4.4 Inngest topology — **[AMENDED: 60s reality]**

Prerequisite: `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` in prod (hard launch prerequisite). Pattern mirrors `modules/learn/jobs/pathwayJob.ts` (ids-only payloads, re-fetch from Mongo, `step.run` checkpoints, `onFailure` status, pure exported handlers).

| Function | Trigger | Concurrency |
|---|---|---|
| `jobsIngestScheduler` | cron `15 * * * *` | — |
| `jobsSourceSyncJob` | event `jobs/source.sync {sourceId}` | `{limit: 2}` (Atlas shared-tier rule) |
| `jobsBoardProbeJob` | cron weekly | — |
| `jobsRetentionSweepJob` | cron daily | — |

Cadence: JSearch 24h; ATS 6h; india-native 24h, staggered. Freshness cursors: page 1 with smallest `date_posted` window covering `newestPostedAt`; page N+1 only if page N's already-known rate < 60% → steady-state ≈ 3,500 req/mo (inside Pro $25). **Amendments:** hard cap **3 pages/bucket/day**; `maxRetries=1` for JSearch (RapidAPI bills error responses — retry storms burn quota before the health machine reacts); meter attempts, not logical calls; **chunk budgets sized to Vercel Hobby's 60s function cap** (≤15 detail fetches/chunk with hard per-fetch timeouts) unless the plan check confirms Pro/Fluid — the repo's own comments say Hobby; a 2-minute ops check is load-bearing and $20/mo Vercel Pro joins the cost table if wrong.

Health machine: `active → degraded → quarantined → dead` (2 healthy weekly probes to recover). Board 404/410 → quarantine immediately; emptyStreak ≥3 → degraded, ≥6 → quarantined; normalize-null drift >20%/>50% → degraded/quarantined; 429 → degraded with backoff, never quarantined; `minIndiaPostings` breach 3 weeks → quarantined; +`revoked` (legal objection → dark same-day). **No inline fallback** — deliberate divergence from `analysis/start`: ingestion has no waiting user; "Inngest not configured" is the off state. Manual kick: `POST /api/jobs/admin/sync` (platform_admin) or 503.

### 4.5 Quality gate (deterministic only — no LLM at ingest)

**Hard drops** (never stored): blocklist-company (CMS-seeded) · blocklist-apply-domain (bit.ly, forms.gle, wa.me, Telegram) · title-walkin · title-spam-shape (phone in title, >3 slash-joined roles, "N openings", CAPS >0.7) · junk-posting (verified live in foundit) · fee-fraud (registration fee / deposit / pay-for-training) · contact-spam · valid-through-expired · mass-repost (Redis `sha1(JD body)` counter, 7d: same body under >3 companyKeys) · no-company. Per-rule per-source drop counters as the false-positive audit trail; rules in `spamRules.ts` + CMS overlay.

**Stored demotion flags** (ranking consumes): `staffing` (TeamLease/Randstad/Quess + consultancy list via `hiringOrganization.name`), `confidentialCompany`, `jdLength < 400`, high `repostCount`. Salary "not disclosed": no penalty (Indian default). Dropping borderline supply in fresher buckets — the thinnest market — is worse than demoting it.

### 4.6 Observability (<2 hrs/week ops)

`JobIngestCycle` per sync (30d TTL): fetched/normalized/driftNulls, per-rule drops, new/merged/refreshed/closed, dupCollapsedPct, quotaSpent, health transitions. Redis quota meters: 80% → cadence halves; 95% → no new syncs. CMS dashboard `/cms/jobs-ingest` (precedent `/cms/score-telemetry`): per-source health, quota gauges, board table with one-click reactivate, corpus panel (count vs cap, storage vs trigger, **apply-tier distribution = the fidelity KPI**, spam-drop rates), **[AMENDED]** + per-source JD-stub-rate gauge (the quality drift the health machine can't see). Monday digest email; immediate alerts only for quarantine, quota >80%, failStreak ≥2, storage >300 MB. Kill switch: `jobs_ingest` feature flag.

---

## 5. Cost model

| Line item | Launch (~100 MAU) | 1k MAU | 10k MAU |
|---|---|---|---|
| JSearch | $25 Pro (Ultra $75 pre-approved ceiling) | $75 Ultra | $150 Mega |
| apna + Unstop + ATS boards (+ fast-follows) | $0 | $0 | $0 |
| Fantastic.jobs (optional, phase-2) | — | $95 | $95 |
| Atlas | $9 M2 (recommended) | $25 M5 | ~$60 M10 |
| Inngest | $0 | $0–20 | ~$50 |
| Vercel Pro **[AMENDED — pending plan check]** | $0 or $20 | $20 | $20 |
| **Total ingestion** | **$34–54/mo** | **~$120–215/mo** | **~$280–375/mo** |
| Lazy JD parse (usage-scaled, shared cache) | ~$8 | ~$40 | ~$250 |

Efficiency metric: **cost per fresh usable listing** (unique, non-spam, full-JD, live-link) ≈ $0.001–0.005 projected (vs TheirStack $0.017 floor). The probe replaces projections; the dashboard tracks realized monthly as the per-source buy/kill signal. Ingestion cost scales with corpus breadth, not user count.

---

## 6. Rollout

### Phase 0 — liquidity probe (2.5 days, BEFORE writing modules/jobs; green-lit)

`scripts/jobs-liquidity-probe.mjs` — standalone Node ≥18, zero repo imports, `RAPIDAPI_KEY` env. Embeds the 90-bucket matrix, the §4.2 normalization functions inline (probe validates the same fingerprint the pipeline will use), and the §4.5 spam regexes. Day 1: 12 pilot buckets → full 90-bucket run (snapshot A) + link-rot sample + `viaSite=naukri` share. Day 2: re-run 20 buckets ≥24h later (snapshot B) → `freshPerDay = |B \ A|` by fingerprint. +½ day: sample 100 detail pages each from apna(/FW) + 5 Unstop API pages → **JD-length distribution per source** [AMENDED], JSON-LD validity, validThrough-expired rate, consultancy share, slug-filter yield per fresher domain.

| Gate | Threshold |
|---|---|
| G1 Liquidity | median bucket ≥ 20 net-usable postings/week; top-5 fresher-domain variants ≥ 10/week |
| G2 Freshness | ≥ 10 net-new/bucket/week on ≥ 70% of sampled buckets |
| G3 Full-JD rate | ≥ 70% corpus-wide (measured per source post-stub-filter); priority bucket < 50% flagged |
| G4 Apply fidelity | ≥ 30% at tier employer+; dead-link rate < 10% |
| G5 Dedup burden | cross-source dup < 35% |
| G6 Spam floor | post-filter yield still meets G1 in fresher buckets |

Verdicts: PASS (G1–G4 for segments 1+2) → build as written. PARTIAL → launch scoped to passing domains, re-probe monthly; never ship a tab that's empty for the majority. FAIL (<50% of priority buckets pass G1–G3) → TheirStack $169 trial against the same gates + Naukri partner hunt informed by measured `viaSite=naukri` share.

### Phase 1 — build order

1. `fetchJSONWithRetry` + models + barrel (no behavior)
2. `identityResolver` + `qualityGate` — pure, unit-tested first, **with the §4.2 false-merge amendments**
3. `jsearchAdapter` (+ fixture tests; probe validated shapes)
4. `atsBoardAdapter` + seed registry (PhonePe, Meesho, Groww, Postman, BoschGroup, Continental) + liveness invariant
5. `apnaAdapter` (sitemapJsonLd base; ≥400-char JD floor)
6. `unstopAdapter` (`regn_open` filter)
7. Inngest functions + `/api/inngest` registration + `jobs_ingest` flag (default OFF) + `/cms/jobs-ingest` + digest email
8. Flip flag in prod after Inngest keys land; first sync via admin kick

### Phase 2 — telemetry-gated fast-follows

Freshersworld (WAF-liveness probe + honest ToS posture) · Shine (detail JSON-LD verified) · foundit (junk filter proven) · govt RSS shelf (Open Decision I-3) · Fantastic.jobs $95 (enterprise-brand demand shown) · SerpAPI (JSearch quarantine only — pre-create account) · TheirStack (JSearch failure / probe FAIL) · Internshala/NCS (founder-relationship track).

---

## 7. Open decisions (ingestion-scoped)

1. **JSearch tier at launch** — Pro $25 (recommended; overage is pennies, probe corrects within a month) vs Ultra $75.
2. **Atlas M0 → M2 ($9/mo)** when ingestion turns on — recommended, honestly framed as storage insurance (connection cap is identical on all shared tiers).
3. **Govt-notification shelf** — defer behind a flag (recommended) or build with Phase 1.

**Standing pre-build actions:** Vercel plan check (2 min, load-bearing for §4.4) · read apna/Unstop ToS in a browser + counsel skim · send apna/Unstop/Internshala partnership emails · run `db.stats()` and record the storage baseline.

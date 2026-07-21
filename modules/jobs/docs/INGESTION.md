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
| Metro professionals (incl. non-SWE majority) | **Serviceable at launch** | JSearch 90-bucket matrix (13 measured domains × 6 metros + remote) + ATS anchor. Gated on probe confirming marketing/sales bucket depth (G1). **[AMENDED 2026-07-20, ruling #23]** the LIVE harvest is now domain × COUNTRY + remote (43 buckets, not the 6-metro fan-out) — cost cut; coverage recovered via depth (page cap 3→4). The probe keeps the city-sliced matrix (it is the byte-frozen build gate). |
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
  | { kind: 'board';   boardId: string; slug: string; atsKind: 'greenhouse'|'lever'|'smartrecruiters'|'ashby'|'workable'|'bamboohr'; displayName?: string }  // human company name for boards whose payload omits one (Lever/Ashby); GH/SR payload names win
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
2. **Exempt `confidentialCompany` rows from fingerprint and fuzzy merging entirely** — degenerate companyKey merges *different employers*. **Index consequence (Codex on #503):** exempt rows store NO `fingerprint`, and a plain unique index permits only one missing-field document — the `{fingerprint}` index must therefore be a **partial unique** (`partialFilterExpression: { fingerprint: { $type: 'string' } }`) so unlimited confidential rows can coexist while real fingerprints stay unique.
3. Evict provenance (cap 8) by `lastSeenAt` **preserving source diversity** — JSearch's rotating `job_id` must not churn out genuine cross-source entries.
4. Order merge ops delete-before-insert (or transaction) — provenance moves can transiently violate the unique sourceKey index mid-`bulkWrite`.

Merge policy: canonical `applyUrl` = highest tier across all provenance options (`direct-ats > employer > aggregator-deep > platform-funnel > aggregator-redirect`), ties by lastSeenAt then source priority (ats-board > jsearch > india-native). All options retained — rot on the winner promotes the next rung. `jdText` = longest full body; salary conflicts >25% midpoint → `flags.salaryConflict` + range union, never an invented midpoint; `postedAt` = earliest non-null.

### 4.3 Storage budget + Atlas — **[AMENDED]**

~4 KB/doc avg (base+keys ~1.2 KB, provenance ~0.7 KB, gzipped JD ~1.5 KB, amortized lazy `parsedJD` ~0.25 KB, **[AMENDED 2026-07-12]** `llmVerdict` sub-doc ~0.3 KB → ~4.3 KB/doc, ≈ +7.5 MB at cap). Launch hard bound **25k retained canonical rows ≈ 125 MB incl. indexes**: active rows, owner-pinned archives, and tombstones all consume it. Active-feed/source sub-caps must leave headroom inside that retained bound and are tuned post-probe. Index budget: `{fingerprint}` **partial unique** (`partialFilterExpression: { fingerprint: { $type: 'string' } }` — confidential rows carry no fingerprint by design; a plain unique index would reject the second one) · `{'provenance.sourceKey'}` unique · **[AMENDED A02]** `{sourceIds}` (durable legal lineage) and `{'provenance.sourceId'}` (board lifecycle + rolling migration) · `{companyKey, status}` · `{domain, locationKeys, status, postedAt:-1}` · `{purgeAt}` TTL · **[AMENDED 2026-07-12]** `{'llmVerdict.status': 1}` partial (`partialFilterExpression: {'llmVerdict.status': 'pending'}`, the sweeper query). No text index. Verdict lives inside the doc — no new TTL machinery.

Expiry: ATS missing 2 consecutive polls → closed(`board-poll-miss`); JSON-LD `validThrough` past → closed (and never ingested if already past); aggregator `lastSeenAt` > 14d → closed(`aged-out`); purge = closedAt + 7d via TTL. **[AMENDED 2026-07-20] User-referenced jobs never purge.** The pin is monotonic in close paths, every ownership write removes `purgeAt`, and close writers first remove any TTL before conditionally stamping one against the current `userReferenced:false` state. Normal expiry/delisting archives retain the shared canonical `jdCompressed` (and current hash-bound `parsedJD`) while referenced so the owner can continue preparation; this is the latest canonical retained body, not an immutable per-user save-time snapshot. A future conservative orphan reconciler may reclaim pins only with race-safe cross-collection coordination. **[AMENDED 2026-07-12]** `closedReason:'llm-verdict'` rows likewise never purge — the TTL purge would delete the fingerprint that §4.5's anti-resurrection depends on, letting the same scam posting re-ingest as new on a later sync. The retention sweep instead slims them to a durable restricted tombstone (identity keys + fingerprint + `llmVerdict` + provenance sourceKeys, both JD bodies stripped, ~0.5 KB): a re-ingest with an unchanged `verdictInputHash` refreshes `lastSeenAt` and stays closed; a changed body re-verdicts and may reopen. `source-revoked` and unknown policy closures also expose no retained body through serving. Tombstones are outside active-feed eligibility/counts but **inside the 25k retained-corpus bound** and get their own dashboard gauge (§4.6) so scam-tombstone growth is visible.

**Mandatory owner-retention deployment gate (A05):** writer fixes do not heal TTL contradictions already stored. Every environment containing Jobs data must run this sequence before promotion: (1) `npm run repair:jobs-retention` and retain the dry-run counts; (2) `npm run repair:jobs-retention -- --apply`; (3) `npm run check:jobs-retention`, whose read-only non-zero exit blocks promotion if any application-owned posting is unpinned or any pinned posting still has `purgeAt`; (4) deploy and drain the old workers; (5) repeat apply + check once, because an old in-flight writer can reintroduce a contradiction before it drains. Ordinary PR CI cannot honestly execute this data gate without an environment-scoped staging Mongo credential; the deploy pipeline must wire `check:jobs-retention` to a protected staging environment rather than treating a code-only smoke as proof.

**Legacy closure support policy:** a closed row with no `closedReason` is restricted, never guessed into a normal archive. Age, a now-expired `validThrough`, or a later-missing source cannot prove why the row originally closed and could misclassify a legal/safety removal. The repair therefore does not backfill reasons. Support copy is: “This older or policy-restricted posting keeps your tracked status, but its original content and new job-specific actions are unavailable.” Any future backfill must use contemporaneous, auditable closure evidence—not present-day heuristics.

Amendments: publish the measured `db.stats()` baseline before trusting the 350 MB alert trigger (existing tenants — transcripts, MultimodalAnalysis, ScoreTelemetry — consume an unmeasured share of M0's 512 MB); **M2 ($9/mo) is storage insurance only** — all shared tiers (M0/M2/M5) cap at 500 connections, so the QA connection-exhaustion risk is carried by the concurrency-2 design, not the upgrade; warn operators at 20k retained rows and transactionally stop new canonical admission above the exact 25k retained-row bound.

### 4.4 Inngest topology — **[AMENDED: 60s reality]**

Prerequisite: `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` in prod (hard launch prerequisite). Pattern mirrors `modules/learn/jobs/pathwayJob.ts` (ids-only payloads, re-fetch from Mongo, `step.run` checkpoints, `onFailure` status, pure exported handlers).

| Function | Trigger | Concurrency |
|---|---|---|
| `jobsIngestScheduler` | cron `15 * * * *` | — |
| `jobsSourceSyncJob` | event `jobs/source.sync {sourceId, controlRevision}` | `{limit: 2}` (Atlas shared-tier rule) |
| `jobsBoardProbeJob` | cron weekly | — |
| `jobsRetentionSweepJob` | cron daily | — |
| `jobsEvaluatePostingsJob` **[AMENDED 2026-07-12]** | event `jobs/verdict.requested {postingIds[≤40], reason}` | `{limit: 1}` (net-new Inngest config — no repo precedent; **2 postings/step**: worst case 2 × (12s call + 12s JSON-repair) = 48s < 60s budget — the repair is a second model attempt and is accounted, not free) |
| `jobsVerdictSweeperJob` **[AMENDED 2026-07-12]** | cron `45 * * * *` (offset from `:15` scheduler) | — (oldest-first, limit 400, attempts <5, budget-aware; queries `status:'pending'` via the partial index PLUS open rows missing the `llmVerdict` sub-doc entirely) |

Cadence: JSearch 24h; ATS 6h; india-native 24h, staggered. Freshness cursors: page 1 with smallest `date_posted` window covering `newestPostedAt`; page N+1 only if page N's already-known rate < 60% → steady-state ≈ 3,500 req/mo (inside Pro $25). **Amendments:** ~~hard cap **3 pages/bucket/day**~~ **[AMENDED 2026-07-20, ruling #23: cap 3→4 with the country-only harvest — a country query has the fresh supply to use the depth a metro slice couldn't]**; `maxRetries=1` for JSearch (RapidAPI bills error responses — retry storms burn quota before the health machine reacts); meter attempts, not logical calls; ~~**chunk budgets sized to Vercel Hobby's 60s function cap**~~ **[AMENDED 2026-07-20 #23: the real per-step budget is `maxDuration=300s` (`app/api/inngest/route.ts`); the "Hobby 60s" note predated the plan check and is stale — `BUCKETS_PER_CHUNK=1` keeps worst-case ~61s regardless]** (≤15 detail fetches/chunk with hard per-fetch timeouts).

Health machine: `active → degraded → quarantined → dead` (2 healthy weekly probes to recover). Board 404/410 → quarantine immediately; emptyStreak ≥3 → degraded, ≥6 → quarantined; normalize-null drift >20%/>50% → degraded/quarantined; 429 → degraded with backoff, never quarantined; `minIndiaPostings` breach 3 weeks → quarantined; +`revoked` (legal objection → dark same-day). **No inline fallback** — deliberate divergence from `analysis/start`: ingestion has no waiting user; "Inngest not configured" is the off state. Manual kick: `POST /api/jobs/admin/sync` (platform_admin) or 503.

**A03 apply-link network boundary (2026-07-21):** the production liveness worker accepts only credential-free HTTP(S) URLs on default ports, rejects non-global IP literals and any DNS answer set containing a non-global address, and opens each socket through a vetted address while preserving the original Host/SNI/certificate checks. The candidate-facing Apply ladder and its feed badge use the same structural rule, so localhost, special/private IP literals, credentials, and non-default ports never reach `window.open`. Redirects are manual, bounded, downgrade-safe, and re-run the complete URL/DNS/pinning policy on every hop; response reads, DNS, redirects, and connections share one deadline and a bounded body budget. Posting authority is rechecked before DNS, after DNS, and before each physical attempt, so a source revoke or provenance replacement discards the observation. Only authoritative NXDOMAIN, all-vetted-address connection refusal, 404/410, or an explicit closed-job page counts as dead evidence; all ambiguous network failures remain unverifiable. DNS-named browser destinations and an already-open tab cannot receive the server worker's DNS pin or immediate revocation semantics; the A08 server-mediated Apply/interstitial remains the explicit active-tab boundary. The standalone, byte-frozen `scripts/jobs-liquidity-probe.mjs rot` command is not wired to this production transport and must run only from an isolated runner with controlled outbound egress; its output is a build-gate artifact, not a production authorization signal.

**A02 source-authority protocol (2026-07-21):** every `jobs/source.sync` event carries the source's monotonic `controlRevision`. A real no-op fence transaction runs before any paid provider fetch; normalized pages then persist in bounded 25-row transactions. Every such transaction locks the corpus-wide `JobSourceControlMeta` before `JobSourceConfig`, increments both ingest fences, validates the exact revision/enabled/health predicate and permanent audit head, and admits its actual insert count only if the serialized retained-corpus total remains at or below 25k. Revoke uses the same global-meta→source-config order, increments the revision, disables the source, sets `health:'revoked'` **before** bounded corpus scans, upgrades **all** canonical rows carrying that durable source lineage (open, archived, or multi-source) to the restricted `source-revoked` state with no TTL, and appends a permanent `JobSourceControlAudit`. This order gives every batch and revoke a total order: batch-first is counted and closed by revoke; revoke-first makes that and all later batch fences fail. Cursor checkpoints/finalization use the same fence; the board finalizer emits one lifecycle-CAS bulk write instead of thousands of sequential updates; board probes and writes also validate the permanent audit head, preventing a deleted/reseeded config from resetting legal authority. `sourceIds` is a monotonic, non-evicting, canonical lookup independent of cap-8 detailed provenance and is written even when a provider omits its external ID; a second indexed provenance rail and the bounded, disjoint malformed-lineage fallback close out-of-band drift without double-counting. The LLM ToS worker/sweeper always excludes missing/empty/unknown lineage and additionally excludes every opted-out source in the query, so ineligible legacy rows cannot starve its oldest-first window. **Restore is clearance-only**, not reactivation: the separate idempotent audited action increments revision, leaves the source `enabled:false` + `health:'quarantined'`, clears cursors for a future cold validation, and reopens no posting. A later enable/revalidation decision belongs to the broader A08 control plane. The mutation API is the minimal `POST /api/jobs/admin/source-control` primitive; full source editing/UI remains A08, while the read-only CMS table exposes the current revision and last legal action. The permanent reason is not returned by the CMS monitoring GET; enter a non-sensitive case reference, never privileged narrative or personal data.

**Mandatory A02 rollout gate:** schema auto-indexing is not evidence that the legal lookup is ready. Before lineage repair or legacy-revoked adoption, run the explicit non-dropping `prepare:jobs-source-control-indexes -- --apply` command; it serially uses `createIndex`, verifies all five whole-collection exact indexes, rejects key-identical partial/sparse/hidden/TTL/collated variants, and never calls `syncIndexes` or removes an index. Staging and production deliberately use different execution paths. Staging uses the protected, main-only **Jobs Source Control Promotion Gate** twice: `prepare-indexes` before any adoption, then `verify-promotion` after repairs/adoption. The post-merge staging smoke exercises the production transaction shape at the same hard 25,000 **retained-row** limit enforced by the service/read-only gate, including owner-pinned archives and tombstones; this is not the active-feed cap. Production never receives that workflow's credential and never runs its destructive-to-temporary-collections smoke. Follow the ordered [A02 Source Control Runbook](./SOURCE_CONTROL_RUNBOOK.md); dispatch stays paused until every applicable read-only gate passes.

**Known A02 boundary:** this is serving revocation, not indiscriminate erasure. Canonical rows can merge contributions from multiple sources without field-level JD lineage, so the whole row is conservatively restricted; source content is not destructively scrubbed because doing so could erase another source's legitimate contribution. Derived user artifacts (tailored resumes, practice evidence, ATS results) also have separate retention contracts. Field-level content lineage and erasure policy belong to A04/A08 legal-retention work, not an unsafe guess in the revocation path. Historical rows whose full source set cannot be reconstructed are deliberately over-restricted through the unknown-lineage sentinel; this protects the legal boundary at the cost of possible collateral hiding, and the repair reports its exact count before writing. Mongo primary reads are forced for authority checks. Evaluator/X-ray/ATS calls recheck exact authority for every router adapter attempt and disable SDK-internal retries on gated OpenAI/Anthropic/Groq/OpenRouter calls; Jobs email rechecks user, recipient, tracker, and posting after asynchronous preparation. External providers and browsers still cannot participate in the Mongo transaction: a request accepted in the final read→HTTP micro-gap cannot be recalled, nor can content/apply URLs already rendered in an open tab. The five-minute propagation claim covers server requests whose final authority read begins after commit. Active-tab invalidation/server-mediated apply belongs to A08. If authority changes after an ambiguous email provider call, the transactional key is burned into the alert ledger rather than risk a duplicate or changed-payload retry.

### 4.5 Quality gate (two-layer: deterministic floor + async LLM verdict) — **[AMENDED 2026-07-12: founder direction supersedes the original "deterministic only — no LLM at ingest" header; see DECISIONS ruling #16]**

**Layer 1 — deterministic rules (BLOCKING, permanent floor; unchanged).**
**Hard drops** (never stored): blocklist-company (CMS-seeded) · blocklist-apply-domain (bit.ly, forms.gle, wa.me, Telegram) · title-walkin · title-spam-shape (phone in title, >3 slash-joined roles, "N openings", CAPS >0.7) · junk-posting (verified live in foundit) · fee-fraud (registration fee / deposit / pay-for-training) · contact-spam · valid-through-expired · mass-repost (Redis `sha1(JD body)` counter, 7d: same body under >3 companyKeys) · no-company. Per-rule per-source drop counters as the false-positive audit trail; rules in `spamRules.ts` + CMS overlay. Per ruling #15 these rules can never be demoted to advisory or put behind a flag — they are also the LLM bill-guard (dropped rows are never stored, so they never reach layer 2).

**Stored demotion flags** (ranking consumes): `staffing` (TeamLease/Randstad/Quess + consultancy list via `hiringOrganization.name`), `confidentialCompany`, `jdLength < 400`, high `repostCount`. Salary "not disclosed": no penalty (Indian default). Dropping borderline supply in fresher buckets — the thinnest market — is worse than demoting it.

**Layer 2 — async LLM verdict (`jobs.evaluate-posting` slot; gpt-5.6-luna, maxTokens 800, effort `low` — corpus-scaled, deliberately below the "judgment=high" tier policy).** One call per unique posting evaluates: genuineness verdict `{genuine, suspicious, fraud}` + 1–4 reason codes from a frozen enum (fee_fraud, contact_harvest, pii_harvest, mlm_pyramid, training_bait, fake_company, not_a_job, mass_repost_shell, title_body_mismatch, vague_jd, salary_unrealistic, walk_in_funnel, consultancy_funnel, legit_staffing, thin_but_genuine, ok) + scalars genuineness/quality/completeness + typed attributes `domain`, `seniority`, `fresherFriendly`, `geo {locations, workMode}` (geo-agnostic per ruling #14). Binding invariants:

- **Async post-store, never blocks sync** (ruling #11): a dedicated Inngest worker + hourly sweeper evaluate stored survivors. When verdict collection is enabled (DB config row — no env flags, founder correction 2026-07-13), the store step initializes new survivors with `llmVerdict: {status:'pending', attempts:0}` so the steady-state sweeper runs on the §4.3 partial index; the sweeper ADDITIONALLY catches eligible open or normally archived rows with no `llmVerdict` sub-doc at all (pre-flip corpus, missed enqueues, backfill — a bounded ≤25k-doc scan branch, hourly), so no survivor can sit unevaluated indefinitely behind a missed `jobs/verdict.requested` event. Collection disabled = no init, no sweeper, byte-identical. Pending/invalid verdict ≡ rules-only scoring — degradation is always safe.
- **Monotonicity:** the LLM only ADDS severity; it never overrides a layer-1 drop or flag. Safety/legal closures also outrank normal expiry: board/link close writers use current-status/version CAS, and an exact-input fraud verdict that loses to a normal archive atomically upgrades that archive to `llm-verdict` without overriding `source-revoked` or changed inputs. If that upgrade also loses to a benign ownership-pin write, its missing-or-pending normal archive re-enters the hourly verdict sweep until it scores or the content/lifecycle genuinely changes; restricted and unknown closures never enter that recovery rail. Identity merges that may reopen a normal archive likewise use an acknowledged lifecycle/version CAS; a missed predicate forces a fresh read and policy re-evaluation, so a concurrent `source-revoked` or `llm-verdict` close cannot be reversed by a stale ingest document. Disagreement telemetry is scoped to STORED rows — hard-dropped rows are never stored and never reach layer 2, so drop-side disagreement is undefined by design. Two computable signals, counted per source: `llm-flagged-clean-row` (LLM fraud/suspicious on a rules-clean row — the rules-missed-it signal) and `llm-cleared-flagged-row` (LLM ok/legit_staffing on a demotion-flagged row — advisory only; the flag stands). The injection/drift alarm is a per-source anomaly in these rates (rising clean-rate on flagged rows, or falling LLM-added-severity rate).
- **Verdict binds to `verdictInputHash` = sha256(companyKey | titleKey | locationKey | normalizedBody | sorted apply-hosts | salaryPresence | promptVersion | epoch)** — never body-hash alone (provenance merge swaps apply URLs without touching jdText). **[PRECISED 2026-07-14]** `normalizedBody` = the PII-stripped, model-visible head-3000+tail-1500 slice — content beyond the window the model never saw cannot invalidate its verdict, and the PII strip only ever runs on the bounded slice (ReDoS surface otherwise). The merge layer owns invalidation: any JD replacement or apply-URL change on a stored row resets a scored verdict to `pending` (fresh attempts), which is also the §4.3 tombstone re-verdict path. Input change re-enqueues; verdicts are immutable within an epoch (`epoch = actualModel:promptVersion`); epoch cutover = founder-triggered rolling budget-capped re-classification, replay-compared on the golden set (ruling #8 discipline).
- **Prompt hygiene:** one prompt sees all fields together (split-signal scams); `DATA_BOUNDARY_RULE` + instructions outside `<job_posting>` tags; metadata through `neutralizePromptLine`; body = classifyJob-normalized (tag-strip + entity-decode + residual `<>` strip), head 3000 + tail 1500 chars; recruiter-PII strip (ruling #9) strictly precedes any LLM call; per-source verdict opt-out on `JobSourceConfig` (ToS lever). Output = closed enum codes only, Zod-validated; **no free-text rationale persisted**; parse-fail/truncation → `pending`, never fabricated, never `clean`.
- **Enforcement (I-4):** `fraud` + genuineness ≤ 0.2 → **auto soft-close** (`closedReason:'llm-verdict'`, fingerprint intact = anti-resurrection, never deleted, CMS-reviewable/reopenable); `suspicious`/low-quality → stored demotion fields consumed by serving as deterministic math with honest reason-chip vocabulary (rulings #3/#4). Identity (§4.2) never consumes LLM output (ruling #10).
- **Rollout:** DB-config switches, NOT env flags (founder correction 2026-07-13) — verdict collection and enforcement are system config rows (CMS-editable), both defaulting OFF; shadow ≥2 ingest weeks with exit criteria (error <5%, backlog age <24h, spend ±30% of estimate, fraud false-positive rate on the labeled-genuine golden set <2%, founder-reviewed disagreement drill-down).
- **Budget breaker:** Redis daily meters (per-cycle / ~900 verdicts ≈ $2.50 daily / monthly caps; 80% → sweeper halves, 95% → pending-only) + per-companyKey and per-source daily caps (salted-repost storm defense); retry amplification capped by construction (1 evaluator invocation per posting per sweep, 12s timeout per model attempt, one JSON-repair max — a second 12s-capped attempt counted in the step runtime budget above — no fallbackModel on the slot, Inngest retries cover infra throws only).
- **Probe reconciliation:** the liquidity probe stays byte-untouched and deterministic (it is the build gate). `JobIngestCycle` dual-reports per-bucket yield rules-only (probe-comparable) AND rules+LLM (reality); enforcement flips only if G1/G6 still pass on rules+LLM yield.

### 4.6 Observability (<2 hrs/week ops)

`JobIngestCycle` per sync (30d TTL): fetched/normalized/driftNulls, per-rule drops, new/merged/refreshed/closed, dupCollapsedPct, quotaSpent, health transitions. **[AMENDED 2026-07-12]** + `kind: 'sync' | 'llm-verdict'` discriminator; verdict runs write their own cycle rows: `{requested, scored, cacheHits, errors, timeouts, softClosed, verdictDistribution, reasonCodeCounts, bySource, disagreementCount, tokens, costUsd, epoch}` + per-bucket yield dual-report (rules-only vs rules+LLM). Redis quota meters: 80% → cadence halves; 95% → no new syncs (same idiom governs the LLM budget breaker, §4.5). CMS dashboard `/cms/jobs-ingest` (precedent `/cms/score-telemetry`): per-source health, quota gauges, board table with one-click reactivate, corpus panel (count vs cap, storage vs trigger, **apply-tier distribution = the fidelity KPI**, spam-drop rates), **[AMENDED]** + per-source JD-stub-rate gauge (the quality drift the health machine can't see), **[AMENDED 2026-07-12]** + LLM verdict panel: pending backlog + oldest-pending age, verdicts/day, verdict distribution, top reason codes per source, disagreement rate by epoch, epoch coverage %, spend today/MTD vs caps, error/timeout rate, soft-close drill-down (the false-positive review surface). Monday digest email; immediate alerts only for quarantine, quota >80%, failStreak ≥2, storage >300 MB, **[AMENDED 2026-07-12]** verdict backlog age >48h, LLM budget >80%, disagreement-rate spike per source. Kill switch: DATA, not flags (founder correction 2026-07-13) — disable sources via `JobSourceConfig.enabled`; the LLM verdict shadow/enforce switches are DB config rows (§4.5).

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
| LLM ingest verdict **[AMENDED 2026-07-12, I-4]** (corpus-scaled, cached per verdictInputHash; + ~$68 one-time backfill of the standing corpus) | $45–67 | ~$60–90 (breadth-scaled) | ~$80–120 |
| **Total ingestion** | **$79–121/mo** | **~$180–305/mo** | **~$360–495/mo** |
| Lazy JD parse (usage-scaled, shared cache) | ~$8 | ~$40 | ~$250 |

Efficiency metric: **cost per fresh usable listing** (unique, non-spam, full-JD, live-link) ≈ $0.001–0.005 rules-only; **[AMENDED 2026-07-12]** ≈ **$0.004–0.008 including the LLM verdict line** (vs TheirStack $0.017 floor — still under it). The probe replaces projections; the dashboard tracks realized monthly as the per-source buy/kill signal. Ingestion cost scales with corpus breadth, not user count (the verdict line included — it is per-unique-posting, cached, never per-user).

---

## 6. Rollout

### Phase 0 — liquidity probe (2.5 days, BEFORE writing modules/jobs; green-lit)

`scripts/jobs-liquidity-probe.mjs` — standalone Node ≥18, zero repo imports, `RAPIDAPI_KEY` env. Embeds the bucket matrix (90 core + 10 fresher variants, fresher ON by default), the §4.2 normalization functions inline (probe validates the same fingerprint the pipeline will use), and the §4.5 spam regexes. **Runbook (matches the CLI exactly):** Day 1: `pilot` (12 buckets, classification sanity — never gate-graded) → `snapshot` (full run = snapshot A); optionally `rot <snapshot A>` for an early dead-link read. Day 2 (≥24h, ≤7d later): `snapshot` again (snapshot B — FULL run; `fresh` rejects pilots and partial runs) → `fresh <A> <B>` (per-bucket `freshPerWeek`, undated rows excluded as non-comparable; verdict persisted) → **`rot <snapshot B>`** — the report's G4 pairing rule accepts only a rot artifact matching the snapshot it selects, which after Day 2 is B, so the gate-grade rot run happens against B immediately before `report`. +½ day (any time): `india` (100 apna detail pages + 5 Unstop API pages) → **JD-length distribution per source**, JSON-LD validity, validThrough-expired rate, consultancy share, per-fresher-domain matched × full-JD × ingest-usable counts. `report` then prints every gate plus the §6 verdict from the persisted artifacts, with strict gate-grade selection (stale/invalid/sub-spec/core-only artifacts are skipped with reasons).

| Gate | Threshold |
|---|---|
| G1 Liquidity **[AMENDED 2026-07-12, ruling #17]** | ~~median bucket ≥ 20~~ → per-domain **country-level (India + remote)** unique supply ≥ 20 net-usable/week for every measured domain, with per-domain full-JD ≥ 70% and employer-share ≥ 30%; city cells are harvest/telemetry only, never verdict inputs. Fresher floor unchanged: fresher-domain variants ≥ 10/week |
| G2 Freshness | ≥ 10 net-new/bucket/week on ≥ 70% of sampled buckets (unchanged by ruling #17) |
| G3 Full-JD rate | ≥ 70% corpus-wide (measured per source post-stub-filter); priority bucket < 50% flagged |
| G4 Apply fidelity | ≥ 30% at tier employer+; dead-link rate < 10% |
| G5 Dedup burden | cross-source dup < 35% |
| G6 Spam floor | post-filter yield still meets the fresher floor per fresher domain |

Verdicts **[AMENDED 2026-07-12, ruling #17 — domain-level, supersedes the city-bucket <50% rule]**: PASS (every measured domain clears amended G1; G2/G4/G5/G6 companions hold) → build as written. PARTIAL → launch scoped to the domains that pass, re-probe monthly; never ship a tab that's empty for the majority. FAIL (< 50% of measured domains pass amended G1, or a companion gate disproves) → TheirStack $169 trial against the same gates + Naukri partner hunt informed by measured `viaSite=naukri` share. Note: the probe's `computeVerdict` amendment lands separately — until it does, `report` prints the superseded city-cell verdict. Precision caveat for pre-amendment artifacts: snapshots persist per-fingerprint only `{fp, postedAt}`, so the domain-level readout derived from them computes **unique supply exactly** but full-JD rate and employer-share only **approximately** (bucket aggregates double-count cross-city duplicates; measured cross-bucket dup 2.5%, small against the 70%/30% gate margins) — decision-grade, but marked approximate. The `computeVerdict` amendment therefore also bumps `SCHEMA_VERSION` to persist per-fingerprint `{tier, fullJd}` so post-amendment snapshots compute the amended G1 exactly; the first such snapshot is the exact baseline.

### Phase 1 — build order

1. `fetchJSONWithRetry` + models + barrel (no behavior)
2. `identityResolver` + `qualityGate` — pure, unit-tested first, **with the §4.2 false-merge amendments**
3. `jsearchAdapter` (+ fixture tests; probe validated shapes)
4. `atsBoardAdapter` + seed registry (PhonePe, Meesho, Groww, Postman, BoschGroup, Continental) + liveness invariant
5. `apnaAdapter` (sitemapJsonLd base; ≥400-char JD floor)
6. `unstopAdapter` (`regn_open` filter)
7. Inngest functions + `/api/inngest` registration (control = `JobSourceConfig.enabled`, seeded false — NO env flag, founder correction 2026-07-13) + `/cms/jobs-ingest` + digest email
8. Flip flag in prod after Inngest keys land; first sync via admin kick

### Phase 2 — telemetry-gated fast-follows

Freshersworld (WAF-liveness probe + honest ToS posture) · Shine (detail JSON-LD verified) · foundit (junk filter proven) · govt RSS shelf (Open Decision I-3) · Fantastic.jobs $95 (enterprise-brand demand shown) · SerpAPI (JSearch quarantine only — pre-create account) · TheirStack (JSearch failure / probe FAIL) · Internshala/NCS (founder-relationship track).

---

## 7. Open decisions (ingestion-scoped)

1. **JSearch tier at launch** — Pro $25 (recommended; overage is pennies, probe corrects within a month) vs Ultra $75.
2. **Atlas M0 → M2 ($9/mo)** when ingestion turns on — recommended, honestly framed as storage insurance (connection cap is identical on all shared tiers).
3. **Govt-notification shelf** — defer behind a flag (recommended) or build with Phase 1.

**Standing pre-build actions:** Vercel plan check (2 min, load-bearing for §4.4) · read apna/Unstop ToS in a browser + counsel skim · send apna/Unstop/Internshala partnership emails · run `db.stats()` and record the storage baseline.

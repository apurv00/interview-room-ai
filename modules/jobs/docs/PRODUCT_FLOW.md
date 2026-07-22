# Jobs Product Flow — Specification of Record

**Status:** Design of record, pre-build (v1.1, 2026-07-11). Counterpart to [INGESTION.md](./INGESTION.md); standing rulings and open decisions in [DECISIONS.md](./DECISIONS.md).
**The brief (founder's sketch, verbatim intent):** upload resume → build resume → Apply → prep jobs → apply → prep jobs. Apply is a first-class loop step. No auto-apply. Zero hot-path edits.
**Provenance:** Multi-agent design workflow (apply/tracking, resume integration, loop/screens) + adversarial critique with independent repo verification. Critique amendments folded in and marked **[AMENDED]**.

---

## 1. The flow of record

```
        ┌─────────────────────────────────────────────────────────────┐
        │                                                             ▼
STRANGER ─► /jobs feed ─► UPLOAD RESUME ─► confirm bar ─► ranked feed ─► job detail
 (anon,      (Tier-A       (or BUILD via     (editable      (fit bands       │
  public)     rank)         wizard, or        target role)    on parsed)     ▼
                            one question)                            ┌── VERDICT chip ──┐
                                                                     ▼                  ▼
                                                              APPLY (link-out,    PREP (JD-seeded
                                                              5-tier ladder)      20-min mock)
                                                                     │                  │
                                                         "Did you apply?" sheet   practice count
                                                                     │             ("2/3 sessions")
                                                                     ▼                  │
                                                              TRACKER row ◄────────────┘
                                                                     │
                                                     interview_scheduled ──► PREP PLAN ──► sessions
                                                                     │            (peak moment)
                                                                     ▼
                                                          outcome capture ──► loops back to feed
```

**Stage 0 — Stranger on public `/jobs`.** Anon feed, deterministic Tier-A ranking, "Looks relevant · title & location match" vocabulary only. Banner: *"Attach your resume — we'll sort these for you."* `anonId` (localStorage UUID) minted on first event.

**Geo note (standing ruling #14):** the location capture accepts ANY location — never an India-metro dropdown. Covered geos get the ranked feed; uncovered geos get the honest empty state + tracker tail, and the entry itself is recorded as expansion telemetry. The core loop (Fit, readiness, practice, tracker, tailor) is fully geo-agnostic.

**Stage 1 — Upload resume.** `/jobs/start` chooser: Upload / Build (wizard) / Import profile (authed) / one target-role question. Upload sends a PDF with a neutral filename to the stateless `/api/jobs/parse-pdf`, then sends extracted text to `/api/resume/parse` (authOptional, 10/IP/day — verified). The parsed resume remains in page memory while the reviewed role and matching skills are stored owner-scoped in **sessionStorage** for the tab; a sign-in/sign-out/account switch clears mismatched targeting. All doors converge on a review step: imported sections and parser truncation/recovery warnings are visible; feed-matching skills and **"Role you're targeting"** are editable without silently rewriting canonical resume skill groups. Absence of a parser warning is explicitly not presented as semantic accuracy. Known-loss uploads link to Builder for a deliberate re-import and full review. The one-question path gets no resume-flavored reveal copy. Personalized feed inputs travel in a bounded, private/no-store `POST /api/jobs/feed` body; the public GET accepts only page/domain and rejects legacy role/skill query parameters.

**Stage 2 — Build/save resume.** A parsed upload defaults to **"Use for this tab only"**. When no known extraction loss was reported, a signed-in user can explicitly choose **"Save to My Resumes"**, which stores the parser's canonical structure unchanged plus original text as **"Base Resume — {targetRole}"** (`preserveFullText: true`); matching-skill edits remain feed-only. Known-loss uploads go through Builder for full-section review. The client awaits a requested save, prevents double submission, binds it to the account that began the review, and stays on review after invalid/network/server failure. At the 3/3 `MAX_RESUMES` cap, it explains that the upload was not saved and asks the user to continue tab-only or free a slot. The Builder accepts only the literal `/jobs/start` generic return intent (a validated tracked `jobId` wins), never auto-redirects after incremental saves, and exposes a user-directed continuation after a successful save. Apply is never blocked on a missing resume.

**Stage 3 — Apply (sacred).** Link-out on the 5-tier ladder; `window.open` fires synchronously in the click handler (mobile popup blockers kill async opens). Nothing ever stands between intent and the employer's page. Details in §4b.

**Stage 4 — Prep.** [Practice for this job] refreshes the authenticated detail and carries a 30-minute, HMAC-signed transport token plus `InterviewConfig{ jobDescription, targetCompany, duration: 20, attribution: {source:'jobs', jobId, applicationId} }` through localStorage → `/lobby`. The token binds user, posting and a normalized SHA-256 JD identity. It is refreshed again immediately before session creation so a long lobby stay cannot expire the handoff. `POST /api/interviews` verifies it **before quota mutation**, re-reads the canonical posting, rejects any client job/JD/known-role mismatch, resolves the canonical application, and persists only server-derived attribution with `handoffVersion`, `jdHash` and `verifiedAt`. A live posting may prepare any authenticated viewer; a normally expired posting (`board-poll-miss`, `valid-through-expired`, `aged-out`, or `dead-apply-link`) may prepare only the owner of its existing `JobApplication`, using the retained JD. Security/policy closures (`source-revoked`, `llm-verdict`, or an unknown close reason) never expose JD-derived preparation, and a missing posting falls back to snapshot-only history. Restricted/snapshot history may state that an ATS check occurred, but never returns its JD-derived score or missing-keyword details. A domain-less live posting may use its cached inferred role only when `parsedJDHash` still matches that same canonical JD, the parse belongs to the current authoritative catalog revision, **and** the role maps through the closed Jobs/interview taxonomy. A normal owner-only archive cannot refresh historical evidence, so its exact-JD inferred role may survive catalog revision drift only while the current authoritative catalog still contains that slug; restricted closures never receive this exception. Every authenticated detail variant is private/no-store; the token is removed from browser storage after session creation and never enters runtime/model config. Legacy/unverified Jobs sessions remain readable but cannot mint new tracker evidence. A verified Jobs **Retake** routes back through `/jobs/{id}?practice=1&retake={rootSessionId}` instead of copying consumed browser config only when the current posting can still mint Practice for the parent session's exact JD hash: live postings remain eligible, while a normal archive also requires the authenticated candidate's existing `JobApplication`. The job page mints a fresh token, then the normal session POST independently verifies parent ownership plus the same server-verified job and exact JD hash at both parent and chain root. Changed/unreadable JDs, inactive CMS roles, restricted/deleted postings, and non-owned archives degrade to general setup instead of a dead Jobs route. That generic fallback is explicit in the setup URL so every hydrator (legacy/scoped browser state and DB last-config) strips `jobDescription`, JD filename metadata, target company/industry, Jobs attribution and the consumed handoff token while preserving safe resume/interview choices. The job-detail route preserves the same safe escape if readiness changes between the retake check and its click-time refresh. Retake intent is cleared only after session creation succeeds or returns a terminal error, so a transient failure can retry without losing lineage. Feedback page adds "Back to {job}" + the evidence tick. The first **completed, feedback-persisted, type-aware scored** practice atomically auto-saves the job to the tracker (`status: saved`, system-sourced history) if no relationship exists. The feedback handler awaits that evidence attach/enqueue boundary before returning; the reconciliation sweep remains the repair rail. A standard interview needs three scorable answers; coding/system-design needs one substantive result. A conditional `$addToSet` makes one session count once even with Mongoose timestamps and concurrent Save/Apply/Tailor writes. Attendance-only, short-form, failed, stale, corrupt, expired or cross-job handoffs create nothing. Token replay by the same user is intentionally allowed because readiness supports multiple practices for one job; the normal interview quota remains the abuse boundary.

**Generic Jobs fallback boundary.** When exact-job reuse cannot be verified, the destination is always `/interview/setup?jobsFallback=1`; the URL is authoritative even if browser storage is unavailable. The client reconstructs the parent candidate-owned resume from the stored session’s top-level document fields, then strips posting-derived JD/company/attribution/token context. Because the benchmark has changed, this path is presented as a **new general practice** and intentionally carries no retake parent or comparison lineage. The retained retake intent described above applies only to the verified exact-job path.

**Stage 5 — Track → outcome → loop.** Return-sheet claims, 21d ghost prompt, interview inference at practice time, post-interview check-in. Terminal outcomes offer a neutral route back to the live feed without claiming similarity.

### Apply-then-prep vs prep-then-apply: the verdict chip

Deterministic (no LLM), recommends without gating. **Apply is never disabled; "not ready" is banned copy.**

| Condition | Verdict |
|---|---|
| No readiness band / below confidence floor (launch majority) | Capability-aware Apply copy + "Job-specific practice completed: 0/3 sessions" |
| Low band with evidence, posting open >7 days | "Worth 2 sessions first — open till {date}." *(Based on your 3 {domain} sessions)* |
| Low band, closing ≤7d or unknown | "Apply now, then prep — closes {date}." |
| Medium/High band | **[AMENDED]** "You're interview-ready in {domain}." (domain-scoped — never job-scoped until must-have attribution ships) |
| interview_scheduled | chip replaced by Prep Plan panel |

---

## 2. Screen map + data model

### Routes — `app/(jobs)/jobs/**`

| Route | Auth | Content |
|---|---|---|
| `/jobs` | Public (deferred-auth block, `middleware.ts:143`) | Feed. Anon-no-resume → Tier-A + attach banner; anon-resume → stateless Tier-B; authed → fit bands on parsed jobs, verdict chips. Flags render as demotions, never hidden. |
| `/jobs/start` | Public | Attach chooser → confirm bar. Authed users with base resume skip to confirm. |
| `/jobs/[id]` | Public shell, authed body (Open Decision P-2) | Anon: title/company/tier badge/provenance + blurred X-ray → gate. Authed: lazy JD parse → Interview X-ray (must-haves), verified job-specific practice count, verdict chip, Apply block, Save, Tailor. Tailor metadata survives refresh; full tailored text stays behind the owner-only private read. `interview_scheduled` uses exact dates for spaced plans and reminders; week choices remain preferences. Separate low-key "View full posting ↗" link keeps Apply clicks distinct from read intent. |
| `/jobs/tracker` | Authed (client-side gate) | Single mobile-first list grouped by status with counts. Row: title, company, status chip, days-in-status, job-specific practice count, tailored-resume/application provenance, [Practice] [View]. Chip-strip transitions + undo toast. Nudges render here from recorded tracker state. |
| `/jobs/[id]/prep` | Fast-follow | Phase 1 = panel on detail. |

Nav: `{ href: '/jobs', label: 'Jobs' }` at index 1 in `NAV_LINKS` (`shared/layout/AppShell.tsx:19`). Resume surfaces: `/jobs/start` → `/resume/builder?return=…`; detail → `/resume/tailor?jobId=` (Phase 1, small additive page edit — the page is paste-only today, verified).

### `JobApplication` (new collection — NOT an extension of `SavedJobDescription`)

```ts
{
  userId, jobPostingId,                    // unique {userId, jobPostingId}; creation sets ingestion's userReferenced pin
  jobSnapshot: { title, company, location, source, applyTierAtClick?, applyUrlAtClick? },  // tracker survives posting close
  status: 'saved'|'apply_clicked'|'applied'|'interview_scheduled'|'offer'|'rejected'|'ghosted'|'withdrawn',
  statusHistory: [{ status, at, source: 'user'|'system' }],   // append-only
  appliedAt?, appliedWith?: { resumeId?, wasTailored, tailoredFromResumeId? },
  interviewDate?, interviewDateConfidence?: 'exact'|'week'|'unknown',
  interviewDatePreference?: 'this-week'|'next-week'|'unknown',
  outcome: { passedScreen?, interviewRounds?, offerReceived?, lastAskedAt?, askCount },   // askCount = anti-nag budget
  tailoredVersion?: { sourceResumeId, tailoredText, structured?, matchScore, addedKeywords[], missingKeywords[], jdHash, createdAt },
  notes?, clickedApplyOptionIds: string[],       // legacy status/telemetry only; not report authority
  applyOpenAttempts: [{ optionId, subject, generation, incidentVersion, openedAt }], // bounded trusted /open Apply attempts
  brokenLinkReports: [{ optionId?, url, tier?, reportedAt, subject?, generation?, incidentVersion?, disposition? }],
  practiceSessionIds: ObjectId[],               // all historical attendance
  verifiedPracticeSessionIds: ObjectId[],       // signed handoff v1; job-specific practice count
  readinessRevision: number,                    // CAS fence; evidence deletion invalidates stale snapshots
  readiness?: { handoffVersion: 1, band, sessions, practicedCount, mustHaveTotal, quality, strongCoverage, xrayHash, scoringEpoch, at },
  ghostSuggestedAt?
}
```

- `apply_clicked` (machine fact) vs `applied` (user claim) — never conflated. An unconfirmed click receives only the bounded confirmation card; response nudges and automatic "No response" inference require `status:'applied'` plus `appliedAt`.
- `ghosted` renders as **"No response"**. User corrections remain loose and `ghosted`/`rejected` remain recoverable, but an `apply_clicked` row cannot jump directly to `ghosted` without first becoming a confirmed application.
- Tracker GET is physically read-only. Day-35 inference runs in the daily `jobs-tracker-status-sweep`, uses account-fenced optimistic predicates, appends system history, and emits the matching audit event atomically.
- **`tailoredVersion` lives here, latest-wins, NOT counted against the 3-resume cap** — `savedResumes` is embedded in the User doc; the cap is a doc-size bound and stays meaningful for the curated library; the application record absorbs per-job volume. "Save to my resumes" escape hatch uses the normal path + existing limit UX. Truncation guards ported from the tailor page.
- Tailor persistence is bidirectional: job detail/tracker receive metadata only, while `GET /api/jobs/[id]/tailored` returns the full latest artifact only to its active owner with `private, no-store`. Live and normal archives may recover it; restricted or missing posting context remains status-only. A changed canonical JD marks the saved version outdated rather than silently presenting it as current.
- `appliedWith` is written only from an explicit apply-confirmation choice. The server exact-matches the selected Tailor timestamp and derives `tailoredFromResumeId` from the owned persisted artifact; the existence of `tailoredVersion` alone never claims that the candidate submitted it.
- **GDPR:** `JobApplication` + `ProductEvent` land in BOTH `accountDeletion.ts` cascade and `dataExportService.ts` export (outcome self-reports are Article-20 core) + completeness test asserting every model with a `userId` path appears in both. `userReferenced` is a non-personal, monotonic retention pin in close paths: clearing it inline from a cross-collection existence check races a concurrent first Save/Apply/Tailor. Ownership writes and the idempotent `repair:jobs-retention` migration set the pin and remove `purgeAt`; conservative orphan reclamation requires a separate race-safe reconciler.

### `ProductEvent`

`{ name, anonId?, userId?, jobPostingId?, applicationId?, sessionId?, props, ts }` — TTL 180d. Server-side writes wherever a route exists; client keepalive `/api/events` only for anon surfaces. Signup writes `identity_aliased{anonId,userId}` + backfill. Event vocabulary: `jobs.feed_viewed`, `jobs.resume_attach_started/completed{method}`, `jobs.target_role_confirmed{edited}`, `jobs.signup_completed{trigger}`, `jobs.job_viewed{parsed,fitBand?}`, `jobs.job_saved`, `jobs.apply_click{tier,source,verdict}`, `jobs.apply_confirmed{latencyMs,viaNudge}`, `jobs.broken_link{tier,hadFailover}`, `jobs.status_changed{from,to,source}`, `jobs.ghost_suggested/confirmed/auto`, `jobs.interview_scheduled{daysUntil,inferredFromPrep}`, `jobs.prep_started{applicationId,sessionOrdinal,evidenceCount}`, `jobs.prep_deferred_email`, `jobs.outcome_reported{passedScreen,offer}`, `jobs.tailor_run{jobId}`, `jobs.quickwins_viewed/clicked`, `jobs.ats_score_landed`, `jobs.wizard_started/completed`.

### Other model additions

- `JobSeekerProfile.baseResumeId` → `savedResumes[].id`; feed matching reads the jobs module's own extractor output, never savedResumes directly.
- `InterviewSession.attribution` extended with `applicationId`. **[AMENDED — silent-failure trap]** `InterviewConfigSchema` strips unknown keys: posting `config.attribution` without the schema edit vanishes silently → all three 60-day verdict metrics go dark. The schema edit is one optional field but the schema validates hot-path routes' requests — full accountability process applies. **Package 4's explicit deliverable: a round-trip test (localStorage config → persisted `InterviewSession.attribution`) landing before any UI writes attribution.**
- Quota seams (nothing gated at launch): `PlanConfig.{jobsTrackedApplicationsCap, jobsSavedCap, tailorsPerMonth, jobPrepSessionsNote}`; `UsageRecord` types `jd_parse`, `ats_check`, `resume_tailor`.
- **[AMENDED — cleanup]** `SavedJobDescription` + `/api/interview/saved-jds` (zero UI consumers, verified dead): hoist `IParsedJobDescription` to shared, delete the model + route (+ its cascade entry), ~0.5d — before someone forks the data model on top of them.

---

## 3. The quota reconciliation — **[AMENDED: paywall-flip blocker, verified in code]**

The enforcement machinery is **live today**: `createInterviewSession` does an atomic guarded update and throws `UsageLimitError` at the cap (`modules/interview/services/core/interviewService.ts:150-166`). But the cap is 999999 on every plan AND a dev-phase backfill actively resets lower limits to 999999 — so nothing fires today.

**The collision arrives the moment the paywall sets a real number:** the evidence ticker sells 3 sessions per job, the prep plan prescribes up to 3 per interview, and a monthly global cap breaks both at the peak moment ("You got the interview" → session 2 → `UsageLimitError`). Required before the flip (founder decision P-1):
- Either jobs-attributed sessions get a distinct allowance (the `PlanConfig` seam, wired in Phase 1), or
- Every quota-adjacent surface degrades honestly: prep plan renders "1 session before Friday — that's what you have left"; ticker shows remaining budget; the `interview_scheduled` sheet designs its limit-hit state.
- Re-derive the 3/3-evidence guardrail metric for whatever free allowance is chosen (at 3/month global it is mathematically near-impossible).

---

## 4. The three flagship moments

### 4a. Resume upload → feed reveal
Drop file → "Reading your resume…" → review imported sections and any loss warnings → edit feed-matching skills and **Role you're targeting** → choose tab-only (default) or, only when no known loss exists, explicit account save → **the reveal**. The feed may name actual matching signals, such as SQL or Tableau, but must not imply parser accuracy or persistence the user did not choose. A requested save is awaited; any failure, including the resume cap, stays on review with an actionable tab-only fallback. Re-rank honesty: claim "sharpened N matches" only when matched-skill sets actually changed; otherwise "Feed refreshed."

### 4b. The apply moment
Tier-honest button subtitles ("Opens {company}'s application form" / "Opens on {apna} — you'll need a free account" / "Via {source} — this link redirects"). Tailor is offered **beside** the button, never in front ("Tailor your resume for this job first · ~15s"). No resume → "Build a quick resume for this job" → wizard. Apply submits a native same-origin `POST /open?intent=apply` form synchronously to a new tab with `noopener noreferrer`. The server transaction resolves the current canonical option, records `apply_clicked`, the exact current option generation, and a server-resolved attempt, then returns 303 so the employer receives GET rather than a replayed POST. The client still sends the legacy `/apply-click` keepalive asynchronously for backward-compatible status/telemetry, but that directly callable edge creates no report-governance proof and never delays navigation. The low-key View full posting link uses `GET /open?intent=view` and records neither an Apply status nor governance evidence; GET Apply and POST View fail closed. A signed-in direct caller can still POST `intent=apply`, and the redirect cannot prove that the external page loaded, so this is explicitly a **server-recorded resolution attempt**, not a successful visit.

**Return-to-tab sheet** (`visibilitychange→visible` ≥20s after click, armed 45 min; <20s leads with "That was quick — did the link work?"): **[✓ Yes, applied] [Not yet] [⚠ Link didn't work]**. When a tracked Tailor version exists, Yes becomes the explicit pair **[with tailored resume] [with another resume]**; status, timestamp, history, and that claim commit atomically. Not yet → "Want an edge first?" → tailor CTA (highest-intent tailoring moment) — **[AMENDED]** this branch forks on resume existence → wizard CTA for the resume-less majority. Tailor returns to `/jobs/[id]#apply`; saving a copy carries only a validated `jobId` through Builder, never an arbitrary return URL. Link didn't work records one idempotent report and offers the next current ladder rung immediately. The response is deliberately graduated: `pending-verification` → “Thanks—we’re checking this link”; `crowd-demoted` → several distinct reports caused soft ordering only; `machine-demoted` → “A recent check found this link unavailable” (a later unverifiable observation preserves the last positive dead signal; one machine-dead observation soft-demotes but is not yet the two-sweep posting-closure verdict). A stale/404 report says it could not be submitted and never invents a global effect. Each reporter needs a matching server-resolved Apply attempt from the preceding 24 hours; three distinct qualifying users must then report within seven days for crowd soft-demotion. Reports never hide or close. Only two qualifying machine-dead sweeps ≥20h apart across every current URL may close the posting, and a later machine-alive result reverses both crowd and single-check machine soft-ordering. Legacy aggregate reports are soft-only compatibility/audit metadata, not current demotion authority, and cannot satisfy the new quorum. The return arm in browser storage is convenience state, not authority: another tab may replace or consume it, and every displayed option is rebound to a fresh server projection before any report.

**Dead-link recovery invariant:** reopening a `dead-apply-link` closure requires two authoritative alive observations at least 20 hours apart for the same current link `subject:generation`. Alive observations from alternating URLs never combine; an unverifiable result preserves only that same link's first recovery strike, while positive death, removal, or generation replacement resets it.

**Anti-nag budget:** return-sheet = ask #1; ask #2 = in-app next-visit confirm card at top of feed/tracker ("You clicked {Company} {derived age} — did you apply?"). The age is derived from the recorded click and never collapses the full seven-day eligibility window into “yesterday.” After that the row reads "Clicked · not confirmed" forever, one tap to flip.

### 4c. `interview_scheduled` → prep plan (the peak moment)
Two doors: tracker chip, and **the inference** — launching practice on an `applied` job asks one tap ("Prepping for a real interview at {Company}? [Yes — it's scheduled] [Just practicing]"), never delaying the session; date capture waits for the feedback page. The sheet distinguishes exact dates from preferences: Tomorrow or an explicit date writes `interviewDate`; This week / Next week writes only `interviewDatePreference`; Not sure leaves the exact date unset. Only an exact date produces a spaced plan and T-1 reminder. The visible counter is attendance truth — "Job-specific practice completed: 1/3 sessions" — not readiness evidence or cross-job transfer. The deferred CTA is "Email me this practice link" and success means only "Request received." T-1 skips the warm-up CTA only after a verified completed job-specific session in the last 24h.

---

## 5. Phase-1 scope

| # | Package | d |
|---|---|---|
| 1 | JobApplication model (+ tailoredVersion) + GDPR cascade/export/completeness test + saved-jds cleanup | 2.0 |
| 2 | Apply moment: tier-labeled link-out, sync open, click capture, return-sheet, broken-link failover, view-posting link | 3.0 |
| 3 | Tracker v1: grouped list, chip transitions + undo, notes, read-only 7d/21d derived nudges, and audited applied-only day-35 status sweep | 3.5 |
| 4 | Practice hand-off + attribution (`InterviewConfigSchema` field + round-trip test) + feedback-page bridge + evidence ticker | 2.0 |
| 5 | interview_scheduled sheet + deterministic prep plan + inference ask + next-visit confirm card | 2.0 |
| 6 | **time_up taper exemption fix** (scoring precondition — lands before the first attributed session can exist) | 1.0 |
| 7 | Verdict chip (5 deterministic rules; rule 3 per Open Decision P-3) | 1.0 |
| 8 | ProductEvent + `/api/events` + anon stitch + GDPR | 2.5 |
| 9 | Resume onboarding: explicit save consent + tab-only default + parse diagnostics + editable matching inputs + cap-full fallback + re-upload dedup + safe Builder return | 2.5 |
| 10 | Quick-wins engine + feed card; background ATS one-shot (Inngest) + seam | 2.0 |
| 11 | Tailor: `?jobId=` prefill, tailoredVersion persist + escape hatch + truncation guards, parse-in-parallel PDF, post-apply prompt | 3.5 |
| 12 | Wizard entry at `/jobs/start` + apply intent (segment preselect, post-export wiring) | 1.0 |
| 13 | Routes scaffold + nav + middleware entries + new-match badge | 1.5 |
| | **Product-flow round total** **[AMENDED: repriced +~15% per critique]** | **~27.5** |

Build order: 1+8 → 2+3 → 4+5+6 → 9+10+12 → 11 → 7+13. **Fast-follow:** the entire email wave (digest, ghost sweep, T-1 reminders, deferred practice link, match alerts — behind `RESEND_API_KEY`, ~6–7d) · per-answer→must-have attribution (~2–3d) → job-scoped coverage snapshot · re-rank delta copy · readiness-aware feed re-ranking · `/jobs/[id]/prep` page. **Never:** kanban drag-drop, employer-odds anything, auto-apply.

### Total Jobs feature estimate (honest)

| Round | Raw eng-days |
|---|---|
| Ingestion | ~10 |
| Feed UI + onboarding (prior round) | ~19.5 |
| Product flow (this spec) | ~27.5 |
| **Raw total** | **~57** |
| × 1.6–2.0 measured accountability overhead (impact scripts, tests-per-commit, Codex cycles) | **~90–115 eng-days** |

**Plainly: ~4.5–6 calendar months of solo full-time work** to Phase 1 + first fast-follow wave. The core loop (packages 1–8 on top of ingestion + feed) closes at roughly the 60% mark. The job-detail X-ray page is owned by the feed-UI round (not double-counted here).

---

## 6. Metrics

Every readout segmented **fresher (0–2) vs professional — never blended**; at current scale read absolute counts alongside rates.

| Step | Healthy | Kill / alarm |
|---|---|---|
| Stranger → attach completed | ≥25% | <10% @ 4wks |
| Attach → signup (7d) | ≥40% | <15% |
| Signup → first action (save/apply-click) | ≥60% | <30% |
| Save → apply-click | ≥50% | <25% |
| Apply-click → confirmed | ≥60% (re-baseline after 2wks channel-loss data) | <30% — check broken-link rate by tier first |
| **Save → practice** | **≥30% — THE differentiator** | **<10% @ 4wks → we built a job board, not a prep loop** |
| Practice → return ≤7d | ≥40% | <20% |
| Applied → interview_scheduled ≤21d | ≥8% | <2% (freshers run lower — segment baseline) |
| Applied → outcome reported ≤30d | ≥25% | <10% |
| W1 return | ≥35% | <15% |

Guardrails: verdict-rule-3 fire rate (never fires by wk 3 → readiness data isn't accruing) · % practicing users with 3/3 verified job-specific sessions on ≥1 job in 14d (re-derive per quota decision) · broken-link rate by tier (feeds ingestion QA) · JD-parse cost/user.

**The three 60-day verdict numbers:** (1) save→practice ≥30%; (2) apply-clicked→confirmed ≥60% with absolute confirmed-applies growing week-over-week; (3) interview_scheduled absolute count with ≥half arriving via the practice-inference channel.

---

## 7. Open decisions (product-flow scoped)

- **P-1 (promoted, pre-paywall-flip):** jobs-session quota economics — distinct allowance for jobs-attributed sessions vs honest degradation surfaces. See §3.
- **P-2:** public anon `/jobs` exposure — fully public detail pages vs public feed + auth-gated detail (middle option recommended pending SEO/scrape posture).
- **P-3:** verdict rule 3 ("Worth 2 sessions first") at launch vs behind a flag until verdict-distribution data exists (degrades gracefully to rule 2's copy).
- **P-4:** 35-day silent auto-ghost (reversible) vs suggest-only forever.

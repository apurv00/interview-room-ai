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
                            3 questions)                             ┌── VERDICT chip ──┐
                                                                     ▼                  ▼
                                                              APPLY (link-out,    PREP (JD-seeded
                                                              5-tier ladder)      20-min mock)
                                                                     │                  │
                                                         "Did you apply?" sheet   evidence tick
                                                                     │             ("2/3 on this job")
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

**Stage 1 — Upload resume.** `/jobs/start` chooser: Upload / Build (wizard) / Import profile (authed) / 3 questions. Anon upload = client-side text extraction → `/api/resume/parse` (authOptional, 10/IP/day — verified), structure held in **sessionStorage** (dies with tab; stranger PII never persists server-side — the builder's stale-draft PII modal exists precisely because localStorage outlives strangers). All doors converge on the **confirm bar**: extracted facts read-only + **editable "Role you're targeting"** (resume = past, target = future; `interviewGoal: career_switch` exists). **[AMENDED]** The 3-questions path gets no resume-flavored reveal copy (its rank is effectively Tier-A + role filter — don't claim "sorted by your resume").

**Stage 2 — Build resume.** Signed-in: parsed upload auto-saves as **"Base Resume — {targetRole}"** (`preserveFullText: true`). At the 3/3 `MAX_RESUMES` cap (verified `resumeService.ts:6`; updates bypass the cap, `:111-119`): no auto-save, no block — extraction still feeds ranking, dismissible notice explains. Deterministic quick-wins engine (zero LLM) renders a non-blocking feed card → builder deep-link. Background one-shot ATS check via Inngest (the ~35s Sonnet `checkATS` never runs inline). **[AMENDED]** Freshers (54%, mostly resume-less): the Resume Wizard (`fresh_grad` segment) is a **primary door** with destination-honest copy ("you'll need a resume on Naukri anyway — build one in 10 minutes"), not just an apply-time fallback. Apply is never blocked on a missing resume.

**Stage 3 — Apply (sacred).** Link-out on the 5-tier ladder; `window.open` fires synchronously in the click handler (mobile popup blockers kill async opens). Nothing ever stands between intent and the employer's page. Details in §4b.

**Stage 4 — Prep.** [Practice for this job] refreshes the authenticated detail and carries a 30-minute, HMAC-signed transport token plus `InterviewConfig{ jobDescription, targetCompany, duration: 20, attribution: {source:'jobs', jobId, applicationId} }` through localStorage → `/lobby`. The token binds user, posting and a normalized SHA-256 JD identity. It is refreshed again immediately before session creation so a long lobby stay cannot expire the handoff. `POST /api/interviews` verifies it **before quota mutation**, re-reads the canonical posting, rejects any client job/JD/known-role mismatch, resolves the canonical application, and persists only server-derived attribution with `handoffVersion`, `jdHash` and `verifiedAt`. A live posting may prepare any authenticated viewer; a normally expired posting (`board-poll-miss`, `valid-through-expired`, `aged-out`, or `dead-apply-link`) may prepare only the owner of its existing `JobApplication`, using the retained JD. Security/policy closures (`source-revoked`, `llm-verdict`, or an unknown close reason) never expose JD-derived preparation, and a missing posting falls back to snapshot-only history. Restricted/snapshot history may state that an ATS check occurred, but never returns its JD-derived score or missing-keyword details. A domain-less live posting may use its cached inferred role only when `parsedJDHash` still matches that same canonical JD, the parse belongs to the current authoritative catalog revision, **and** the role maps through the closed Jobs/interview taxonomy. A normal owner-only archive cannot refresh historical evidence, so its exact-JD inferred role may survive catalog revision drift only while the current authoritative catalog still contains that slug; restricted closures never receive this exception. Every authenticated detail variant is private/no-store; the token is removed from browser storage after session creation and never enters runtime/model config. Legacy/unverified Jobs sessions remain readable but cannot mint new tracker evidence. A verified Jobs **Retake** routes back through `/jobs/{id}?practice=1&retake={rootSessionId}` instead of copying consumed browser config only when the current posting can still mint Practice for the parent session's exact JD hash: live postings remain eligible, while a normal archive also requires the authenticated candidate's existing `JobApplication`. The job page mints a fresh token, then the normal session POST independently verifies parent ownership plus the same server-verified job and exact JD hash at both parent and chain root. Changed/unreadable JDs, inactive CMS roles, restricted/deleted postings, and non-owned archives degrade to general setup instead of a dead Jobs route. That generic fallback is explicit in the setup URL so every hydrator (legacy/scoped browser state and DB last-config) strips `jobDescription`, JD filename metadata, target company/industry, Jobs attribution and the consumed handoff token while preserving safe resume/interview choices. The job-detail route preserves the same safe escape if readiness changes between the retake check and its click-time refresh. Retake intent is cleared only after session creation succeeds or returns a terminal error, so a transient failure can retry without losing lineage. Feedback page adds "Back to {job}" + the evidence tick. The first **completed, feedback-persisted, type-aware scored** practice atomically auto-saves the job to the tracker (`status: saved`, system-sourced history) if no relationship exists. The feedback handler awaits that evidence attach/enqueue boundary before returning; the reconciliation sweep remains the repair rail. A standard interview needs three scorable answers; coding/system-design needs one substantive result. A conditional `$addToSet` makes one session count once even with Mongoose timestamps and concurrent Save/Apply/Tailor writes. Attendance-only, short-form, failed, stale, corrupt, expired or cross-job handoffs create nothing. Token replay by the same user is intentionally allowed because readiness supports multiple practices for one job; the normal interview quota remains the abuse boundary.

**Generic Jobs fallback boundary.** When exact-job reuse cannot be verified, the destination is always `/interview/setup?jobsFallback=1`; the URL is authoritative even if browser storage is unavailable. The client reconstructs the parent candidate-owned resume from the stored session’s top-level document fields, then strips posting-derived JD/company/attribution/token context. Because the benchmark has changed, this path is presented as a **new general practice** and intentionally carries no retake parent or comparison lineage. The retained retake intent described above applies only to the verified exact-job path.

**Stage 5 — Track → outcome → loop.** Return-sheet claims, 21d ghost prompt, interview inference at practice time, post-interview check-in. Every terminal outcome routes back to the feed ("keep prepping — 3 similar live jobs").

### Apply-then-prep vs prep-then-apply: the verdict chip

Deterministic (no LLM), recommends without gating. **Apply is never disabled; "not ready" is banned copy.**

| Condition | Verdict |
|---|---|
| No readiness band / below confidence floor (launch majority) | "Apply now — prep while you wait." + evidence ticker 0/3 |
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
| `/jobs/[id]` | Public shell, authed body (Open Decision P-2) | Anon: title/company/tier badge/provenance + blurred X-ray → gate. Authed: lazy JD parse → Interview X-ray (must-haves), readiness band or evidence ticker, verdict chip, Apply block, Save, Tailor. `interview_scheduled` swaps to the exact-JD Prep Plan only when the signed Practice contract is ready; otherwise it preserves interview-date capture and routes truthfully to general setup without promising JD-built mocks. **[AMENDED]** Separate low-key "View full posting ↗" link so Apply clicks aren't polluted by read-intent. |
| `/jobs/tracker` | Authed (client-side gate) | Single mobile-first list grouped by status with counts. Row: title, company, status chip, days-in-status, evidence ticker, [Practice] [View]. Chip-strip transitions + undo toast. Nudges render here (read-time derived). |
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
  outcome: { passedScreen?, interviewRounds?, offerReceived?, lastAskedAt?, askCount },   // askCount = anti-nag budget
  tailoredVersion?: { sourceResumeId, tailoredText, structured?, matchScore, addedKeywords[], missingKeywords[], jdHash, createdAt },
  notes?, brokenLinkReports: [{ url, reportedAt }],
  practiceSessionIds: ObjectId[],               // all historical attendance
  verifiedPracticeSessionIds: ObjectId[],       // signed handoff v1; evidence ticker only
  readinessRevision: number,                    // CAS fence; evidence deletion invalidates stale snapshots
  readiness?: { handoffVersion: 1, band, sessions, practicedCount, mustHaveTotal, quality, strongCoverage, xrayHash, scoringEpoch, at },
  ghostSuggestedAt?
}
```

- `apply_clicked` (machine fact) vs `applied` (user claim) — never conflated. An unconfirmed click receives only the bounded confirmation card; response nudges and automatic "No response" inference require `status:'applied'` plus `appliedAt`.
- `ghosted` renders as **"No response"**. User corrections remain loose and `ghosted`/`rejected` remain recoverable, but an `apply_clicked` row cannot jump directly to `ghosted` without first becoming a confirmed application.
- Tracker GET is physically read-only. Day-35 inference runs in the daily `jobs-tracker-status-sweep`, uses account-fenced optimistic predicates, appends system history, and emits the matching audit event atomically.
- **`tailoredVersion` lives here, latest-wins, NOT counted against the 3-resume cap** — `savedResumes` is embedded in the User doc; the cap is a doc-size bound and stays meaningful for the curated library; the application record absorbs per-job volume. "Save to my resumes" escape hatch uses the normal path + existing limit UX. Truncation guards ported from the tailor page.
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
Drop file → "Reading your resume…" (~5–10s) → confirm bar (one screen: facts read-only; editable **Role you're targeting** + locations) → **the reveal**: feed re-ranks with evidence-naming header — *"Sorted for you — based on your resume: SQL, Tableau, campaign analytics."* Unparsed cards keep relevance vocabulary; bands only on parsed jobs after auth. Signed-in side effects: base-resume auto-save, quick-wins card ("Resume: 6 quick wins → Fix in builder"), background ATS score. Re-rank honesty: claim "sharpened N matches" only when matched-skill sets actually changed; otherwise "Feed refreshed."

### 4b. The apply moment
Tier-honest button subtitles ("Opens {company}'s application form" / "Opens on {apna} — you'll need a free account" / "Via {source} — this link redirects"). Tailor offered **beside** the button, never in front ("Tailor your resume for this job first · ~15s"). No resume → "Build a quick resume for this job" → wizard. Click → keepalive `apply_clicked` upsert + snapshot → button becomes "Applied? Confirm when you're back."

**Return-to-tab sheet** (`visibilitychange→visible` ≥20s after click, armed 45 min; <20s leads with "That was quick — did the link work?"): **[✓ Yes, applied] [Not yet] [⚠ Link didn't work]**. Yes → `applied`. Not yet → "Want an edge first?" → tailor CTA (highest-intent tailoring moment) — **[AMENDED]** this branch forks on resume existence → wizard CTA for the resume-less majority. Link didn't work → demote dead option, offer the next ladder rung instantly ("Try this instead: Apply on {company}'s careers page"); no rung left → "This posting's links have gone stale. [Mark as closed] [Keep saved]." One user's dead click heals the link for everyone.

**Anti-nag budget:** return-sheet = ask #1; **[AMENDED]** ask #2 = in-app next-visit confirm card at top of feed/tracker ("You clicked {Company} yesterday — did you apply?") since the email digest is fast-follow and Android app deep-links (Naukri/apna open in native apps) mean the return-sheet often never fires; after that the row reads "Clicked · not confirmed" forever, one tap to flip. Re-baseline the confirm-rate threshold after 2 weeks of measured channel loss.

### 4c. `interview_scheduled` → prep plan (the peak moment)
Two doors: tracker chip, and **the inference** — launching practice on an `applied` job asks one tap ("Prepping for a real interview at {Company}? [Yes — it's scheduled] [Just practicing]"), never delaying the session; date capture waits for the feedback page. The sheet: "🎙 You got the interview. Let's make sure you're ready. When is it? [Tomorrow] [This week] [Next week] [Pick a date] [Not sure yet]." The plan is instant and deterministic: ≥3 days → 3 sessions (today / midpoint / day-before); ≤2 days → two focused sessions; unsure → start now. **[AMENDED]** Phase-1 copy = "3 mocks built from this JD" — NO per-session must-have tags until a focus channel exists (`InterviewConfig` carries only raw `jobDescription`; generate-question's JD targeting is global; cheapest zero-hot-path option later: prepend a FOCUS header into the jobDescription text). **[AMENDED]** Unify on ONE persisted JD parse passed through the hand-off — session-create already parses `config.jobDescription` independently; two parsers on the same JD = double spend + visible disagreement between the X-ray and the interviewer. Deferred CTA is load-bearing: "Email me tonight's practice link" (voice mock needs a mic + quiet room; interview news arrives on a phone). Evidence line always visible: "Evidence toward Readiness on this job: 1/3 sessions." T-1 reminder skipped if a session happened in the last 24h. Post-date check-in leads with the outcome ask only ("How did the {Company} interview go?"); "Advanced" → `interviewRounds++` + new-date capture (multi-round is the Indian norm).

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
| 9 | Resume onboarding: base-resume auto-save + anon sessionStorage claim + cap-full fallback + re-upload dedup + confirm bar | 2.5 |
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

Guardrails: verdict-rule-3 fire rate (never fires by wk 3 → readiness data isn't accruing) · % practicing users at 3/3 evidence on ≥1 job in 14d (re-derive per quota decision) · broken-link rate by tier (feeds ingestion QA) · JD-parse cost/user.

**The three 60-day verdict numbers:** (1) save→practice ≥30%; (2) apply-clicked→confirmed ≥60% with absolute confirmed-applies growing week-over-week; (3) interview_scheduled absolute count with ≥half arriving via the practice-inference channel.

---

## 7. Open decisions (product-flow scoped)

- **P-1 (promoted, pre-paywall-flip):** jobs-session quota economics — distinct allowance for jobs-attributed sessions vs honest degradation surfaces. See §3.
- **P-2:** public anon `/jobs` exposure — fully public detail pages vs public feed + auth-gated detail (middle option recommended pending SEO/scrape posture).
- **P-3:** verdict rule 3 ("Worth 2 sessions first") at launch vs behind a flag until verdict-distribution data exists (degrades gracefully to rule 2's copy).
- **P-4:** 35-day silent auto-ghost (reversible) vs suggest-only forever.

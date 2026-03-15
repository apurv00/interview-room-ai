# Phase 2 — Candidate Growth & Retention

> **Status**: Planning
> **Target**: Q2 2026
> **Depends on**: Phase 1 (Modular Monolith, CMS, Interview Domains/Depth) — complete

---

## Executive Summary

Phase 2 transforms Interview Prep Guru from a "practice and leave" tool into a **continuous improvement platform**. The 9 initiatives below focus on giving candidates reasons to return (analytics, learning paths, benchmarking), reducing friction (mobile, prep checklist), and enabling viral growth (shareable scorecards, email re-engagement).

---

## Initiatives (9)

### 1. Personal Analytics Dashboard

**Goal**: Let candidates visualize their progress over time — score trends, competency radar, session history.

**What exists today**:
- `UserCompetencyState` model tracks per-competency EMA scores, trend (`improving`/`stable`/`declining`), confidence intervals, and 20-point score history (`competencyService.ts:84-99`)
- `SessionSummary` model stores per-session domain, overall score, pass probability, strengths/weaknesses, communication markers
- `UsageRecord` model tracks token/cost per API call with session linkage
- B2B recruiter dashboard at `api/hire/dashboard/route.ts` (aggregates candidate stats — reusable pattern)

**What to build**:

| Deliverable | Details |
|---|---|
| `GET /api/learn/analytics` | Aggregate endpoint: score time-series, competency breakdown, session count, streak, communication trend |
| `<AnalyticsDashboard>` page | Route: `/dashboard`. Charts: line chart (score over time), radar (competency snapshot), bar (sessions per week), stat cards (total sessions, avg score, streak) |
| Chart library | Recharts (lightweight, React-native, SSR-friendly) — add as dependency |
| Streak tracking | Add `currentStreak` and `longestStreak` fields to `User` model. Increment on session completion, reset after 48h gap |

**Key files to modify**:
- `shared/db/models/User.ts` — add streak fields
- `modules/learn/services/` — new `analyticsService.ts`
- `app/api/learn/analytics/route.ts` — new endpoint
- `app/(learn)/dashboard/page.tsx` — new page

**Effort**: Medium (3–4 days)

---

### 2. Answer Retry / Drill Mode

**Goal**: Let candidates re-attempt weak answers from past sessions without running a full interview.

**What exists today**:
- `InterviewSession` model stores full Q&A transcript with per-answer evaluations (relevance, structure, specificity, ownership scores)
- `WeaknessCluster` model tracks recurring weaknesses with severity, recurrence count, evidence trail (`competencyService.ts:215-273`)
- `PathwayPlan.practiceTasks` already generates drill-type tasks targeting specific competencies (`pathwayPlanner.ts:281-328`)
- Evaluation engine scores individual answers independently — can be reused for drill scoring

**What to build**:

| Deliverable | Details |
|---|---|
| `GET /api/learn/drill/questions` | Pull weak questions from past sessions (filter by score < 60, group by competency) |
| `POST /api/learn/drill/evaluate` | Submit new answer for a specific question, return comparative score (before vs after) |
| `<DrillMode>` page | Route: `/practice/drill`. Shows question, original answer + score, text input for new answer, side-by-side comparison |
| Drill history | New `DrillAttempt` model: questionId, original score, new score, delta, timestamp |

**Key files to modify**:
- `shared/db/models/` — new `DrillAttempt.ts`
- `modules/learn/services/` — new `drillService.ts`
- `app/api/learn/drill/` — new route handlers
- `app/(learn)/practice/drill/page.tsx` — new page

**Effort**: Medium (3–4 days)

---

### 3. Comparative Feedback

**Goal**: Show candidates how their latest session compares to their personal history — "You improved +12 on structure since last week."

**What exists today**:
- `SessionSummary` stores per-session scores, strengths, weaknesses, communication markers (`sessionSummaryService.ts`)
- `getRecentSummaries(userId, domain, limit)` retrieves last N summaries — already used by pathway planner
- `UserCompetencyState.scoreHistory` stores last 20 data points with timestamps per competency
- Feedback page already renders dimension scores — extend, don't replace

**What to build**:

| Deliverable | Details |
|---|---|
| `computeComparison()` | Utility: diff current session scores against previous session + 5-session rolling average. Returns per-dimension delta with direction arrows |
| `<ComparisonCard>` component | Render on feedback page: "+8 relevance vs last session", "-3 structure vs 5-session avg". Green/red color coding, sparkline trend |
| Baseline snapshot | On first session, store as personal baseline. All future comparisons reference it as "since you started" |

**Key files to modify**:
- `modules/learn/services/sessionSummaryService.ts` — add comparison logic
- `modules/learn/components/feedback/` — new `ComparisonCard.tsx`
- `app/(learn)/feedback/[id]/page.tsx` — integrate comparison card

**Effort**: Low (1–2 days)

---

### 4. Guided Learning Paths UI

**Goal**: Surface the existing pathway planner as a visible, actionable UI — candidates see a roadmap from "not ready" to "strong candidate."

**What exists today (90% backend complete)**:
- `pathwayPlanner.ts` generates full plans: readiness level, blocking weaknesses, practice tasks, milestones (Foundation/Competent/Ready/Strong), difficulty progression, AI-enhanced suggestions via Claude
- `PathwayPlan` model persists plans with upsert-per-user
- `markTaskComplete()` API for task progress tracking
- `getCurrentPathway()` retrieves active plan
- `generateAIPlan()` creates personalized tasks via Claude Sonnet

**What to build**:

| Deliverable | Details |
|---|---|
| `<PathwayDashboard>` page | Route: `/learn/pathway`. Milestone progress bar (4 stages), task checklist with completion toggles, next session recommendation card, readiness gauge |
| `GET /api/learn/pathway` | Expose `getCurrentPathway()` — already exists, needs route |
| `POST /api/learn/pathway/task/:id/complete` | Expose `markTaskComplete()` — already exists, needs route |
| Task-to-drill linking | "Start drill" button on practice tasks that routes to drill mode (#2) with pre-selected competency |

**Key files to modify**:
- `app/api/learn/pathway/route.ts` — new endpoint
- `app/(learn)/learn/pathway/page.tsx` — new page
- `modules/learn/components/` — new `PathwayDashboard.tsx`, `MilestoneBar.tsx`, `TaskList.tsx`

**Effort**: Low–Medium (2–3 days) — backend is 90% done

---

### 5. Shareable Scorecards

**Goal**: Let candidates share a public, read-only scorecard from a session — for LinkedIn, portfolios, or recruiter review.

**What exists today**:
- `InterviewSession` stores full evaluation data, domain, depth, experience, scores
- `SessionSummary` stores aggregated scores, strengths, weaknesses, pass probability
- B2B invite/template system provides a sharing pattern (`hireService.createInvite`)
- No public/anonymous access routes exist yet

**What to build**:

| Deliverable | Details |
|---|---|
| Scorecard model | Add `shareToken` (nanoid, 12 chars) and `isPublic` boolean to `InterviewSession` |
| `POST /api/learn/share` | Generate share token for a session. Returns public URL |
| `GET /api/public/scorecard/[token]` | Public endpoint (no auth). Returns sanitized scorecard data: domain, depth, overall score, dimension scores, strengths. Excludes transcript |
| `<PublicScorecard>` page | Route: `/scorecard/[token]`. Branded card with scores, radar chart, "Verified by Interview Prep Guru" badge. OG meta tags for link previews |
| Share buttons | Copy link, LinkedIn share, Twitter/X share on feedback page |
| Expiry | Tokens expire after 90 days. Cron or TTL index on MongoDB |

**Key files to modify**:
- `shared/db/models/InterviewSession.ts` — add shareToken, isPublic fields
- `app/api/public/scorecard/[token]/route.ts` — new public route
- `app/scorecard/[token]/page.tsx` — new public page
- `modules/learn/components/feedback/` — new `ShareButton.tsx`

**Effort**: Medium (3–4 days)

---

### 6. Email Digest & Practice Reminders

**Goal**: Re-engage dormant users with personalized nudges — "Your structure score dropped this week. Try a 10-min drill."

**What exists today**:
- `User` model has email, emailVerified fields
- Competency data provides personalized content (weak areas, trends, streaks)
- Usage tracking knows last session date
- No email infrastructure exists

**What to build**:

| Deliverable | Details |
|---|---|
| Email service | Integrate Resend (or SendGrid). Create `shared/services/emailService.ts` with typed send function |
| Email templates | 3 templates: (a) weekly progress digest, (b) inactivity nudge (3+ days), (c) milestone achieved. Use React Email for templating |
| User preferences | Add `emailPreferences` to User model: `{ digest: boolean, reminders: boolean, frequency: 'daily' \| 'weekly' }` |
| Trigger logic | `modules/learn/services/emailTriggerService.ts` — evaluate conditions post-session and on cron schedule |
| Cron endpoint | `GET /api/cron/email-digest` — Vercel Cron (daily at 9am UTC). Batch process eligible users |
| Unsubscribe | One-click unsubscribe via signed token in email footer |

**Key files to modify**:
- `shared/db/models/User.ts` — add emailPreferences
- `shared/services/` — new `emailService.ts`
- `modules/learn/services/` — new `emailTriggerService.ts`
- `app/api/cron/email-digest/route.ts` — new cron route
- `vercel.json` — add cron config

**Effort**: Medium–High (4–5 days)

---

### 7. Peer Benchmarking

**Goal**: Show "You scored in the top 30% for PM behavioral interviews" — makes individual scores meaningful via social context.

**What exists today (40% complete)**:
- `computePercentile()` in `learn/lib/peerComparison.ts` — O(log n) binary search percentile calculation, handles ties
- `<PeerComparison>` component renders color-coded tier badges (high/medium/low)
- `PeerData` interface defined with count, averages (overall, answerQuality, communication, engagement)
- `api/benchmark/route.ts` exists for platform admins

**What to build**:

| Deliverable | Details |
|---|---|
| Aggregation pipeline | MongoDB aggregation: group `SessionSummary` by domain + interviewType + experience, compute sorted score arrays. Cache in Redis (TTL 6h) |
| `GET /api/learn/benchmark` | Candidate-facing endpoint. Input: userId, domain, interviewType. Output: percentile, peer count, score distribution buckets |
| Dimension percentiles | Extend to per-dimension (relevance, structure, etc.) not just overall |
| Dashboard integration | Add peer benchmark card to analytics dashboard (#1) and feedback page |
| Minimum threshold | Require 30+ peers in cohort before showing percentile (avoid misleading small-sample stats) |

**Key files to modify**:
- `modules/learn/lib/peerComparison.ts` — add aggregation pipeline
- `modules/learn/services/` — new `benchmarkService.ts` (not to be confused with `cms/services/benchmarkService`)
- `app/api/learn/benchmark/route.ts` — new endpoint
- `modules/learn/components/feedback/PeerComparison.tsx` — enhance with real data

**Effort**: Medium (3–4 days)

---

### 8. Interview Prep Checklist

**Goal**: Pre-interview guidance page that reduces first-session drop-off — tips, warm-up, and environment checks.

**What exists today (50% lobby complete)**:
- Lobby page (`app/lobby/page.tsx`) already handles: camera/mic permission, audio level visualizer, domain/depth/experience selection, document upload (resume, JD)
- Config persists to localStorage (`INTERVIEW_CONFIG`)
- No pre-interview tips, warm-up questions, or environmental guidance

**What to build**:

| Deliverable | Details |
|---|---|
| `<PrepChecklist>` component | Renders inside lobby, before "Start Interview" button. Expandable accordion sections |
| Checklist items | (a) Environment: quiet room, good lighting, neutral background. (b) Tech: stable internet, headphones recommended. (c) Content: review JD, prepare 3 STAR stories, know your resume highlights. (d) Mindset: treat as practice, mistakes are learning |
| Warm-up question | One random behavioral question with a 60-second timer. Not scored. Helps users warm up their speaking cadence |
| Domain-specific tips | Pull 2–3 tips based on selected domain (e.g., PM: "Prepare a metrics framework", SWE: "Have a system design example ready") |
| Estimated duration | Show "~15–25 minutes" based on interview depth selection |
| Progress gate | Optional: require 3/4 checklist sections checked before enabling Start (soft gate, can skip) |

**Key files to modify**:
- `app/lobby/page.tsx` — integrate checklist
- `modules/interview/components/` — new `PrepChecklist.tsx`, `WarmUpQuestion.tsx`
- `modules/interview/config/` — new `prepTips.ts` (domain-specific tips config)

**Effort**: Low (1–2 days)

---

### 9. Mobile-Responsive Interview Experience

**Goal**: Make the full interview flow usable on phones/tablets — unblock mobile users (estimated 40%+ of traffic).

**What exists today (30% responsive)**:
- TailwindCSS 3.4 configured with standard breakpoints (sm/md/lg/xl/2xl)
- Some components use responsive prefixes (`hidden sm:inline-block` in InterviewControls, `md:hidden` in ResumeEditor)
- Button sizes are touch-friendly (px-5 py-2.5)
- No systematic mobile-first audit. Avatar assumes desktop viewport. Feedback page untested on mobile

**What to build**:

| Deliverable | Details |
|---|---|
| Mobile audit | Test all interview flow pages (lobby → interview → feedback → dashboard) at 375px and 768px viewports. Document breakages |
| Layout overhaul | Interview page: stack avatar above transcript on mobile (currently side-by-side). Controls as bottom-fixed bar. Collapsible transcript |
| Avatar scaling | Scale SVG avatar to fit mobile viewport. Reduce idle animation complexity on small screens for performance |
| Feedback page | Score cards: 1-column stack on mobile (currently grid). Radar chart: reduce size, add touch zoom. Transcript: accordion collapse |
| Lobby page | Full-width form inputs. Camera preview: reduce to 50% width. Checklist (#8): accordion natively works |
| Touch interactions | Ensure all buttons have min 44x44px touch targets. Add swipe-to-dismiss for coaching nudges. Long-press for tooltips |
| Testing | Visual regression tests at 375px (iPhone SE), 390px (iPhone 14), 768px (iPad) using Playwright or manual |

**Key files to modify**:
- `modules/interview/components/interview/` — InterviewControls, TranscriptPanel, Avatar
- `modules/interview/components/feedback/` — all feedback components
- `app/lobby/page.tsx` — responsive layout
- `app/(learn)/` — dashboard and pathway pages
- `tailwind.config.ts` — verify/add custom breakpoints if needed

**Effort**: Medium–High (4–5 days)

---

## Dependency Graph

```
                    ┌─────────────┐
                    │  8. Prep     │  (no deps, start immediately)
                    │  Checklist   │
                    └─────────────┘

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ 1. Analytics │────▶│ 7. Peer     │     │ 3. Compare  │
│  Dashboard   │     │ Benchmarking│     │  Feedback   │
└──────┬───── ┘     └─────────────┘     └──────┬──────┘
       │                                        │
       ▼                                        ▼
┌─────────────┐                         ┌─────────────┐
│ 4. Learning │◀────────────────────────│ 2. Drill    │
│  Paths UI   │                         │    Mode     │
└─────────────┘                         └─────────────┘

┌─────────────┐     ┌─────────────┐
│ 5. Shareable│     │ 6. Email    │  (independent, can parallelize)
│ Scorecards  │     │   Digest    │
└─────────────┘     └─────────────┘

┌─────────────┐
│ 9. Mobile   │  (do last — applies responsive polish to all new UI)
│ Responsive  │
└─────────────┘
```

## Suggested Build Order

| Sprint | Initiatives | Rationale |
|--------|------------|-----------|
| **Sprint 1** (Week 1–2) | 8. Prep Checklist, 3. Comparative Feedback, 1. Analytics Dashboard | Quick wins first. Checklist is standalone. Comparative feedback is low-effort. Analytics dashboard unlocks #7 |
| **Sprint 2** (Week 3–4) | 2. Drill Mode, 4. Learning Paths UI | Core learning loop. Drill mode feeds into pathway tasks. Pathway UI is mostly frontend (backend 90% done) |
| **Sprint 3** (Week 5–6) | 7. Peer Benchmarking, 5. Shareable Scorecards | Social features. Benchmarking needs analytics infra from Sprint 1. Scorecards are independent |
| **Sprint 4** (Week 7–8) | 6. Email Digest, 9. Mobile Responsive | Email is independent infra work. Mobile responsive is final polish pass across all new Phase 2 UI |

---

## New Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `recharts` | Charts for analytics dashboard | ~280KB gzipped |
| `resend` (or `@sendgrid/mail`) | Transactional email delivery | ~15KB |
| `react-email` | Email template components | ~50KB (dev only) |
| `nanoid` | Share token generation for scorecards | ~1KB |

---

## New Database Models / Fields

| Change | Model | Fields |
|--------|-------|--------|
| Add fields | `User` | `currentStreak: Number`, `longestStreak: Number`, `lastSessionDate: Date`, `emailPreferences: { digest: Boolean, reminders: Boolean, frequency: String }` |
| Add fields | `InterviewSession` | `shareToken: String (unique, sparse)`, `isPublic: Boolean`, `shareExpiresAt: Date` |
| New model | `DrillAttempt` | `userId, sessionId, questionIndex, originalScore, newAnswer, newScore, delta, competency, createdAt` |

---

## New API Routes

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/learn/analytics` | User | Personal analytics (score trends, competency radar, streaks) |
| GET | `/api/learn/drill/questions` | User | Weak questions from past sessions |
| POST | `/api/learn/drill/evaluate` | User | Submit drill answer, get comparative score |
| GET | `/api/learn/pathway` | User | Get current learning pathway |
| POST | `/api/learn/pathway/task/:id/complete` | User | Mark pathway task complete |
| GET | `/api/learn/benchmark` | User | Peer percentile for user's domain/depth |
| POST | `/api/learn/share` | User | Generate scorecard share token |
| GET | `/api/public/scorecard/[token]` | None | Public scorecard data |
| GET | `/api/cron/email-digest` | Cron | Daily email digest processor |

---

## New Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/dashboard` | `AnalyticsDashboard` | Personal progress charts and stats |
| `/practice/drill` | `DrillMode` | Re-attempt weak answers |
| `/learn/pathway` | `PathwayDashboard` | Learning roadmap with tasks and milestones |
| `/scorecard/[token]` | `PublicScorecard` | Shareable public scorecard (no auth) |

---

## Success Metrics

| Metric | Baseline (Phase 1) | Phase 2 Target |
|--------|-------------------|----------------|
| 7-day retention | TBD | +25% |
| Sessions per user/month | ~1.5 | 3+ |
| Drill completions/week | 0 | 50+ |
| Scorecard shares/week | 0 | 30+ |
| Email open rate | N/A | 35%+ |
| Mobile session completion | ~20% (est.) | 60%+ |

---

## Deferred to Phase 3

| # | Initiative | Reason for Deferral |
|---|-----------|---------------------|
| 7 | **Question Bookmarking** | Nice-to-have; drill mode covers the "save for later" use case. Revisit after drill adoption data |
| 10 | **Multi-Language Support** | High TAM impact but requires i18n infrastructure + AI prompt localization. Needs dedicated sprint |
| 12 | **Social Proof / Testimonials** | Depends on having enough users to generate meaningful stats. Better after organic growth from Phase 2 |
| 13 | **Interview Recording Playback** | Media storage costs + privacy considerations. Needs infrastructure planning (S3/CloudFront) |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Recharts bundle size bloats client | Medium | Dynamic import (`next/dynamic`) with SSR disabled. Lazy-load only on dashboard page |
| Email deliverability (spam folder) | High | Use Resend (good deliverability). Set up SPF/DKIM/DMARC. Start with low volume, warm domain |
| Peer benchmarking with small user base | Medium | Show "Not enough data yet" below 30 peers. Seed with synthetic benchmark data from beta |
| Mobile responsive breaks existing desktop UI | Medium | Use `min-width` (mobile-first) additions only. Never remove desktop styles. Visual regression tests |
| Share token enumeration | Low | Use nanoid (12 chars, ~3.5 trillion possibilities). Rate-limit public endpoint. No PII in public response |

---

*Document generated: 2026-03-15*

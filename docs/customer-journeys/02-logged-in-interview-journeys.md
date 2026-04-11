# Logged-In Interview Journeys

Everything an **authenticated** user can do inside the **core interview product**: onboarding, setup, lobby, the live interview state machine, feedback, replay, drill mode, and history.

Resume, Learn, Settings, and sharing are covered in `03-*.md` and `04-*.md`.

---

## 1. First-Time Sign-In & Onboarding

### 1.1 Post-auth redirect

After Google/GitHub OAuth completes:

1. NextAuth sets JWT cookie, `User` row is upserted (`onboardingCompleted: false` for new users).
2. Redirect to `callbackUrl` (default `/`) — **but** any page that calls `useUser()` or the `OnboardingGate` will detect `onboardingCompleted === false` and redirect to `/onboarding`.

### 1.2 `/onboarding`

Multi-step wizard (`OnboardingWizard.tsx`):

| Step | Fields | Action |
|------|--------|--------|
| 1. Name & Role | Name (prefilled), current title, industry | **"Next"** |
| 2. Experience | Years of experience, level (junior/mid/senior/lead) | **"Next"** / **"Back"** |
| 3. Goals | Target roles (multi), target companies (chips), timeline | **"Next"** / **"Back"** |
| 4. Skills | Skill chips, optional LinkedIn URL | **"Finish"** → `POST /api/user/onboarding` → updates `User`, sets `onboardingCompleted: true` → `router.push('/interview/setup')` |

- **"Skip for now"** (top-right): sets `onboardingCompleted: true` with defaults and routes to `/`.
- Progress bar + step indicator.
- Closing the tab preserves partial state in React component state only (not persisted).

### 1.3 Welcome banner

On the first visit to `/` post-onboarding, a dismissible "Welcome, {name}!" banner appears with **"Start your first interview"** → `/interview/setup`.

---

## 2. Interview Setup (`/interview/setup`) — authenticated

Same form shell as the anonymous version, plus:

- **Usage badge** in the header: *"2 of 3 free interviews remaining this month"* (hidden for Pro/Enterprise).
- **"Import from Profile"** CTA auto-fills target role, industry, skills, experience level.
- **Resume upload** → `POST /api/documents/upload` → stored temporarily; parsed text powers AI personalization.
- **Domain selector** → fetches `/api/domains` (CMS-managed, 12+ entries).
- **Experience picker** → junior / mid / senior / lead / principal.
- **Interview depth selector** → HR Screening, Behavioral, Technical, Case Study, Domain Knowledge, Culture Fit.
- **Duration** → 10 / 20 / 30 minutes.
- **Job Description** → paste, upload, or **"Generate from company"** (calls `POST /api/extract-company-context`, prefills company + role).
- **"Practice with sample JD"** → loads a fixture.

### Sticky CTA bar

- Shows: *"{Domain} · {Depth} · {Duration} min"*
- **"Enter Interview Room →"** →
  - `status === 'authenticated'` → `router.push('/lobby')`
  - `user.plan === 'free' && usage >= 3` → `UsageLimitModal` → **"Upgrade to Pro"** (→ `/pricing`) or **"Close"**.

Before navigation, config is persisted to `localStorage.INTERVIEW_CONFIG` and cleared at `FEEDBACK`.

---

## 3. Lobby (`/lobby`)

Pre-interview readiness check.

- Reads `INTERVIEW_CONFIG` from localStorage. Missing config → `router.replace('/interview/setup')`.
- **Camera preview** with live video, mirrored.
- **Mic level meter** (WebAudio) — shows a live percentage and a "picking up audio" confirmation message.
- **Auto-detection system checks** (four rows, no manual picker):
  - **Camera** → "HD video ready" on success / "Permission denied" on failure.
  - **Microphone** → "Audio detected" on success.
  - **Speech recognition** → "Browser supported" / "Not supported — you can still join in text mode".
  - **Network** → HEAD pings `/api/health` twice (first warms up the serverless cold start; second measures latency). Shows e.g. "276 ms latency" when healthy; "High latency (N ms)" or "Server returned an error" on failure.
- **Prep checklist** (12 items across 4 accordions): Environment, Technology, Content Prep, Mindset.
- **"Start 60s warm-up (not scored)"** → optional practice question that doesn't consume quota.
- **"Back"** → `/interview/setup`
- **"Join Interview Room"** → `router.push('/interview')`. Plays entry chime.

> **Removed in a redesign** (noted in QA Run 2): the earlier build had manual device-picker dropdowns (camera / microphone) and two consent checkboxes ("I consent to be recorded", "I understand AI analysis"). Both were replaced by automatic detection and implicit consent via the Terms page. The "Test Audio" playback button was also removed in favor of the live mic meter.

Errors:
- Camera/mic permission denied → the camera/mic rows flip to error state with "Permission denied"; the Join button stays enabled but the candidate is nudged to re-grant permissions.
- Network check fails → "Server returned an error" row; the Join button remains enabled so the candidate can still try.
- No devices found → fallback to audio-only mode (recorded, but avatar reactions degrade).

---

## 4. Live Interview (`/interview`)

Controlled by `useInterview.ts` — a finite state machine.

### 4.1 States

```
LOBBY → CALIBRATION → ASK_QUESTION → LISTENING → PROCESSING → COACHING → WRAP_UP → FEEDBACK
```

- **CALIBRATION** (~3 s): avatar says "Let's do a quick mic check." Mic level captured; baseline stored.
- **ASK_QUESTION**: Alex (avatar) speaks the question; TTS via Deepgram Aura (fallback: Web Speech Synthesis). Emotion: friendly/curious. Lip sync driven by `LipSyncEngine`.
- **LISTENING**: STT via Deepgram streaming (fallback: Web Speech API). Live transcript fills in. Word-level timestamps recorded.
- **PROCESSING**: `POST /api/interview/evaluate` (Claude Haiku) → 5-dimension score + coaching tip.
- **COACHING** (~800 ms): avatar offers a brief nudge ("Try adding a specific metric."). Skippable with **"Continue"**.
- **WRAP_UP**: Alex summarizes ("Great, last question..."). Auto-advances.
- **FEEDBACK**: redirect to `/feedback/[sessionId]`.

### 4.2 On-screen controls

| Control | Behavior |
|---------|----------|
| **Mute mic** | Stops streaming to STT; avatar pauses listening. |
| **Pause video** | Black screen; multimodal analysis still captures audio. |
| **"Skip question"** | Advances to next `ASK_QUESTION` after confirmation. |
| **"End interview"** | Confirmation modal → `POST /api/interview/finish` → `FEEDBACK`. |
| **"Repeat question"** | Re-plays TTS; does not count as a retry for scoring. |
| **Transcript panel** | Toggleable live caption, auto-scrolls. |
| **Coaching nudge toast** | Real-time tips from `useCoachingNudge` — non-blocking. |

### 4.3 Real-time multimodal coaching (when `NEXT_PUBLIC_FEATURE_MULTIMODAL=true`)

- MediaPipe Face Landmarker runs locally.
- Nudges:
  - Eye contact dropping → "Look at the camera."
  - Flat expression → "Smile when sharing wins."
  - Head jitter → "Stay steady."
  - Speaking too fast → "Slow down a touch."
- Nudges appear as toasts that fade in 3 s.

### 4.4 Errors mid-interview

- **STT fails** → falls back to Web Speech API → if that fails, shows **"Type your answer"** textarea.
- **API error on evaluate** → retry × 2 with backoff → otherwise advances without score; flagged in final feedback.
- **Tab backgrounded > 60 s** → warning modal "Return to interview" + auto-pause.
- **Session orphaned** (reload) → `INTERVIEW_DATA` in localStorage allows resume; otherwise marked abandoned.
- **Quota exhausted mid-session** → never (quota consumed at start).

### 4.5 Completion

On reaching `WRAP_UP`:
1. `POST /api/interview/finish` → stores final `InterviewSession`, sets `status: 'completed'`.
2. If multimodal feature enabled + quota available → `POST /api/analysis/start` → Inngest job kicked off (returns `{ jobId, status: 'pending' }`).
3. `localStorage.INTERVIEW_CONFIG` cleared.
4. `router.replace('/feedback/{sessionId}')`.

---

## 5. Feedback (`/feedback/[sessionId]`)

Post-interview scoring & analysis page.

### 5.1 Top-level summary

- **Overall score ring** (0–100), animated.
- Dimension bars: Relevance, Structure (STAR), Specificity, Ownership, JD Alignment.
- Duration, question count, domain, depth.
- Badges earned this session (e.g. "First Interview", "STAR Master").

### 5.2 Question-by-question review

Each question card shows:
- Question text
- Your transcribed answer (word-level)
- Per-question scores
- **"Why"** expand → AI rationale
- **"Better answer"** expand → sample rewrite
- **"Add to drill"** → adds to drill queue → confirmation toast.

### 5.3 Header toolbar (top-right of feedback page)

- **"Download transcript"** (↓ icon) → client-generates a plain-text `interview-transcript.txt` from `data.transcript` and triggers a download.
- **"Download report (PDF)"** (document icon) → calls `buildFeedbackPrintHtml({ feedback, data, domainLabel })` to construct a print-optimized scorecard (hero score ring, Answer Quality / Communication / Engagement dimensions, strengths, weaknesses, top improvements, red flags, full transcript), opens it in a new window, and auto-launches the browser print dialog. User saves as PDF via the browser's "Print to PDF". Pop-up blocked → fallback alert.
- **"Share Scorecard"** → dropdown with **Copy Link** and **Share on LinkedIn** (see `04-*.md §5`).

### 5.4 Coaching actions (bottom of feedback page)

- **"Retake"** → `/interview/setup?retry={sessionId}` (re-uses same config).
- **"View Pathway"** → `/learn/pathway`.
- **"New Interview"** → `/interview/setup`.
- **"Back to history"** → `/history` (via `router.back()` on the header back arrow).

### 5.4 Multimodal Replay block

Renders only if the Inngest analysis job has completed.

- **Status: pending** → skeleton + **"Analyzing… this takes ~30 seconds."** + polling `/api/analysis/[sessionId]` every 3 s.
- **Status: processing** → same skeleton, spinner.
- **Status: failed** → **"Replay unavailable"** + **"Retry"** → `POST /api/analysis/start`.
- **Status: completed** → **"Open Replay →"** → `/replay/[sessionId]` (internally routes to the `InterviewReplay` component, legacy `/replay/*` also redirects here).

---

## 6. Interview Replay (`/replay/[sessionId]` → `/feedback/[sessionId]/replay`)

Full multimodal replay view (feature-flagged, quota-gated).

### 6.1 Layout

- **Video player** (top) — recorded session, scrubber with keyboard controls.
- **Signal timeline** (middle) — horizontal lanes:
  - Speaking rate
  - Eye contact %
  - Dominant expression
  - Filler words
- **Word-level transcript** (bottom) — clicking a word seeks video.
- **Coaching sidebar** — tips indexed to timestamps; clicking tip jumps video.

### 6.2 Controls

- Play / pause / seek / 0.5x/1x/1.5x/2x speed.
- **"Download transcript (TXT)"** → client-generated download.
- **"Download insights (JSON)"** → `GET /api/analysis/[sessionId]`.
- **"Back to feedback"** → `/feedback/[sessionId]`.

### 6.3 Quota

- Free: 1 replay/month
- Pro: 10 replays/month
- Enterprise: unlimited

Exceeded quota shows an `UpsellModal` instead of the replay UI.

---

## 7. History (`/history`)

List of every completed session for the signed-in user.

- Filters: domain, depth, date range, score range.
- Sort: date desc (default), score desc, duration.
- Pagination: 10 per page.
- Each row:
  - Domain + depth + date
  - Overall score badge
  - Duration
  - **"View feedback"** → `/feedback/[sessionId]`
  - **"Share"** → `ShareScorecardModal`
  - **"Delete"** → confirmation → `DELETE /api/interview/[sessionId]`
- Empty state: **"No interviews yet — Start your first interview →"** → `/interview/setup`.
- Bulk toolbar appears on selection: **"Delete selected"**, **"Export selected (CSV)"**.

---

## 8. Drill Mode (`/practice/drill`)

Rapid-fire question practice loop, seeded from weak areas.

### 8.1 Entry points

- `/feedback/[sessionId]` → **"Start a drill on weak areas"** → `/practice/drill?from={sessionId}`
- `/learn/progress` → **"Drill weak competencies"**
- Direct URL → picks top 5 weakest competencies from `Competency` store.

### 8.2 Flow

1. Drill intro card: "You'll answer 5 targeted questions. 60 s each."
2. **"Start"** → timer begins.
3. Each question:
   - TTS-read
   - Mic opens, STT captures
   - 60 s countdown (visible)
   - **"Submit early"** available
4. Mini-feedback after each → score + tip.
5. Summary screen: average score, competencies improved.
6. **"Do another drill"** / **"Back to progress"**.

### 8.3 Quota

Drill does not count against the monthly interview quota (Pro perk; free users get 1 drill/week).

---

## 9. Errors & Edge Cases

| Event | Behavior |
|-------|----------|
| Quota hit on start | `UsageLimitModal` → Upgrade CTA |
| Camera/mic denied | OS-specific help modal |
| Mid-session network loss | Offline banner + retry |
| Backgrounded tab | Auto-pause + return modal |
| Session reload | Resume from localStorage if possible |
| Session not owned by user | 403 → redirect to `/history` |
| Session deleted | 404 → `/history` with toast |
| Replay unavailable | Feedback page hides Replay block |
| Inngest job stuck > 10 min | Marked `failed`; retry CTA appears |

---

## 10. Behaviors confirmed & gaps surfaced by QA Run 2

Confirmed live:
- Resume upload drives **personalized questions** — QA observed Q2 referencing "Swiggy Minis" from the uploaded PDF. (`POST /api/resume/parse` feeds structured resume text into `personalizationEngine`, which the question generator then conditions on.)
- Interview state machine transitions **STARTING → SPEAKING → LISTENING** all render their expected UI states.
- Post-interview pipeline (`/api/analysis/start` + `/api/storage/presign`) fires on session completion as documented in §4.5.
- Feedback page renders Score Ring, Scoring Dimensions, Communication metrics (Pacing / Filler words / Conciseness), "How You Compare" benchmarks (Overall / Answer Quality / Communication / Engagement), Top Improvements, per-question Questions tab, and full Transcript tab.
- History page lists sessions with scores, statuses (completed / in-progress), and Replay links.

Gaps vs. this document:
- **Lobby redesign**: device-picker dropdowns and consent checkboxes are no longer present — see note in §3.
- **PDF download on Feedback** (QA Issue #10): originally documented as a CTA but never shipped. **Now shipped on this branch** via `modules/interview/utils/feedbackPrintHtml.ts` + a new button in the feedback page header. Uses client-side print-to-PDF (matches the Resume editor's print fallback pattern), no new API route. See §5.3.
- **`/api/health` HEAD returning 503** during interview (QA Issue #2): the QA observed three consecutive 503s on the lobby warm-up pings. Fixed on this branch — the HEAD handler now reflects actual `mongoose.connection.readyState` and heavy deps are dynamic-imported so a module-load failure can't take the route down.
- **Mongoose stale-connection warnings** (QA Issue #1): addressed on this branch by validating `readyState` on every `connectDB()` call instead of trusting the cached handle indefinitely; a no-op `.catch()` is attached to the pending connect promise so parallel-invocation races can't leak UnhandledPromiseRejection warnings.

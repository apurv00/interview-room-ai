# Logged-In Resume & Learn Journeys

Authenticated journeys for the **Resume Builder** (`/resume/*`) and the **Learn module** (`/learn/*`, `/dashboard`, `/practice/*`).

Core interview product is in `02-*.md`. Settings / sharing / account is in `04-*.md`.

---

## Part A — Resume Module

### A1. Resume Dashboard (`/resume`)

The authenticated landing page for the resume module.

- **Quick-action cards** (top row):
  - **"Build a Resume"** → `/resume/builder`
  - **"Tailor to a Job"** → `/resume/tailor`
  - **"ATS Check"** → `/resume/ats-check`
  - **"Browse Templates"** → `/resume/templates`
  - **"Resume Wizard"** (AI-guided) → `/resume/wizard`
- **Saved resumes list** (`GET /api/resume`):
  - Each card: title, template, last-updated, ATS score badge.
  - **"Open"** → `/resume/builder?id={resumeId}`
  - **"Duplicate"** → `POST /api/resume` with `copyFrom={id}` → `/resume/builder?id={newId}`
  - **"Delete"** → confirmation modal → `DELETE /api/resume/[id]` → list refresh
  - **"Download PDF"** → `GET /api/resume/[id]/pdf`
  - **"Tailor this"** → `/resume/tailor?resumeId={id}`
  - **"Run ATS check"** → `/resume/ats-check?resumeId={id}`
- **Resume cap banner**: "You have 2 of 3 resumes." Hit cap → **"Create"** disabled with tooltip "Delete one to make room."
- **Empty state** (no resumes): **"Create your first resume"** → `/resume/builder`.

### A2. Resume Builder (`/resume/builder`)

Two-pane editor: form on the left, live template preview on the right.

**Loading**: `?id={id}` loads via `GET /api/resume/[id]`; otherwise `?template={templateId}` starts a new draft.

#### A2.1 Header toolbar

| CTA | Action |
|-----|--------|
| **Title input** | Inline editable, auto-saves on blur. |
| **Template picker** | Dropdown of 10 templates → updates preview. |
| **"Save"** | `POST` (new) or `PUT /api/resume/[id]` → toast "Saved". Auto-save every 10 s while dirty. |
| **"Preview PDF"** | Opens preview modal. |
| **"Download PDF"** | `GET /api/resume/[id]/pdf` → blob → download. Fallback: browser print. |
| **"Import from Profile"** | Merges user profile (name, email, title, industry, skills, LinkedIn) → confirmation modal before overwrite. |
| **"Upload Resume"** | File dropzone (PDF/DOCX/TXT) → `POST /api/documents/upload` → `POST /api/resume/parse` → populates fields. |
| **"Delete resume"** | → confirmation → `DELETE /api/resume/[id]` → `/resume`. |
| **"Back to dashboard"** | `/resume`. |

#### A2.2 Section editors

Each section has drag handles, add/remove buttons, and inline validation.

| Section | Fields | AI actions |
|---------|--------|-----------|
| Contact Info | Name, email, phone, location, LinkedIn, website | — |
| Summary | Paragraph | **"AI Enhance"** → `POST /api/resume/enhance` (section type) |
| Work Experience | Company, title, dates, bullets[] | **"AI Enhance Bullets"** per role; **"Add bullet"** |
| Education | School, degree, dates, GPA | — |
| Skills | Categorized chips | **"AI Suggest Skills"** based on target role |
| Projects | Title, description, tech, links | **"AI Enhance"** per project |
| Certifications | Name, issuer, date | — |
| Custom Sections | Title + free text | — |

Global AI actions in the sidebar:
- **"AI Generate for all sections"** → `POST /api/resume/ai-suggestions` → drafts for every empty section.
- **"AI Tailor to role"** → opens a mini-tailor modal prompting target role → rewrites bullets.

Live preview reflects every keystroke. Template switcher does not lose content.

### A3. Resume Templates (`/resume/templates`)

- Grid of 10 templates. Each card shows a sample-data preview.
- Click card → right pane updates with a larger preview.
- **"Use This Template"** → `/resume/builder?template={id}` (creates new draft with that template).
- **"Apply to existing"** → dropdown of saved resumes → `PUT /api/resume/[id]` with `template` field → toast + navigates to builder.

### A4. Resume Tailor (`/resume/tailor`)

Two-step flow: input → results.

#### A4.1 Input

- **Resume source**: dropdown of saved resumes, or upload, or paste text.
- **Job description**: textarea or upload or **"Generate from company"** (`POST /api/extract-company-context` → prefills company + role + description).
- **Target role** (optional override).
- **"Tailor My Resume"** → `POST /api/resume/tailor` (Claude).

#### A4.2 Results

- Match score ring (0–100).
- **Keywords added** (green chips) / **Keywords still missing** (red chips).
- Changes list: each entry = old vs. new bullet + reason.
- **Tailored resume preview** (full text).
- Actions:
  - **"Copy to clipboard"** → toast.
  - **"Save as new resume"** → `POST /api/resume` → `/resume/builder?id={newId}`.
  - **"Apply to existing resume"** → dropdown → `PUT /api/resume/[id]` → toast.
  - **"Download PDF"** → generated PDF of tailored version.
  - **"Tailor again"** → resets form but keeps JD.

### A5. ATS Check (`/resume/ats-check`)

- Input form: resume (saved / upload / paste) + optional JD.
- **"Run ATS Check"** → `POST /api/resume/ats-check`.
- Results:
  - ATS score (0–100) with severity color.
  - Formatting score (separately).
  - Issues grouped by severity: critical / warning / suggestion. Each issue has description + **"Fix in builder"** → opens builder at that field.
  - Sections found vs. missing vs. recommended.
  - Keyword coverage (JD mode only).
  - Contact info placement, date format consistency.
- **"Check another resume"** → resets.
- **"Export report (PDF)"** → `GET /api/resume/[id]/ats-report.pdf`.
- **"Share with a friend"** → copy link to a tokenized report (7-day TTL).

### A6. Resume Wizard (`/resume/wizard`)

Guided step-by-step draft using AI. Auth required (no anonymous path).

- Step 1: Target role & industry.
- Step 2: Paste or upload existing resume / LinkedIn PDF (optional).
- Step 3: AI generates a structured draft (`POST /api/resume/ai-suggestions`) → preview.
- Step 4: Review & tweak → **"Open in builder"** → `/resume/builder?id={newId}`.

Skip any step → defaults from profile. Each step has **"Back"** / **"Next"**.

### A7. Resume limits & errors

- Hard cap: **3 saved resumes** per user (Free & Pro — raised for Enterprise).
- Hitting cap: **"Save"** disabled → upsell tooltip.
- AI enhancement failures → inline error "Couldn't enhance — try again" + retry button.
- Upload parse failures → toast "Couldn't read file" + format tips.
- Save conflict (two tabs) → last-write-wins with warning toast.

---

## Part B — Learn Module

The Learn module includes the **dashboard**, **progress tracking**, **guides**, **practice sets**, **pathway**, **badges**, **daily challenge**, and **streaks**.

### B1. Dashboard (`/dashboard`)

Post-login landing for returning users. Summary of activity.

- **XP badge + current level** (top right, also in header).
- **Streak counter** — 🔥 consecutive days with interview/drill/guide activity.
- **Cards**:
  - **"Next recommended interview"** → `/interview/setup?domain={slug}&depth={type}` (from pathway).
  - **"Weekly goal progress"** ring — interviews this week vs goal.
  - **"Recent sessions"** (3 latest) → each → `/feedback/[sessionId]`.
  - **"Competency snapshot"** (radar chart) → `/learn/progress`.
  - **"Today's challenge"** → `/learn/challenge`.
  - **"Pathway"** → `/learn/pathway`.
- **Action row**:
  - **"Start interview"** → `/interview/setup`
  - **"Drill weak areas"** → `/practice/drill`
  - **"Read a guide"** → `/learn/guides`

### B2. Progress (`/learn/progress`)

In-depth analytics.

- **Competency radar**: Answer Quality, Communication, Structure (STAR), Specificity, Ownership, JD Alignment.
- **Trend chart**: overall score by session over time.
- **Competency history**: each dimension over last 10 sessions.
- **Strengths & weaknesses** auto-extracted.
- **Peer comparison** (anonymous benchmarks) → "You score above 72% of Pro PMs".
- **Session list** → `/feedback/[sessionId]`.
- Actions:
  - **"Drill weak competencies"** → `/practice/drill`
  - **"Set a goal"** → goal modal → writes to `User.learnGoals`.
  - **"Share progress"** → `ShareScorecardModal` with aggregate data.
- Filter by domain / depth / date range.

### B3. Pathway (`/learn/pathway`)

Personalized learning plan.

- Title: *"Your pathway to {targetRole}"*.
- Multi-week plan generated by `pathwayPlanner` service: interviews, guides, drills per week.
- Each item is a card with a status:
  - ✅ Completed → clickable → `/feedback/[sessionId]` or `/learn/guides/[slug]`
  - 🎯 Next → **"Start"** → `/interview/setup?...`
  - 🔒 Future → disabled, tooltip "Complete previous step first".
- **"Regenerate pathway"** → modal → `POST /api/learn/pathway/regenerate` (Claude). Monthly auto-regen via Inngest; manual regen limited to once/week.
- **"Change target role"** → opens profile edit → settings.

### B4. Practice Sets (`/learn/practice`)

Curated question sets (non-interview format — more like flashcards).

- List view: categories (Behavioral, Technical, STAR drills, Leadership Principles, etc.).
- Filters: domain, difficulty, duration.
- Each set card: title, question count, estimated time, **"Start set"** → `/learn/practice/[setId]`.

#### B4.1 Playing a set (`/learn/practice/[setId]`)

- Card-by-card question display.
- **"Speak answer"** (mic) → STT captured.
- **"Submit"** → `POST /api/learn/practice/submit` → Claude eval → inline score + tip.
- **"Show model answer"** → expands sample STAR response.
- **"Next"** → advances.
- **"Mark for review"** → adds to drill queue.
- Completion: summary screen → avg score, XP earned, streak update.
- **"Do another set"** / **"Back to practice"**.

### B5. Practice Drill (`/practice/drill`)

See `02-*.md §8`. Accessible from the Learn dashboard and progress page.

### B6. Badges (`/learn/badges`)

Gamification gallery.

- Grid of all badges (earned + locked).
- Earned cards: colored + timestamp.
- Locked cards: grayscale + **"How to earn"** tooltip.
- Click badge → modal with details + share button (`ShareBadgeModal`).
- **"Share badge"** → generates social card → LinkedIn/X prefill.
- **"See recent unlocks"** → activity feed.
- Hidden badges: revealed only after unlock.

### B7. Daily Challenge (`/learn/challenge`)

One curated question per day.

- "Today's challenge: {question}".
- **"Record answer"** → same STT flow as drill (60 s).
- **"Submit"** → `POST /api/learn/challenge/submit` → score + XP (2x if streak ≥ 3 days).
- Completion: confetti animation + streak badge update.
- Missed days break streak; a "Freeze streak" button uses 1 freeze token (Pro perk).

### B8. Learn Guides (authenticated view)

Same pages as `/learn/guides` and `/learn/guides/[slug]` from the logged-out flows (§6 of `01-*.md`), plus:

- **"Mark as read"** → adds XP + tracks in `User.readGuides`.
- **"Save for later"** → bookmarks into `/learn/saved`.
- **"Start related interview"** → `/interview/setup?topic={tag}`.
- Progress indicator on each guide card (unread / reading / completed).
- `/learn/saved` — bookmarked guides list.

### B9. XP / Levels / Streaks (cross-cutting)

- XP is awarded for: completing interviews, finishing drills, reading guides, daily challenge, earning badges.
- Level up toasts fire on threshold crossings.
- `XpBadge` in AppShell always shows current level + XP bar. Click → `/learn/progress`.
- `BadgeUnlockChecker` runs silently post-nav; on unlock, opens `BadgeUnlockToast` with **"See badge"** → `/learn/badges`.
- Streak freeze tokens: Pro gets 2/month, Free gets 0.

### B10. Errors in the Learn module

- Pathway regeneration rate-limited: "Next regen available in X days".
- Badge unlock race (double-fire) → idempotent via `User.earnedBadges[].id`.
- XP sync failure → retries in background, no user-facing error.

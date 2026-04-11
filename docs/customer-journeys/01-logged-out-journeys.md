# Logged-Out Customer Journeys

Every journey available to an **anonymous (not-signed-in) visitor**. Anything that requires auth is flagged as `[Auth Gate]` — the visitor hits a modal or a redirect at that point.

The product uses a **deferred-auth pattern**: most pages are browseable anonymously, and authentication is only required at value-capture actions (save, download, start interview, view history, etc.).

---

## 1. Entry Points

An anonymous visitor can land on the site from:

| Entry | URL | Notes |
|-------|-----|-------|
| Homepage (SEO / direct) | `/` | Primary marketing surface |
| Sign in (deep link / callback) | `/signin` | With optional `?callbackUrl=...` |
| Sign up (deep link) | `/signup` | OAuth-only (Google, GitHub) |
| Pricing (SEO / footer) | `/pricing` | Indexed |
| Legal pages | `/privacy`, `/terms` | Indexed |
| SEO guide (slug) | `/learn/guides/[slug]` | 26+ indexed articles |
| Guides hub | `/learn/guides` | Indexed |
| Shared public scorecard | `/scorecard/[token]` | 90-day token |
| Interview setup landing | `/interview/setup` | Browseable, auth on start |
| Resume dashboard landing | `/resume` | Shows unauth landing variant |
| Resume tool deep links | `/resume/builder`, `/resume/tailor`, `/resume/ats-check`, `/resume/templates`, `/resume/wizard` | Partial anonymous access with caps |
| Subdomain redirects | `resume.*`, `learn.*` | Rewritten by middleware |
| Legacy redirect | `/replay/[sessionId]` | 301 → `/feedback/[sessionId]` |

Routes that **immediately redirect anonymous users** to `/signin`:

- `/onboarding` → `/signin` (client-side guard)
- `/settings` → displays nothing; nav menu hides this link

Routes middleware protects at the edge (redirect to `/signin?callbackUrl=...`):
- (None of the consumer routes — only `/hire/*` and `/cms/*` are hard-blocked, both excluded from this doc.)

---

## 2. Homepage (`/`)

Served by `modules/marketing/components/MarketingHomepage.tsx` — a multi-fold marketing page.

### 2.1 Top Navigation (AppShell)

| CTA | Target (anonymous) | Notes |
|-----|--------------------|-------|
| Logo/"Interview Prep Guru" | `/` | Brand home link |
| **"Interview"** | `/interview/setup` | Browseable as anonymous |
| **"Resume"** | `/resume` | Anonymous landing |
| **"History"** | `/history` | Shows `SignedOutEmptyState` |
| **"Progress"** | `/learn/progress` | Shows `SignedOutEmptyState` |
| **"Resources"** | `/resources` (→ guides hub) | Public |
| **"Pricing"** | `/pricing` | Public |
| **"Sign in"** (button) | Opens `AuthGate` modal | `openAuthGate('generic')` |
| **"Get started"** (button) | Opens `AuthGate` modal | `openAuthGate('generic')` |

Mobile menu adds the same links plus a hamburger toggle. No `Settings` or `Sign out` entries appear when logged out.

### 2.2 Hero (Fold 1)

| CTA | Behavior |
|-----|----------|
| **"Take Your First Interview — Free"** | `requireAuth('start_interview', () => router.push('/interview/setup'))` → opens auth modal → on auth → `/interview/setup` |
| Tabs **"Live Interview" / "AI Replay" / "Scoring"** | Switches preview image only (no navigation) |

### 2.3 "How It Works" Journey Pipeline (Fold 4)

Five cards that each either navigate or trigger the start CTA:

| Step | Label | Target |
|------|-------|--------|
| 1. Resume gets you in | "Resume Tools" | `/resume` |
| 2. Guides prep your mind | "26+ Guides" | `/resources` |
| 3. Live AI coaching | "Try Free" | Start CTA → auth gate |
| 4. Replay the truth | "View Replays" | Start CTA → auth gate |
| 5. Track and repeat | "Progress" | `/learn/progress` |
| Bottom CTA | **"Start the journey free"** | Start CTA → auth gate |

### 2.4 Domains & Social Proof (Fold 5)

Clickable domain chips (Software Engineering, Data Science, Product Management, Design/UX, Finance & Banking, Management Consulting) and company links:

- Google → `/resources/how-to-interview-at-google`
- Amazon → `/resources/amazon-leadership-principles-guide`
- Meta → `/resources/how-to-interview-at-meta`
- McKinsey → `/resources/mckinsey-interview-guide`
- Stripe → `/resources/how-to-interview-at-stripe`
- **"See all domains →"** → `/resources`

### 2.5 Guides Preview (Fold 7.5)

| Link | Target |
|------|--------|
| Behavioral Interview Questions | `/learn/guides/behavioral-questions` |
| The STAR Method | `/learn/guides/star-method-guide` |
| How to Interview at Google | `/learn/guides/how-to-interview-at-google` |
| Amazon Leadership Principles | `/learn/guides/amazon-leadership-principles-guide` |
| McKinsey Interview Guide | `/learn/guides/mckinsey-interview-guide` |
| **"See all 26 guides →"** | `/learn/guides` |

### 2.6 Pricing Preview (Fold 7)

| Plan | CTA | Behavior |
|------|-----|----------|
| Free | **"Get Started Free"** | Start CTA → auth gate → `/interview/setup` |
| Pro (Coming Soon) | Email input + **"Notify Me"** | `POST /api/waitlist` → confirmation "You're on the list!" |
| Pro link | **"Get Notified When Pro Launches"** | → `/pricing` |
| Enterprise | **"Contact Sales"** | `mailto:contact@interviewprep.guru` |

### 2.7 Final CTA (Fold 8)

- **"Take Your First Interview — Free"** → Start CTA → auth gate

### 2.8 Footer (shared on every page)

Every column has multiple links — all public unless noted.

**Product column:**
- Home → `/`
- Interview → `/interview/setup`
- Pricing → `/pricing`
- Resources → `/learn/guides`
- **"Get Started"** (`StartCta` component) → anonymous: `/signup`; authed: `/interview/setup`

**Tools column:**
- Resume Builder → `/resume`
- Resume Tailor → `/resume/tailor`
- ATS Checker → `/resume/ats-check`
- Resume Templates → `/resume/templates`
- For Recruiters → `/hire` (out of scope)

**Topic Hubs:**
- Behavioral Interviews → `/learn/guides/behavioral-interviews`
- Company Interview Guides → `/learn/guides/company-interviews`
- Interview Types & Formats → `/learn/guides/interview-types`

**Interview Questions:**
- Common Interview Questions → `/learn/guides/common-interview-questions`
- Behavioral Questions → `/learn/guides/behavioral-questions`
- Technical Questions → `/learn/guides/technical-interview-questions`
- Mock Interview Guide → `/learn/guides/mock-interview-guide`
- Readiness Quiz → `/learn/guides/interview-readiness-quiz`

**Tips & Frameworks:**
- 50+ Interview Tips → `/learn/guides/interview-tips`
- Phone Interview Tips → `/learn/guides/phone-interview-tips`
- Video Interview Tips → `/learn/guides/video-interview-tips`
- STAR Method Guide → `/learn/guides/star-method-guide`
- Body Language Tips → `/learn/guides/body-language-guide`
- Interview Frameworks → `/learn/guides/interview-frameworks`

**Bottom legal row:**
- Privacy → `/privacy`
- Terms → `/terms`
- Contact → `mailto:contact@interviewprep.guru`
- **"Sign in"** → `AuthGate` modal (`openAuthGate('generic')`)

---

## 3. Authentication Pages

### 3.1 `/signin`

- **"Continue with Google"** → NextAuth Google OAuth → on success, redirect to `callbackUrl` (default `/`)
- **"Continue with GitHub"** → NextAuth GitHub OAuth → same
- Link: **"Don't have an account? Sign up"** → `/signup`
- Error query param `?error=OAuthAccountNotLinked` or similar renders a banner.
- Pre-flight: existing NextAuth cookies are cleared to avoid stale JWT issues.

### 3.2 `/signup`

- **"Continue with Google"** → Google OAuth → new `User` row auto-created with defaults (`role: candidate`, `plan: free`, `onboardingCompleted: false`)
- **"Continue with GitHub"** → same
- Link: **"Already have an account? Sign in"** → `/signin`
- Link: **"View pricing"** → `/pricing`
- Account linking is automatic across providers sharing an email.

### 3.3 AuthGate modal (shared, not a page)

Opened from "Sign in" / "Get started" and from any gated action. The modal shows context-aware messaging depending on `reason`:

| Reason | Message |
|--------|---------|
| `generic` | "Sign in to interviewprep.guru" |
| `start_interview` | "Sign in to start your interview" |
| `save_resume` | "Sign in to save your resume" |
| `download_resume` | "Sign in to download your resume" |
| `tailor_resume` | "Sign in to tailor your resume" |
| `ats_check` | "Sign in to run an ATS check" |
| `parse_resume` | "Sign in to import your resume" |
| `enhance_resume` | "Sign in to enhance with AI" |
| `view_history` | "Sign in to see your interview history" |
| `view_progress` | "Sign in to track your progress" |
| `view_dashboard` | "Sign in to view your dashboard" |

The modal offers Google and GitHub buttons. On successful sign-in, if the calling component provided a `onAuthed` callback, it auto-fires and the modal closes; otherwise the page stays put.

---

## 4. Pricing (`/pricing`)

- Plan cards: Free, Pro, Enterprise.
- **Free** card: `StartCta` → anonymous goes to `/signup`.
- **Pro** card: email input + **"Notify Me"** → `POST /api/waitlist` → "You're on the list!" success state.
- Extra link: **"Get Notified When Pro Launches"** → stays on page (scroll/anchor).
- **Enterprise** card: **"Contact Sales"** → `mailto:contact@interviewprep.guru`.
- FAQ accordion (static).
- Bottom link: **"← Start practicing now"** → `/`.

---

## 5. Legal Pages

### 5.1 `/privacy`
Static text. In-body links:
- "Return home" → `/`
- "View your history" → `/history` (renders signed-out empty state)
- "Manage settings" → `/settings` (redirects client-side if unauthed)
- Contact: `mailto:privacy@interviewprep.guru`

### 5.2 `/terms`
Static text. In-body links:
- "Return home" → `/`
- "Manage settings" → `/settings`
- Contact: `mailto:legal@interviewprep.guru`

Both pages inherit the shared footer (see §2.8).

---

## 6. Learn Guides (Public SEO Surface)

### 6.1 `/learn/guides` (hub)
- Lists all guides, categorized.
- Each guide card → `/learn/guides/[slug]`.
- Secondary CTAs: **"Start Practicing Free"** / **"Try an Interview"** → Start CTA → auth gate.

### 6.2 `/learn/guides/[slug]` (individual article)
- Full article with sections, Key Tips, FAQ, related resources.
- JSON-LD metadata for SEO.
- Breadcrumb navigation: `Home / Guides / [Slug]`.
- Pillar backlinks to topic hubs.
- In-article CTAs (varies per guide):
  - **"Start Practice Interview"** (company-related guides) → Start CTA → auth gate
  - **"Start Practicing Free"** (general guides) → Start CTA → auth gate
  - **"Browse All Resources"** → `/learn/guides`
- Internal cross-links to related slugs.

Slugs encountered include:
`behavioral-interviews`, `company-interviews`, `interview-types`, `behavioral-questions`, `common-interview-questions`, `technical-interview-questions`, `mock-interview-guide`, `interview-readiness-quiz`, `interview-tips`, `phone-interview-tips`, `video-interview-tips`, `star-method-guide`, `body-language-guide`, `interview-frameworks`, `how-to-interview-at-google`, `amazon-leadership-principles-guide`, `how-to-interview-at-meta`, `mckinsey-interview-guide`, `how-to-interview-at-stripe`, etc. (Total ~26.)

---

## 7. Interview Setup (`/interview/setup`) — anonymous path

Anonymous users can browse the full setup form. The system prompts auth only at **"Enter Interview Room →"**.

- Header: marketing blocks, "How it works" row, stats row, resource cards.
- Form lets you enter/upload everything:
  - Resume upload → anonymous file upload via `POST /api/documents/upload` is allowed (per-IP rate limit).
  - Domain selection (`/api/domains` — public).
  - Experience level, interview type/depth, duration.
  - JD upload or generate-from-company.
- Sticky CTA bar summarizes selection.
- **"Enter Interview Room →"** CTA:
  - `getStartRedirect(status)`:
    - `status === 'loading'` → disabled
    - `status === 'unauthenticated'` → `/signin?callbackUrl=/lobby`  **[Auth Gate]**
    - `status === 'authenticated'` → `/lobby`

So anonymous users can *configure* an interview but cannot actually start one without signing in.

---

## 8. Anonymous Resume Tools

The resume module intentionally lets anonymous users try everything with caps (per-IP daily limits) and local drafts.

### 8.1 `/resume` (anonymous landing)

If `session` is null, the page switches to a marketing variant:
- Feature cards: AI Resume Builder, Job-Specific Tailoring, ATS Compatibility.
- 4-step "How It Works" diagram.
- **"Get Started Free"** → `/signup`
- **"Sign In"** → `/signin`

(No saved resume list.)

### 8.2 `/resume/builder` (anonymous)

- `AnonymousDraftBanner` shown: *"Your work is saved in this browser only. Sign in to save to the cloud and access it anywhere."* with **"Sign in"** → auth modal (`save_resume`).
- Drafts auto-save to localStorage key `resume:draft:anon`.
- Sidebar actions:
  - **"Import from Profile"** → `[Auth Gate]` (`save_resume`)
  - File dropzone (PDF/DOCX/TXT) → `POST /api/documents/upload` allowed anonymously (rate-limited), then `POST /api/resume/parse`. Anonymous alternative: a plain textarea to paste resume text.
- Section editors: all fully usable locally.
- AI buttons (**AI Enhance**, **AI Enhance Bullets**, **AI Generate suggestions for all sections**) → `[Auth Gate]` (`enhance_resume`).
- **"Save"** → `[Auth Gate]` (`save_resume`).
- **"Print PDF"** → browser print dialog (allowed anonymously).
- **"Download PDF"** → `[Auth Gate]` (`download_resume`).
- Template selector, font/style controls: fully usable anonymously.
- Live preview pane: updates with every keystroke.

### 8.3 `/resume/templates` (anonymous)

- Fully browseable. 10 templates with live preview.
- Template click: updates right-pane preview (no nav).
- **"Use This Template"** → `/resume/builder?template={templateId}` (anonymous build flow).

### 8.4 `/resume/tailor` (anonymous)

- Anonymous users can:
  - Paste resume text into textarea (no "select from saved" dropdown — requires auth).
  - Upload resume via `POST /api/documents/upload` (rate-limited).
  - Enter company + job description.
- **"Tailor My Resume"** → `POST /api/resume/tailor` — allowed with **per-IP daily cap**.
  - On cap hit: modal "Daily limit reached. Sign in for unlimited tailoring." → `[Auth Gate]` (`tailor_resume`).
- Results view:
  - Match score, keywords added/missing, changes list, tailored text.
  - **"Copy"** → clipboard (allowed).
  - **"Save as New Resume"** → `[Auth Gate]` (`save_resume`) → after auth → `/resume/builder?id={newId}`.
  - **"Start Over"** → resets to input form.

### 8.5 `/resume/ats-check` (anonymous)

- Same input options as tailor (paste/upload + optional JD).
- **"Run ATS Check"** → `POST /api/resume/ats-check` (per-IP daily cap).
  - On cap hit: `[Auth Gate]` (`ats_check`).
- Results: ATS score, severity-tagged issues, formatting score, sections found/missing.
- **"Check Another Resume"** resets form.

### 8.6 `/resume/wizard` (anonymous — hard gate)

Unlike the builder, the wizard is fully auth-gated. Anonymous visitors see a sign-in prompt with Google/GitHub buttons and cannot proceed.

---

## 9. Pages That Render Empty States for Anonymous Visitors

These routes are in the public allowlist but show a `SignedOutEmptyState` or similar prompt because all data is per-user.

| Route | Empty state CTA |
|-------|-----------------|
| `/history` | "Sign in to see your history" → auth gate |
| `/learn/progress` | "Sign in to track your progress" → auth gate |
| `/learn/practice` | Prompt + sample sets |
| `/learn/pathway` | "Start your first interview" → start CTA |
| `/dashboard` | "Sign in to view your dashboard" → auth gate |
| `/learn/badges` | Read-only gallery; earned states hidden |
| `/practice/drill` | "Sign in to access drill mode" |

---

## 10. Public Scorecard (`/scorecard/[token]`)

A completely public page — no auth, no user data — used by authenticated users to share a snapshot of their interview performance.

- URL is generated by `POST /api/learn/share` and shaped as `https://interviewprep.guru/scorecard/{12-char-token}`.
- Token TTL: 90 days.
- Visible data:
  - Domain, interview type, experience level, date, question count, duration.
  - Overall score (animated ring).
  - Dimension bars: Answer Quality, Communication, Engagement/Delivery.
  - Top strengths (up to 5).
  - "Verified by Interview Prep Guru" badge.
- **CTA:** **"Practice Your Own Interview"** → `/` (home) → triggers the marketing start flow.
- Expired or revoked token: renders "This scorecard may have expired or been revoked" with the same CTA.
- Rate-limited to 30 req/min per IP (`GET /api/public/scorecard/[token]`) to prevent token enumeration.

Anonymous consumption only — there is no way to interact beyond the single CTA.

---

## 11. Navigation Edge Cases (Logged Out)

- **Subdomain rewrites**: `resume.interviewprep.guru/*` → `/resume/*`, `learn.interviewprep.guru/*` → `/learn/*`, `cms.*` and `hire.*` are out of scope. Rewrites preserve the anonymous session.
- **`/replay/[sessionId]`** → 301 → `/feedback/[sessionId]` — anonymous user lands on an auth-gated feedback page that redirects them to sign-in via the empty state.
- **Middleware headers**: Every public response still gets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and a `x-request-id`.
- **Robots / SEO**: `/api/*`, `/interview`, `/lobby`, `/feedback/*`, `/history`, `/progress`, `/settings` are `Disallow`ed by `app/robots.ts`. Everything else (home, pricing, legal, guides, scorecards) is indexable.
- **`sitemap.ts`** priorities: home 1.0, pricing/guides 0.8, pillar guides 0.9, resource guides 0.7, sign-in/signup 0.5, privacy/terms 0.3.

---

## 12. Dead-End / Redirect Journeys (Logged Out)

| Starting point | Action | Outcome |
|----------------|--------|---------|
| `/onboarding` direct hit | none | `router.replace('/signin')` (client-side) |
| `/settings` direct hit | none | Client-side empty render; nav link hidden |
| `/history`, `/dashboard`, `/learn/progress` | none | `SignedOutEmptyState` with auth-gate CTA |
| `/interview/setup` | **"Enter Interview Room →"** | `/signin?callbackUrl=/lobby` |
| `/resume/builder` | **"Save"** / **"Download PDF"** / **"AI Enhance"** | Auth modal |
| `/resume/tailor` | **"Save as New Resume"** | Auth modal |
| `/resume/wizard` | any | Inline sign-in prompt |
| `/feedback/[sessionId]` | direct hit for non-owner | Error / empty state (cannot view other users' feedback) |
| `/scorecard/[token]` with expired token | any | "Expired or revoked" + CTA to home |
| `/api/*` (write endpoints) | POST without session | 401 Unauthorized JSON |
| Daily cap hit on tailor/ATS | retry | Auth gate |

---

## 13. Anonymous-Only Side-Effects (Writes That Work Without Auth)

The product deliberately exposes a few write endpoints without auth, always rate-limited:

- `POST /api/documents/upload` — resume/JD parsing.
- `POST /api/resume/parse` — structured extraction.
- `POST /api/resume/tailor` — AI tailoring (daily IP cap).
- `POST /api/resume/ats-check` — ATS scoring (daily IP cap).
- `POST /api/extract-company-context` — company metadata (regex-first, bounded cost).
- `POST /api/waitlist` — Pro waitlist signup (email only).
- `GET /api/domains` / `GET /api/interview-types` — catalog lookups.
- `GET /api/public/scorecard/[token]` — public scorecard view.
- `GET /api/health` — liveness.

No other writes are possible without authentication.

# Interview Prep Guru — UI Revamp Design Brief

**Version:** 1.0
**Date:** May 2026
**Status:** Open for vendor quotes
**Owner:** Apurv ( abhishek.apurv00@gmail.com )
**Live URL:** https://interviewprep.guru

---

## 1. One-paragraph summary

We are a consumer AI mock-interview platform (live AI interviewer, scored feedback, multimodal replay, spaced-repetition learning, resume tooling). The product is feature-complete and stable. **We need a complete visual revamp of the consumer-facing surface for launch day** — same flows, same features, dramatically tighter and more confident UI. Open canvas on brand direction. Deliverables are Figma + design tokens + a Tailwind config our engineers will wire into the existing Next.js codebase.

> **Important:** this is a **visual + IA polish** engagement, not a product redesign. You are not changing how features work. You **are** expected to challenge section order, messaging hierarchy, and mobile layout decisions on each page so the right things are surfaced at the right time.

---

## 2. What success looks like

A user landing on the marketing site on launch day should feel:

1. **Premium and trustworthy** — this is an AI product taking their money; it should feel as polished as Linear, Notion, or Granola.
2. **Obvious what to do next** — on every screen, the primary action is unambiguous.
3. **Mobile-first ready** — 70%+ of first visits will be mobile; we cannot ship a mobile experience that feels like a desktop afterthought.
4. **Consistent across the four product surfaces** — Home, Interview, Resume, Learn should feel like one product family, not four bolted-together apps.

Quantitative bars we'll measure post-launch:
- Mobile Lighthouse performance ≥ 90, accessibility ≥ 95
- Time-to-first-CTA-click on `/` ≤ 8s (median)
- Setup-to-first-question completion ≥ 80%

---

## 3. Scope

### 3.1 In scope (consumer surface)

All routes below get a full visual revamp + responsive behavior:

| Area | Routes |
|---|---|
| **Marketing & account** | `/`, `/pricing`, `/privacy`, `/terms`, `/signin`, `/signup`, `/settings` |
| **Interview** | `/interview/setup`, `/lobby`, `/interview`, `/feedback`, `/feedback/[sessionId]`, `/scorecard/[token]`, `/history` |
| **Resume** | `/resume`, `/resume/builder`, `/resume/tailor`, `/resume/ats-check`, `/resume/templates`, `/resume/wizard` |
| **Learn** | `/learn/pathway`, `/learn/practice`, `/practice/drill`, `/learn/guides`, `/learn/guides/[slug]`, `/learn/badges`, `/learn/progress` |
| **Shared** | Global nav, footer, auth-aware menu, empty states, loading states, error states, toast/notification system, modal patterns |

### 3.2 Out of scope (do **not** quote on these)

- `/hire/*` — B2B recruiter platform (different audience, separate engagement later)
- `/cms/*` — internal admin panel
- `/invite/[sessionId]` — pre-auth candidate OTP page (B2B-adjacent)
- Backend / API behavior
- Adding or removing product features
- Brand naming / wordmark redesign (we'll keep "Interview Prep Guru" as the name)

### 3.3 Section-ordering authority

You **are** authorized to reorder sections within a page when current order hurts comprehension (e.g. landing-page section sequence, feedback page section sequence, settings page grouping). You are **not** authorized to add new sections that introduce new product functionality. When in doubt, propose and ask.

---

## 4. Deliverables

The vendor ships:

1. **Figma file**, organized by:
   - `00 Foundations` — color, typography, spacing, radius, shadow, motion tokens
   - `01 Components` — buttons, inputs, cards, modals, toasts, badges, navigation, avatars, score visualizations
   - `02 Patterns` — empty states, error states, paywall states, loading skeletons
   - `10 Pages — Marketing` (each page, every responsive breakpoint, every variant)
   - `20 Pages — Interview`
   - `30 Pages — Resume`
   - `40 Pages — Learn`
   - `90 Handoff notes` — interaction notes, motion specs, accessibility notes per page
2. **Design tokens** as `tokens.json` (Style Dictionary or Tokens Studio format) covering colors (light + dark if proposed), spacing, type scale, radii, shadows, motion durations/easings.
3. **Tailwind config** (`tailwind.config.js` extension) generated from tokens — drop-in for our existing v3.4 config.
4. **Component spec sheet** — for each component: states (default, hover, focus, active, disabled, loading, error), prop variants, accessibility notes, motion behavior.
5. **Responsive design at 4 breakpoints minimum** per page (see §8).
6. **Loom walkthrough (~10–15 min)** explaining design rationale and key decisions.
7. **Two rounds of revisions** included in base quote.

What we **don't** need (please don't quote on these unless we ask):
- Coded React components
- Storybook setup
- Production CSS
- User research / interviews / usability testing
- Brand strategy or naming work

---

## 5. Brand direction — open canvas

We are **not** wedded to current colors, typography, or visual language. Propose what serves the product.

We'd like your quote to include **2–3 mood directions** as part of the discovery phase (1-page each, hero composition + 4 component samples + type/color spec). We pick one, you take it to completion.

### 5.1 Reference brands we admire (vibe, not visual copy)

- **Linear** — confident, dense, opinionated, beautiful empty states
- **Granola** — warm, calm, AI-native without screaming "AI"
- **Notion** — clear hierarchy, friendly without being childish
- **Cron / Notion Calendar** — premium feel on mobile

We are **not** trying to look like Duolingo, ChatGPT, or any LMS.

### 5.2 Voice / tone constraints

- The AI interviewer character is named **Alex Chen** — neutral-friendly, not robotic, not bubbly
- Avoid emoji in UI copy unless functional (rating, status)
- Microcopy should be confident: "Start interview" not "Click here to begin your interview journey"

---

## 6. Page inventory + variants

For each page below, design **all listed variants** at all responsive breakpoints. Variants are mutually exclusive states a real user will hit.

### 6.1 Marketing & account

| Page | Variants |
|---|---|
| `/` (Home) | (a) Anonymous first visit · (b) Anonymous returning (has cookie) · (c) Authenticated user — empty state (no sessions yet) · (d) Authenticated user — has history (show "continue where you left off") |
| `/pricing` | (a) Anonymous · (b) Authenticated free-tier · (c) Authenticated paid (shows current plan + manage billing) · (d) Authenticated free-tier with quota exhausted (paywall emphasis) |
| `/signin`, `/signup` | (a) Default · (b) Error state (wrong password, email taken) · (c) OAuth-only (Google/GitHub only, no email field shown) · (d) Post-OAuth-redirect spinner |
| `/settings` | Tabs/sections for: Account · Plan & billing · Usage · Consent & privacy · Data export · Delete account |
| `/privacy`, `/terms` | Long-form legal — design the typographic system for readable long-form |

### 6.2 Interview flow

| Page | Variants |
|---|---|
| `/interview/setup` | (a) New user — guided wizard feel · (b) Repeat user — pre-filled with last config + "use last setup" shortcut · (c) Free-tier with 1 interview left this month (subtle warning) · (d) Free-tier exhausted (paywall blocks Start) · (e) Pro/Enterprise (no quota messaging) |
| `/lobby` | (a) Loading — system check in progress (mic, camera, AI warm-up) · (b) Ready · (c) Permissions denied · (d) Browser unsupported |
| `/interview` (live session) | (a) Desktop landscape — full avatar + transcript + coaching · (b) Tablet portrait — collapsed coaching · (c) Mobile — recommend desktop OR ship stripped mobile UX (your call — propose) · (d) AI speaking · (e) User speaking · (f) Coaching nudge visible · (g) End-of-interview confirm modal |
| `/feedback/[sessionId]` | (a) Processing (background analysis pending) · (b) Complete — full multimodal replay · (c) Failed / partial (analysis errored, show what we have) · (d) Locked (Pro feature on free tier) |
| `/feedback` (list) | (a) Empty · (b) 1–3 sessions · (c) 10+ sessions (pagination/grouping) |
| `/scorecard/[token]` | (a) Public share view (no auth, no nav chrome — clean shareable card) · (b) Expired / invalid token |
| `/history` | (a) Empty · (b) Populated with filters by domain/date |

### 6.3 Resume flow

| Page | Variants |
|---|---|
| `/resume` (dashboard) | (a) Empty (no resumes saved) · (b) 1–3 resumes with thumbnails · (c) At cap (3 of 3 saved — show upgrade or delete prompt) |
| `/resume/builder` | (a) Blank from-scratch · (b) Template selected · (c) Uploaded resume parsed · (d) AI enhancement in-progress · (e) Live preview pane on desktop, tabbed editor/preview on mobile · (f) Unsaved-changes warning state |
| `/resume/tailor` | (a) Select existing resume · (b) Upload new · (c) JD input · (d) Results — diff view + match score · (e) Save as new resume |
| `/resume/ats-check` | (a) Upload / select · (b) Scanning · (c) Results — score gauge + issue list grouped by severity |
| `/resume/templates` | Grid of 10 templates with live preview hover/tap; selected state; "use this template" CTA |
| `/resume/wizard` | Multi-stage wizard — design progress indicator, stage transitions, review step, export step |

### 6.4 Learn flow

| Page | Variants |
|---|---|
| `/learn/pathway` | (a) Day-1 (no progress) · (b) Mid-streak (active learner) · (c) Streak broken (re-engagement) · (d) Phase complete · (e) Daily review due banner |
| `/learn/practice` | List of drill sets with progress indicators |
| `/practice/drill` | (a) Question presented · (b) Voice input active · (c) Text input fallback · (d) Evaluating · (e) Feedback shown with ideal-answer reveal · (f) Drill complete summary |
| `/learn/guides` | Index page with category groupings |
| `/learn/guides/[slug]` | Long-form article with TOC, code/quote blocks, related links |
| `/learn/badges` | Earned vs. locked grid, unlock animation pattern |
| `/learn/progress` | Charts (XP over time, streak calendar, competency radar), peer comparison card |

### 6.5 Shared / global

| Component | Notes |
|---|---|
| Top nav | Authenticated vs. anonymous; mobile hamburger; product switcher (Interview / Resume / Learn) |
| Footer | Minimal — links, status, social |
| Auth-aware menu | Avatar, plan badge, settings, sign out |
| Toast system | Success / error / info / progress (analysis-running) |
| Modals | Confirm, paywall, full-screen (interview end) |
| Empty states | Illustration system — propose; consistent across modules |
| Loading skeletons | Per-page-shape, not generic spinners |
| 404 / 500 pages | On-brand |

---

## 7. Key flows to storyboard

Beyond per-page design, we want **end-to-end flow boards** in Figma for these journeys so we can review the experience holistically:

1. **First-time visitor → first interview** — `/` → `/signup` → `/interview/setup` → `/lobby` → `/interview` → `/feedback/[sessionId]`
2. **Repeat user — quick retry** — `/` (authenticated home) → "Retake last" → `/lobby` → `/interview` → `/feedback`
3. **Free-tier paywall** — `/interview/setup` with quota exhausted → `/pricing` → checkout → return to setup
4. **Multimodal analysis** — end-of-interview → processing state → polling UX → completed replay screen (with synced video, signal timeline, transcript)
5. **Pathway daily loop** — `/learn/pathway` → lesson card → drill → evaluation → XP/streak update → next lesson queued
6. **Drill deep-dive** — `/practice/drill` → question → voice answer → AI eval → ideal-answer reveal → save to weakness queue
7. **Resume — build from scratch** — `/resume` empty → `/resume/templates` → `/resume/builder` → AI enhance → save → PDF export
8. **Resume — tailor to JD** — `/resume/tailor` → select resume + paste JD → AI tailoring → diff review → save as new
9. **Public scorecard share** — `/feedback/[sessionId]` → "Share" → generates `/scorecard/[token]` → recipient view (no auth)

Each flow should be a **single Figma frame** with the screens laid out left-to-right with arrows and annotations on decision points / variant branches.

---

## 8. Responsive breakpoints

Design at **four primary widths**, all mobile-first:

| Breakpoint | Width | Maps to Tailwind | Target device |
|---|---|---|---|
| **Mobile S** | 360px | (below `sm`) | iPhone SE, older Androids — design floor |
| **Mobile L** | 414px | (below `sm`) | iPhone 14/15, modern Android |
| **Tablet** | 768px | `md` | iPad portrait |
| **Laptop** | 1024px | `lg` | small laptop |
| **Desktop** | 1280px | `xl` | standard desktop |
| **Wide** | 1440px+ | `2xl`-ish | large desktop (graceful upscale, not a new layout) |

**Hard rules:**
- Nothing horizontal-scrolls at 360px (except intentionally swipeable carousels)
- Tap targets ≥ 44×44px on mobile
- Body type ≥ 16px on mobile (no 14px body)
- Modals on mobile become full-sheet, not centered dialogs
- The interview live screen (`/interview`) is the **one screen where we'll accept a "best on desktop" recommendation** — propose either a stripped-down mobile experience or a friendly "we recommend desktop for the live interview" handoff. Your call, justify it.

---

## 9. Accessibility & quality bar

- WCAG 2.1 AA color contrast on all text + UI
- Focus states visible and on-brand (not browser default)
- Form errors are color + icon + text (never color-only)
- Motion respects `prefers-reduced-motion`
- Keyboard-only navigation is fully usable on every page
- Screen reader: all interactive elements have accessible names; meaningful landmarks

---

## 10. Tech context vendors should know

So your tokens drop in cleanly:

- **Framework:** Next.js 14.2 (App Router), React 18, TypeScript 5
- **Styling:** TailwindCSS 3.4 (we'll consume your `tailwind.config.js` extension directly)
- **Animation:** Framer Motion 11 already in the stack
- **Icons:** Currently `lucide-react` — propose alternative only if strongly motivated
- **Components:** We use Radix primitives (accordion, dropdown, progress, separator, slot) — design with their composition model in mind
- **Charts:** Recharts is in the stack (used on `/learn/progress`)
- **Avatar:** SVG-based; emotions (neutral, friendly, curious, skeptical, impressed) + lip sync. Designer should review current implementation and decide if it stays, gets refreshed, or is fully redesigned. Quote should specify which.
- **Dark mode:** Not currently shipped. **Optional add-on** — quote separately if you want to propose it.

---

## 11. Timeline

**Hard launch date: `[FILL IN — please share]`**

> Apurv — please fill the launch date into this section before sending the brief out. Vendors will use it to size their team and confirm feasibility.

We expect vendors to work backward from the launch date and propose:

- **Discovery + 2–3 mood directions** — week range
- **Direction selected → component foundations** — week range
- **Page design (in priority order: Home, Interview live, Feedback, Pricing first)** — week range
- **Revisions (2 rounds built into quote)** — week range
- **Final handoff + tokens + Tailwind config + Loom walkthrough** — week

**Priority order if timeline gets tight** (cut from the bottom):
1. Home, Pricing, Sign-in/up, Settings
2. Interview setup → Lobby → Live → Feedback
3. Resume dashboard, builder, templates
4. Learn pathway + drill
5. Resume tailor + ATS check
6. Learn guides, badges, progress
7. History, scorecard share, legal pages

---

## 12. What we want in the quote

Please structure your proposal with these line items so we can compare quotes apples-to-apples:

| Line item | Detail | Cost | Days |
|---|---|---|---|
| 1. Discovery + mood directions (2–3) | | | |
| 2. Foundation tokens (color, type, spacing, motion) | | | |
| 3. Component library (Figma) — list components | | | |
| 4. Page designs — itemize by page count × variant count × 4 breakpoints | | | |
| 5. Flow boards (9 flows listed in §7) | | | |
| 6. Handoff package (tokens.json + Tailwind config + spec sheet + Loom) | | | |
| 7. Revisions — 2 rounds included; rate for additional rounds | | | |
| 8. Optional: Dark mode | | | |
| 9. Optional: Avatar visual refresh | | | |
| **Total (base)** | | | |
| **Total (with optional adds)** | | | |

Also include:
- **Team composition** — who works on this (lead designer, support, PM)
- **Tools used** — Figma plan, Tokens Studio, etc.
- **Communication cadence** — async (Loom) vs. live (Zoom), frequency
- **Sample work** — 2–3 most-relevant past projects (ideally consumer SaaS, AI products, or design-token engagements)
- **Availability** — when can you start; capacity per week
- **Payment terms** — milestone breakdown, deposit %

---

## 13. Selection criteria (how we'll choose)

Weighted, in order:
1. **Quality of past work** in consumer-SaaS visual design (40%)
2. **Clarity of process** and how you handle handoff to engineering (20%)
3. **Confidence in hitting the launch date** (15%)
4. **Price** (15%)
5. **Cultural fit / communication style** (10%)

We expect to shortlist 2–3 vendors after first round and do a paid micro-engagement (one page, one mood — $1–2k) before awarding the full scope.

---

## 14. What we'll provide

- This brief + appendix
- Read-only access to the live product (we'll create a test account with each tier — free, pro, enterprise)
- Read access to a staging environment if requested
- Slack/Discord channel for async questions during the engagement
- A point person (Apurv) for decision-making, 1 live call per week, async otherwise

---

## 15. Next steps

1. Reply with any clarifying questions by **`[deadline]`**
2. Submit proposal in the format of §12 by **`[deadline]`**
3. Shortlist call (45 min, Zoom) week of **`[date]`**
4. Paid micro-engagement (1 page, 1 mood) — 1 week
5. Full engagement award — **`[date]`**

---

## Appendix A — Current product context (for designer orientation)

**What we are:** AI mock-interview platform. A candidate signs up, configures an interview (role + interview type + JD), then has a live ~20-min conversation with an AI interviewer (Alex Chen). After the interview, they get a scored multimodal replay (synced video + word-level transcript + signal timeline + coaching tips). They can also build/tailor resumes and follow a spaced-repetition learning pathway between interviews.

**Who uses us:** consumer candidates — early-career to senior, technical and non-technical roles. Distribution skews mobile for first visit, desktop for the actual interview session.

**Pricing tiers:**
- **Free:** 3 interviews/month, basic feedback, 1 multimodal analysis/month
- **Pro:** 10 interviews/month, full multimodal, advanced features
- **Enterprise:** Unlimited

**Domains supported (managed dynamically by CMS):** PM, SWE, Data Science, Design, Marketing, Finance, Consulting, DevOps, HR, Legal, and more — vendor can reference these but doesn't need to design domain-specific UI.

**Interview depth levels:** HR Screening, Behavioral, Technical, Case Study, Domain Knowledge, Culture Fit.

---

## Appendix B — Pages explicitly NOT in scope

For clarity, vendors should NOT quote on or include these in deliverables:

- `/hire/*` — entire recruiter B2B platform (dashboard, candidates, scorecard, invite, templates, settings)
- `/cms/*` — internal admin panel
- `/invite/[sessionId]` — pre-auth candidate OTP page
- `/api/*` — backend
- Email templates (separate engagement)
- Mobile apps (we are web-only)

---

## Appendix C — Open questions for the vendor

We expect strong vendors to push back on us. Specifically, we want your opinion on:

1. **Mobile interview experience** — strip-down vs. desktop-handoff?
2. **Dark mode** — worth the scope cost for a v1 launch?
3. **Avatar (Alex Chen)** — refresh, redesign, or leave as-is?
4. **Section order on Home** — current page exists; tell us what you'd reorder and why
5. **Section order on Feedback** — current page exists; same
6. **Pricing page** — 3 tiers shown side-by-side, or stacked progressive disclosure?
7. **Empty states** — do you propose an illustration system or photographic / abstract?

Strong opinions, loosely held, please.

---

*End of brief.*

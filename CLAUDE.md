# Interview Prep Guru

AI-powered mock interview simulator. Users practice HR screening interviews with an AI interviewer (Alex Chen), get real-time coaching, and receive scored feedback.

Full-stack Next.js 14 app with Claude AI, MongoDB, Redis, and Stripe.

## Quick Commands

```bash
npm run dev        # Dev server on :3000
npm run build      # Production build
npm run test:run   # Run 111 tests (vitest)
npm run lint       # ESLint
```

## Tech Stack

| Layer        | Tech                                              |
|--------------|----------------------------------------------------|
| Framework    | Next.js 14.2.5 (App Router), React 18, TypeScript 5 |
| Auth         | NextAuth v4 — credentials + Google/GitHub OAuth    |
| Database     | MongoDB (Mongoose), Redis (ioredis)                |
| AI           | Anthropic Claude (claude-opus-4-6) via @anthropic-ai/sdk |
| Payments     | Stripe (free / pro / enterprise plans)             |
| Styling      | TailwindCSS 3.4 + Framer Motion                   |
| Testing      | Vitest + React Testing Library + JSDOM             |
| Validation   | Zod · Logging: Pino                                |
| Docs         | pdf-parse, mammoth (DOCX), plain text              |

## Project Structure (Modular Monolith)

```
modules/
  interview/                # Core interview engine (@interview/*)
    services/               # interviewService, evaluationEngine, personalizationEngine
    hooks/                  # useInterview, useSpeechRecognition, useMediaRecorder, useCoachingNudge
    components/             # Avatar, TranscriptPanel, Controls, DomainSelector, DepthSelector
    config/                 # coachingNudges, coachingTips, feedbackConfig, speechMetrics
    avatar/                 # EmotionEngine, LipSyncEngine, IdleAnimations
    validators/             # Zod schemas for interview API routes
  learn/                    # Learning & progress tracking (@learn/*)
    services/               # competencyService, pathwayPlanner, sessionSummaryService
    lib/                    # peerComparison, resources
    components/             # ResourceLinks
  b2b/                      # B2B hiring platform (@b2b/*)
    services/               # hireService (org, candidates, invites, templates, dashboard)
    validators/             # Zod schemas for hire API routes
  resume/                   # Resume builder tools (@resume/*)
    services/               # resumeService (CRUD), resumeAIService (enhance, ATS, tailor)
    validators/             # Zod schemas for resume API routes
  cms/                      # Content management (@cms/*)
    services/               # benchmarkService
    validators/             # CMS domain/type schemas
shared/                     # Cross-cutting concerns (@shared/*)
  auth/                     # NextAuth config, permissions, role hierarchy
  db/models/                # User, InterviewSession, Organization, InterviewTemplate, UsageRecord
  services/                 # documentParser, usageTracking, stripe
  middleware/               # composeApiRoute (auth → rate limit → validate → handler)
  layout/                   # AppShell, AuthMenu, Footer
  ui/                       # Generic UI components (Input, Button, Badge)
  providers/                # SessionProvider, ThemeProvider
  types.ts                  # Core TypeScript types
app/                        # Next.js App Router (pages & API routes)
  api/hire/                 # B2B recruiter API endpoints
  api/resume/               # Resume builder API endpoints
  api/learn/                # Learning feature API endpoints
  api/cms/                  # CMS admin API endpoints
  (hire)/                   # B2B recruiter pages
  (resume)/                 # Resume tool pages
  (learn)/                  # Learning & practice pages
  (cms)/                    # CMS admin pages
middleware.ts               # Route protection, subdomain rewriting, security headers
```

## Architecture Patterns

- **Client vs server**: Interview UI uses `'use client'` (hooks, browser APIs). Layouts and legal pages are server components.
- **API middleware**: `composeApiRoute<T>` chains auth → rate limiting (Redis) → Zod validation → handler. Error types: AppError, NotFoundError, ForbiddenError, UsageLimitError.
- **Interview state machine** (`useInterview.ts`): LOBBY → CALIBRATION → ASK_QUESTION → LISTENING → PROCESSING → COACHING → WRAP_UP → FEEDBACK
- **Session data**: localStorage for in-progress config (`INTERVIEW_CONFIG`, `INTERVIEW_DATA`). MongoDB for persistence.
- **AI scoring**: 5 dimensions — relevance, structure (STAR), specificity, ownership, jdAlignment. Supports follow-up questions.
- **Avatar**: SVG-based with emotions (neutral, friendly, curious, skeptical, impressed), lip sync, and Web Speech Synthesis TTS.

## Environment Variables

Required: `ANTHROPIC_API_KEY`, `NEXTAUTH_SECRET`, `MONGODB_URI`, `REDIS_URL`
Optional: `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, Stripe keys
Full list: `.env.local.example`

## Deployment

- **Production**: Vercel — auto-deploys from `main` branch
- **Workflow**: feature branch → PR → merge to `main` → Vercel deploys automatically
- **Self-hosting**: Docker available (`docker-compose up` — app + MongoDB + Redis)
- **`reactStrictMode: false`** in next.config.js — prevents interview double-invocation

## Auth & Roles

- Roles: `candidate` (default), `recruiter`, `org_admin`, `platform_admin`
- Free plan: 3 interviews/month (usage tracked per user)
- Protected routes defined in `middleware.ts`
- B2B routes (`/hire/*`) require recruiter+

---

## Recent Changes

_Update this section each session to carry context forward._

- **Bug fixes**: history/feedback navigation, login redirect flow, first question timing delay, voice synthesis, branding consistency
- **Code quality**: DRY extraction of shared utilities, session-scoped localStorage keys, 111 tests passing
- **SEO phase 1**: Open Graph metadata, JSON-LD structured data, sitemap.ts, favicons, security headers, robots.txt
- **SEO phase 2**: "How It Works" + feature content sections on homepage, Privacy Policy & Terms of Service pages, semantic HTML (aria-labels, `<main>` wrappers), internal cross-linking, h1 brand name fix
- **CLAUDE.md**: Added this file for cross-session context
- **Voice & responsiveness**: Faster TTS rate (0.95→1.08), warmer pitch, parallel eval+question generation, reduced inter-phase delays, switched real-time APIs to claude-sonnet-4-6 for speed
- **CMS + Interview Domains/Depth**: Expanded from 4 hardcoded roles to 12+ dynamic interview domains (PM, SWE, DS, Design, Marketing, Finance, Consulting, DevOps, HR, Legal, etc.) managed via CMS. Added 6 interview depth levels (HR Screening, Behavioral, Technical, Case Study, Domain Knowledge, Culture Fit). CMS admin at cms.interviewprepguru.com subdomain with middleware-based routing. Homepage redesigned with domain catalog, search, category tabs, and depth selector. AI prompts dynamically adapt to domain/depth. All 166 tests passing.
- **Modular monolith refactor**: Reorganized codebase from flat `lib/`, `components/`, `hooks/` into 5 domain modules (`interview`, `learn`, `b2b`, `resume`, `cms`) + `shared/` kernel. All modules have barrel exports and path aliases (`@interview/*`, `@learn/*`, `@b2b/*`, `@resume/*`, `@cms/*`, `@shared/*`). Business logic extracted from API routes into module services. Removed legacy empty directories and dead middleware routes. 252 tests passing, production build clean.

## Known Issues / TODO

_Add items as they arise. Remove when resolved._

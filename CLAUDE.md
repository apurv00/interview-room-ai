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

## Project Structure

```
app/                        # Next.js App Router
  (auth)/                   # signin, signup pages
  api/                      # API routes
    generate-question/      # AI question generation
    evaluate-answer/        # Real-time answer scoring (5 dimensions)
    generate-feedback/      # End-of-session feedback
    interviews/             # Interview CRUD
    recordings/             # Video upload
    documents/upload/       # JD/resume parsing (PDF, DOCX, TXT)
    analytics/              # Peer comparison metrics
  interview/                # Main interview page (client component)
  feedback/[sessionId]/     # Feedback display
  history/                  # Past interviews
  pricing/                  # Pricing page
  privacy/, terms/          # Legal pages
components/
  interview/                # TranscriptPanel, Controls, CoachingNudge
  feedback/                 # ScoreTrendChart, PeerComparison, AudioPlayer
  layout/                   # AppShell, Header, Footer
hooks/
  useInterview.ts           # Interview state machine (main orchestrator)
  useSpeechRecognition.ts   # Browser speech-to-text
  useMediaRecorder.ts       # Video recording
  useCoachingNudge.ts       # Live coaching tips
lib/
  auth/                     # NextAuth config, permissions
  db/models/                # User, InterviewSession, Organization, InterviewTemplate, UsageRecord
  services/                 # interviewService, documentParser, usageTracking, stripe
  middleware/               # composeApiRoute (auth → rate limit → validate → handler)
  avatar/                   # EmotionEngine, LipSyncEngine
  types.ts                  # Core TypeScript types
providers/                  # React context (SessionProvider)
middleware.ts               # Route protection & role checks
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
- B2B routes (`/dashboard`, `/candidates`, `/templates`) require recruiter+

---

## Recent Changes

_Update this section each session to carry context forward._

- **Bug fixes**: history/feedback navigation, login redirect flow, first question timing delay, voice synthesis, branding consistency
- **Code quality**: DRY extraction of shared utilities, session-scoped localStorage keys, 111 tests passing
- **SEO phase 1**: Open Graph metadata, JSON-LD structured data, sitemap.ts, favicons, security headers, robots.txt
- **SEO phase 2**: "How It Works" + feature content sections on homepage, Privacy Policy & Terms of Service pages, semantic HTML (aria-labels, `<main>` wrappers), internal cross-linking, h1 brand name fix
- **CLAUDE.md**: Added this file for cross-session context
- **Voice & responsiveness**: Faster TTS rate (0.95→1.08), warmer pitch, parallel eval+question generation, reduced inter-phase delays, switched real-time APIs to claude-sonnet-4-6 for speed

## Known Issues / TODO

_Add items as they arise. Remove when resolved._

<!-- Example:
- [ ] Stripe webhook endpoint not tested in production
- [ ] Mobile recording quality needs testing on Safari
-->

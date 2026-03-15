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
- **CMS + Interview Domains/Depth**: Expanded from 4 hardcoded roles to 12+ dynamic interview domains (PM, SWE, DS, Design, Marketing, Finance, Consulting, DevOps, HR, Legal, etc.) managed via CMS. Added 6 interview depth levels (HR Screening, Behavioral, Technical, Case Study, Domain Knowledge, Culture Fit). CMS admin at cms.interviewprep.guru subdomain with middleware-based routing. Homepage redesigned with domain catalog, search, category tabs, and depth selector. AI prompts dynamically adapt to domain/depth. All 166 tests passing.
- **Modular monolith refactor**: Reorganized codebase from flat `lib/`, `components/`, `hooks/` into 5 domain modules (`interview`, `learn`, `b2b`, `resume`, `cms`) + `shared/` kernel. All modules have barrel exports and path aliases (`@interview/*`, `@learn/*`, `@b2b/*`, `@resume/*`, `@cms/*`, `@shared/*`). Business logic extracted from API routes into module services. Removed legacy empty directories and dead middleware routes. 252 tests passing, production build clean.

## Resume Module — Functional Context

The Resume Builder is a self-contained tool within Interview Prep Guru that helps candidates create, enhance, and optimize resumes. It lives under the `/resume` route group and is accessible to all authenticated users.

### What It Does

**Build & Edit Resumes**
Users create resumes through a structured editor with sections for contact info, professional summary, work experience (with bullet points), education, skills (grouped by category), projects, certifications, and custom sections. Each user can save up to 3 resumes. Users can start from scratch, choose from 10 pre-built templates, upload an existing resume (PDF, DOCX, or plain text), or import details from their Interview Prep Guru profile.

**AI-Powered Enhancement**
An AI assistant (powered by Claude) can improve resume content in several ways:
- **Enhance a section** — Rewrites a summary or section to be more impactful with stronger action verbs, quantified achievements, and ATS-friendly keywords while keeping the facts unchanged.
- **Enhance bullets** — Rewrites individual experience bullet points to start with action verbs, add metrics, and include relevant keywords.
- **Generate full suggestions** — Produces AI-written drafts for every section (summary, experience, education, skills, projects) based on the user's profile and target role.
- **Parse uploaded resume** — Converts unstructured resume text from an uploaded file into the structured format used by the editor, extracting contact info, experience, education, skills, projects, and certifications.

**ATS Compatibility Check**
Users can run an ATS (Applicant Tracking System) analysis on any resume. The system scores the resume from 0–100 and reports:
- Formatting issues that ATS software may struggle with (tables, columns, non-standard headers)
- Missing standard section headers
- Keyword gaps (especially when a job description is provided for comparison)
- Contact info placement and date formatting consistency
- A list of sections found, missing, and recommended

**Job-Specific Tailoring**
Users provide a resume and a job description, and the AI:
- Reorders bullet points to highlight the most relevant experience first
- Weaves job-description keywords naturally into existing descriptions
- Quantifies achievements where possible
- Never fabricates experience — only rephrases existing content
- Returns a match score (0–100), a list of changes made with reasons, and keyword analysis (added vs. still missing)
Users can copy the tailored resume or save it as a new resume.

**Templates**
There are 10 resume templates, each designed for different career contexts:
- Professional (finance, consulting, enterprise)
- Technical (engineering, data science)
- Creative (design, marketing, media)
- Executive (C-suite, VP+, director)
- Career Change (transferable-skills focused)
- Entry Level (education-forward for graduates)
- Minimalist (clean single-column)
- Academic (publications and research)
- Federal (USAJobs-compatible format)
- Startup (personality-forward, modern)

Each template has a live preview in the editor that updates in real time as the user types.

**PDF Export**
Users can download their resume as a PDF. The system generates a server-side PDF using the selected template. If server-side generation is unavailable, a browser print-to-PDF fallback is offered.

### User Flow

1. **Dashboard** (`/resume`) — Shows quick-action cards (build, tailor, ATS check), lists saved resumes with their ATS scores and last-updated dates, and provides delete functionality.
2. **Builder** (`/resume/builder`) — The main editor with a two-column layout: form editor on the left, live template preview on the right. Includes AI enhancement buttons, drag-and-drop section reordering, and save/export controls.
3. **Templates** (`/resume/templates`) — Browse and preview all 10 templates with sample data. Select a template to start building with it.
4. **Tailor** (`/resume/tailor`) — Select or upload a resume, paste a job description, and get an AI-tailored version with keyword analysis and match scoring.
5. **ATS Check** (`/resume/ats-check`) — Select or upload a resume, optionally add a job description, and receive a detailed ATS compatibility report.

### Integration with Other Modules

- **User Profile**: The resume builder can import a user's name, email, title, industry, skills, and LinkedIn URL from their Interview Prep Guru profile (set during interview onboarding).
- **Document Upload**: Shares the document parsing service (`/api/documents/upload`) with the interview module for uploading PDFs, DOCX files, and plain text.
- **Authentication**: All resume features require sign-in. Resume data is stored as part of the User document in MongoDB.

## Known Issues / TODO

_Add items as they arise. Remove when resolved._

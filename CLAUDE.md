# Interview Prep Guru

AI-powered mock interview simulator. Users practice HR screening interviews with an AI interviewer (Alex Chen), get real-time coaching, and receive scored feedback.

Full-stack Next.js 14 app with Claude AI, MongoDB, Redis, and Stripe.

## Session Setup (run first)

```bash
git pull origin main        # Get latest changes
npx gitnexus analyze        # Rebuild codebase graph for full awareness
```

## Quick Commands

```bash
npm run dev          # Dev server on :3000
npm run dev:inngest  # Inngest dev dashboard on :8288 (run in a second terminal for background jobs)
npm run build        # Production build
npm run test:run     # Run tests (vitest)
npm run lint         # ESLint
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
- **Background jobs (Inngest)**: Long-running and scheduled work runs as Inngest functions, not inline HTTP handlers.
  - Client posts to `/api/analysis/start` → route emits `inngest.send({ name: 'analysis/requested', ... })` → returns `{ jobId, status: 'pending' }` in <500ms.
  - `analysisJob` (at `modules/interview/jobs/analysisJob.ts`) runs the 5 pipeline steps as independent `step.run()` calls, each retried by Inngest.
  - Client keeps polling `/api/analysis/[sessionId]` every 3s; DB row advances `pending → processing → completed`.
  - Scheduled functions: `emailDigestJob` (daily 9 AM UTC), `regeneratePlansJob` (monthly). All registered via `/api/inngest`.
  - Local dev: run `npm run dev:inngest` in a second terminal to boot the Inngest dev dashboard at localhost:8288.

- **Model Router** (`shared/services/modelRouter.ts`): All LLM calls go through `completion()` / `completionStream()` which resolve the model+provider from CMS config (ModelConfig collection). 26 task slots cover every AI call site. Fallback chain: CMS primary → CMS fallback → hardcoded Anthropic default. Config cached in-memory for 60s, invalidated on CMS save. OpenRouter integration via Anthropic SDK pointed at `https://openrouter.ai/api/v1`. CMS admin: `/cms/model-config`.

## HOT PATH — DO NOT BREAK

These files drive the live interview and AI analysis pipelines. A regression
here is a P0 that reaches users on the next deploy:

- `modules/interview/hooks/useInterview.ts`
- `modules/interview/hooks/useAvatarSpeech.ts`
- `modules/interview/hooks/useDeepgramRecognition.ts`
- `modules/interview/hooks/useStreamingAudio.ts`
- `modules/interview/audio/voiceMixer.ts`
- `app/api/tts/route.ts`
- `app/api/tts/stream/route.ts`
- `app/api/generate-question/route.ts`
- `app/api/evaluate-answer/route.ts`
- `modules/interview/jobs/analysisJob.ts`

**Rules for ANY change to these files (no exceptions):**

1. **Measure before theorizing.** If the bug is about timing or latency,
   reproduce it locally with DevTools Network panel open and record actual
   numbers before proposing a fix. Never defer a UI update to "smooth over"
   a slow backend — fix the backend.

2. **Check the neighborhood.** Run `git log --since="7 days ago" -- modules/interview app/api/tts app/api/generate-question app/api/evaluate-answer`
   before diagnosing. The root cause may be two commits upstream in a file
   the bug report doesn't mention.

3. **End-to-end verification is mandatory.** Unit tests, type checks, and
   `npm run build` are NOT sufficient. Run `npm run dev` with real
   `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` set, complete one full
   interview, and verify:
   - Intro text appears ≤500 ms after clicking Start
   - First audio byte on `/api/tts/stream` arrives ≤600 ms (cold cache)
   - TranscriptPanel's "Preparing next question..." placeholder is never
     visible for >500 ms
   - Candidate can interrupt the AI with ≥3 words of speech
   - One-word background noise does NOT interrupt the AI
   - End-interview button stops all audio within 100 ms

4. **Do not treat symptoms.** If the obvious fix is "hide this slow thing
   from the user" or "add a delay so timings line up", STOP and find the
   actual cause. Deferring UI to match a slow API is not a fix, it's
   camouflage. This is the exact failure mode that broke BUG-7.

5. **When in doubt, ask before merging.** The cost of a clarifying
   question is zero. The cost of re-breaking the investor demo is not.

6. **Read the flow doc first.** Before touching any hot-path file, read
   the relevant spec in `modules/interview/docs/`:
   - `INTERVIEW_FLOW.md` — live interview pipeline
   - `AI_ANALYSIS.md` — post-interview multimodal analysis

   Update section 8 (Known Failure Modes) whenever you fix a bug in
   these files. The log is append-only and is the institutional memory
   of what has broken and why.

## Commit Accountability — ENFORCED BY HOOKS

Claude has historically shipped "fixes" that addressed symptoms without
root causes, wasting user time. This repo runs harness hooks
(`.claude/hooks/`, registered in `.claude/settings.json`) that
**mechanically block** commits and edits that skip these rules. You cannot
argue past the hooks — they run in the harness, not in the model.

**Every Claude-authored commit message MUST contain these fields:**

```
Root-cause: <the actual mechanism — not "the test failed", but WHY>
Symbols-modified: <comma-separated list, or "none — data-only">
Tests-added: <path>  OR  No-tests-needed-because: <justified reason>
Verified-by: <unit test / integration test / manual steps with expected output>
```

If a file listed in `.claude/hotpath.txt` is in the staged diff, the
commit MUST also include a test file (under `__tests__/`, `*.test.ts`,
or `*.spec.ts`) OR an explicit `No-tests-needed-because:` line.

**Every edit to a hot-path file MUST be preceded by:**

```
./scripts/gitnexus-impact.sh <file>
```

This writes `.claude/audit/current/impact-<basename>.md`, listing every
d=1 caller from `.gitnexus/csv/relations.csv`. The pre-edit hook blocks
the edit until this file exists and is <24h old.

**Permanent audit trail:** every commit is appended to
`.claude/audit/log.md` with its root-cause, verification method, and
test delta — giving the user an independent record of every claim
Claude has made in this repo.

**CI enforcement:** `.github/workflows/claude-accountability.yml`
rejects any PR whose Claude-authored commits are missing the required
fields. Bypassing requires rewriting history, which shows up in review.

**If you find yourself about to say "this is a minor change, skip the
process":** that's the exact failure mode the hooks exist to catch.
Either the change is genuinely no-risk (write `No-tests-needed-because:
pure whitespace` — the hook will accept it) or you're about to repeat a
historical mistake.

## Environment Variables

Required: `ANTHROPIC_API_KEY`, `NEXTAUTH_SECRET`, `MONGODB_URI`, `REDIS_URL`
Optional model routing: `OPENROUTER_API_KEY` — enables routing AI calls through OpenRouter (configure per-task in CMS)
Multimodal: `DEEPGRAM_API_KEY`, `FEATURE_FLAG_MULTIMODAL_ANALYSIS=true`, `NEXT_PUBLIC_FEATURE_MULTIMODAL=true`
Optional model routing: `GROQ_API_KEY` — enables routing AI calls through Groq (configure per-task in CMS)
Inngest (production only): `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — not required in dev; the `npm run dev:inngest` dev server handles routing locally.
Optional: `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, Stripe keys, `OPENAI_API_KEY`
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

- **Background jobs moved to Inngest** (architecture Phase 2): `/api/analysis/start` no longer runs the multimodal pipeline inline — it emits an `analysis/requested` Inngest event and returns `{ jobId, status: 'pending' }` in <500ms. The pipeline now runs as 5 independently-retried Inngest `step.run()` calls inside `modules/interview/jobs/analysisJob.ts`. The two Vercel crons (`email-digest`, `regenerate-plans`) migrated to Inngest scheduled functions; `vercel.json` crons entry removed. `FailedJob` model deleted (unused; Inngest handles retries natively). Client polling infrastructure at `AnalysisTrigger.tsx` required no changes — it was already designed for a background-worker model.
- **Boundary hygiene + ESLint enforcement** (architecture Phase 1): Moved ScoreBar + FileDropzone from `modules/interview` into `shared/ui/`. AppShell now takes slot props so `app/layout.tsx` injects XpBadge / BadgeUnlockChecker from `@learn` (no more shared → module import). Fixed 6 cross-module barrel bypasses (cms, resume, interview, learn services + components). Added `no-restricted-imports` ESLint rule with per-module overrides: `shared/**` cannot depend on any module; modules cross-import only via barrels; `app/**` and tests exempt. Added bare aliases (`@interview`, `@learn`, …) to tsconfig paths.
- **Service-level test safety net** (architecture Phase 0): Added 86 new tests across resume, b2b, and cms module services before touching any code. Total: 819 tests passing across 66 files.
- **Multimodal interview analysis (Phase 2)**: Post-interview analysis pipeline — Groq Whisper transcription + MediaPipe facial landmarks + Claude Haiku fusion → Interview Replay page with synced video, signal timeline, word-level transcript, coaching tips. Feature-flagged, quota-gated (Free: 1/month, Pro: 10/month, Enterprise: unlimited).
- **Real-time multimodal coaching**: Client-side MediaPipe facial coaching (eye contact, expression, head stability nudges), reactive avatar (responds to candidate), Deepgram Aura TTS (natural AI voice), Deepgram streaming STT (replaces Web Speech API), real-time prosody coaching.
- **Performance**: Switched fusion from Sonnet→Haiku (~15s→3-5s), Whisper from OpenAI→Groq (~25s→3s), eval+question gen from Sonnet→Haiku (~4s→1-2s), coaching delay 1500ms→800ms.
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

- **Tech debt: Re-enable research pipeline once Vercel Pro + Inngest configured.** The inline analysis fallback (`runMultimodalPipeline({ inline: true })`) skips the dual-pipeline research comparison and per-second facial timeseries generation to fit within Vercel Hobby's 60s function timeout. Once Inngest is configured in production (env vars `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`) or Vercel Pro is available, these features run automatically via the background job path. No code change needed — just configure the env vars. To also enable them for the inline path, remove the `isInline` guards in `modules/interview/services/analysis/multimodalPipeline.ts`.

- **Tech debt: expand `REQUIREMENT_TO_SLOT` for non-SWE domains before flipping `FEATURE_FLAG_JD_FLOW_OVERLAY=true` in production for PM/design/business JDs.** The keyword map at `modules/interview/flow/jdOverlayBuilder.ts:8-49` is SWE-biased. Keywords like `incident`, `tech debt`, `ci/cd` land cleanly on backend/sdet/data-science slot ids but have near-zero coverage for pm, design, and business templates. Consequence: for PM/design/business JDs, the overlay degrades to "2 generic insertions, cap-dropped rest" — still a net improvement over today's zero-overlay, but not high-quality. Fix paths: (a) widen the flat map in-place (~2h content authoring + 30min coverage test), or (b) refactor to per-domain keyword files (`modules/interview/flow/templates/{domain}-jd-keywords.ts` composed in the builder) when the flat map exceeds ~100 entries. Also note: current matcher uses `String.includes(keyword)` which can false-positive short keywords (`ml`, `api`) — consider `\b` word-boundary regex before the map grows. Safe to enable `FEATURE_FLAG_JD_FLOW_OVERLAY=true` in production for backend/frontend/sdet/data-science domains today (keyword coverage solid); defer PM/design/business enable until keyword expansion lands.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **interview-room-ai** (4398 symbols, 8966 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/interview-room-ai/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/interview-room-ai/context` | Codebase overview, check index freshness |
| `gitnexus://repo/interview-room-ai/clusters` | All functional areas |
| `gitnexus://repo/interview-room-ai/processes` | All execution flows |
| `gitnexus://repo/interview-room-ai/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

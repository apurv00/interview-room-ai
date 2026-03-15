# Mock Interview — Functional & Architecture Context

> AI-powered mock interview simulator where users practice HR screening and behavioral interviews with an AI interviewer (Alex Chen), receive real-time coaching during the session, and get a scored feedback report afterwards.

---

## Table of Contents

1. [User Flow Overview](#1-user-flow-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Interview State Machine](#3-interview-state-machine)
4. [AI Interviewer Persona](#4-ai-interviewer-persona)
5. [Avatar System](#5-avatar-system)
6. [Coaching System](#6-coaching-system)
7. [Scoring & Evaluation](#7-scoring--evaluation)
8. [Feedback Report](#8-feedback-report)
9. [Personalization Engine](#9-personalization-engine)
10. [Speech & Media](#10-speech--media)
11. [API Reference](#11-api-reference)
12. [Data Models](#12-data-models)
13. [Module Structure](#13-module-structure)
14. [Security & Safety](#14-security--safety)
15. [Configuration & CMS](#15-configuration--cms)
16. [Usage Limits & Billing](#16-usage-limits--billing)

---

## 1. User Flow Overview

```
Home Page          Lobby              Interview Room         Feedback
┌───────────┐    ┌──────────┐       ┌────────────────┐     ┌──────────────┐
│ Select:   │    │ System   │       │ AI Avatar      │     │ Overall Score│
│ • Domain  │───>│ Checks:  │──────>│ Live Transcript│────>│ Dimensions   │
│ • Depth   │    │ • Camera │ Join  │ Speech Input   │ End │ Per-Question │
│ • Exp Lvl │    │ • Mic    │       │ Coaching Tips  │     │ Improvements │
│ • Duration│    │ • Network│       │ Timer/Controls │     │ Peer Compare │
│ • JD/Resume│   │ • Speech │       │ Recording      │     │ Transcript   │
└───────────┘    └──────────┘       └────────────────┘     └──────────────┘
```

### Step-by-Step

1. **Configure** — User selects interview domain (PM, SWE, Sales, etc.), depth level (HR Screening, Behavioral, Technical, etc.), experience level (0-2, 3-6, 7+ years), and duration (10/20/30 min). Optionally uploads a Job Description and/or Resume (PDF/DOCX/TXT).

2. **Lobby** — System checks camera, microphone, speech recognition, and network latency. User sees a live camera preview with an audio level meter. Config is stored in `localStorage`.

3. **Interview Room** — The AI interviewer (Alex Chen) conducts the interview. User sees an SVG avatar, their own camera feed, a live transcript, and coaching nudges. The full session is recorded (WebM video).

4. **Feedback** — A comprehensive scored report with per-question breakdown, communication metrics, red flags, improvement tips, peer comparison, and downloadable transcript.

---

## 2. Architecture Overview

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router), React 18, TypeScript |
| AI | Anthropic Claude (claude-sonnet-4-6 for real-time, claude-opus-4-6 for feedback) |
| Database | MongoDB (Mongoose) — session storage, user profiles, CMS config |
| Cache | Redis (ioredis) — rate limiting, peer comparison cache |
| Storage | Cloudflare R2 — recordings, uploaded documents |
| Speech | Web Speech API (SpeechRecognition) — browser-native STT |
| TTS | Web Speech Synthesis API — avatar voice output |
| Recording | MediaRecorder API — WebM video capture |
| Auth | NextAuth v4 (credentials + Google/GitHub OAuth) |

### Request Flow

```
Browser                    Next.js API Routes              External Services
┌─────────────┐           ┌─────────────────┐            ┌──────────────┐
│ useInterview │──fetch───>│ composeApiRoute  │───────────>│ Claude API   │
│ hook         │          │  ├─ auth check   │            │ (Anthropic)  │
│              │          │  ├─ rate limit   │            └──────────────┘
│ useSpeech    │          │  ├─ zod validate │            ┌──────────────┐
│ Recognition  │          │  └─ handler      │───────────>│ MongoDB      │
│              │          └─────────────────┘            └──────────────┘
│ useMedia     │                                         ┌──────────────┐
│ Recorder     │──upload──────────────────────────────────>│ Cloudflare R2│
└─────────────┘                                          └──────────────┘
```

### Module Organization

The interview feature is organized as a module within a modular monolith:

```
modules/interview/          # @interview/* path alias
  services/                 # Server-side business logic
  hooks/                    # Client-side React hooks
  components/               # UI components
  config/                   # Static configuration
  avatar/                   # Avatar animation engines
  validators/               # Zod schemas for API validation
```

---

## 3. Interview State Machine

The interview is driven by a state machine in `useInterview.ts`. Each state transition triggers specific actions.

```
LOBBY ──> CALIBRATION ──> ASK_QUESTION ──> LISTENING ──> PROCESSING ──> COACHING
  │                           ^                              │              │
  │                           │                              v              │
  │                           └──────────────────────────────┘              │
  │                           ^                                             │
  │                           └─────────────────────────────────────────────┘
  │
  │         (after all questions or timer expires)
  │
  └──────────────────────────> WRAP_UP ──> FEEDBACK
```

### State Details

| State | What Happens | Duration |
|-------|-------------|----------|
| **LOBBY** | Load config from localStorage, create DB session, check usage limits. If limit reached, redirect to pricing. | Instant |
| **CALIBRATION** | Play intro greeting via TTS ("Hi, I'm Alex Chen..."), set avatar emotion to `friendly`. Establishes the persona. | ~3-5s |
| **ASK_QUESTION** | Call `/api/generate-question` to get next question from Claude. Display question text, speak it via TTS, set avatar emotion to `curious`. | ~2-4s |
| **LISTENING** | Start speech recognition. User speaks their answer. Live transcript updates in real-time. Filler words, WPM, and pauses are tracked. Coaching nudges appear if issues detected. | User-controlled |
| **PROCESSING** | User finishes speaking. Call `/api/evaluate-answer` to score the response. Compute speech metrics. Check for follow-up questions. | ~1-2s |
| **COACHING** | Display coaching tip based on evaluation scores. If evaluation says `needsFollowUp`, use the follow-up question as the next question instead of generating a new one. Set avatar emotion based on scores. | ~3s |
| **WRAP_UP** | Final closing statement from Alex. Persist full session to DB (transcript, evaluations, speech metrics). Upload recording. | ~3s |
| **FEEDBACK** | Call `/api/generate-feedback` for comprehensive report. Save feedback to DB. Navigate to `/feedback` page. | ~5-10s |

### Question Flow Logic

```
questionIndex = 0

for each question:
  1. Generate question via Claude (or use follow-up from prior evaluation)
  2. Speak question, wait for answer
  3. Evaluate answer → get scores + followUp flag
  4. If needsFollowUp AND not at question limit:
       → Use followUpQuestion as next question (no new generation)
  5. Else:
       → Increment questionIndex, generate new question
  6. If questionIndex >= QUESTION_COUNT[duration] OR timer expired:
       → Transition to WRAP_UP

QUESTION_COUNT = { 10: 4, 20: 7, 30: 10 }
```

### Avatar Emotion Mapping

| Score Range | Emotion | Description |
|-------------|---------|-------------|
| >= 80 | `impressed` | Eyes wide, slight smile — great answer |
| >= 60 | `friendly` | Warm, encouraging — solid answer |
| >= 40 | `neutral` | Professional, attentive — average answer |
| < 40 | `skeptical` | Slight frown, head tilt — needs improvement |
| (asking) | `curious` | Raised eyebrow — listening intently |

---

## 4. AI Interviewer Persona

### Identity: Alex Chen

Alex Chen is a senior HR professional with 12+ years of experience. The persona is embedded in every Claude API prompt.

**Core Persona Traits:**
- Warm but professional tone
- Asks focused, single-part questions
- Uses follow-up probing when answers lack depth
- Adapts difficulty based on experience level
- References job description/resume when available
- Never breaks character or reveals AI nature

### Prompt Architecture

Each AI call constructs a system prompt with layered context:

```
┌─────────────────────────────────────────┐
│ System Prompt                           │
│  ├─ Persona definition (Alex Chen)     │
│  ├─ Domain context (from CMS/DB)       │
│  ├─ Depth-specific instructions        │
│  ├─ User profile context               │
│  │    ├─ Career stage & title          │
│  │    ├─ Weak areas (from history)     │
│  │    ├─ Career switcher status        │
│  │    └─ Target companies/goal         │
│  ├─ Session brief (personalization)    │
│  └─ Question bank (RAG context)        │
│                                         │
│ User Prompt                             │
│  ├─ <job_description>...</job_desc>    │
│  ├─ <resume>...</resume>               │
│  ├─ Previous Q&A (conversation context)│
│  └─ "Generate question #N"             │
└─────────────────────────────────────────┘
```

### AI Models Used

| Endpoint | Model | Max Tokens | Why |
|----------|-------|-----------|-----|
| Generate Question | `claude-sonnet-4-6` | 300 | Fast response for real-time flow |
| Evaluate Answer | `claude-sonnet-4-6` | 400 | Fast scoring during interview |
| Generate Feedback | `claude-opus-4-6` | 1200 | Higher quality for final report |
| Extract Profile | `claude-sonnet-4-6` | 300 | Resume parsing for onboarding |

---

## 5. Avatar System

The AI interviewer is represented by an SVG-based animated avatar.

### Components

| Engine | File | Purpose |
|--------|------|---------|
| **EmotionEngine** | `avatar/EmotionEngine.ts` | Maps emotion states to facial feature parameters (eye shape, mouth curve, brow position, head tilt). Smooth transitions between emotions via interpolation. |
| **LipSyncEngine** | `avatar/LipSyncEngine.ts` | Analyzes TTS audio output to drive mouth animation. Maps phoneme groups to viseme shapes (open/closed/round). Syncs with Web Speech Synthesis events. |
| **IdleAnimations** | `avatar/IdleAnimations.ts` | Subtle idle movements (blinking, micro head movements, breathing) to make the avatar feel alive when not actively speaking or emoting. |

### Emotion States

| Emotion | Visual | Trigger |
|---------|--------|---------|
| `neutral` | Default professional expression | Idle, between questions |
| `friendly` | Warm smile, relaxed eyes | Good answer (60-79), greeting |
| `curious` | Raised eyebrow, slight head tilt | Asking a question, listening |
| `skeptical` | Slight frown, narrowed eyes | Weak answer (<40) |
| `impressed` | Wide eyes, genuine smile | Excellent answer (80+) |

### Avatar Component

The `Avatar` component (`components/Avatar.tsx`) renders an SVG face with:
- Dynamic facial features driven by the emotion engine
- Lip sync animation during TTS speech
- Idle animations (blinks every 3-5s, micro-movements)
- Smooth transitions between emotion states (~300ms)

---

## 6. Coaching System

Real-time coaching provides feedback during the interview, not just after.

### Coaching Nudges (Real-time)

Triggered by `useCoachingNudge` hook based on speech metrics during the LISTENING state:

| Nudge | Trigger | Message Example |
|-------|---------|-----------------|
| **Filler Words** | fillerRate > 0.05 | "Try to reduce filler words like 'um' and 'uh'" |
| **Speaking Pace** | WPM > 180 | "Slow down a bit — you're speaking quite fast" |
| **Speaking Pace** | WPM < 90 | "Try to maintain a steady pace" |
| **Long Pauses** | pause > 5s | "Take a moment to collect your thoughts, then continue" |
| **Rambling** | answer > 90s | "Consider wrapping up your response" |

### Coaching Tips (Post-answer)

Generated by `deriveCoachingTip()` based on evaluation scores:

| Dimension | Low Score Tip |
|-----------|--------------|
| `relevance` < 60 | "Focus on directly answering the question asked" |
| `structure` < 60 | "Try using the STAR method (Situation, Task, Action, Result)" |
| `specificity` < 60 | "Include specific numbers, metrics, or concrete examples" |
| `ownership` < 60 | "Use 'I' statements to show personal contribution" |
| `jdAlignment` < 60 | "Connect your answer to the job requirements" |

### Speech Metrics Tracked

| Metric | Calculation | Good Range |
|--------|-------------|-----------|
| **WPM** | totalWords / durationMinutes | 120-160 |
| **Filler Rate** | fillerWordCount / totalWords | < 0.03 |
| **Pause Score** | Based on silence gaps | 60-100 |
| **Rambling Index** | Answer length relative to expected | < 0.3 |

---

## 7. Scoring & Evaluation

### Per-Answer Scoring (5 Dimensions)

Each candidate answer is evaluated by Claude across 5 dimensions:

| Dimension | What It Measures | Score Range |
|-----------|-----------------|-------------|
| **Relevance** | Does the answer address the question asked? | 0-100 |
| **Structure** | Is the answer organized (STAR method)? | 0-100 |
| **Specificity** | Does it include concrete examples, numbers, metrics? | 0-100 |
| **Ownership** | Does the candidate show personal contribution ("I did X")? | 0-100 |
| **JD Alignment** | Does it connect to the job description? (only if JD provided) | 0-100 |

### Evaluation Response

Each evaluation also returns:
- `needsFollowUp: boolean` — Should Alex probe deeper?
- `followUpQuestion: string` — The specific follow-up to ask
- `flags: string[]` — Red flags detected (e.g., "Blame-shifting", "No measurable impact", "Vague generalization")

### CMS-Configurable Scoring

Interview depth types (configured via CMS) can override the default 5 dimensions with custom ones:

```json
{
  "slug": "technical",
  "scoringDimensions": [
    { "name": "technical_depth", "label": "Technical Depth", "weight": 30 },
    { "name": "problem_solving", "label": "Problem Solving", "weight": 25 },
    { "name": "system_design", "label": "System Design", "weight": 20 },
    { "name": "communication", "label": "Communication", "weight": 15 },
    { "name": "code_quality", "label": "Code Quality", "weight": 10 }
  ]
}
```

---

## 8. Feedback Report

Generated by Claude Opus after the interview ends. The feedback page (`/feedback/[sessionId]`) displays:

### Overall Assessment

| Field | Type | Description |
|-------|------|-------------|
| `overall_score` | 0-100 | Weighted composite of all dimensions |
| `pass_probability` | High/Medium/Low | Likelihood of passing a real interview |
| `confidence_level` | High/Medium/Low | How confident the AI is in its assessment |

### Three Scoring Dimensions

**1. Answer Quality**
- Aggregate of per-question relevance, structure, specificity, ownership scores
- Lists specific strengths and weaknesses
- Example: _Strength: "Strong STAR structure in 3/5 answers"_

**2. Communication**
- WPM (words per minute)
- Filler word rate
- Pause score (comfortable vs. awkward silences)
- Rambling index

**3. Engagement Signals**
- Per-question engagement score
- Confidence trend (increasing/stable/declining across the interview)
- Energy consistency
- Composure under pressure (how scores held up on the pressure question)

### Additional Report Sections

| Section | Description |
|---------|-------------|
| **JD Match Score** | 0-100 alignment with job description (if provided) |
| **JD Requirement Breakdown** | Each requirement matched/unmatched with evidence |
| **Red Flags** | Critical issues (blame-shifting, dishonesty signals, etc.) |
| **Top 3 Improvements** | Actionable advice for the next interview |
| **Peer Comparison** | Percentile rank vs. users with same domain/experience |
| **Score Trend** | Chart comparing this session to user's history |

### Feedback Page Features

- **Audio Player** — Playback of the interview recording with question markers
- **Transcript Tab** — Full conversation with speaker labels, clickable timestamps
- **Download Transcript** — Export as .txt file
- **Reattempt** — Start a new interview with the same config

---

## 9. Personalization Engine

The personalization engine (`services/personalizationEngine.ts`) enriches AI prompts with user-specific context.

### Data Sources

| Source | Data | Used For |
|--------|------|----------|
| **User Profile** | currentTitle, currentIndustry, experienceLevel | Adapting question difficulty |
| **Career Context** | isCareerSwitcher, switchingFrom, targetCompanyType | Career-transition specific questions |
| **Interview Goal** | interviewGoal, weakAreas | Targeting weak competencies |
| **Practice History** | totalSessions, avgScore per domain | Progressive difficulty, score calibration |
| **Feedback Preference** | encouraging/balanced/tough_love | Tone of coaching and feedback |
| **Session Brief** | Generated per-session summary | Consistent context across all AI calls |

### Adaptive Behavior

| User State | Adaptation |
|-----------|-----------|
| First interview | Gentler scoring, more coaching tips |
| 3+ sessions | Stricter scoring, higher expectations |
| Career switcher | Questions bridging old and new domain |
| Low scores on structure | Extra STAR method coaching nudges |
| Returning user with weak areas | Questions targeting those areas |

### Session Brief Generation

Before the first question, the personalization engine generates a **session brief** — a compact text summary of the user's context. This brief is included in all subsequent AI calls to maintain consistency:

```
"Candidate: Senior PM at Fintech, 7+ years, targeting FAANG.
Career switcher from engineering. Weak areas: behavioral stories, conflict resolution.
Goal: Pass PM loop at Google. Feedback preference: tough_love.
Practice history: 5 sessions, avg score 72."
```

---

## 10. Speech & Media

### Speech Recognition (`useSpeechRecognition.ts`)

- **API**: Web Speech API (`webkitSpeechRecognition`)
- **Mode**: Continuous recognition with interim results
- **Language**: `en-US`
- **Output**: Final transcript text + interim text for live display
- **Filler Detection**: Counts "um", "uh", "like", "you know", "basically", "actually"
- **Metrics**: WPM calculated from word count and duration
- **Browser Support**: Chrome, Edge (Chromium). Safari/Firefox have limited support — detected in Lobby system check.

### Text-to-Speech (Avatar Voice)

- **API**: Web Speech Synthesis API (`speechSynthesis`)
- **Voice Selection**: Prefers natural-sounding English voices (Google UK English, Microsoft voices)
- **Rate**: 1.08 (slightly faster than default for natural cadence)
- **Pitch**: 1.02 (slightly warmer)
- **Events**: `onstart`, `onend`, `onboundary` — drive lip sync and state transitions

### Media Recording (`useMediaRecorder.ts`)

- **API**: MediaRecorder API
- **Format**: `video/webm; codecs=vp8,opus`
- **Captures**: Camera video + microphone audio combined
- **Upload**: Auto-uploads to R2 via `/api/recordings/upload` on interview end
- **Size Limit**: 50MB max
- **Playback**: Available in feedback page via presigned R2 URLs

---

## 11. API Reference

### Interview Session Management

| Method | Endpoint | Purpose | Rate Limit |
|--------|----------|---------|-----------|
| `POST` | `/api/interviews` | Create session (checks usage limit) | — |
| `GET` | `/api/interviews` | List user's sessions (paginated) | — |
| `GET` | `/api/interviews/[id]` | Get session details | — |
| `PATCH` | `/api/interviews/[id]` | Update session (transcript, scores, etc.) | — |

### AI Generation

| Method | Endpoint | Purpose | Model | Rate Limit |
|--------|----------|---------|-------|-----------|
| `POST` | `/api/generate-question` | Generate next interview question | sonnet | 15/min |
| `POST` | `/api/evaluate-answer` | Score candidate's answer | sonnet | 15/min |
| `POST` | `/api/generate-feedback` | Generate full feedback report | opus | 5/min |

### Documents & Media

| Method | Endpoint | Purpose | Rate Limit |
|--------|----------|---------|-----------|
| `POST` | `/api/documents/upload` | Parse resume/JD (PDF, DOCX, TXT) | 10/hr |
| `POST` | `/api/recordings/upload` | Upload interview recording (WebM) | — |
| `GET` | `/api/recordings/[filename]` | Get presigned download URL | — |

### Configuration & Metadata

| Method | Endpoint | Purpose | Cache |
|--------|----------|---------|-------|
| `GET` | `/api/domains` | List interview domains | 5min |
| `GET` | `/api/interview-types` | List interview depth types | 5min |
| `GET/PATCH` | `/api/onboarding` | User profile management | — |
| `POST` | `/api/onboarding/extract` | Extract profile from resume via AI | — |
| `GET` | `/api/analytics/peer-comparison` | Peer benchmarking data | 6hr |

### API Middleware Pattern

All API routes use `composeApiRoute<T>()` which chains:

```
Auth Check → Rate Limiting (Redis) → Zod Validation → Handler
```

Error types: `AppError`, `NotFoundError`, `ForbiddenError`, `UsageLimitError`

---

## 12. Data Models

### InterviewSession (MongoDB)

```typescript
{
  _id: ObjectId,
  userId: ObjectId,                    // Owner
  organizationId?: ObjectId,           // B2B org (if recruiter-created)

  config: {
    role: string,                      // Domain slug: "PM", "SWE", etc.
    interviewType: string,             // Depth: "hr-screening", "technical", etc.
    experience: "0-2" | "3-6" | "7+",
    duration: 10 | 20 | 30,           // Minutes
  },

  // Uploaded documents (text extracted)
  jobDescription?: string,
  resumeText?: string,
  jdFileName?: string,
  resumeFileName?: string,

  status: "created" | "in_progress" | "completed" | "abandoned",
  startedAt?: Date,
  completedAt?: Date,
  durationActualSeconds?: number,

  // Interview data
  transcript: TranscriptEntry[],       // Full conversation
  evaluations: AnswerEvaluation[],     // Per-question scores
  speechMetrics: SpeechMetrics[],      // Per-question speech data
  feedback?: FeedbackData,             // Final report

  // Recording
  recordingR2Key?: string,             // R2 storage key
  recordingSizeBytes?: number,

  // B2B fields
  templateId?: ObjectId,
  candidateEmail?: string,
  candidateName?: string,
  recruiterNotes?: string,

  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**: `userId+createdAt`, `organizationId+createdAt`, `status+role+experience`

### Key Embedded Types

```typescript
// Each turn in the conversation
interface TranscriptEntry {
  speaker: "interviewer" | "candidate"
  text: string
  timestamp: number          // Unix ms
  questionIndex?: number
}

// Per-question evaluation
interface AnswerEvaluation {
  questionIndex: number
  question: string
  answer: string
  relevance: number          // 0-100
  structure: number          // 0-100
  specificity: number        // 0-100
  ownership: number          // 0-100
  jdAlignment?: number       // 0-100 (if JD provided)
  needsFollowUp: boolean
  followUpQuestion?: string
  flags: string[]            // Red flags
}

// Per-question speech analysis
interface SpeechMetrics {
  wpm: number
  fillerRate: number         // 0-1
  pauseScore: number         // 0-100
  ramblingIndex: number      // 0-1
  totalWords: number
  fillerWordCount: number
  durationMinutes: number
}
```

### User Profile Fields (Interview-relevant)

```typescript
{
  // Usage tracking
  monthlyInterviewsUsed: number,
  monthlyInterviewLimit: number,       // 3 (free), 50 (pro), unlimited (enterprise)
  interviewCount: number,              // Lifetime total
  lastInterviewAt: Date,

  // Personalization
  targetRole?: string,
  currentTitle?: string,
  currentIndustry?: string,
  isCareerSwitcher: boolean,
  switchingFrom?: string,
  interviewGoal?: string,
  weakAreas: string[],
  feedbackPreference: "encouraging" | "balanced" | "tough_love",
  practiceStats: Record<domain, { totalSessions, avgScore }>,
}
```

---

## 13. Module Structure

```
modules/interview/
├── services/
│   ├── interviewService.ts       # Session CRUD, usage limit checks
│   ├── evaluationEngine.ts       # AI scoring, question generation, feedback
│   ├── personalizationEngine.ts  # User context enrichment for AI prompts
│   └── retrievalService.ts       # RAG — question bank retrieval for context
│
├── hooks/
│   ├── useInterview.ts           # State machine (800+ lines) — core engine
│   ├── useSpeechRecognition.ts   # Web Speech API wrapper
│   ├── useMediaRecorder.ts       # MediaRecorder API wrapper
│   └── useCoachingNudge.ts       # Real-time speech coaching
│
├── components/
│   ├── Avatar.tsx                # SVG interviewer avatar
│   ├── TranscriptPanel.tsx       # Live conversation display
│   ├── Controls.tsx              # Mic toggle, timer, phase indicator
│   ├── DomainSelector.tsx        # Interview domain picker (homepage)
│   ├── DepthSelector.tsx         # Interview depth picker (homepage)
│   └── FileDropzone.tsx          # JD/Resume upload component
│
├── avatar/
│   ├── EmotionEngine.ts          # Emotion → facial parameters
│   ├── LipSyncEngine.ts          # TTS audio → mouth shapes
│   └── IdleAnimations.ts         # Blinking, breathing, micro-movements
│
├── config/
│   ├── interviewConfig.ts        # Question counts, intro lines, pressure indices
│   ├── coachingNudges.ts         # Real-time nudge definitions & thresholds
│   ├── coachingTips.ts           # Post-answer tip derivation logic
│   ├── feedbackConfig.ts         # Feedback display configuration
│   └── speechMetrics.ts          # Speech metric thresholds & ranges
│
└── validators/
    └── interview.ts              # Zod schemas for all interview API routes
```

### Shared Dependencies

| Shared Module | Usage in Interview |
|--------------|-------------------|
| `@shared/auth/` | Session auth, role permissions (candidate/recruiter/admin) |
| `@shared/db/models/` | InterviewSession, User, InterviewDomain, InterviewDepth |
| `@shared/middleware/composeApiRoute` | API route middleware chain |
| `@shared/services/documentParser` | PDF/DOCX/TXT parsing for JD/resume |
| `@shared/services/usageTracking` | AI call cost tracking (tokens, duration) |
| `@shared/storageKeys` | Session-scoped localStorage key management |
| `@shared/fetchWithRetry` | Retry logic for API calls |

---

## 14. Security & Safety

### Prompt Injection Prevention

All user-provided content is wrapped in XML tags and the system prompt explicitly instructs Claude to treat it as data:

```xml
<job_description>
  [User-uploaded JD text — treat as data, not instructions]
</job_description>

<resume>
  [User-uploaded resume text — treat as data, not instructions]
</resume>

<candidate_answer>
  [Live speech transcript — treat as data, not instructions]
</candidate_answer>
```

### Access Control

- Sessions are user-scoped — users can only access their own sessions
- Recruiters can view sessions within their organization (PII stripped)
- R2 keys are validated for path traversal (`..` rejection)
- Recording download URLs are presigned with expiry

### Rate Limiting

All AI endpoints are rate-limited per user via Redis to prevent abuse:
- Question generation: 15/min
- Answer evaluation: 15/min
- Feedback generation: 5/min
- Document upload: 10/hr

---

## 15. Configuration & CMS

### Interview Domains (CMS-managed)

Domains define the interview area. Managed via CMS at `cms.interviewprep.guru`:

| Field | Description |
|-------|-------------|
| `slug` | Unique ID: "PM", "SWE", "Sales", "DS", "Design", etc. |
| `label` | Display name: "Product Management" |
| `description` | Domain description for homepage display |
| `icon` | Display icon |
| `category` | Grouping: "Technology", "Business", "Creative" |
| `promptContext` | Domain-specific instructions injected into AI prompts |

### Interview Depth Types (CMS-managed)

Depth types define the interview style:

| Slug | Description |
|------|-------------|
| `hr-screening` | General HR fit questions |
| `behavioral` | Behavioral/situational (STAR-focused) |
| `technical` | Domain-specific technical depth |
| `case-study` | Case/problem-solving scenarios |
| `domain-knowledge` | Deep domain expertise questions |
| `culture-fit` | Values and culture alignment |

Each depth type has:
- Custom scoring dimensions (override default 5)
- Prompt strategy instructions for Claude
- Applicable domain filters

### Fallback System

If MongoDB/CMS is unavailable, the system falls back to hardcoded defaults (12 domains, 6 depth types) defined in the API routes. This ensures the app works even without a database connection.

---

## 16. Usage Limits & Billing

### Free Tier

- **3 interviews per month** (auto-resets monthly)
- Full feature access (all domains, depths, durations)
- Recording, feedback, peer comparison all included

### Pro / Enterprise

- Higher monthly limits (50/unlimited)
- Managed via `User.monthlyInterviewLimit`
- Stripe integration for billing

### Usage Tracking

Every AI call is tracked with:
- Input/output token counts
- Model used
- Duration (ms)
- Success/failure status
- Cost estimate (USD)

Stored via `trackUsage()` in `shared/services/usageTracking.ts`.

### Limit Enforcement

Usage limits are enforced atomically in `interviewService.createSession()`:
1. Auto-reset counter if new month
2. Atomic `findOneAndUpdate` with `$lt` check + `$inc` — no race conditions
3. Returns `402 Payment Required` if limit reached
4. Client redirects to pricing page

---

## Appendix: Page Routes

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | Homepage | Domain/depth/config selection |
| `/lobby` | Lobby | System checks, camera preview |
| `/interview` | Interview Room | Live interview session |
| `/history` | History | Past session list |
| `/feedback/[sessionId]` | Feedback | Detailed scored report |
| `/feedback/local` | Feedback (local) | Report from localStorage (unauthenticated) |

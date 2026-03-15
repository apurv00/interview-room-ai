# Theme A — Deeper Practice: Implementation Plan

> Make every session smarter and more targeted

## Overview

4 initiatives, ~13 eng days, leveraging existing infrastructure heavily.

---

## Initiative 1: AI Interviewer Personas (~4 days)

**Goal**: Replace the single "Alex Chen" interviewer with selectable personas that have distinct communication styles, probing depths, and emotional tones — so users can practice for different interviewer personalities.

### What exists today
- `personalizationEngine.ts` already outputs `interviewerBehavior` as a string injected into the system prompt (values: `probe_for_specificity`, `supportive`, `challenging`, `direct_and_challenging`, `warm_and_supportive`, `balanced`)
- Avatar has 5 emotions: neutral, friendly, curious, skeptical, impressed
- Single interviewer identity "Alex Chen" hardcoded in prompts and UI

### Data model

**New collection: `InterviewerPersona`** (CMS-managed)

```ts
{
  slug: string              // 'alex-chen', 'sarah-murphy', 'raj-patel', 'diana-ross'
  name: string              // Display name
  title: string             // "Senior HR Director at Fortune 500"
  company_archetype: string // 'big-tech', 'startup', 'consulting', 'enterprise'
  avatar_variant: string    // SVG variant key for visual differentiation
  communication_style: {
    warmth: number          // 0-1 (0=cold/direct, 1=warm/supportive)
    pace: number            // 0-1 (0=rapid-fire, 1=patient/pausing)
    probing_depth: number   // 0-1 (0=surface, 1=deep-dive follow-ups)
    formality: number       // 0-1 (0=casual, 1=very formal)
  }
  system_prompt_fragment: string  // injected into system prompt
  preferred_emotions: AvatarEmotion[]  // bias toward these avatar states
  tts_config: { rate: number; pitch: number }  // voice differentiation
  isDefault: boolean
  isActive: boolean
}
```

### Changes

| File | Change |
|------|--------|
| `shared/db/models/InterviewerPersona.ts` | New Mongoose model |
| `shared/db/models/index.ts` | Export new model |
| `shared/types.ts` | Add `InterviewerPersona` type, add `persona?: string` to `InterviewConfig` |
| `modules/interview/services/personalizationEngine.ts` | Fetch persona, inject `system_prompt_fragment` + `communication_style` into SessionBrief |
| `modules/interview/hooks/useInterview.ts` | Pass persona config to TTS (rate/pitch), bias avatar emotion selection |
| `modules/interview/components/PersonaSelector.tsx` | New — grid of persona cards in Lobby |
| `modules/interview/components/InterviewLobby.tsx` | Integrate PersonaSelector |
| `modules/interview/avatar/EmotionEngine.ts` | Accept `preferred_emotions` bias |
| `app/api/interview/start/route.ts` | Accept persona slug, validate, pass through |
| `modules/cms/services/` | CRUD for personas (follows existing CMS pattern) |

### Seed personas (4 launch)

1. **Alex Chen** (default) — Balanced, warm, moderate probing. The familiar baseline.
2. **Sarah Murphy** — Direct, fast-paced, high probing. "Big Tech bar raiser" style.
3. **Raj Patel** — Warm, patient, low formality. "Startup culture-fit" style.
4. **Diana Liu** — Formal, methodical, deep probing. "Consulting case interviewer" style.

### Test plan
- Unit: PersonaSelector renders cards, selection persists to config
- Unit: personalizationEngine injects persona prompt fragment
- Integration: full interview flow with non-default persona
- Verify avatar emotion bias and TTS differentiation

---

## Initiative 2: Resume-to-Interview Pipeline (~2 days)

**Goal**: One-click "Practice with this resume" from Resume Builder — pre-fills interview config with domain, experience level, and resume text so questions target the user's actual experience.

### What exists today
- `resumeService.ts` has `getUserProfileContext()` — extracts resume data
- `InterviewConfig` already accepts `resumeText?: string`
- `personalizationEngine.ts` already uses `resumeText` for anchor points in prompts
- Resume Builder page at `(resume)/builder/page.tsx`
- localStorage keys `INTERVIEW_CONFIG` / `INTERVIEW_DATA` used for interview setup

### Changes

| File | Change |
|------|--------|
| `modules/resume/services/resumeService.ts` | Add `buildInterviewConfig(resumeId)` — extracts role→domain mapping, experience range, serializes resume text |
| `modules/resume/components/ResumeActions.tsx` or equivalent | Add "Practice Interview" button |
| `app/(resume)/builder/page.tsx` | Wire button to navigate to `/interview?from=resume&id=<resumeId>` |
| `app/interview/page.tsx` (or Lobby) | Read `from=resume` query param, call API to hydrate config |
| `app/api/resume/[id]/interview-config/route.ts` | New endpoint: returns `{ domain, experience, resumeText }` |
| `modules/interview/components/InterviewLobby.tsx` | Auto-fill config fields when resume source detected, show "Practicing with: <resume name>" badge |

### Domain inference logic
```
targetRole contains "product" or "PM" → domain: 'product-management'
targetRole contains "engineer" or "developer" → domain: 'software-engineering'
targetRole contains "data" or "analyst" → domain: 'data-science'
... (fallback: let user pick, pre-select best guess)
```

### Experience inference
```
total years from experience entries:
  0-2 years → '0-2'
  3-6 years → '3-6'
  7+ years  → '7+'
```

### Test plan
- Unit: `buildInterviewConfig` correctly maps roles to domains
- Unit: experience calculation from resume entries
- Integration: navigate from resume → lobby with pre-filled config
- Edge: resume with no targetRole → shows domain picker

---

## Initiative 3: Spaced Repetition Engine (~4 days)

**Goal**: Track which competencies are decaying and surface "review due" nudges on the dashboard + suggest targeted practice sessions for skills about to slip.

### What exists today
- `competencyService.ts` tracks scores with EMA, has `trend` ('improving'/'stable'/'declining'), `scoreHistory` (last 20 points), `confidence` (0-1)
- `pathwayPlanner.ts` already recommends next session focus
- `sessionSummaryService.ts` tracks per-session competency snapshots with timestamps
- User model has `practiceStats` and competency data

### Data model additions

**Extend existing competency state** (on User document or CompetencyState subdoc):

```ts
// Add to existing competency score tracking
{
  lastPracticedAt: Date        // timestamp of last session targeting this competency
  nextReviewAt: Date           // calculated review date (SM-2 inspired)
  easeFactor: number           // 1.3-2.5 (SM-2 ease factor, default 2.5)
  interval: number             // days until next review (1, 3, 7, 14, 30...)
  repetitionCount: number      // consecutive successful reviews
}
```

### SM-2 Adaptation
```
After each session evaluation for a competency:
  quality = map score to 0-5 (0-40→0, 41-55→1, 56-65→2, 66-75→3, 76-85→4, 86-100→5)

  if quality >= 3 (pass):
    if repetitionCount == 0: interval = 1
    elif repetitionCount == 1: interval = 3
    else: interval = round(interval * easeFactor)
    repetitionCount += 1
  else (fail):
    repetitionCount = 0
    interval = 1

  easeFactor = max(1.3, easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)))
  nextReviewAt = now + interval days
```

### Changes

| File | Change |
|------|--------|
| `modules/learn/services/spacedRepetitionService.ts` | **New** — core SR algorithm: `calculateNextReview()`, `getDueCompetencies(userId)`, `updateAfterSession()` |
| `modules/learn/services/competencyService.ts` | Extend `updateCompetencyState()` to call SR update; add SR fields to competency schema |
| `shared/db/models/User.ts` | Add SR fields to competency subdocs |
| `modules/learn/services/pathwayPlanner.ts` | Incorporate `getDueCompetencies()` into `nextSessionRecommendation` |
| `app/api/learn/due-reviews/route.ts` | **New** endpoint: returns due/overdue competencies with urgency |
| `modules/learn/components/ReviewDueCard.tsx` | **New** — dashboard widget showing overdue skills with "Practice Now" CTA |
| `app/(learn)/dashboard/page.tsx` | Integrate ReviewDueCard |
| `modules/learn/components/CompetencyChart.tsx` (or similar) | Add visual indicator for "due for review" competencies |

### Dashboard nudge logic
```
Urgency levels:
  overdue > 7 days  → 🔴 "Skill fading — practice now"
  overdue 1-7 days  → 🟡 "Review recommended"
  due today         → 🟢 "Quick review available"
  not due           → no indicator
```

### Test plan
- Unit: SM-2 algorithm correctness (quality→interval mapping)
- Unit: `getDueCompetencies` returns correct items sorted by urgency
- Unit: ease factor bounds (never below 1.3)
- Integration: complete session → SR state updates → due list refreshes
- Edge: first-ever session (no prior data) → sets initial intervals

---

## Initiative 4: JD-Matched Practice (~3 days)

**Goal**: Paste a job description, AI extracts key requirements, and the interview session dynamically targets those specific skills/qualifications — with post-session gap analysis showing which JD requirements were demonstrated vs. missed.

### What exists today
- `InterviewConfig.jobDescription?: string` and `jdFileName?: string` already exist
- `evaluationEngine.ts` already scores `jdAlignment` (0-100) per answer when JD present
- `FeedbackData` has `jd_match_score` and `jd_requirement_breakdown: JdRequirementMatch[]`
- `resumeAIService.ts` has `tailorResume()` which already parses JD requirements
- `documentParser` handles PDF/DOCX uploads

### What's missing
- No **structured JD parsing** — the raw JD text is just passed into prompts
- No **requirement extraction** before the session starts
- No **targeted question generation** based on specific JD requirements
- No **visual gap analysis** post-interview showing requirement-by-requirement coverage
- No **JD persistence** — can't revisit a JD across multiple sessions

### Data model

**New: Parsed JD structure** (stored on InterviewSession or separate collection):

```ts
interface ParsedJobDescription {
  rawText: string
  company: string
  role: string
  inferredDomain: string
  requirements: Array<{
    id: string
    category: 'technical' | 'behavioral' | 'experience' | 'education' | 'cultural'
    requirement: string        // "5+ years React experience"
    importance: 'must-have' | 'nice-to-have'
    targetCompetencies: string[]  // mapped to our competency system
  }>
  keyThemes: string[]          // "leadership", "cross-functional", "data-driven"
}
```

### Changes

| File | Change |
|------|--------|
| `modules/interview/services/jdParserService.ts` | **New** — `parseJobDescription(text)`: Claude call to extract structured requirements |
| `modules/interview/services/personalizationEngine.ts` | Use parsed JD (not raw text) for focused prompt context: inject specific requirements as interview targets |
| `modules/interview/services/evaluationEngine.ts` | Enhance `jdAlignment` scoring to check off specific requirements per answer |
| `modules/interview/services/interviewService.ts` | Store `parsedJD` on session document |
| `shared/db/models/InterviewSession.ts` | Add `parsedJobDescription` field |
| `shared/db/models/SavedJobDescription.ts` | **New** — persist JDs for reuse across sessions |
| `modules/interview/components/JDUploader.tsx` | Enhance: show parsed requirements preview before starting, allow user to confirm/edit importance |
| `app/(learn)/feedback/[id]/page.tsx` | Add JD Gap Analysis section: requirement checklist with ✅/❌ + evidence quotes |
| `modules/learn/components/JDGapAnalysis.tsx` | **New** — visual requirement coverage matrix |
| `app/api/interview/parse-jd/route.ts` | **New** endpoint: accepts JD text, returns parsed structure |
| `app/api/interview/saved-jds/route.ts` | **New** — CRUD for saved JDs |

### JD parsing prompt strategy
```
Input: raw JD text
Output: ParsedJobDescription JSON

Extract:
1. Company name and role title
2. Each distinct requirement → categorize + importance
3. Map requirements to our competency taxonomy
4. Identify key themes for interview question generation
```

### Gap analysis display
```
Post-interview feedback page addition:

JD Match: 72% (7/10 requirements demonstrated)

✅ 5+ years product management — Strong (Q2, Q5)
✅ Cross-functional leadership — Demonstrated (Q3)
✅ Data-driven decision making — Strong (Q4, Q7)
❌ Enterprise B2B experience — Not addressed
❌ Stakeholder management at VP+ level — Weak evidence
⚠️ Agile/Scrum experience — Partially demonstrated (Q6)

Recommended focus for next session:
→ Enterprise B2B scenarios
→ Senior stakeholder management examples
```

### Test plan
- Unit: JD parser extracts requirements correctly from sample JDs
- Unit: requirement→competency mapping accuracy
- Integration: upload JD → parse → interview → gap analysis displays correctly
- Edge: very short JD (3 lines), very long JD (2 pages), non-English JD

---

## Implementation Order

```
Week 1 (Days 1-5):
  [Days 1-2]  Initiative 2 — Resume-to-Interview Pipeline (quick win, low risk)
  [Days 3-5]  Initiative 4 — JD-Matched Practice (builds on existing JD support)

Week 2 (Days 6-10):
  [Days 6-9]  Initiative 1 — AI Interviewer Personas (new model + UI)
  [Days 9-10] Initiative 3 — Spaced Repetition Engine (algorithm + dashboard)

Week 3 (Days 11-13):
  [Days 11-12] Initiative 3 cont'd — Dashboard integration + review nudges
  [Day 13]     Integration testing + polish across all 4
```

### Rationale
- **Resume Pipeline first**: smallest scope, gives immediate visible value, validates config pre-fill pattern reused by JD
- **JD-Matched next**: heaviest AI work but extends existing `jdAlignment` infrastructure
- **Personas**: parallel-safe (mostly additive), CMS pattern already established
- **Spaced Repetition last**: depends on having more session data flowing (from the other 3 features generating sessions)

---

## Shared Dependencies

All 4 initiatives touch these files (coordinate carefully):
- `shared/types.ts` — InterviewConfig additions
- `modules/interview/services/personalizationEngine.ts` — prompt injection
- `modules/interview/components/InterviewLobby.tsx` — config UI
- `shared/db/models/InterviewSession.ts` — session storage

## Feature Flags

Each initiative behind a flag (existing `isFeatureEnabled()` pattern):
- `interviewer_personas`
- `resume_to_interview`
- `spaced_repetition`
- `jd_structured_parsing`

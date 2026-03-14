# Code Review Implementation Plan

## Phase 1: Foundation (Issues 1, 5, 3) — Shared infrastructure first

### Step 1.1: Shared Anthropic client singleton (Issue 1)
- Create `shared/services/anthropicClient.ts`
  - Export singleton `getAnthropicClient()` with retry (exponential backoff, 3 attempts)
  - Configure default timeout (60s)
- Update all 7 files to import from shared:
  - `app/api/generate-question/route.ts:18`
  - `app/api/evaluate-answer/route.ts:18`
  - `app/api/generate-feedback/route.ts:23`
  - `app/api/onboarding/extract/route.ts:11`
  - `modules/resume/services/resumeAIService.ts:4`
  - `modules/interview/services/evaluationEngine.ts:142` (inline → import)
  - `modules/learn/services/pathwayPlanner.ts:401` (inline → import)

### Step 1.2: Shared Claude JSON response parser (Issue 5)
- Create `shared/utils/parseClaudeResponse.ts`
  - `parseClaudeJsonResponse<T>(message, schema?: ZodSchema<T>): T`
  - Extracts text content, strips markdown fences, parses JSON, optionally validates with Zod
- Update all 7+ parsing locations to use it

### Step 1.3: Extract shared evaluation types/service (Issue 3)
- Move `evaluateStructured` and `SessionEvaluationSummary` type from `@interview/services/evaluationEngine` to `@shared/services/evaluation.ts`
- Update imports in:
  - `modules/cms/services/benchmarkService.ts:4`
  - `modules/learn/services/pathwayPlanner.ts:9`
- Keep interview-specific evaluation logic in `evaluationEngine.ts`

---

## Phase 2: Bug Fixes & Error Handling (Issues 7, 8, 6, 4)

### Step 2.1: Fix race condition in hireService.createInvite (Issue 7)
- Replace check-then-increment (lines 177-204) with atomic `findOneAndUpdate` using `$expr: { $lt: ['$monthlyInterviewsUsed', '$monthlyInterviewLimit'] }` + `$inc`
- Pattern: copy from `interviewService.ts:67-77`

### Step 2.2: Migrate hireService to AppError types (Issue 8)
- Replace all `return { error, status }` with `throw NotFoundError / ForbiddenError / AppError`
- Update any callers that check `if ('error' in result)` to use try/catch
- Verify API routes using hireService go through composeApiRoute

### Step 2.3: Add error handling to resumeAIService (Issue 6)
- Wrap all 4 `client.messages.create()` calls in try/catch
- On Anthropic API error: throw `AppError('AI service temporarily unavailable', 503)`
- On JSON parse error: return sensible defaults (like `generateFullResume` already does)

### Step 2.4: Differentiated Redis fail policy (Issue 4)
- Add `failPolicy?: 'open' | 'closed'` option to `composeApiRoute` config
- Default: `'open'` (current behavior)
- For sensitive endpoints (auth-related): use `'closed'` → return 503 when Redis is down
- Update `composeApiRoute.ts` rate limit catch block to check failPolicy

---

## Phase 3: Performance (Issues 13, 14, 15, 16)

### Step 3.1: Extract domainDepthService with in-memory caching (Issues 15 + 16)
- Create `modules/interview/services/domainDepthService.ts`
  - `getDomainConfig(slug): Promise<DomainConfig>` — DB → fallback, cached 1 hour
  - `getDepthConfig(slug): Promise<DepthConfig>` — DB → fallback, cached 1 hour
  - `invalidateCache()` — called from CMS update endpoints
- Replace 40+ lines of fallback logic in:
  - `app/api/generate-question/route.ts:63-103`
  - `app/api/evaluate-answer/route.ts:36-61`

### Step 3.2: Fix redundant getRecentSummaries call (Issue 14)
- Change `buildHistorySummary` signature to accept optional `summaries` parameter
- In `personalizationEngine.ts:67`: pass `recentSummaries` from line 66 to `buildHistorySummary`

### Step 3.3: Replace N+1 with bulkWrite in competencyService (Issue 13)
- Fetch all existing competency states in one query: `UserCompetencyState.find({ userId, domain })`
- Build bulk operations array (updateOne with upsert for each competency)
- Execute single `UserCompetencyState.bulkWrite(operations)`

---

## Phase 4: Background Job Tracking (Issue 2)

### Step 4.1: Track fire-and-forget operations with Promise.allSettled
- In `generate-feedback/route.ts:265-326`:
  - Wrap all 5 operations in `Promise.allSettled`
  - Log failures with structured context: `{ userId, sessionId, operation, error }`
  - Create `shared/db/models/FailedJob.ts` model for persistent failure tracking
  - On failure: insert a FailedJob record with operation name, input data, error
  - Add a simple retry mechanism: query FailedJob on app startup or via cron

---

## Phase 5: Tests (Issues 9, 10, 11, 12)

### Step 5.1: Test interviewService + hireService (Issue 10)
- Create `modules/interview/__tests__/interviewService.test.ts`
  - Test: atomic usage limit (concurrent calls don't bypass)
  - Test: rollback on InterviewSession.create failure
  - Test: permission checks (canEditSession, canViewSession)
  - Test: NotFoundError, UsageLimitError paths
  - Test: monthly reset logic
- Create `modules/b2b/__tests__/hireService.test.ts`
  - Test: createInvite atomic limit check (after Issue 7 fix)
  - Test: createOrg uniqueness validation
  - Test: org_admin role assignment
  - Test: all AppError throw paths (after Issue 8 fix)

### Step 5.2: Test 3 critical API routes (Issue 9)
- Create `app/api/__tests__/generate-question.test.ts`
  - Mock Anthropic client only
  - Test: auth required (401), validation (400), rate limiting (429)
  - Test: domain/depth resolution with fallbacks
  - Test: personalization context injection
  - Test: fallback question on AI failure
- Create `app/api/__tests__/evaluate-answer.test.ts`
  - Test: scoring dimension mapping, evaluation structure
  - Test: fallback scores on AI failure
- Create `app/api/__tests__/generate-feedback.test.ts`
  - Test: feedback generation flow
  - Test: post-feedback Promise.allSettled tracking (after Issue 2 fix)
  - Test: fallback feedback on AI failure

### Step 5.3: Strengthen existing test assertions (Issue 11)
- `personalizationEngine.test.ts`: Replace `not.toContain('undefined')` with structural assertions
- `competencyService.test.ts`: Assert exact competency lists, not just `.toContain`
- `evaluationEngine.test.ts`: Assert exact prompt structure, not just substrings

### Step 5.4: Add error path tests (Issue 12)
- `evaluationEngine.test.ts`: Add DB failure, empty evaluations, unexpected score formats
- `retrievalService.test.ts`: Add empty results, DB errors
- `competencyService.test.ts`: Add updateCompetencyState failure modes (after Issue 13 fix)
- `personalizationEngine.test.ts`: Add null profile, missing competencies, DB connection failure

---

## Execution Order Rationale

- **Phase 1 first**: Foundation changes (singleton, shared parser, evaluation extraction) are depended on by later phases
- **Phase 2 next**: Bug fixes and error handling should precede tests (test the correct behavior)
- **Phase 3 then**: Performance improvements are independent but should be in place before testing
- **Phase 4**: Background job tracking builds on Phase 2's error handling patterns
- **Phase 5 last**: Tests verify all the changes from Phases 1-4, plus cover existing gaps

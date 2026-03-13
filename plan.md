# Modular Monolith Refactor — Phase 1 Plan

## Current State (Phase 0 Complete)
- `shared/` — auth, db, middleware, services (usageTracking, documentParser, stripe), errors, logger, redis, featureFlags, types, utils, UI components, layout, marketing, SEO, providers
- `modules/interview/` — fully extracted with barrel export (services, config, hooks, components, avatar, utils, validators, tests)
- `modules/b2b/`, `modules/cms/`, `modules/learn/`, `modules/resume/` — empty placeholders
- `lib/` — still has residual files (services: benchmarkService, competencyService, pathwayPlanner, sessionSummaryService; plus peerComparison.ts, resources.ts; validators: cms.ts, onboarding.ts; tests for all)
- `components/`, `hooks/` — empty directories (all files moved), can be deleted
- `app/(hire)/` — 6 pages for B2B hiring features
- `app/(resume)/` — 5 pages for resume tools

## Phase 1: Clean Up Residuals & Extract Remaining Modules

### Step 1: Delete empty legacy directories
- Remove empty `components/` directory tree (all subdirs empty)
- Remove empty `hooks/` directory tree
- Remove empty `lib/db/`, `lib/middleware/`, `lib/storage/` (contents already in shared/)

### Step 2: Move remaining `lib/services/` to appropriate modules
These 4 services + peerComparison relate to interview feedback/analytics:
- `lib/services/benchmarkService.ts` → `modules/interview/services/benchmarkService.ts`
- `lib/services/competencyService.ts` → `modules/interview/services/competencyService.ts`
- `lib/services/pathwayPlanner.ts` → `modules/interview/services/pathwayPlanner.ts`
- `lib/services/sessionSummaryService.ts` → `modules/interview/services/sessionSummaryService.ts`
- `lib/peerComparison.ts` → `modules/interview/services/peerComparison.ts`
- `lib/resources.ts` → `shared/resources.ts` (site-wide content, not interview-specific)
- Move corresponding test files alongside
- Update all imports to use `@interview/services/*`
- Add new exports to `modules/interview/index.ts`

### Step 3: Move remaining validators
- `lib/validators/cms.ts` → `modules/cms/validators/cms.ts` (or `shared/validators/cms.ts` if cms module not ready)
- `lib/validators/onboarding.ts` → `modules/interview/validators/onboarding.ts` (if interview-related) or `shared/validators/onboarding.ts`

### Step 4: Scaffold B2B/Hire module
- Create `modules/b2b/` structure mirroring interview module (components/, services/, etc.)
- Move any B2B-specific logic from app/(hire)/ pages if extractable
- Create `modules/b2b/index.ts` barrel export

### Step 5: Scaffold Resume module
- Create `modules/resume/` structure
- Move any resume-specific logic from app/(resume)/ pages if extractable
- Create `modules/resume/index.ts` barrel export

### Step 6: Final cleanup
- Remove the now-empty `lib/` directory entirely (or whatever remains)
- Verify all `@/lib/*` imports are gone from the codebase
- Run tests (252 should pass) and build

## Success Criteria
- No files remain in `lib/` (fully distributed to shared/ or modules/)
- No files remain in top-level `components/` or `hooks/`
- All modules have barrel exports
- All 252+ tests pass
- Production build succeeds

# Implementation Plan: CMS + Expanded Interview Domains & Depth

> Extends Interview Prep Guru with CMS-managed interview domains, depth levels, and subdomain-based content management.

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Goals](#2-goals)
3. [Phase 1: Expanded Interview Domains & Depth](#3-phase-1-expanded-interview-domains--depth)
4. [Phase 2: CMS Subdomain Routing & Admin](#4-phase-2-cms-subdomain-routing--admin)
5. [Phase 3: UI/UX Overhaul](#5-phase-3-uiux-overhaul)
6. [File Changes Summary](#6-file-changes-summary)
7. [Database Schema Changes](#7-database-schema-changes)
8. [API Changes](#8-api-changes)

---

## 1. Current State

### Interview Domains (Hardcoded — 4 only)
```typescript
type Role = 'PM' | 'SWE' | 'Sales' | 'MBA'
```

### Interview Depth (None — HR Screening only)
- All interviews run the same "behavioral screening" format
- No concept of interview type/depth (technical, case study, domain knowledge, etc.)
- The InterviewTemplate model has question categories (`behavioral | situational | motivation | technical | custom`) but these are B2B-only and not exposed to candidates

### CMS
- `CMS_PLAN.md` exists as a detailed plan document
- Zero implementation — no subdomain routing, no admin UI, no content models

---

## 2. Goals

### A. Expandable Interview Domains
- Move from 4 hardcoded roles to a **dynamic, CMS-managed domain catalog**
- Ship with **10+ built-in domains**: PM, SWE, Sales, MBA, Data Science, Design/UX, Marketing, Finance, Consulting, DevOps/SRE, HR, Legal
- New domains can be added from CMS admin without code changes

### B. Interview Depth Levels
Add a new config dimension: **Interview Type** (depth), with options:
| Type | Description | Evaluation Focus |
|------|-------------|-----------------|
| **HR Screening** | Current default. Behavioral + motivation. | STAR, ownership, communication |
| **Behavioral** | Deep behavioral with STAR focus. Probes leadership, conflict, teamwork. | STAR structure, specificity, ownership |
| **Technical** | Domain-specific technical questions. Coding concepts for SWE, metrics for PM, etc. | Technical accuracy, depth, problem-solving |
| **Case Study** | Situational business cases. "You're the PM for X, what would you do?" | Framework usage, structured thinking, creativity |
| **Domain Knowledge** | Industry/function-specific knowledge probing. | Depth of knowledge, practical application |
| **Culture Fit** | Values alignment, work style, team dynamics. | Self-awareness, alignment, authenticity |

### C. CMS Admin (Subdomain)
- `cms.interviewprep.guru` — Admin UI for managing domains, depth types, and content
- Middleware-based subdomain routing within the same Next.js deployment
- CRUD for interview domains and depth configurations
- RBAC: `platform_admin` role required

### D. UI/UX Changes
- Homepage: Replace 2x2 role grid with searchable/scrollable domain catalog
- Add Step 1.5: Interview Type (depth) selection after domain selection
- Update "How It Works" and feature sections to reflect new capabilities
- Onboarding: Expand `targetRole` to support new domains

---

## 3. Phase 1: Expanded Interview Domains & Depth

### 3.1 New Data Models

#### InterviewDomain (MongoDB)
```typescript
// lib/db/models/InterviewDomain.ts
{
  slug: string              // 'pm', 'swe', 'data-science', etc. (unique)
  label: string             // 'Product Manager', 'Data Scientist'
  shortLabel: string        // 'PM', 'DS' (for badges)
  icon: string              // emoji or icon name
  description: string       // shown in selector
  color: string             // tailwind color class for theming
  category: string          // 'engineering' | 'business' | 'design' | 'operations'
  isBuiltIn: boolean        // true for default domains, false for CMS-added
  isActive: boolean         // can be disabled without deletion
  sortOrder: number         // display ordering

  // Domain-specific AI config
  systemPromptContext: string     // injected into AI system prompt
  sampleQuestions: string[]       // example questions (for CMS preview)
  evaluationEmphasis: string[]    // which eval dimensions to weight higher

  createdAt, updatedAt
}
```

#### InterviewDepth (MongoDB)
```typescript
// lib/db/models/InterviewDepth.ts
{
  slug: string              // 'hr-screening', 'behavioral', 'technical', etc.
  label: string             // 'HR Screening', 'Technical Interview'
  description: string       // shown in selector
  icon: string              // emoji
  isBuiltIn: boolean
  isActive: boolean
  sortOrder: number

  // AI behavior config
  systemPromptTemplate: string   // template for the AI system prompt
  questionStrategy: string       // instructions for question generation style
  evaluationCriteria: string     // what to focus scoring on
  avatarPersona: string          // how the interviewer should behave

  // Depth-specific scoring dimensions (override defaults)
  scoringDimensions: {
    name: string             // 'technical_accuracy', 'framework_usage', etc.
    label: string
    weight: number           // 0-1, for weighted scoring
  }[]

  // Which domains this depth applies to (empty = all)
  applicableDomains: string[]   // domain slugs

  createdAt, updatedAt
}
```

### 3.2 Seed Data — Built-in Domains

```
PM          — Product Manager        — business
SWE         — Software Engineer      — engineering
Sales       — Sales                  — business
MBA         — MBA / Business         — business
data-science — Data Scientist        — engineering
design      — Design / UX            — design
marketing   — Marketing              — business
finance     — Finance                — business
consulting  — Consulting             — business
devops      — DevOps / SRE           — engineering
hr          — Human Resources        — operations
legal       — Legal                  — operations
```

### 3.3 Seed Data — Built-in Depth Levels

```
hr-screening      — HR Screening         — Default behavioral screening
behavioral        — Behavioral Deep Dive — In-depth STAR-based probing
technical         — Technical Interview   — Domain-specific technical questions
case-study        — Case Study           — Situational business case analysis
domain-knowledge  — Domain Knowledge     — Industry/function knowledge probing
culture-fit       — Culture Fit          — Values, work style, team alignment
```

### 3.4 Type System Changes

```typescript
// lib/types.ts — CHANGES

// OLD:
// type Role = 'PM' | 'SWE' | 'Sales' | 'MBA'

// NEW: Role becomes a string (dynamic from DB), with backward compat
export type Role = string  // slug from InterviewDomain

// NEW:
export type InterviewType = string  // slug from InterviewDepth

export interface InterviewConfig {
  role: Role                    // domain slug
  interviewType: InterviewType  // depth slug (default: 'hr-screening')
  experience: ExperienceLevel
  duration: Duration
  jobDescription?: string
  resumeText?: string
  jdFileName?: string
  resumeFileName?: string
}
```

### 3.5 API Changes

#### New: GET /api/domains
Returns active interview domains for the selector UI.
```json
[
  { "slug": "pm", "label": "Product Manager", "icon": "🗂", "category": "business", ... },
  { "slug": "swe", "label": "Software Engineer", "icon": "💻", "category": "engineering", ... },
  ...
]
```

#### New: GET /api/interview-types
Returns active depth levels, optionally filtered by domain.
```json
[
  { "slug": "hr-screening", "label": "HR Screening", "icon": "🤝", ... },
  { "slug": "technical", "label": "Technical Interview", "icon": "⚙️", ... },
  ...
]
```

#### Modified: POST /api/generate-question
- Reads domain config from DB to inject `systemPromptContext`
- Reads depth config from DB to use `systemPromptTemplate` and `questionStrategy`
- Falls back to current behavior for legacy domain slugs

#### Modified: POST /api/evaluate-answer
- Uses depth-specific `evaluationCriteria` and `scoringDimensions`
- Technical interviews score on technical accuracy instead of STAR structure

#### Modified: POST /api/generate-feedback
- Adapts feedback framing based on interview type
- Uses depth-specific scoring weights

### 3.6 Backward Compatibility
- Existing sessions with `role: 'PM'` etc. continue to work
- `interviewType` defaults to `'hr-screening'` if not present
- Migration: existing Role enum values map to domain slugs (PM→pm, SWE→swe, Sales→sales, MBA→mba)
- InterviewSession schema accepts any string for `role` (remove enum constraint)

---

## 4. Phase 2: CMS Subdomain Routing & Admin

### 4.1 Middleware Subdomain Detection

```typescript
// middleware.ts additions
const hostname = req.headers.get('host') || ''
const baseDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'interviewprep.guru'
const subdomain = hostname.replace(`.${baseDomain}`, '').split('.')[0]

// CMS admin subdomain
if (subdomain === 'cms') {
  // Rewrite to /cms/* route group
  // Require platform_admin role
}
```

### 4.2 CMS Admin Routes

```
app/(cms)/cms/
  layout.tsx              — CMS admin shell (sidebar nav)
  page.tsx                — Dashboard (domain count, depth count, stats)
  domains/
    page.tsx              — List all interview domains (table)
    new/page.tsx          — Create new domain form
    [slug]/page.tsx       — Edit domain
  interview-types/
    page.tsx              — List all depth levels
    new/page.tsx          — Create new depth level
    [slug]/page.tsx       — Edit depth level
```

### 4.3 CMS API Routes

```
app/api/cms/
  domains/
    route.ts              — GET (list), POST (create)
    [slug]/route.ts       — GET, PUT, DELETE
  interview-types/
    route.ts              — GET (list), POST (create)
    [slug]/route.ts       — GET, PUT, DELETE
```

All CMS API routes require `platform_admin` role.

### 4.4 Environment Variables

```
NEXT_PUBLIC_ROOT_DOMAIN=interviewprep.guru   # for subdomain detection
```

Local development: use `?subdomain=cms` query param as fallback.

---

## 5. Phase 3: UI/UX Overhaul

### 5.1 Homepage Redesign

**Step 1: Domain Selection** (replaces 2x2 grid)
- Category tabs: All | Engineering | Business | Design | Operations
- Scrollable grid of domain cards (3-4 per row)
- Each card: icon + label + short description
- Search/filter input above the grid

**Step 2: Interview Type Selection** (NEW step)
- Horizontal cards showing available depth levels
- Filtered by selected domain (some depths don't apply to all domains)
- Default pre-selected: HR Screening
- Each card: icon + label + description

**Step 3: Experience Level** (unchanged)

**Step 4: Session Length** (unchanged)

**Step 5: Upload Documents** (unchanged)

### 5.2 Updated "How It Works"
- Step 1: "Choose Your Domain & Interview Type"
- Step 2: "Practice with AI" (same)
- Step 3: "Get Scored Feedback" (same)

### 5.3 Lobby & Interview Pages
- Show domain label + interview type in header
- Interview page phase badge shows interview type context

### 5.4 Feedback Page
- Scoring dimensions adapt based on interview type
- Technical interviews show technical accuracy scores
- Case studies show framework usage scores

### 5.5 Onboarding
- `targetRole` dropdown uses dynamic domain list instead of hardcoded 4

---

## 6. File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `lib/db/models/InterviewDomain.ts` | Domain MongoDB model |
| `lib/db/models/InterviewDepth.ts` | Depth level MongoDB model |
| `lib/db/seed.ts` | Seed script for built-in domains & depths |
| `app/api/domains/route.ts` | Public domain listing API |
| `app/api/interview-types/route.ts` | Public depth listing API |
| `app/api/cms/domains/route.ts` | CMS domain CRUD |
| `app/api/cms/domains/[slug]/route.ts` | CMS domain CRUD by slug |
| `app/api/cms/interview-types/route.ts` | CMS depth CRUD |
| `app/api/cms/interview-types/[slug]/route.ts` | CMS depth CRUD by slug |
| `app/(cms)/cms/layout.tsx` | CMS admin layout |
| `app/(cms)/cms/page.tsx` | CMS dashboard |
| `app/(cms)/cms/domains/page.tsx` | CMS domain list |
| `app/(cms)/cms/domains/new/page.tsx` | CMS create domain |
| `app/(cms)/cms/domains/[slug]/page.tsx` | CMS edit domain |
| `app/(cms)/cms/interview-types/page.tsx` | CMS depth list |
| `app/(cms)/cms/interview-types/new/page.tsx` | CMS create depth |
| `app/(cms)/cms/interview-types/[slug]/page.tsx` | CMS edit depth |
| `components/cms/CmsSidebar.tsx` | CMS navigation sidebar |
| `components/cms/DomainForm.tsx` | Domain create/edit form |
| `components/cms/DepthForm.tsx` | Depth create/edit form |
| `components/DomainSelector.tsx` | New domain selection grid |
| `components/DepthSelector.tsx` | New depth selection cards |

### Modified Files
| File | Changes |
|------|---------|
| `lib/types.ts` | Add `InterviewType`, change `Role` to string, update `InterviewConfig` |
| `lib/interviewConfig.ts` | Remove hardcoded ROLE_LABELS/INTROS, add dynamic loading |
| `lib/db/models/InterviewSession.ts` | Remove enum constraint on `role`, add `interviewType` field |
| `lib/db/models/User.ts` | Change `targetRole` from enum to string |
| `lib/db/models/index.ts` | Export new models |
| `lib/validators/interview.ts` | Update Zod schemas for new fields |
| `middleware.ts` | Add subdomain detection + CMS route rewriting |
| `app/page.tsx` | Complete redesign with DomainSelector + DepthSelector |
| `app/api/generate-question/route.ts` | Use domain/depth config from DB |
| `app/api/evaluate-answer/route.ts` | Use depth-specific scoring |
| `app/api/generate-feedback/route.ts` | Adapt feedback for interview type |
| `app/onboarding/page.tsx` | Dynamic domain list for targetRole |
| `app/interview/page.tsx` | Show domain + depth in header |
| `app/lobby/page.tsx` | Show selected domain + depth |
| `hooks/useInterview.ts` | Pass interviewType through config |
| `components/layout/AppShell.tsx` | Handle CMS subdomain nav |
| `app/history/page.tsx` | Show interview type in list |

---

## 7. Database Schema Changes

### InterviewSession — Migration
```javascript
// Remove enum constraint, add interviewType with default
role: { type: String, required: true }  // was enum: ['PM', 'SWE', 'Sales', 'MBA']
interviewType: { type: String, default: 'hr-screening' }
```

### User — Migration
```javascript
targetRole: { type: String }  // was enum: ['PM', 'SWE', 'Sales', 'MBA']
```

---

## 8. API Changes

### New Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/domains` | Public | List active domains |
| GET | `/api/interview-types` | Public | List active depth levels |
| GET | `/api/cms/domains` | Admin | CMS: list domains |
| POST | `/api/cms/domains` | Admin | CMS: create domain |
| GET | `/api/cms/domains/[slug]` | Admin | CMS: get domain |
| PUT | `/api/cms/domains/[slug]` | Admin | CMS: update domain |
| DELETE | `/api/cms/domains/[slug]` | Admin | CMS: delete domain |
| GET | `/api/cms/interview-types` | Admin | CMS: list depths |
| POST | `/api/cms/interview-types` | Admin | CMS: create depth |
| GET | `/api/cms/interview-types/[slug]` | Admin | CMS: get depth |
| PUT | `/api/cms/interview-types/[slug]` | Admin | CMS: update depth |
| DELETE | `/api/cms/interview-types/[slug]` | Admin | CMS: delete depth |
| POST | `/api/db/seed` | Admin | Seed built-in data |

---

## Implementation Order

1. **Database models** — InterviewDomain, InterviewDepth, seed data
2. **Type system** — Update types.ts, validators, interviewConfig.ts
3. **Public APIs** — /api/domains, /api/interview-types
4. **Schema migrations** — InterviewSession, User model changes
5. **AI integration** — Update generate-question, evaluate-answer, generate-feedback
6. **Homepage UI** — DomainSelector, DepthSelector, redesigned flow
7. **Middleware** — Subdomain detection and CMS routing
8. **CMS Admin UI** — Layout, dashboard, domain/depth CRUD pages
9. **CMS API routes** — CRUD endpoints with admin auth
10. **Supporting pages** — Update lobby, interview, feedback, history, onboarding
11. **Tests** — Update existing tests, add new tests
12. **Build & push**

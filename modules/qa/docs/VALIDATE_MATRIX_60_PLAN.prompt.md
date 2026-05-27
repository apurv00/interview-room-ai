# Prompt — Validate MATRIX_60_PLAN (RCAs, phases, fixes)

**Plan version:** Post-validation (2026-05-22) — includes **RCA-QGEN**, **RCA-AN-429**, revised **RCA-3** / **RCA-4b**, retired **RCA-4c** as primary.

Copy everything below the line into a new agent session. Attach or `@`-reference `modules/qa/docs/MATRIX_60_PLAN.md` and ensure the repo (or baseline artifacts) is available.

---

## Role

You are a **validation reviewer** for Interview Prep Guru’s production QA matrix recovery plan. Your job is **not** to implement fixes yet. You must **prove or disprove** each RCA and proposed fix using the baseline run artifacts and the current codebase.

Be skeptical: treat the plan as hypotheses until evidence confirms them.

---

## Context

**Product:** AI mock interview platform (Next.js 14, MongoDB, Inngest, Claude).  
**Baseline prod matrix run:** `qa-browser-full-1779893074279` — **30/60** harness pass (2026-05-27).  
**Goal:** 60/60 unattended prod matrix pass with honest criteria.  
**Plan document:** `modules/qa/docs/MATRIX_60_PLAN.md` (RCA register, phases 0–6, validation record).

**Validated core claims (re-validate, do not assume):**

1. **RCA-1:** Coding/SD failures are G.10 + pathway gates, **not** wrong eval API.
2. **RCA-3:** Missing feedback = **Vercel 504** (~60s) ×3 + **500** ×1 — **not** primary 202/lock/Zod.
3. **RCA-QGEN:** 5/6 `bandOk` on `pm/case-study/weak`, `design/technical/strong`, `backend/technical/weak` = **generate-question 5xx** → empty Q → eval 400 — **not** template band drift alone.
4. **RCA-AN-429:** `general/system-design/strong` analysis = **start 429** — **not** slow pipeline / poll cap.
5. **RCA-4b:** Domain mismatch affects **backend + sdet + data-science** coding and SD strong bands — **not** SDET-only.
6. **Phase 1 alone → ~42/60**, not 60/60.

---

## Required inputs (read before judging)

| Artifact | Path |
|----------|------|
| Plan + RCAs | `modules/qa/docs/MATRIX_60_PLAN.md` |
| Session outcomes | `modules/qa/output/qa-browser-full-1779893074279-sessions.csv` |
| Per-step evidence | `modules/qa/output/runs/qa-browser-full-1779893074279/activities/` |
| Full step log | `modules/qa/output/runs/qa-browser-full-1779893074279/telemetry.jsonl` |
| Generated report | `modules/qa/output/qa-browser-full-1779893074279.md` |
| Pathway history (optional) | `modules/qa/docs/PATHWAY_P0_TRACE.md` |

**Code paths cited in plan (must open and trace):**

- `modules/interview/services/eval/completionAdjustment.ts` — `SHORT_FORM_MIN_ANSWERS`, `shouldReturnShortForm`
- `app/api/generate-feedback/route.ts` — G.10 early return (~395–437), pathway enqueue (~1223–1494)
- `app/api/evaluate-code/route.ts`, `app/api/evaluate-design/route.ts`, `app/api/generate-question/route.ts`
- `modules/learn/services/pathwayUpdateEligibility.ts`, `pathwayRegeneration.ts`
- `modules/interview/config/interviewConfig.ts` — `getCodingQuestionCount` vs `getQuestionCount`
- `modules/interview/hooks/useInterview.ts` — coding/SD flow, `generate-feedback` body (1241–1254)
- `modules/qa/browser/qa-matrix-runner.js` — interview, coding, design, feedback, analysis, gates
- `scripts/generate-qa-browser-report.mjs` — `sessionStageIssues`
- `modules/learn/__tests__/pathwayLoaderIntegration.test.ts` — “coding-style” encodes **bug** today

---

## Validation tasks

### A. Baseline arithmetic

1. From the CSV, count `harnessPass=PASS` and `FAIL` — confirm **30/60**.
2. For every `FAIL` row, assign RCA id(s) using the plan **Quick lookup** table.
3. Report any FAIL row that does not fit or needs a new RCA.

### B. Per-RCA validation (do all nine)

For **each** of RCA-1, RCA-2, RCA-3, RCA-QGEN, RCA-4a, RCA-4b, RCA-AN-429, RCA-RPT, produce:

```
RCA-ID: <id>
Verdict: CONFIRMED | PARTIALLY CONFIRMED | REJECTED | INSUFFICIENT EVIDENCE

Symptom check:
  - 1–2 baseline cells
  - CSV fields
  - Activity + telemetry.jsonl lines (prefer telemetry for multi-step interview)

Root cause check:
  - Code path (file:line)
  - Matches plan “Root cause”?

Ruled-out check:
  - Each “NOT the root cause” claim

Fix check:
  - Phase fix adequate? gaps?

Harness pass delta if only this phase ships:
```

**Mandatory spot-checks:**

| RCA | Minimum evidence |
|-----|------------------|
| **RCA-1** | `frontend/coding/strong`: evaluate-code high scores + generate-feedback short-form + `pathwayPlanStatus: null` |
| **RCA-2** | `backend/technical/weak`: feedback score present, pathway poll `pathwayGenerationAttempts: 0` |
| **RCA-3** | `frontend/technical/strong/feedback/generate-feedback`: **504** @ ~60688ms, `FUNCTION_INVOCATION_TIMEOUT` |
| **RCA-QGEN** | `pm/case-study/weak` telemetry: Q1 generate-question **504**; `backend/technical/weak` Q4 **500** → eval **400** |
| **RCA-4b** | `backend/coding/strong/evaluate-code`: “wrong problem”; not only `sdet/coding` |
| **RCA-4a** | `frontend/coding/weak`: avg ~63, `perQuestionPassCount=0` |
| **RCA-AN-429** | `general/system-design/strong/analysis/analysis-start`: **429** |

**Deprecated as primary:** RCA-4c (template band) — only confirm if telemetry shows **200** qgen + eval ok + band fail with **no** 5xx on that question index.

### C. Phase ↔ RCA alignment

1. Each phase fixes only its RCAs.
2. Validate pass-rate table: Phase 1 **+12 → 42/60**; Phase 2 **+5** (not +6 if QGEN on same session); 60/60 only after all phases.
3. **Phase 1 alone → 60/60?** Must be **No** with cell math.

### D. Implementation checklist (Phases 1–5)

For each checklist row: correct file? correct lever? tests named? symptom-only fixes flagged?

### E. Cross-cutting questions (answer explicitly)

1. Is `getCodingQuestionCount()` wired in `generate-feedback` today?
2. Does `useInterview` send `plannedQuestionCount` / `answeredCount` on `generate-feedback`?
3. Does `pathwayLoaderIntegration.test.ts` encode bug or desired behavior?
4. Pathway pending: `attempts: 0` + 8 Inngest functions — worker never ran vs missing function?
5. Four missing-feedback cells: exact HTTP status and duration from telemetry?
6. `pm/case-study/weak` / `design/technical/strong`: qgen 5xx or template band?

---

## Output format (strict)

### 1. Executive summary (≤10 bullets)

### 2. RCA verdict table (9 RCAs)

| RCA | Verdict | Confidence | Fix adequate? |
|-----|---------|------------|---------------|

### 3. Baseline coverage (unmapped FAIL rows)

### 4. Phase pass-rate sanity check

| After phase | Plan claims | Your estimate | Delta |

### 5. Recommended plan edits (if any remain)

### 6. Go / no-go per phase

---

## Rules

- Validation only — no implementation unless asked.
- Cite `telemetry.jsonl` for per-question interview failures (activity files often show **last** step only).
- Distinguish **product** vs **harness** vs **ops/Inngest** vs **Vercel platform limit**.

---

## Optional commands

```bash
# Pass/fail count
rg ",FAIL,|,PASS," modules/qa/output/qa-browser-full-1779893074279-sessions.csv

# Feedback 504 cells
rg "generate-feedback.*504" modules/qa/output/runs/qa-browser-full-1779893074279/telemetry.jsonl

# QGEN failures
rg "generate-question.*(504|500)" modules/qa/output/runs/qa-browser-full-1779893074279/telemetry.jsonl

# Analysis 429
rg "analysis-start.*429" modules/qa/output/runs/qa-browser-full-1779893074279/telemetry.jsonl

# getCodingQuestionCount in feedback route
rg "getCodingQuestionCount" app/api/generate-feedback/route.ts
```

---

## One-line mission

**Re-validate the post-review MATRIX_60_PLAN: nine RCAs, honest pass-rate math, and go/no-go — especially RCA-QGEN, RCA-3 (504), and RCA-AN-429 (429).**

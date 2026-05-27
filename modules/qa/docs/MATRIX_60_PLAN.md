# Phased Plan — 60/60 QA Matrix (Production)

**Baseline run:** `qa-browser-full-1779893074279` — **30/60** harness pass (2026-05-27)  
**Goal:** Unattended prod 60-cell matrix green with honest pass criteria  
**Principle:** Fix product root causes first; align harness with prod; verify each phase with a partial or full matrix rerun.  
**Plan status:** Revised after dual-agent validation (see [Validation record](#validation-record-dual-agent-review)).

---

## Executive scorecard (baseline)

| Failure bucket | Cells | RCA | Phase |
|----------------|------:|-----|-------|
| Coding + system-design short-form | 18 | [RCA-1](#rca-1--coding--system-design-scored-eval-zero-feedback-unchanged-pathway) | **1** |
| Pathway `pending` after 120s poll (`attempts: 0`) | 6 | [RCA-2](#rca-2--pathway-stuck-pending-after-poll-feedback-ok) | **2** |
| Feedback Vercel 504 / route 500 | 4 | [RCA-3](#rca-3--feedback-vercel-504--route-500) | **3** |
| `/api/generate-question` 500/504 → empty Q → eval 400 | 3+ | [RCA-QGEN](#rca-qgen--generate-question-5xx--empty-question--eval-400) | **4** |
| Harness domain mismatch (coding + SD strong band) | 6+ | [RCA-4b](#rca-4b--harness-domain-mismatch-coding--system-design) | **4** |
| Harness coding weak STAR band | 1 | [RCA-4a](#rca-4a--harness-weak-coding-fails-despite-weak-like-code-eval) | **4** |
| Analysis start 429 (not slow pipeline) | 1 | [RCA-AN-429](#rca-an-429--analysis-start-rate-limited) | **5** |
| Report mislabel + hidden 5xx | 18+ | [RCA-RPT](#rca-rpt--report-mislabel-triage-noise) | **4** |
| Already passing | 30 | — | — |

**Important:** Phase 1 alone → **~42/60** (+12), not 60/60. Full 60/60 requires Phases 1–5 with expanded RCA-4b and RCA-QGEN fixes.

---

## RCA register (symptom → mechanism → fix)

Use this section to triage any failing cell: match **symptoms** to an RCA id, then implement the linked **phase**.

| RCA ID | Phase | Cells (baseline) | One-line root cause |
|--------|-------|------------------|---------------------|
| **RCA-1** | 1 | 18 coding/SD | G.10 + pathway gates built for ≥3 **spoken** answers; coding/SD only submit **1 code/design** eval |
| **RCA-2** | 2 | 6 behavioral/technical/case-study | Pathway enqueued; worker never finished in poll (`pathwayGenerationAttempts: 0`) — not missing function (8 Inngest fns OK) |
| **RCA-3** | 3 | 4 technical/behavioral/case-study | **Vercel `FUNCTION_INVOCATION_TIMEOUT` 504** (~60s) on 3 cells; **HTTP 500** on 1 — not 202/lock/Zod |
| **RCA-QGEN** | 4 | 3+ interview gates | `/api/generate-question` **500/504** → `question: ""` → `/api/evaluate-answer` **400** or missing eval → 5/6 `bandOk` |
| **RCA-4a** | 4 | 1 coding weak | Harness uses behavioral STAR band (avg ≤ 55) on code-mapped dimensions |
| **RCA-4b** | 4 | 6+ coding/SD strong | Harness generic Two Sum / URL-shortener vs domain-generated problem → low avg or “wrong problem” |
| **RCA-AN-429** | 5 | 1 general/SD strong | `/api/analysis/start` **429** rate limit; poll 404 until timeout — analysis never started |
| **RCA-RPT** | 4 | 18+ labels | Report `score < 10` conflates short-form 0, legit low passes, and hides upstream 5xx |

---

### RCA-1 — Coding & system-design: scored eval, zero feedback, unchanged pathway

| | |
|---|---|
| **Symptom (harness / user)** | `harnessPass=FAIL`, `feedbackScore=0`, `pathwayState=unchanged`, stage issue `[Feedback] Very low session score (<10)`; pathway banner “retake — not enough answers.” Often `sessionAvgDimensions` is **high** (e.g. 96) while `feedbackScore` is **0**. |
| **Problem** | Product refuses to score the session and never updates the learning pathway, even though code/design was evaluated correctly. |
| **Root cause** | **Policy mismatch**, not wrong eval API. (1) `computeCompletionAdjustment` sets `shouldReturnShortForm` when `answeredCount < SHORT_FORM_MIN_ANSWERS` (3) with **no** exemption for `interviewType === 'coding' \| 'system-design'`. (2) `generate-feedback` returns early at that guard with `overall_score: 0` and **never** runs LLM feedback or pathway side effects (`pathwayPlanStatus: null` in activities). (3) `canEnqueuePathwayRegeneration` and `getPathwayUpdateEligibility` also require `answeredCount >= 3`. (4) `hasScoredFeedback` rejects `overall_score === 0` without `degraded`. Harness sends `answeredCount: 1`, `plannedQuestionCount: 1`; prod coding often sends 1–2 evals and omits planned count (fallback `getQuestionCount(30)` → “1 of 16” in red flag). |
| **NOT the root cause** | Spoken-answer / STAR evaluation of code; `evaluate-code` / `evaluate-design` already score the right artifact. PR #407 pathway polling UX does not cause this bucket (enqueue never happens). |
| **Evidence** | Activity `frontend/coding/strong/feedback/generate-feedback`: `"Answered 1 of 1 planned — not enough to score"`, `pathwayPlanStatus: null`. Activity `frontend/coding/strong/interview/evaluate-code`: correctness 100, efficiency 100. CSV: 18 rows `*/coding/*` and `*/system-design/*` all `feedbackScore=0`, `unchanged`. Code: `completionAdjustment.ts:77`, `generate-feedback/route.ts:395-437`, `pathwayRegeneration.ts:105`, `pathwayUpdateEligibility.ts:84-90`. `getCodingQuestionCount()` defined in `interviewConfig.ts` but unused in feedback route. |
| **What solves it** | Phase **1**: interview-type-aware G.10; planned count via `getCodingQuestionCount`; deterministic + LLM `overall_score` from code/design evals; pathway enqueue + eligibility at ≥1 substantive submission; `useInterview` sends completion shape on `generate-feedback`. |
| **Verify** | `overall_score > 0` on coding/SD cells; `pathwayPlanEnqueue: scheduled` → `pathwayGenerationStatus: succeeded`; `pathwayState` ≠ `unchanged`. Unit: `pathwayLoaderIntegration` “coding-style” → eligible. |

**Affected cells (18):**  
`frontend|backend|sdet|data-science` × `coding|system-design` × `strong|weak`; `general/system-design/strong|weak` (no `general/coding` in this matrix).

---

### RCA-2 — Pathway stuck `pending` after poll (feedback OK)

| | |
|---|---|
| **Symptom** | `feedbackScore` present (e.g. 7–11), `pathwayPlanEnqueue: scheduled`, `pathwayGenerationStatus: pending` after 120s, `harnessPass=FAIL`, issues `[Pathway] generationStatus=pending after poll window`. |
| **Problem** | User sees “pathway catching up” forever; harness fails pathway stage though interview + feedback succeeded. |
| **Root cause** | **Worker never ran or did not finish**, not missing enqueue. Poll bodies show `pathwayGenerationStatus: pending` with **`pathwayGenerationAttempts: 0`** after 120s — event accepted but no worker pickup/completion (concurrency, cold start, planner LLM > 120s). Baseline infra: **8 Inngest functions** registered (including `pathway-regenerate`) — this run is **not** the historical “missing function” P0 from `PATHWAY_P0_TRACE.md`, but that check remains a **blocking Phase 0 gate**. PR #407 improves client poll/retry/stale UX; `STALE_PATHWAY_PENDING_MS` (10 min) exceeds harness poll (2 min). |
| **NOT the root cause** | Short-form G.10 (these sessions have real scores). Client poll typo alone (poll reflects DB truth). Missing enqueue (`pathwayPlanStatus: scheduled` is present). |
| **Evidence** | `backend/technical/weak/pathway/pathway-poll.json`: `pathwayGenerationAttempts: 0`, status `pending`. Same pattern: `sdet/behavioral/weak`, `pm/case-study/strong`, `design/behavioral/strong`, `business/behavioral/weak`, `business/technical/strong`. |
| **What solves it** | Phase **2**: PR #407; stale `pending`/`running` → `failed` + retry; Inngest concurrency/timeout tuning; optional harness poll extension + one retry; bulk replay for stuck sessions. |
| **Verify** | 5–6 cells → `pathwayGenerationStatus: succeeded` within poll. **`backend/technical/weak` may still FAIL** on interview gate ([RCA-QGEN](#rca-qgen--generate-question-5xx--empty-question--eval-400)) even if pathway succeeds — expect **+5** harness wins from Phase 2 alone. |

---

### RCA-3 — Feedback: Vercel 504 / route 500

| | |
|---|---|
| **Symptom** | `feedbackScore` empty, `feedbackPass=no`, `[Feedback] No overall_score returned`; interview stage often 6/6 evals OK. |
| **Problem** | Session completes Q&A but `/api/generate-feedback` never returns a persisted score; pathway may show `unchanged` / “generate feedback first.” |
| **Root cause** | **Synchronous feedback exceeds Vercel function wall clock** — not short-form, not 202+poll, not Redis lock (primary). Baseline telemetry: **3× HTTP 504** `FUNCTION_INVOCATION_TIMEOUT` at **~60310–60688ms**; **1× HTTP 500** at ~18s. |
| **NOT the root cause** | G.10 short-form (returns 200 + `overall_score: 0`). Coding/SD policy (RCA-1). Generic “investigate lock/Zod” without timeout fix. |
| **Evidence** | `frontend/technical/strong/feedback/generate-feedback`: 504 @ 60688ms. `data-science/technical/weak`: 504 @ 60310ms. `pm/behavioral/weak`: 504 @ 60311ms. `design/case-study/weak`: 500 @ 18063ms. |
| **What solves it** | Phase **3** (pick one or combine): (a) move feedback generation to **Inngest** (mirror `analysisJob.ts`), (b) Vercel Pro / Fluid Compute **300s** timeout, (c) profile + reduce LLM latency for heavy domains. Triage `design/case-study/weak` 500 separately (server error, not timeout). Lock/Zod/truncation = tertiary. |
| **Verify** | All 4 cells return non-null `overall_score`; zero `No overall_score returned` in `stageIssues`. |

---

### RCA-4a — Harness: weak coding “fails” despite weak-like code eval

| | |
|---|---|
| **Symptom** | `perQuestionPassCount=0`, `sessionAvgDimensions` ~63, product eval shows low **efficiency** but high **correctness** (e.g. 88). |
| **Problem** | Matrix marks interview stage fail for weak persona even when eval API correctly flagged inefficient code. |
| **Root cause** | `scoreQuestionGates` uses **behavioral** rule `g2Separation: avg <= 55` on STAR-mapped dims (`relevance/structure/specificity/ownership`). Weak coding maps to ~63 avg (correct brute-force) → gate fails. |
| **NOT the root cause** | Product scoring (RCA-1). Eval API quality. |
| **Evidence** | `frontend/coding/weak`: activity `evaluate-code` correctness 88, efficiency 25 → avg 63; `g2Separation` false. `qa-matrix-runner.js:233-237`. |
| **What solves it** | Phase **4**: depth-specific gates — weak coding passes on low `efficiency` or `correctness` threshold, not STAR avg ≤ 55. |
| **Verify** | `frontend/coding/weak` → `perQuestionPassCount=1` after RCA-1 also fixed feedback. |

---

### RCA-4b — Harness: domain mismatch (coding + system-design)

| | |
|---|---|
| **Symptom** | Strong coding/SD cells: `sessionAvg` 48–55, `perQuestionPassCount=1` or fail strong band (≥60). Weak coding may show “wrong problem” flags. |
| **Problem** | Matrix blames eval quality; harness submits **generic** artifacts against **domain-generated** problems. |
| **Root cause** | `runCodingInterview`: `/api/code/generate-problem` returns domain task; harness always submits `HARNESS_CODE` (Two Sum). `runDesignInterview`: static URL-shortener canvas for all domains. Eval correctly scores mismatch (e.g. backend “sliding-window TTL cache” vs Two Sum → correctness 0). **Not SDET-only** — also `backend/coding/strong`, and SD strong rows at 53–55. |
| **NOT the root cause** | `evaluate-code` / `evaluate-design` prompts. RCA-1 (product scoring still required separately). |
| **Evidence** | `sdet/coding/strong/evaluate-code`: correctness 0. `backend/coding/strong/evaluate-code`: “solves wrong problem”. `backend/system-design/strong` sessionAvg 53, `sdet/system-design/strong` 54, `general/system-design/strong` 55. |
| **What solves it** | Phase **4**: (a) static Two Sum + static SD template for **all** harness domains, **or** (b) per-domain harness code/design matching generated problem, **or** (c) force `generate-problem` to return harness-compatible fixture for QA user. |
| **Verify** | Strong coding/SD cells: `sessionAvg` ≥ 60 where persona is strong; no “wrong problem” flags. |

---

### RCA-QGEN — `/api/generate-question` 5xx → empty question → eval 400

| | |
|---|---|
| **Symptom** | `perQuestionPassCount=5/6`, `harnessPass=FAIL`; report shows one Q with “Missing evaluation payload” or “Question unusually short.” Feedback/pathway may still succeed on other cells. |
| **Problem** | Interview stage fails one index; downstream eval never runs for that question. |
| **Root cause** | **`/api/generate-question` returns 500 or 504** (Vercel timeout up to ~300s on 504 rows) with `question: ""`. Harness still calls `/api/evaluate-answer` → **400** validation (`question` too small). **Replaces prior RCA-4c** (“template band drift”) for baseline cells — telemetry shows 5xx, not borderline STAR scores. |
| **NOT the root cause** | Persona template quality alone (when qgen returns 200, weak answers score low as expected). Pathway pending (orthogonal). |
| **Evidence** | `telemetry.jsonl` — backend/technical/weak Q4: **500** @ 80871ms → eval **400** (lines ~547–548); pm/case-study/weak Q1: **504** @ 300252ms → eval **400** (~1930–1931); design/technical/strong Q0: **504** @ 300239ms → eval **400** (~2102–2103). Qgen 504 durations (~300s) suggest **300s function wall**, not 60s — investigate hung upstream call (LLM/CMS), not “raise timeout” alone. |
| **What solves it** | Phase **4**: harness fail-fast / retry / fallback question when qgen 5xx; reduce qgen latency or Inngest-ize; do not call evaluate-answer with empty question. Product: investigate qgen 500/504 root cause (same Vercel wall as feedback). |
| **Verify** | Affected cells → `perQuestionPassCount=6`; telemetry shows 200 qgen before each evaluate-answer. |

**Use RCA-4c (template band) only when:** qgen **200**, eval **200**, and avg fails `g2Separation` / `g3Relevance` with no upstream 5xx in `telemetry.jsonl`.

---

### RCA-AN-429 — Analysis start rate-limited

| | |
|---|---|
| **Symptom** | `analysisStatus=timeout`, `[Analysis] Poll timeout` on `general/system-design/strong`. |
| **Problem** | Harness fails analysis stage; blocks 60/60 on that cell. |
| **Root cause** | **`POST /api/analysis/start` → HTTP 429** `"Rate limit exceeded"` — analysis **never started**. Subsequent polls return **404** “Analysis not found” until harness timeout. **Not** a slow multimodal pipeline exceeding poll cap. |
| **NOT the root cause** | Multimodal pipeline duration. RCA-1 feedback on same cell (coexists but separate). |
| **Evidence** | `general/system-design/strong/analysis/analysis-start.json`: status **429**. Coexists with RCA-1 (`feedbackScore=0`) on same cell. |
| **What solves it** | Phase **5**: harness throttle/queue `analysis-start` across cells; QA-user rate-limit bump; fail-fast on non-2xx start (do not poll 60×). Optional: skip analysis gate for matrix if product accepts. |
| **Verify** | `analysisStatus=completed` or explicit `skipped` policy; no 429 on start. |

---

### RCA-RPT — Report mislabel (triage noise)

| | |
|---|---|
| **Symptom** | `[Feedback] Very low session score (<10)` on coding/SD and on **passing** low-score cells (e.g. `backend/technical/weak=9`). |
| **Problem** | Operators chase wrong bugs; upstream 5xx/429 often absent from `stageIssues`. |
| **Root cause** | `sessionStageIssues()` (`generate-qa-browser-report.mjs:181`) flags any `fb.score < 10` as “very low session score” — includes deliberate short-form **0** and legitimate weak-session scores. |
| **What solves it** | Phase **4**: (1) short-form red-flag pattern → `[Feedback] Short-form — insufficient answers`; (2) raise threshold or drop issue for real low passes; (3) surface qgen/feedback/analysis **5xx/429** from telemetry in `stageIssues`. |
| **Verify** | No false “very low” on refused-to-score rows; passing cells with score 6–9 not mis-tagged; API failures visible in report. |

---

## Phase 0 — Lock baseline & branch strategy

**Goal:** One reproducible “before” and clean workstreams.

| Task | Owner | Done when |
|------|-------|-----------|
| Save baseline artifacts: `modules/qa/output/runs/qa-browser-full-1779893074279/` | — | ✓ (exists) |
| Tag baseline in report: `qa-browser-full-1779893074279.md` | — | ✓ |
| Merge **PR #407** (pathway loader/polling) if CI green — separate from scoring | Eng | Merged or explicitly deferred |
| Confirm prod Inngest shows **8 functions** including `pathway-regenerate` | Ops | **Blocking** — dashboard + `inngestCheck` |
| Open feature branch e.g. `fix/matrix-60-scoring` off `main` | Eng | Branch created |

**Exit:** Baseline CSV linked; **8-function gate passed** (load-bearing for RCA-2 — pending cells show `attempts: 0`, not missing registration on this run).

---

## Phase 1 — Product: scorable coding & system-design (P0)

**RCA:** [RCA-1](#rca-1--coding--system-design-scored-eval-zero-feedback-unchanged-pathway)  
**Target pass rate:** **~42/60 (+12 cells)** — upper bound ~44 only if pathway jobs complete on all coding/SD cells  
**User impact:** Real candidates completing one code/design submission get scored feedback + pathway update.

### 1.1 RCA summary

| | |
|---|---|
| **Symptom** | High `sessionAvgDimensions`, `feedbackScore=0`, `pathwayState=unchanged` |
| **Root cause** | G.10 + pathway gates require ≥3 answers; coding/SD sessions have 1 substantive submission |
| **Fix** | Type-aware completion, scored feedback from code/design evals, pathway enqueue at ≥1 |
| **Not caused by** | Wrong eval API or spoken-answer grading of code |

### 1.2 Problem statement (mechanism detail)

- `evaluate-code` / `evaluate-design` return correct dimension scores.
- `generate-feedback` hits G.10 short-form when `answeredCount < 3` (harness sends 1; prod coding often 1–2).
- `canEnqueuePathwayRegeneration` and `getPathwayUpdateEligibility` require `answeredCount >= 3`.
- `hasScoredFeedback` treats `overall_score === 0` as unscored.
- `getCodingQuestionCount()` exists but is **unused** in feedback completion logic.

### 1.3 Design decisions (pick before coding)

| Option | Recommendation |
|--------|----------------|
| Min answers for coding/SD | **1 substantive submission** counts as a completed “answer” for G.10 and pathway gates |
| `plannedQuestionCount` fallback | Use `getCodingQuestionCount(duration)` for `coding`; **1** for `system-design` (or same helper if extended) |
| `overall_score` without full LLM | Deterministic blend from code/design eval dimensions + optional LLM narrative |
| Pathway input | Enqueue when ≥1 ok eval with type-specific scores OR full feedback persisted |

### 1.4 Implementation checklist

| # | Change | Files (primary) |
|---|--------|-----------------|
| 1 | `computeCompletionAdjustment`: interview-type-aware short-form (`coding`, `system-design` exempt or min=1) | `modules/interview/services/eval/completionAdjustment.ts` |
| 2 | `generate-feedback`: pass `interviewType` into G.10; use `getCodingQuestionCount` for planned count fallback | `app/api/generate-feedback/route.ts`, `modules/interview/config/interviewConfig.ts` |
| 3 | Short-form branch: if exempt types have ≥1 ok eval, run scoring path (blend + LLM) instead of `overall_score: 0` return | `app/api/generate-feedback/route.ts` |
| 4 | Add `blendCodeDesignOverallScore(evaluations, interviewType)` pure helper | `modules/interview/services/eval/` (new or `overallScore.ts`) |
| 5 | `canEnqueuePathwayRegeneration`: `count >= 1` when session config is coding/system-design OR eval has `primaryGap` in technical set | `modules/learn/services/pathwayRegeneration.ts` |
| 6 | `getPathwayUpdateEligibility` / `hasScoredFeedback`: recognize code/design scored sessions | `modules/learn/services/pathwayUpdateEligibility.ts` |
| 7 | `finishInterview` → generate-feedback body: include `answeredCount`, `plannedQuestionCount`, `endReason` for coding/SD | `modules/interview/hooks/useInterview.ts` |
| 8 | Tests: completion adjustment, generate-feedback route; **flip** `pathwayLoaderIntegration` “coding-style” from `insufficient_answers` → **eligible** | `completionAdjustment.test.ts`, `generateFeedbackIdempotency.test.ts`, `pathwayLoaderIntegration.test.ts` |
| 9 | `useInterview` fire-and-forget: today sends only `config, transcript, evaluations, speechMetrics, sessionId` — add `answeredCount`, `plannedQuestionCount`, `endReason` (persistSession writes them to DB but route does not re-read) | `modules/interview/hooks/useInterview.ts:1241-1254` |

### 1.5 GitNexus / hot path

- Run `gitnexus_impact` before editing `useInterview.ts` (hot path).
- Run `./scripts/gitnexus-impact.sh` per repo hooks if touching hot-path files.
- Commit accountability fields required on Claude commits.

### 1.6 Verification

| Check | Expected |
|-------|----------|
| Unit tests | All scoring + pathway eligibility tests green |
| Local manual | 1 coding session → feedback `overall_score` > 0, pathway enqueue scheduled |
| Mini matrix | `frontend/coding/strong`, `frontend/system-design/weak` → feedback score not 0, pathway not `unchanged` |
| Prod partial matrix | ≥14/18 coding/SD: `feedbackScore > 0`, pathway not `unchanged` |

### 1.7 Known residual after Phase 1 (not fixed by Phase 1 alone)

| Cell / issue | RCA | Why Phase 1 is not enough |
|--------------|-----|---------------------------|
| `frontend/coding/weak` | [RCA-4a](#rca-4a--harness-weak-coding-fails-despite-weak-like-code-eval) | Interview `bandOk` (avg 63 > 55) |
| `sdet/coding/*`, `backend/coding/strong`, SD strong 53–55 | [RCA-4b](#rca-4b--harness-domain-mismatch-coding--system-design) | Domain mismatch / strong band |
| `general/system-design/strong` | [RCA-AN-429](#rca-an-429--analysis-start-rate-limited) + RCA-1 | Analysis 429 + short-form feedback |

**Phase 1 exit:** ≥14/18 coding/SD cells: `feedbackScore > 0` and `pathwayState` ≠ `unchanged` (or `active` after succeed). **Harness pass** may remain below 18 until Phase 4.

---

## Phase 2 — Pathway worker reliability (P0)

**RCA:** [RCA-2](#rca-2--pathway-stuck-pending-after-poll-feedback-ok)  
**Target pass rate:** **~49–51/60 (+5 to +6 cells)** — count **+5** unless [RCA-QGEN](#rca-qgen--generate-question-5xx--empty-question--eval-400) fixed on `backend/technical/weak`  
**Cells:** `backend/technical/weak`, `sdet/behavioral/weak`, `pm/case-study/strong`, `design/behavioral/strong`, `business/behavioral/weak`, `business/technical/strong`.

### 2.1 RCA summary

| | |
|---|---|
| **Symptom** | `pathwayGenerationStatus=pending` after 120s; feedback has `overall_score` |
| **Root cause** | Inngest `pathway/regenerate` did not complete in poll window (worker/sync/concurrency) |
| **Fix** | Stale detection, retry, PR #407, ops Inngest 8-fn sync, optional longer poll |
| **Not caused by** | G.10 short-form or `unchanged` eligibility |

### 2.2 Problem statement

Feedback returns `overall_score`; `pathwayPlanEnqueue: scheduled` but poll ends with `pathwayGenerationStatus: pending`.

### 2.3 Implementation checklist

| # | Change | Files / ops |
|---|--------|-------------|
| 1 | Verify PR #407 merged: stale pending, retry CAS, poll epoch | `pathwayUpdateEligibility.ts`, `pathway/retry/route.ts`, `usePathwayGenerationPoll.ts` |
| 2 | `pathwayJob`: mark stale `pending`/`running` > `STALE_PATHWAY_PENDING_MS` → `failed` | `modules/learn/jobs/pathwayJob.ts` (or equivalent) |
| 3 | Increase prod worker concurrency / timeout if planner LLM > 120s | Inngest dashboard / function config |
| 4 | Harness: extend pathway poll for full matrix OR align with `PATHWAY_CLIENT_STUCK_MS` + retry once | `qa-matrix-runner.js` `runPathway()` |
| 5 | Runbook: post-deploy Inngest 8-function check + `scripts/replay-pathway-regenerate.mjs` | `modules/qa/docs/PATHWAY_P0_TRACE.md` |

### 2.4 Verification

- Mongo: 0 sessions stuck `pending` with `attempts: 0` after replay.
- 5–6 cells → `pathwayGenerationStatus: succeeded` on rerun (`backend/technical/weak` may still fail harness on 5/6 interview).

**Phase 2 exit:** Pathway stage ≥39/60 succeeded/skipped; harness +5 from pure pending recovery.

---

## Phase 3 — Feedback missing score (P0)

**RCA:** [RCA-3](#rca-3--feedback-never-returned-overall_score)  
**Target pass rate:** ~52–56/60 (+4 cells)  
**Cells:** `frontend/technical/strong`, `data-science/technical/weak`, `pm/behavioral/weak`, `design/case-study/weak`.

### 3.1 RCA summary

| | |
|---|---|
| **Symptom** | `feedbackScore` blank, `[Feedback] No overall_score returned` |
| **Root cause** | **Vercel 504** (~60s) on 3 cells; **HTTP 500** on 1 — synchronous `/api/generate-feedback` exceeds function limit |
| **Fix** | Inngest background feedback job and/or longer timeout and/or LLM speedup; separate triage for 500 |
| **Not caused by** | RCA-1 short-form; primary fix is **not** lock/Zod-only |

### 3.2 Observed failure modes (baseline — no further forensics required)

| Cell | HTTP | Duration | Notes |
|------|------|----------|-------|
| `frontend/technical/strong` | **504** | 60688ms | `FUNCTION_INVOCATION_TIMEOUT` |
| `data-science/technical/weak` | **504** | 60310ms | Same |
| `pm/behavioral/weak` | **504** | 60311ms | Same |
| `design/case-study/weak` | **500** | 18063ms | Server error — investigate logs |

### 3.3 Implementation checklist

| # | Change | Priority |
|---|--------|----------|
| 1 | Move heavy feedback path to **Inngest** (pattern: `analysisJob.ts`) | P0 |
| 2 | Or: Vercel Pro / Fluid Compute 300s for `generate-feedback` | P0 alt |
| 3 | Profile LLM tokens/latency for technical + case-study domains | P1 |
| 4 | Harness: treat 504 as hard fail with clear `stageIssues` (see RCA-RPT) | P1 |
| 5 | Lock/Zod/truncation hardening | P2 tertiary |

**Files:** `app/api/generate-feedback/route.ts`, new `modules/interview/jobs/feedbackJob.ts` (if created), harness `runFeedback()`.

### 3.4 Verification

- All 4 cells return non-null `overall_score` on prod rerun.
- `feedback` scorecard: 60/60 returned (report already had 56/60).

**Phase 3 exit:** Zero `[Feedback] No overall_score returned` in `stageIssues`.

---

## Phase 4 — Harness fidelity & pass criteria (P1)

**RCA:** [RCA-4a](#rca-4a--harness-weak-coding-fails-despite-weak-like-code-eval), [RCA-4b](#rca-4b--harness-domain-mismatch-coding--system-design), [RCA-QGEN](#rca-qgen--generate-question-5xx--empty-question--eval-400), [RCA-RPT](#rca-rpt--report-mislabel-triage-noise)  
**Target pass rate:** **~57–59/60** (+5–9 cells depending on RCA-4b breadth) — **not 60/60** without all items below  
**Does not change prod UX** — makes matrix honestly reflect product.

### 4.1 RCA summary

| RCA | Symptom | Root cause | Fix |
|-----|---------|------------|-----|
| 4a | Weak coding `perQuestionPassCount=0`, avg ~63 | STAR avg ≤ 55 on code dims | Depth-specific coding gates |
| 4b | Strong coding/SD avg 48–55 | Generic harness vs domain problem | Align fixtures all domains |
| QGEN | 5/6 `bandOk`, missing eval on one Q | generate-question 500/504 → eval 400 | Retry/fallback/skip eval; fix qgen timeout |
| RPT | False “very low” + hidden 5xx | `score < 10` threshold | Pattern match + surface API errors |

### 4.2 Coding / system-design harness

| # | Change | File |
|---|--------|------|
| 1 | Pass `plannedQuestionCount` from `getCodingQuestionCount` / 1 for design | `qa-matrix-runner.js` `runFeedback()` |
| 2 | Depth-specific `scoreQuestionGates` for coding (efficiency/correctness, not STAR avg ≤ 55) | `qa-matrix-runner.js` |
| 3 | **All domains:** static Two Sum + static SD **or** per-domain code/design matching `generate-problem` | `runCodingInterview()`, `runDesignInterview()` |
| 4 | Fail-fast when `generate-problem` 504 (do not silently fall back to wrong stub) | `runCodingInterview()` |
| 5 | Optional: one spoken follow-up to mirror prod 2-eval coding sessions | `runCodingInterview()` |

### 4.3 Question generation resilience (RCA-QGEN)

| # | Change | File |
|---|--------|------|
| 1 | If `generate-question` 5xx: retry once, then use depth fallback question string | `qa-matrix-runner.js` `runInterview()` |
| 2 | Do not call `evaluate-answer` when `question` empty (avoid 400 noise) | `qa-matrix-runner.js` |
| 3 | Product: qgen route timeout investigation / Inngest (same class as RCA-3) | `app/api/generate-question/route.ts` |

**Cells:** `pm/case-study/weak` (Q1 504), `design/technical/strong` (Q0 504), `backend/technical/weak` (Q4 500 + pathway pending).

### 4.4 Report hygiene

| Change | File |
|--------|------|
| Short-form red-flag → dedicated issue text | `generate-qa-browser-report.mjs` |
| Raise or remove `< 10` threshold for legit low passing scores | `generate-qa-browser-report.mjs` |
| Add `interviewType` + upstream 5xx/429 from telemetry to `stageIssues` | `generate-qa-browser-report.mjs` |

**Phase 4 exit:** `perQuestionPassCount=6` on QGEN cells; strong coding/SD `sessionAvg` ≥ 60 where expected.

---

## Phase 5 — Analysis rate limit (P2)

**RCA:** [RCA-AN-429](#rca-an-429--analysis-start-rate-limited)  
**Harness pass impact:** **None today** — `qa-matrix-runner.js:770-788` sets `entry.pass` from interview `bandOk`, feedback `overall_score != null`, and pathway `succeeded|skipped` only; `runAnalysis()` result is **not** wired into `entry.pass`. CSV `analysisStatus=timeout` on `general/system-design/strong` is report/triage noise for harness PASS/FAIL; that cell fails on RCA-1 + RCA-4b (avg 55, strong band ≥60). Phase 5 = **quality/ops**; Phase 6 **60/60 does not require Phase 5** unless analysis is promoted to a gate.

### 5.1 RCA summary

| | |
|---|---|
| **Symptom** | `analysisStatus=timeout` on `general/system-design/strong` |
| **Root cause** | **`/api/analysis/start` HTTP 429** — 60-cell matrix hammers per-user rate limit; poll 404 until timeout |
| **Fix** | Harness throttle between `analysis-start` calls; QA rate-limit bump; fail-fast on non-2xx start |
| **Not caused by** | Slow multimodal pipeline; increasing poll cap alone |

### 5.2 Tasks

| # | Change |
|---|--------|
| 1 | `runAnalysis()`: if start returns 429/5xx, mark failed/skipped — do not poll 60× |
| 2 | Inter-cell delay or global queue for `analysis-start` in matrix runner |
| 3 | Ops: raise RL for automation user or exempt internal QA |
| 4 | Drill skipped on strong persona | **Expected** — not a harness pass blocker |

**Files:** `qa-matrix-runner.js` `runAnalysis()`, `modules/interview/services/analysis/`.

**Phase 5 exit:** Analysis 60/60 completed or explicit skip policy documented.

---

## Phase 6 — GA gate & full matrix (P0 validation)

### 6.1 Pre-flight gate (`npm run qa:v3:gate:prod` when wired)

1. Inngest 8 functions  
2. Mini-smoke (3 cells) — pathway terminal  
3. Coding/SD smoke (2 cells) — scored feedback  
4. Pathway pending smoke (1 behavioral cell) — succeeded within poll  

### 6.2 Full matrix

```bash
# After Phases 1–5 deployed to prod
npm run qa:build:browser   # if harness changed
npm run qa:v3:matrix:prod  # or documented prod command
```

### 6.3 Success criteria (60/60)

| Metric | Target |
|--------|--------|
| `harnessPass` | 60/60 |
| `feedback` with `overall_score` | 60/60 |
| `pathwayGenerationStatus` | 60/60 `succeeded` or `skipped` |
| `pathwayState` | No spurious `unchanged` after scored sessions |
| P0 auto-findings | 0 open |

### 6.4 Regression guard

- Add CI test: `completionAdjustment` coding 1-answer → not short-form  
- Keep `pathwayLoaderIntegration` “coding-style” updated to **eligible** after Phase 1  
- Optional: nightly 60-cell with baseline diff (`qa-v3-diff`)

---

## Dependency graph

```
Phase 0 (baseline)
    │
    ├─► Phase 1 (coding/SD scoring) ──► Phase 6 (full matrix)
    │
    ├─► Phase 2 (pathway worker) ─────► Phase 6
    │         ▲
    │         └── PR #407 helps
    │
    ├─► Phase 3 (missing feedback) ───► Phase 6
    │
    └─► Phase 4 (harness) ──────────────► Phase 6
              │
              └─► Phase 5 (analysis) ──► Phase 6
```

**Parallelizable:** Phase 1 + Phase 3 investigation; Phase 4 harness work can start in parallel with Phase 2 ops.

---

## Estimated pass rate by milestone

| Milestone | Harness pass (validated estimate) | Cumulative work |
|-----------|----------------------------------|-----------------|
| Baseline | 30/60 | — |
| After Phase 1 | **~42/60** (+12) | Product coding/SD scoring + pathway enqueue |
| After Phase 2 | **~47–50/60** (+5–6) | Pathway worker; plan upper ~51 ~1 optimistic |
| After Phase 3 | **~51–54/60** (+4) | Feedback 504/500 fix |
| After Phase 4 | **~57–60/60** (+4–6) | Harness 4a/4b/QGEN/RPT — **60/60 achievable** |
| After Phase 5 | **+0 harness** | Analysis 429 — quality only (`entry.pass` ignores analysis) |
| Phase 6 confirm | **60/60** | Full matrix after **Phases 1–4** + partial reruns |

**Residual math after Phase 1:** 30 + 12 = 42 harness wins where `bandOk` already passes (~11 coding/SD strong-or-weak-band + pathway succeeds). ~18 still failing: 6 pending + 4 feedback 504/500 + 3 QGEN + 4b strong + 1 RCA-4a (AN-429 does not block harness pass today).

---

## Out of scope (do not block 60/60)

- Rebalancing feedback scores into 55–75 band (scoring calibration — separate initiative)  
- PR #407 “unchanged” UX for behavioral sessions with real scores (already passing harness)  
- UI Playwright hot-path smoke (D in `FULL_PLAN.md`)  
- Linear ticket sync  

---

## Suggested PR order

1. `fix(scoring): G.10 + pathway eligibility for coding/system-design` (Phase 1) + flip `pathwayLoaderIntegration` test  
2. `fix(pathway): stale pending + poll alignment` (Phase 2, may include #407)  
3. `fix(feedback): Inngest or 300s timeout for generate-feedback 504` (Phase 3)  
4. `chore(qa): harness domain fixtures, QGEN retry, gates, report` (Phase 4)  
5. `chore(qa): analysis-start throttle for matrix` (Phase 5)  
6. `docs(qa): MATRIX_60_PLAN baseline update` (after Phase 6 run ID recorded)

## Go / no-go (post-validation)

| Phase | Go? | Blocker |
|-------|-----|---------|
| 1 | **Go** | None — RCA-1 confirmed |
| 2 | **Conditional** | Phase 0: 8 Inngest functions verified |
| 3 | **Go** (rewritten scope) | Must target 504/500, not lock-only |
| 4 | **Go** | Include RCA-QGEN + expanded RCA-4b |
| 5 | **Go** (rewritten scope) | RCA-AN-429 throttle, not poll cap only |
| 6 | **No-go** | Until Phases 1–5 deployed + partial matrix rerun |

---

## Quick lookup: failing cell → RCA

| `matrixKey` (baseline FAIL) | Primary RCA(s) | Phase(s) |
|-----------------------------|----------------|----------|
| `*/coding/*`, `*/system-design/*` (18 cells) | RCA-1 | 1 (+ 4a/4b for some) |
| `backend/technical/weak` | **RCA-2 + RCA-QGEN** | 2 + 4 |
| `sdet/behavioral/weak` | RCA-2 | 2 |
| `pm/case-study/strong` | RCA-2 | 2 |
| `design/behavioral/strong` | RCA-2 | 2 |
| `business/behavioral/weak` | RCA-2 | 2 |
| `business/technical/strong` | RCA-2 | 2 |
| `frontend/technical/strong` | RCA-3 | 3 |
| `data-science/technical/weak` | RCA-3 | 3 |
| `pm/behavioral/weak` | RCA-3 | 3 |
| `design/case-study/weak` | RCA-3 | 3 |
| `pm/case-study/weak` | **RCA-QGEN** | 4 |
| `design/technical/strong` | **RCA-QGEN** | 4 |
| `frontend/coding/weak` | RCA-1 + RCA-4a | 1, 4 |
| `sdet/coding/*`, `backend/coding/strong` | RCA-1 + RCA-4b | 1, 4 |
| `backend/system-design/strong`, `sdet/system-design/strong` | RCA-1 + RCA-4b | 1, 4 |
| `general/system-design/strong` | RCA-1 + RCA-4b (AN-429 report-only for harness) | 1, 4 |

---

## Validation record (dual-agent review)

**Validated:** 2026-05-22 against `qa-browser-full-1779893074279` (`telemetry.jsonl`, activities, CSV). Prompt: `VALIDATE_MATRIX_60_PLAN.prompt.md`.

| RCA | Verdict | Notes |
|-----|---------|-------|
| RCA-1 | **CONFIRMED** | G.10 + pathway gates; eval APIs correct |
| RCA-2 | **CONFIRMED** | `attempts: 0`; 8 Inngest fns; +5 not +6 if QGEN on same session |
| RCA-3 | **CONFIRMED** (mechanism revised) | 3×504 ~60s, 1×500 — not lock/202 |
| RCA-QGEN | **CONFIRMED** (new) | Replaces RCA-4c for pm/design/backend cells |
| RCA-4a | **CONFIRMED** | frontend/coding/weak avg 63 |
| RCA-4b | **CONFIRMED** (expanded) | Not SDET-only; includes backend coding + SD strong band |
| RCA-AN-429 | **CONFIRMED** (replaces RCA-5) | analysis-start 429, not slow pipeline |
| RCA-RPT | **CONFIRMED** (expanded) | Short-form 0 + legit low passes |

**Safe to start Phase 1:** Yes — flip `pathwayLoaderIntegration.test.ts` with the fix.  
**Phase 3 / 5 go:** Phase 3 targets 504/500; Phase 5 optional for harness 60/60.  
**Phase 6:** No-go until partial reruns after **Phases 1–4** (minimum).

### Round 3 — adjudication of validator agents (same baseline)

| Claim | Agent 1 | Agent 2 | Independent verdict |
|-------|---------|---------|---------------------|
| RCA-1 G.10 not eval API | CONFIRMED | CONFIRMED | **Agree** |
| RCA-3 = 504/500 not lock | CONFIRMED | CONFIRMED | **Agree** |
| RCA-4c → RCA-QGEN | REJECTED 4c | QGEN confirmed | **Agree** — telemetry proves 5xx |
| RCA-5 → RCA-AN-429 | REJECTED 5 | AN-429 confirmed | **Agree** — 429 on analysis-start |
| Phase 1 → 42 not 60 | implied | 42 (+12) | **Agree** — Agent 1 “+14–16” **overstates harness** wins |
| Analysis in harness pass? | (not stated) | Not in `entry.pass` | **Agent 2 correct** — verified `executeCell` |
| Plan ready | Needs revision | Sound | **Agent 2** for **post-revision** plan; Agent 1 reviewed **pre-revision** |

---

## Implementation record (2026-05-27)

**Baseline preserved:** `qa-browser-full-1779893074279` (30/60). **Code shipped** for Phases 0–5; **full matrix rerun** is operator-owned (prod credentials + Inngest).

| Phase | Status | Key changes |
|-------|--------|-------------|
| **0** | Done | Baseline artifacts verified; 8-function Inngest gate documented in `PATHWAY_P0_TRACE.md` |
| **1** | Done | `sessionScoringPolicy.ts`; interview-type G.10; `getPlannedQuestionCountForFeedback`; pathway enqueue/eligibility min=1 for coding/SD; `useInterview` sends completion shape on pre-gen feedback |
| **2** | Done | `pathwayGenerationStartedAt` at enqueue; harness pathway poll 240s + mid-poll `/api/learn/pathway/retry`; `interviewType` on pathway eligibility API |
| **3** | Done | `generate-feedback` `maxDuration=300` (RCA-3 504 headroom); feedback poll extended in harness |
| **4** | Done | Harness coding/SD gates; static Two Sum fixture; `generate-question` 5xx retry; report labels score `0` as withheld |
| **5** | Done | Analysis-start 429 sleep + single retry; skip with `reason: 429` |
| **6** | Pending rerun | Run full matrix after deploy; compare to checkpoints below |

**Verify (operator):**

```bash
npm run test:run -- modules/interview/__tests__/sessionScoringPolicy.test.ts modules/interview/__tests__/completionAdjustment.test.ts modules/learn/__tests__/pathwayLoaderIntegration.test.ts
# Full prod matrix (requires QA bootstrap URL + auth):
# node modules/qa/orchestrator/... or browser inject per QA_AGENT_V3.md
```

**Expected checkpoints after deploy + rerun:** Phase 1 ~42/60; Phases 1–2 ~47–50/60; +3 ~51–54/60; +4 ~57–60/60.

---

## References

- **Validation prompt (RCA/fix review):** `modules/qa/docs/VALIDATE_MATRIX_60_PLAN.prompt.md`  
- Investigation transcript: coding/SD root cause (G.10 vs eval APIs)  
- `modules/qa/output/qa-browser-full-1779893074279-sessions.csv`  
- `modules/qa/output/runs/qa-browser-full-1779893074279/activities/` — per-step evidence  
- `modules/qa/docs/PATHWAY_P0_TRACE.md` — historical RCA-2 Inngest sync  
- `modules/qa/docs/FINDINGS_AND_FIXES.md`  
- `modules/learn/__tests__/pathwayLoaderIntegration.test.ts` (update after Phase 1)  
- `modules/interview/config/interviewConfig.ts` — `getCodingQuestionCount`  
- Key code: `completionAdjustment.ts`, `generate-feedback/route.ts`, `pathwayUpdateEligibility.ts`, `pathwayRegeneration.ts`, `qa-matrix-runner.js`, `generate-qa-browser-report.mjs`

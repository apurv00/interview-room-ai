# QA Agent — Phase-wise Implementation Report

**Status:** All phases (Q0–Q5) implemented. **13 unit tests passing.** Dry-run confirms **60 full-matrix runs** (30 domain×depth × 2 personas).

**Isolation:** `modules/qa/` only — black-box HTTP. No imports from `@interview/*`, `@learn/*`, `@feedback/*`, `@resume/*`.

---

## Phase Q0 — Scaffold, matrix, auth, dry-run

| Item | Status | Location |
|------|--------|----------|
| 30 valid domain×depth pairs | ✅ | `modules/qa/config/matrix.ts` |
| Smoke subset (6 pairs) | ✅ | `SMOKE_CELLS` |
| CLI + dry-run | ✅ | `scripts/run-qa-agent.ts`, `parseArgs.ts` |
| Auth probe | ✅ | `verifyAuth()` in `httpClient.ts` |
| `@qa` path alias | ✅ | `tsconfig.json` |
| npm scripts | ✅ | `qa:matrix`, `qa:dry-run` |

**Verify:** `npm run qa:dry-run` → `Planned runs: 60`

---

## Phase Q1 — Interview + feedback (HTTP)

| Route | When | Per-question? |
|-------|------|---------------|
| `POST /api/interviews` | Session create | — |
| `PATCH /api/interviews/{id}` | Status + transcript + evals | Per Q loop |
| `POST /api/generate-question` | Each question | ✅ `questionIndex` logged |
| `POST /api/evaluate-answer` | Each question | ✅ full dimension capture |
| `POST /api/generate-feedback` | After interview | — |
| `GET /api/interviews/{id}` | Feedback poll (202 path) | — |

**Checks per question:**
- Question non-empty, not fallback template
- Domain/depth heuristics (banned copy, SWE terms in PM, etc.)
- Score band vs persona (strong 60–100, weak 0–55)
- Eval status not `failed`

**Personas:** `modules/qa/config/personas.ts` — scripted STAR answers (strong) vs vague answers (weak).

**Runner:** `interviewRunner.ts`, `feedbackRunner.ts`

---

## Phase Q2 — Multimodal analysis

| Route | When |
|-------|------|
| `POST /api/analysis/start` | After session completed |
| `GET /api/analysis/{sessionId}` | Poll until `completed` / `failed` |

**Synthetic data:** `liveTranscriptWords` built from candidate transcript (no mic/video).

**Checks:** status completed, fusion/timeline content, copy scan. **403** → warn (feature flag off) — stage may pass with skip semantics.

**Runner:** `analysisRunner.ts` — timeout `QA_ANALYSIS_TIMEOUT_MS` (default 180s).

**Requires:** `npm run dev:inngest` + `FEATURE_FLAG_MULTIMODAL_ANALYSIS=true` on target.

---

## Phase Q3 — Pathway

| Route | When |
|-------|------|
| `GET /api/interviews/{id}?excludeTranscript=true` | Poll `pathwayGenerationStatus` |
| `GET /api/learn/pathway?fromFeedback={sessionId}` | Fetch plan |

**Checks:** generation completed, plan body non-empty, practice tasks array.

**Runner:** `pathwayRunner.ts` — timeout `QA_PATHWAY_TIMEOUT_MS` (default 120s).

---

## Phase Q4 — Drill mode

| Route | When |
|-------|------|
| `GET /api/learn/drill/questions?limit=20` | List weak questions |
| `GET /api/learn/drill/context/question?sessionId=&questionIndex=` | Context for retry |
| `POST /api/learn/drill/evaluate` | SSE improved answer |

**Logic:** Weak persona expects ≥1 weak question for session; strong may skip. Improved answer via `pickImprovedDrillAnswer`.

**Runner:** `drillRunner.ts`

---

## Phase Q5 — Full matrix + reports

| Output | Contents |
|--------|----------|
| `{reportId}.json` | All runs, stages, routes, per-question evals, aggregates |
| `{reportId}.md` | Phase summary, route frequency, latency p50/p95, matrix-wide eval table, per-run detail |
| `{reportId}-evaluations.csv` | One row per question — dimensions, latencies, issues |

**Report builder:** `modules/qa/report/reportBuilder.ts`

**Orchestrator:** `orchestrator.ts` — stages chained per run; `concurrency` workers each get fresh `QaHttpClient` + route log.

---

## Full-mode scale estimate

| Setting | Value |
|---------|-------|
| Runs | 60 |
| Questions/run (default `--questions 5`) | 5 |
| LLM calls/run (approx) | 5×(gen+eval) + feedback + pathway + analysis + drill ≈ 15–25 |
| Total LLM calls (full, 5 Q) | ~900–1500 |
| Wall time (concurrency 2) | ~1–2 hours |

Use a **Pro/Enterprise** test account to avoid monthly interview limits.

---

## How to run and get the live report

```powershell
# Terminal 1
npm run dev

# Terminal 2
npm run dev:inngest

# Terminal 3 — copy cookie from browser DevTools after sign-in
$env:QA_BASE_URL = "http://localhost:3000"
$env:QA_SESSION_COOKIE = "next-auth.session-token=YOUR_TOKEN"

# Smoke first (12 runs)
npm run qa:matrix -- --smoke --questions 3 --concurrency 1

# Full matrix (60 runs)
npm run qa:matrix -- --full --questions 5 --concurrency 2 --output modules/qa/output
```

**Against production/staging:**

```powershell
$env:QA_BASE_URL = "https://www.interviewprep.guru"
$env:QA_SESSION_COOKIE = "next-auth.session-token=..."
npm run qa:matrix -- --smoke --questions 3
```

Reports land in `modules/qa/output/`. Open the `.md` for human review; use `.json` + `-evaluations.csv` for filtering in Excel/Sheets.

---

## What to change / upgrade (how to read results)

| Signal in report | Likely action |
|------------------|---------------|
| `[interview Qn] Question not fallback template` | Fix `generate-question` prompt or model slot for domain/depth |
| `[interview Qn] Avg dimension X in band Y` | Tune `evaluate-answer` scoring calibration for persona separation |
| `evaluate-answer slow (>8000ms)` | CMS model slot → faster model (Haiku) |
| `[feedback] overall_score` missing | `/api/generate-feedback` pipeline or idempotency lock |
| `Multimodal analysis 403` | Enable feature flags + env on target |
| `pathwayGenerationStatus failed` | Inngest pathway job / `regeneratePlansJob` |
| `Weak persona produced 0 drill questions` | Eval too lenient — weak answers not surfacing as weak |
| Route `errorCount` > 0 | Check status codes in JSON `allRoutes[].error` |
| Banned copy patterns | Prompt hygiene in feedback/pathway/analysis |

---

## Routes touched checklist (full mode)

- [x] `POST /api/interviews`
- [x] `PATCH /api/interviews/{id}`
- [x] `POST /api/generate-question` (×N)
- [x] `POST /api/evaluate-answer` (×N)
- [x] `POST /api/generate-feedback`
- [x] `GET /api/interviews/{id}`
- [x] `POST /api/analysis/start`
- [x] `GET /api/analysis/{sessionId}`
- [x] `GET /api/learn/pathway`
- [x] `GET /api/learn/drill/questions`
- [x] `GET /api/learn/drill/context/question`
- [x] `POST /api/learn/drill/evaluate`

---

## Verification completed this session

| Check | Result |
|-------|--------|
| `drillRunner.ts` syntax fix | ✅ |
| `npm run qa:dry-run` | ✅ 60 runs |
| `npm run test:run -- modules/qa/__tests__` | ✅ 13 tests |
| Live HTTP matrix | ⏸ Requires `QA_SESSION_COOKIE` (not in repo) |

---

## Next step for you

1. Export `QA_SESSION_COOKIE` from a signed-in browser session.
2. Run smoke locally, then full matrix.
3. Share `modules/qa/output/qa-full-*.md` for triage — or paste the **Upgrade recommendations** and **All per-question evaluations** sections here.

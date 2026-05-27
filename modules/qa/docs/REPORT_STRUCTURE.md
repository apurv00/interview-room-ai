# QA Matrix Report — Structure Guide

How to organize browser and Node harness output so **product bugs**, **harness artifacts**, and **noise** stay separated.

---

## Design principle

Every observation belongs in **one primary bucket**:

| Bucket | Question it answers | Example |
|--------|---------------------|---------|
| **P0 Ship blockers** | Would we delay a release? | Pathway never updates after interview |
| **P1 Product quality** | Feature works but hurts users | Eval scores all answers low on structure |
| **P2 Harness / test noise** | Artifact of how we tested | Strong persona canned paste → off-topic FAIL |
| **Out of scope** | Not covered by this run | Live TTS, avatar, probe UI follow-through |

If pathway is broken, it must appear in **§1 Ship blockers** — not buried in a 60-row session table.

---

## Recommended report outline

Use this order in Markdown (and mirror key columns in CSVs):

```
1. Metadata & scorecard        ← 30-second read
2. Ship blockers (P0)          ← manual + auto, with next steps
3. Findings register           ← all P0–P2 in one table
4. Pipeline scorecard          ← one row per stage (interview → drill)
5. Stage deep-dives            ← detail per pipeline step
6. Harness calibration         ← persona bands, canned answers (NOT product bugs)
7. Performance                 ← latency p50/p95
8. Appendices                  ← raw tables + CSV pointers
```

---

## Severity definitions

| Level | Label | Criteria |
|-------|-------|----------|
| **P0** | Ship blocker | Core user journey broken; confirmed in prod or 100% harness fail |
| **P1** | Product quality | Feature runs but output is wrong, misleading, or consistently poor |
| **P2** | Minor / harness | Test setup issue, heuristic warning, or inconclusive signal |
| **—** | Out of scope | Explicitly not exercised in this run |

---

## Pipeline stages (columns everywhere)

Use the same stage names in MD, `sessions.csv`, and the findings register:

| Stage | What ran | Pass criteria (product) |
|-------|----------|-------------------------|
| `interview` | generate-question + evaluate-answer × N | Questions contextual; eval dimensions sane for persona |
| `feedback` | generate-feedback | `overall_score` returned; prose actionable (if captured) |
| `analysis` | analysis/start + poll | status completed; timeline non-empty |
| `pathway` | poll status + GET pathway | `pathwayGenerationStatus` → succeeded; plan reflects session |
| `drill` | drill questions + SSE eval | weak Qs indexed; SSE completes for weak persona |

---

## Findings register (single source of truth)

Maintain one table — manual findings in `config/reportFindings.json`, auto findings computed at report time:

| ID | Sev | Stage | Finding | Evidence | Status |
|----|-----|-------|---------|----------|--------|
| P0-001 | P0 | pathway | Plan does not update | Manual UAT + 60/60 pending | confirmed-manual |
| AUTO-001 | P2 | interview | Strong persona below band | Canned off-topic answers | harness-artifact |

**Status values:** `confirmed-manual` | `confirmed-auto` | `suspected` | `resolved` | `wont-fix`

---

## CSV layout

### `*-sessions.csv` (1 row = 1 interview session)

Primary rollup. Sort/filter here first.

Key columns: `matrixKey`, `sessionId`, `harnessPass`, `sessionAvgDimensions`, `feedbackScore`, `analysisStatus`, `pathwayState`, `pathwayGenerationStatus` (when captured), `drillStatus`, `stageIssues`, `findingIds`

### `*-evaluations.csv` (1 row = 1 question)

Per-question eval drill-down. Link to session via `matrixKey`.

Key columns: dimensions, `qualityCriteria`, latencies, probe fields.

### Optional `*-findings.csv`

Export of the findings register for ticketing (Linear/Jira import).

---

## Scorecard (RAG)

Put this immediately after metadata:

| Stage | Status | Metric | Notes |
|-------|--------|--------|-------|
| Interview | 🟡 | 30/60 harness pass | Weak OK; strong fails due to harness paste |
| Feedback | 🟢 | 60/60 score returned | Scores low (2–24) — expected for weak/off-topic |
| Analysis | 🟢 | 60/60 completed | p50 ~9s |
| **Pathway** | **🔴** | **0/60 succeeded** | **P0-001 — confirmed manual** |
| Drill | 🟡 | 25/60 ran | 35 skipped by design |

---

## What goes where (common mistakes)

| Observation | Wrong section | Right section |
|-------------|---------------|---------------|
| Pathway stuck pending | “Session summary row 47” | **§1 Ship blockers** + pathway deep-dive |
| Strong persona 0/30 pass | “Eval is broken” | **§6 Harness calibration** — canned answers |
| Structure score <30 on 179/180 | P0 ship blocker | **§5 Interview deep-dive** — eval calibration P1 |
| No TTS tested | Missing | **§8 Methodology — out of scope** |

---

## Workflow

1. **Run matrix** → `npm run qa:v3:matrix:prod` (or mini-smoke / smoke profiles)
2. **Post-run agents** (automatic with `--report`): observe → infra → triage → MD
3. **Baseline diff** → `npm run qa:v3:diff -- <reportId>` vs `qa-browser-full-1779529900005`
4. **Linear tickets** → `npm run qa:v3:triage -- <reportId> --linear` (requires `LINEAR_API_KEY`)
5. **Re-run** after fix → triage auto-marks pathway P0 `resolved` when ≥95% succeeded

### v3 run directory (Phase 3.4)

```
modules/qa/output/runs/<reportId>/
  matrix-report.json
  triage-summary.json      ← merged findings + recommendations
  baseline-diff.json       ← metrics vs baseline
  findings.csv
  observations/
  infra-report.json
  linear-sync.json         ← when --linear
```

## Generator files

| File | Role |
|------|------|
| `scripts/generate-qa-browser-report.mjs` | MD + CSV from matrix JSON (reads triage/baseline if present) |
| `scripts/qa-v3-triage.mjs` | Merge all signals → triage-summary.json |
| `scripts/qa-v3-diff.mjs` | Baseline metrics comparison |
| `scripts/qa-v3-report.mjs` | MD + triage in one command |
| `modules/qa/agents/triage.mjs` | Triage merge logic |
| `modules/qa/agents/baselineDiff.mjs` | Diff engine |
| `modules/qa/agents/linearSync.mjs` | Linear P0/P1 sync |
| `modules/qa/config/reportFindings.json` | Manual P0/P1 findings |
| `modules/qa/config/linear.json.example` | Linear team config template |
| `modules/qa/docs/REPORT_STRUCTURE.md` | This guide |
| `modules/qa/docs/PATHWAY_P0_TRACE.md` | P0 pathway investigation — flow, Mongo/Inngest queries |

Node harness should follow the same outline via `reportBuilder.ts` when wired to browser JSON.

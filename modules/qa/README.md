# QA Agent — Interview Matrix Harness

External **black-box** simulation agent. Calls public HTTP APIs only.

**Does not modify** interview, feedback, multimodal analysis, pathway, or drill product code.

## Phases

| Phase | Scope |
|-------|--------|
| Q0 | Matrix builder, auth probe, dry-run |
| Q1 | Interview loop (`generate-question`, `evaluate-answer`) + feedback |
| Q2 | Multimodal `analysis/start` + poll |
| Q3 | Pathway poll (`/api/learn/pathway?fromFeedback=`) |
| Q4 | Drill list, context, evaluate SSE |
| Q5 | Full matrix orchestration + JSON/Markdown reports |

## Setup (browser session — recommended)

Uses your **already logged-in Cursor browser** on production. No Playwright. No cookie export.

**Option A — after deploy / local dev** (static runner page):

```
https://www.interviewprep.guru/qa-matrix-runner.html#mode=full&questions=3&autostart=1
```

**Option B — inject on production today** (no deploy):

```bash
node scripts/build-qa-browser-runner.mjs
node scripts/build-qa-inject.mjs --full --questions 3
# Agent navigates Cursor browser to the URL in modules/qa/browser/.inject-url.txt
```

The runner uses `fetch(..., { credentials: 'include' })` — same session as the tab.

## Setup (CLI + cookie — optional)

1. Sign in in any browser.
2. DevTools → Application → Cookies → copy `__Secure-next-auth.session-token`.
3. `export QA_SESSION_COOKIE="__Secure-next-auth.session-token=..."`

## Commands

```bash
# Dry-run — print 60 planned runs (full) or 12 (smoke)
npm run qa:matrix -- --dry-run --full

# Smoke — 6 domain×depth pairs × 2 personas = 12 runs
npm run qa:matrix -- --smoke --questions 3

# Single cell
npm run qa:matrix -- --mode single --domain pm --depth behavioral --persona weak

# Full matrix — 30 pairs × 2 = 60 runs
npm run qa:matrix -- --full --questions 5 --concurrency 2 --output modules/qa/output
```

## Reports

Written to `modules/qa/output/`:

- `{reportId}.json` — machine-readable, every route call, per-question eval
- `{reportId}.md` — phase summary, route frequency + latency p50/p95, matrix-wide eval table, per-run detail
- `{reportId}-evaluations.csv` — one row per question (dimensions, latencies, issues) for Excel/Sheets

See `modules/qa/docs/PHASE_REPORT.md` for the full phase-wise implementation report.

## Routes touched (full mode)

- `POST /api/interviews`
- `PATCH /api/interviews/{id}`
- `POST /api/generate-question` (per question)
- `POST /api/evaluate-answer` (per question)
- `POST /api/generate-feedback`
- `GET /api/interviews/{id}`
- `POST /api/analysis/start`
- `GET /api/analysis/{sessionId}`
- `GET /api/learn/pathway`
- `GET /api/learn/drill/questions`
- `GET /api/learn/drill/context/question`
- `POST /api/learn/drill/evaluate` (SSE)

## Isolation

This module must **never** import `@interview/*`, `@learn/*`, `@feedback/*`, or `@resume/*` services.

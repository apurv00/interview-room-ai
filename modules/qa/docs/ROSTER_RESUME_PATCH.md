# Roster resume + generate-problem patch

Apply these edits to fold **role-matched resumes** and **coding/system-design
generator observation** into the QA matrix, so the next run measures the new
role+resume personalization (PR #446) instead of the automation user's default
profile, and 429s are gone via the rate-limit exemption (PR #447, set
`QA_AUTOMATION_ENABLED=true` + `QA_AUTOMATION_EMAIL`).

Data lives in `modules/qa/orchestrator/rosterResumes.mjs` (25 role resumes,
slugs validated against `ROSTER_DOMAINS`). All edits are additive; rebuild the
injected runner at the end.

---

## Edit 1 — bake `ROSTER_RESUMES` into the runner

`modules/qa/runner/bakeRosterIntoRunner.mjs`

```diff
- import { ROSTER_DOMAINS, ROSTER_DEPTHS, SMOKE_CELLS } from '../orchestrator/rosterMatrixData.mjs'
+ import { ROSTER_DOMAINS, ROSTER_DEPTHS, SMOKE_CELLS } from '../orchestrator/rosterMatrixData.mjs'
+ import { ROSTER_RESUMES } from '../orchestrator/rosterResumes.mjs'
```

…and inside the baked `// __QA_ROSTER_START__ … __QA_ROSTER_END__` block, add one line:

```diff
  const ROSTER_DOMAINS = ${JSON.stringify(ROSTER_DOMAINS)}
  const ROSTER_DEPTHS = ${JSON.stringify(ROSTER_DEPTHS)}
  const SMOKE = ${JSON.stringify(SMOKE_CELLS)}
+ const ROSTER_RESUMES = ${JSON.stringify(ROSTER_RESUMES)}
```

After this, `ROSTER_RESUMES` is in scope everywhere in `qa-matrix-runner.js`.

---

## Edit 2 — attach a role-matched resume to every cell's config

`modules/qa/browser/qa-matrix-runner.js` — at EACH `const config = { role: domain, … }`
build (there are three: `runInterview`, `runCodingInterview`, `runDesignInterview`):

```diff
- const config = { role: domain, interviewType: depth, experience: '3-6', duration: DURATION, privacyMode: true }
+ const config = { role: domain, interviewType: depth, experience: '3-6', duration: DURATION, privacyMode: true, resumeText: ROSTER_RESUMES[domain] || '' }
```

This flows the resume to `POST /api/interviews` (persisted on the session) and to
`/api/generate-question` (which reads `config.resumeText`) — so behavioral /
technical / case-study cells now personalize to the role.

---

## Edit 3 — exercise the coding & system-design generators (observation only)

The coding/design cells eval against deterministic fixtures (Two Sum,
URL-Shortener) to keep scoring stable — **do not** swap those. Instead add a
side observation call so each generated problem lands in the report for the
quality audit, without touching the eval path.

`runCodingInterview` — right after the `patch-start` PATCH, before the
`HARNESS_TWO_SUM` fixture:

```js
    // Observe the role+resume-aware coding generator (quality signal only —
    // eval still uses the deterministic fixture below, RCA-4b).
    await api('POST', '/api/code/generate-problem', {
      domain, experience: '3-6', solvedProblemIds: [],
      resumeText: ROSTER_RESUMES[domain] || '',
    }, {
      stage: 'interview', step: 'generate-problem-observe',
      meta: (r) => ({
        ok: r.ok, status: r.status,
        title: r.ok ? (r.data?.problem?.title || '') : '',
        tags: r.ok ? (r.data?.problem?.tags || []) : [],
      }),
    })
```

`runDesignInterview` — right after its `patch-start` PATCH, before the
`'Design a URL Shortener'` fixture:

```js
    // Observe the role+resume-aware system-design generator (quality signal only).
    await api('POST', '/api/design/generate-problem', {
      domain, experience: '3-6', solvedProblemIds: [],
      resumeText: ROSTER_RESUMES[domain] || '',
    }, {
      stage: 'interview', step: 'generate-problem-observe',
      meta: (r) => ({
        ok: r.ok, status: r.status,
        title: r.ok ? (r.data?.problem?.title || '') : '',
        components: r.ok ? (r.data?.problem?.expectedComponents || []) : [],
      }),
    })
```

---

## Edit 4 — retry generate-feedback on 5xx (resilience under matrix concurrency)

`modules/qa/browser/qa-matrix-runner.js` — right after the `generate-feedback`
`api()` call (before `const sideEffectOutcomes = ...`):

```js
    // Retry once on a 5xx — under the matrix's concurrency a few Vercel function
    // instances crash on the heavy ~22s feedback call (instance-level, not a handled
    // error); the retry lands on a healthy instance. Mirrors the generate-question
    // 5xx retry. Real users issue one feedback call and never create this concurrency.
    if (!fb.ok && (fb.status >= 500 || fb.status === 0)) {
      await sleep(3000)
      fb = await api('POST', '/api/generate-feedback', body, {
        stage: 'feedback', step: 'generate-feedback-retry',
        meta: (r) => ({
          pathwayPlanStatus: r.data?.sideEffectOutcomes?.find((o) => o.name === 'pathwayPlan')?.status ?? null,
          overallScore: r.data?.overall_score ?? null,
        }),
      })
    }
```

> NOTE: Edits 1–4 are already APPLIED in this working tree and baked into
> `inject-chunk-*.txt`. This doc is the record to fold into the roster-refactor
> commit. The feedback 500s are a *synthetic-load artifact* (real users send one
> feedback call); the matching product hardening is separate — bump the
> generate-feedback function memory in `vercel.json` (Pro plan) or move feedback
> to a background Inngest job (the pattern analysis already uses).

## Edit 5 — rebuild the injected runner

```bash
npm run qa:build:browser   # regenerates inject-chunk-*.txt + inject-manifest.json
```

---

## What to check after the next run

- **No 429s** in `*-telemetry.csv` / activity JSON (confirms the exemption works).
- **`generate-problem-observe` activities** carry role-appropriate titles:
  - `data-analyst` / `ml-engineer` coding → pandas/ML tasks, NOT "Two Sum".
  - `ml-engineer` system-design → an ML system; `data-analyst` → a data platform;
    not "Design a URL Shortener".
- **Behavioral / case-study questions** reflect the role's resume (e.g. mechanical
  cells reference thermal/FEA work), not the PM/media default — re-run the
  quality audit on `matrix-report.json` to confirm Defect-1-style skew is gone.

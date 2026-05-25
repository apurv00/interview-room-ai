# Overnight QA Matrix Run — Checklist

> **Use v3 Playwright runner** — see `modules/qa/docs/PLAYWRIGHT_RUN.md`  
> v2 inject bookmarklets deprecated for full runs.

## Pre-flight (before starting harness)

```bash
npm run qa:build:browser   # after editing qa-matrix-runner.js
npm run qa:preflight:prod  # harness v2 + manifest freshness
```

- [ ] Production Inngest shows **8 functions** including `pathway-regenerate`
- [ ] Harness **v2** inject chunks built (`inject-manifest.json` harnessVersion = 2.0.0)
- [ ] Logged into https://www.interviewprep.guru (QA account with quota)
- [ ] Browser tab dedicated (title poll: `QA_MATRIX_RUNNING` → `QA_MATRIX_DONE`)
- [ ] Estimated runtime: **~3–4 hours** for full 60 runs (3 Q × API chains × downstream polls)

## Start run

1. Run bookmarklets **in order** from `modules/qa/browser/inject-manifest.json` `urls` (chunks 0–3, then loader)
   - Or paste each line from `inject-chunk-0.txt` … `inject-chunk-3.txt`, then loader URL
2. Hash auto-set: `#mode=full&questions=3&autostart=1`
3. Optional: `node scripts/poll-qa-browser.mjs --interval 120 --timeout 14400` for progress logging

> **Note:** `bootstrap-url.txt` loads runner from GitHub CDN (v1 until merged). Use inject chunks for v2 tonight.

## After completion

1. Copy JSON from `#qa-result` pre block or `localStorage.qa_matrix_report`
2. Save to `modules/qa/output/qa-browser-full-<timestamp>.json`
3. Generate report:
   ```bash
   npm run qa:report:browser -- modules/qa/output/qa-browser-full-<timestamp>.json
   ```
4. Triage findings register (P0 first)

## Harness v2 improvements (vs last run)

| Improvement | Detects |
|-------------|---------|
| Pathway poll `succeeded`/`failed`/`skipped` | Real pathway completion vs infinite pending |
| Capture `pathwayGenerationStatus` in JSON | Distinguish infra vs UI bugs |
| Strong persona without off-topic hook | Real eval separation (strong vs weak) |
| Capture `sideEffectOutcomes.pathwayPlan` | Enqueue failures at feedback time |

## Success criteria for tonight

| Stage | Target |
|-------|--------|
| pathway | ≥ 95% `pathwayGenerationStatus: succeeded` within poll window |
| analysis | 60/60 completed |
| feedback | 60/60 overall_score |
| interview (weak) | ≥ 80% band pass |
| interview (strong) | ≥ 50% band pass (after harness fix) |
| P0 auto-findings | 0 |

## If pathway fails again

1. Inngest Cloud → Events → `pathway/regenerate` — events without runs?
2. Mongo → `pathwayGenerationStatus`, `pathwayGenerationStartedAt`
3. `npm run replay:pathway -- --dry-run` then replay with prod event key

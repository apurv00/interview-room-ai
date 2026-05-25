# QA Matrix — Findings Deep-Dive & Fix Map

Report: `qa-browser-full-1779529900005` (60 runs, production, 2026-05-23)

---

## Executive summary

| Stage | Report signal | Root cause | Fix status |
|-------|---------------|------------|--------------|
| **interview (strong)** | 0/30 harness pass | Harness pastes off-topic canned answers with `"Regarding …"` hook | **Harness fix shipped (v2)** |
| **pathway** | 60/60 pending (P0) | Inngest Cloud missing `pathway-regenerate` (6/8 functions synced) | **Fixed ops** — sync + replay 59 sessions |
| **interview (eval)** | 179/180 structure < 30 | Likely real + harness artifact; needs on-topic sample | **Investigate P1** — after harness fix |
| **feedback** | 60/60 scores 2–24 | Expected for weak/off-topic scripted answers | No product fix |
| **analysis** | 60/60 completed | Working | None |
| **drill** | 25/60 ran | By design (strong skipped, weak needs indexed Qs) | Optional harness tweak |

---

## P0 — Pathway (RESOLVED — ops + prevention)

### What the report showed
- View-model `state: pending` on all 60 sessions after 120s poll
- Manual UAT: “Your pathway update is catching up” forever
- Feedback + analysis both green

### Root cause (confirmed)
1. `generate-feedback` enqueued `pathway/regenerate` and set `pathwayGenerationStatus: pending`
2. Inngest Cloud had **6 functions**, missing **`pathway-regenerate`**
3. Events accepted; **no worker ever ran** → `attempts: 0`, `startedAt: null`
4. Analysis worked because `analysis/requested` **was** registered

### Fixes applied
| Fix | Type | Status |
|-----|------|--------|
| Re-sync Inngest Cloud app (6 → 8 functions) | Ops | Done |
| Bulk replay 59 stuck sessions | Ops | Done (59/59 sent) |
| `scripts/replay-pathway-regenerate.mjs` | Tooling | Done |

### Product hardening still recommended (P1, not blocking tonight)
| Fix | File | Why |
|-----|------|-----|
| Stale `pending`/`running` > 10min → `failed` + retry UI | `pathwayJob` or cron | Prevents silent orphan if sync breaks again |
| Retry route accepts stale `pending` | `app/api/learn/pathway/retry/route.ts` | Recovery without replay script |
| Post-deploy check: 8 functions in Inngest | Runbook / CI | Catch sync drift |

---

## P2 — Harness artifact: strong persona 0/30 (AUTO-HAR-001)

### What the report showed
- Weak: 30/30 pass (avg ≤ 55 band)
- Strong: 0/30 pass (expected avg ≥ 60)

### Root cause
Harness builds answers as:
```javascript
const answer = (question.length > 80 ? `Regarding "${question.slice(0,80)}...", ` : '') + base
```
The **same generic `base`** (Acme/Kafka paste) is used for every question. Eval correctly scores **low relevance/structure** because the answer doesn't address the actual question.

### Fix (tonight's harness v2)
- **Strong persona:** drop `"Regarding …"` prefix; use depth-specific STAR answers without hook
- **Weak persona:** keep short vague answers
- Optional: per-domain answer variants (phase 2)

**Do not file eval bugs until strong persona uses on-topic answers.**

---

## P1 — Structure dimension cluster (AUTO-EVL-001, suspected)

### What the report showed
- 179/180 eval rows: `structure < 30`

### Likely contributors
1. **Harness artifact** — off-topic strong answers score low on all dims (especially structure)
2. **Possible real calibration** — evaluate-answer prompt may compress structure scores

### Fix path
1. Re-run matrix after harness v2 with on-topic strong answers
2. If structure still < 30 on clearly STAR-formatted answers → prompt tuning in `evaluate-answer`
3. Human-rate 5 sample answers before changing production prompts

---

## Harness bugs (inflated pathway P0 signal)

### Bug: pathway poll typo
```javascript
// WRONG (current)
if (st === 'completed' || st === 'failed' || st === undefined) break

// CORRECT
if (st === 'succeeded' || st === 'failed' || st === 'skipped' || st === undefined) break
```
Terminal DB value is **`succeeded`**, not `completed`. Poll waited full 120s then read view-model while still pending.

### Bug: missing fields in JSON output
Report should capture per session:
- `pathwayGenerationStatus` (from InterviewSession)
- `sideEffectOutcomes.pathwayPlan` (from generate-feedback response)
- `pathway.viewModelState` vs `pathway.planGeneratedFromSessionId`

---

## Out of scope (this run)

Not exercised by browser matrix — do **not** infer pass/fail:
- Live TTS / Deepgram STT / avatar / coaching nudges
- Probe follow-through in UI
- Timer truncation / interrupt behavior
- Real browser media / multimodal facial coaching

---

## Ticket backlog (priority order)

| Priority | ID | Action | Owner |
|----------|-----|--------|-------|
| Done | P0-001 | Inngest sync + replay | Ops |
| Tonight | HAR-001 | Harness v2 (pathway poll + strong answers) | **Done** — `qa-matrix-runner.js` v2.0.0 |
| This week | EVL-001 | Eval structure calibration study | Product |
| This week | PWY-002 | Stale pending recovery + retry route | Eng |
| This week | OPS-001 | Post-deploy Inngest function count check | Eng |

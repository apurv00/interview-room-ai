# Readiness Wave — Spec of Record (v2)

Status: v2 for founder review (2026-07-15). v1 was adversarially reviewed
(3-lens panel: 29 findings — 7 blockers / 14 majors / 8 minors — ALL
folded in; the material ones tagged `[R#]`). Companion to PRODUCT_FLOW.md
and DECISIONS.md; implements "per-answer→must-have attribution" +
"readiness-aware feed re-ranking" as ONE sequenced wave (ruling #8 makes
attribution the precondition; the time_up taper exemption already shipped).

## 0. What readiness is (and is not)

A **confidence-banded statement about the user's own preparation for a
specific job** (ruling #3): how much of the job's must-have surface their
scored practice has addressed, and how well. NEVER a prediction about the
employer; never a percentage; never a gate ("Not ready" is banned; Apply
is never disabled). Zero evidence = zero claims. Copy uses the verb
**"practiced against"** — never "covered": covering is a competence claim
the evidence cannot carry [R0].

## 1. PR-R1 — Attribution (the data layer, ships dark)

**Emit site** [R14][R19]: the generate-feedback rail fires for every
scored session; jobs-attribution resolves inside `recordPracticeEvidence`
— which is therefore where `jobs/evidence.attribute` is emitted, only on
`recorded: true`, carrying the resolved `{sessionId, applicationId,
jobPostingId}` it already holds. A low-frequency reconciliation sweep
(verdict-sweeper pattern) catches missed emits: jobs-attributed scored
sessions with no evidence rows.

**Worker** (`jobsEvidenceAttributionJob`) — three steps so retries never
re-bill the LLM [R25]: `load-inputs` → `llm-attribute` → `persist`.

- *load-inputs*: the session's Q&A + per-answer evaluations. There is no
  persisted per-answer scalar: **answerScore = round(mean of the 4
  universal dims), recomputed here**; `failed`/`truncated` evaluations are
  EXCLUDED from attribution entirely [R13]. Missing/empty evaluations →
  throw (Inngest backoff covers the persist race), bounded retries, logged
  terminal drop.
- *JD-version binding* [R23]: hash the SESSION's own `jobDescription`
  (`xrayHashOf` — the same value the repo already stores as `jdHash`;
  never `bodyHashOf` [R16]). If it equals the posting's `parsedJDHash`,
  attribute against the cached parse; else parse the session's own JD copy
  (one bounded extra call) — **never attribute across JD versions**.
- *Parse stability* [R11]: the X-ray parse cache becomes first-write-wins
  per hash (`updateOne({_id, parsedJDHash: {$ne: hash}}, ...)`) so a
  same-hash re-parse can never replace the requirement ids evidence binds
  to.
- *llm-attribute*: task slot `jobs.evidence-attribution` = `{model:
  gpt-5.6-luna, maxTokens: 1400, reasoningEffort: 'low'}` [R15][R25] —
  sized for the 30-answer worst case, G.3 truncation pattern (one in-step
  retry at bumped budget), deploy-gate: verify no CMS ModelConfig row
  overrides the slot (the #487 lesson). Output per answered question:
  requirement ids evidenced + strength from the closed enum
  `strong | partial | none`. **Strength = depth of evidence; quality
  lives in answerScore — and a row only counts at all when answerScore
  ≥ 40** (the row-level quality floor [R0]). Zod-validated; parse-fail →
  no write, never fabricated.
- *persist* [R12][R24][R26]: evidence is its OWN collection —

```
JobPracticeEvidence {
  userId, applicationId, jobPostingId, sessionId,
  requirementId, xrayHash, strength: 'strong'|'partial',
  answerScore, scoringEpoch, at
}
unique index { sessionId, requirementId, xrayHash }   // real, DB-level
```

  (ServedProblem precedent — array subdocs cannot carry unique indexes.)
  GDPR: cascade + export + completeness-test entries, AND the per-session
  delete path removes the session's evidence rows [R26]. After persist,
  the worker recomputes and **denormalizes a readiness snapshot onto
  JobApplication**: `readiness: {band, sessions, practicedCount,
  mustHaveTotal, quality, strongCoverage, xrayHash, scoringEpoch, at}`
  [R22] — every consumer reads the snapshot; nothing recomputes bands
  per-request. `quality` and `strongCoverage` are IN the snapshot (Codex
  #537): the blocked-state copy ("quality below the bar") and the
  segmented dashboard read them, and without them consumers would be
  forced into per-request recomputation or coverage-only mis-explanations.

**Calibration gate before anything renders** [R10]: a ~30-item golden set
(hand-labeled (answer, requirement) → strength triples from the founder's
own prod sessions) with an agreement floor; re-run on any slot model
change. PR-R2 does not ship until it passes.

**Cost**: one bounded call per scored jobs session (+ at most one JD
parse on version mismatch); never per-user×job. Module budgets: PR-R1
adds a `modules/jobs` budget row + ADR, and the new shared model file
bumps shared maxFiles with the paired ADR [R27].

## 2. PR-R2 — Bands (deterministic, computed at evidence-write time)

`computeReadiness(evidenceRows, currentParse)` — pure, zero LLM:

- Rows counted only when: `xrayHash` = the posting's current
  `parsedJDHash` [R2], `answerScore ≥ 40` [R0], `scoringEpoch` = current
  [R8], and `requirementId ∈ current parse's MUST-HAVE id set` — the
  numerator's universe must equal the denominator's (Codex #537): a
  nice-to-have id inflating practicedCount against a must-have total is a
  silent over-claim. Belt at persist too: the worker rejects any returned
  id outside the must-have set it was given (intersection, never raw
  distinct count [R11]).
- `practicedCount` = distinct counted requirement ids;
  `mustHaveTotal` = current parse's must-have count.
- `quality` = mean over practiced requirements of (best row per
  requirement: strengthWeight × answerScore), strong = 1.0, partial = 0.5
  — **strength MULTIPLIES; the all-partial-72 case scores 36, not 72**
  [R1], and repeat-covered requirements never multi-count [R28]. Test
  vectors for both pinned in the pure-function suite.
- **Bands** (names/criteria = founder approval item; "ready" vocabulary
  banned outright [R3]):
  - *No band* — zero counted evidence. No claims.
  - **Building evidence** — anything below Practiced. Copy: sub-3 sessions
    → "Building evidence (n/3)"; ≥3 sessions but blocked → the ACTUAL
    blocker: "Building evidence — 5 sessions, 2 of 8 must-haves
    practiced" (the /3 form is dropped once n ≥ 3) [R6][R28].
  - **Practiced** — sessions ≥ 3 AND practicedCount/mustHaveTotal ≥ 40%
    AND quality ≥ 50 [R0].
  - **Strong evidence** — sessions ≥ 3 AND coverage ≥ 70% AND quality ≥ 70
    AND strong-strength coverage ≥ 40% of must-haves [R1].
  - *Small-N guard* [R4]: when `mustHaveTotal < 4`, the coverage prong is
    unreliable — bands cap at Practiced and copy names the fact ("this
    posting lists only 2 must-haves").
- **Staleness is explained, never silent** [R2]: when the posting's JD
  re-parses to a different hash, the snapshot degrades with an explicit
  annotation — "This posting was updated on {date}; your 3 earlier
  sessions practiced its previous requirements" — plus optional lazy
  re-attribution of stale sessions on next detail view (bounded,
  visit-triggered). Same pattern for scoring-epoch changes [R8]:
  "sessions from a previous scoring version".
- Surfaces: detail prep panel + tracker chip, reading the SNAPSHOT.
  Closed/purged postings keep their last snapshot (frozen, annotated)
  [R17]. **Pre-render gate**: reconcile the launch verdict-chip vocabulary
  ("You're interview-ready in {domain}") with band vocabulary — suppress
  or reword the domain chip where a band renders; cross-references by rule
  COPY, not number [R3][R18].
- **Telemetry from day one, segmented fresher vs professional** (ruling
  #12) [R7]: band + quality distributions per segment on the dashboard;
  the universal-threshold question (does quality ≥ 70 make the top band a
  professional-only badge for a 54%-fresher base?) is explicitly in the
  founder-approval scope.

## 3. PR-R3 — Feed re-ranking (the consumer)

- **Pool**: the feed's bounded candidate pull UNIONS the user's open
  tracker-row postings [R21] — a practiced job is usually NOT in the
  400-doc pool, and the flagship loop ("practicing re-ranks this job")
  must not silently no-op. Bounded by tracker size (≤ tens).
- **Join**: one projected query on JobApplication
  `{jobPostingId, readiness}` [R22]; staleness detected by comparing
  `readiness.xrayHash` to the pool docs' `parsedJDHash` (added to the
  feed's select) — stale bands get NO boost until the next evidence write.
- **Boost**: scales by band (Building < Practiced < Strong evidence)
  [R9]; eligibility requires ≥1 completed (non-early-quit, via endReason)
  session [R9]. **The cap is an ORDERING INVARIANT, not a constant** [R20]:
  the boost may reorder jobs whose base scores differ by less than X, and
  may NEVER flip an ordering separated by ≥ X, where X sits below the
  smallest load-bearing ranking signal. A worked ordering table goes in
  the PR for founder approval, and a property test over the score
  functions pins the invariant.
- **Chip honesty** [R5]: the chip carries the machine fact — "You've
  practiced 3× for this role" — with NO movement arrow by default. The
  "↑" renders only when rank(with boost) ≠ rank(without), computed in the
  same render over the same pool BEFORE pagination, and both positions
  fall on the currently viewed page. Churn can never dress itself as a
  practice reward.
- Switches: none needed — R3 consumes data that exists or doesn't; if a
  kill-switch is wanted it rides an EXISTING config singleton row, no new
  shared model [R27].

## 4. Sequencing & founder-approval scope

1. **PR-R0 (this doc)** — approve: band names + criteria + thresholds
   (incl. the fresher-segment question), the boost ordering-invariant X,
   the small-N guard, the new task slot.
2. **PR-R1** attribution (dark) → prod verification on the founder's own
   sessions → **calibration golden-set gate**.
3. **PR-R2** bands + surfaces (visible, no rank change) + segment
   telemetry + chip-vocabulary reconciliation.
4. **PR-R3** re-ranking + fact chips.

## 5. Explicitly out of scope

Verdict-chip band-rule activation (own decision after R2); readiness
history (Pro, ruling #13); embeddings (ruling #16 rejection stands);
generation-time FOCUS targeting (hot-path); cross-job evidence transfer
(claims-honesty minefield, deliberately deferred).

## 6. Standing-rule compliance

#2 zero hot-path edits (post-hoc worker; emit lives in an existing jobs
service) ✓ · #3 bands never percentages, no "ready" vocabulary, sub-band
counters honest at every state ✓ · #4 chips = machine facts, movement
claims only when same-page-verifiable ✓ · #5 one bounded call per scored
session + snapshot denormalization keeps serving reads O(1) ✓ · #6 new
collection fully cascaded/exported/completeness-tested + per-session
delete ✓ · #8 preconditions: (a) shipped, (b) = this wave ✓ · #12
segmented telemetry from day one ✓ · #15/#16 no env flags; enum-bound LLM
output; no free text persisted ✓

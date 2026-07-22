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

**Trust boundary:** the signed handoff authenticates which user intentionally
started practice for which job/JD; it is not an anti-cheat attestation. The
self-practice API still trusts candidate-submitted answers/evaluations within
the authenticated session. Readiness therefore remains coaching evidence, not
an employer-verifiable credential or proof that an answer was spoken live.

**Outcome-label boundary (A14.1):** owner-authored tracker reports
(`advanced | waiting | rejected | offer`, plus a non-result Skip/defer) are
factual calibration labels. They are never scored practice evidence, never an
input to a readiness band, and never permission to infer competence, employer
odds, or transfer across jobs. Revising the latest report while its application
remains in the outcome lifecycle corrects the label; the same label becomes
read-only history after a loose transition back to a pre-interview status. A
revision never creates evidence or retroactively changes preparation history.

**CMS availability is part of the Practice authorization boundary.** If the
active role catalog cannot be loaded authoritatively, Jobs intentionally
withholds the role and disables new job-specific Practice site-wide—even for a
posting with a declared domain or cached X-ray. Seed roles are availability
fallbacks, never authorization. The detail page keeps existing non-Practice
history and shows retry/general-setup recovery. Operations must alert on catalog
load failure, verify the CMS/DB path and current catalog revision, and restore
that authority; do not bypass the outage with seed or stale inferred roles.

## 1. PR-R1 — Attribution (the data layer, ships dark)

**Emit site** [R14][R19]: the generate-feedback rail fires for every
scored session; jobs-attribution resolves inside `recordPracticeEvidence`
— which is therefore where `jobs/evidence.attribute` is emitted, only on
`recorded: true`, carrying the canonical `{sessionId, applicationId,
jobPostingId}` it already holds. The producer uses a stable per-session event
id and the worker repeats that key as function idempotency. Generate-feedback
awaits the feedback commit and the evidence attach/enqueue attempt before
returning, so a serverless post-response freeze cannot defer the visible
ticker until the sweep. Failures remain non-fatal to feedback and are repaired
by reconciliation. Those transport
guards are bounded; `attribution.evidenceProcessedAt` is the durable early-exit
that prevents a later duplicate from re-billing the model. A low-frequency
reconciliation sweep (verdict-sweeper pattern) keyset-pages beyond poison rows,
repairs the application row and stale session attribution, and re-emits every
server-verified `completed` session with persisted feedback and the real
type-aware scorable minimum (standard ≥3; coding/system-design ≥1). Completed
but ineligible rows are terminally stamped so they cannot starve later work.
Evidence-row existence is not treated as completion: an unordered bulk insert
may have landed only a subset, so only `evidenceProcessedAt` closes the loop.

**Worker** (`jobsEvidenceAttributionJob`) — three steps so retries never
re-bill the LLM [R25]: `load-inputs` → `llm-attribute` → `persist`.

- *load-inputs*: the session's Q&A + per-answer evaluations. There is no
  persisted per-answer scalar: **answerScore = round(mean of the 4
  universal dims), recomputed here**; `failed`/`truncated` evaluations are
  EXCLUDED from attribution entirely [R13]. Missing/empty evaluations →
  throw (Inngest backoff covers the persist race), bounded retries, logged
  terminal drop.
- *Handoff/JD-version binding* [R23]: session attribution first carries a
  server-verified normalized SHA-256 `jdHash`; legacy/unverified rows cannot
  enter the evidence rail. The worker separately hashes the SESSION's own
  `jobDescription` with `xrayHashOf` for the existing parse-cache/readiness
  identity. If it equals the posting's `parsedJDHash`,
  attribute against the cached parse; else the run is a counted skip
  (`jd-version-mismatch`) — **never attribute across JD versions**, and
  v1 never makes a second parse call (parsing the session's own JD copy
  is a deferred v1.1 option, shipped behavior wins over this spec's
  earlier draft). Mismatch skips stay RETRYABLE within the sweep window
  (Codex #538 r4): the posting cache may simply be stale — a session
  practiced against the updated JD aligns once `/xray` reparses.
- *Parse stability* [R11]: the X-ray parse cache becomes first-write-wins
  per hash (`updateOne({_id, parsedJDHash: {$ne: hash}}, ...)`) so a
  same-hash re-parse can never replace the requirement ids evidence binds
  to.
- *llm-attribute*: task slot `jobs.evidence-attribution` = `{model:
  gpt-5.6-luna, maxTokens: 1400, reasoningEffort: 'low'}` [R15][R25] —
  originally sized around an invalid 30-answer assumption; the interview
  contract permits indices through 500. G.3 truncation pattern (one in-step
  retry at the active CMS slot's bumped budget), deploy-gate: verify no CMS ModelConfig row
  overrides the slot (the #487 lesson). Output per answered question:
  requirement ids evidenced + strength from the closed enum
  `strong | partial | none`. **Strength = depth of evidence; quality
  lives in answerScore — and a row only counts at all when answerScore
  ≥ 40** (the row-level quality floor [R0]). Zod-validated; parse-fail →
  no write, never fabricated. Until deterministic chunking lands, v1 rejects
  more than 40 answers before model egress instead of billing for an output
  its response schema cannot represent. The session is stamped with both the
  processed time and `evidenceUnsupportedContract: evidence-attribution.v1`,
  preventing daily reconcile churn while giving the chunking migration an
  exact replay query.
- *persist* [R12][R24][R26]: evidence is its OWN collection —

```
JobPracticeEvidence {
  userId, applicationId, jobPostingId, sessionId,
  handoffVersion: 1, handoffJdHash,
  requirementId, xrayHash, strength: 'strong'|'partial',
  answerScore, scoringEpoch, at
}
unique index { sessionId, requirementId, xrayHash }   // real, DB-level
```

  (ServedProblem precedent — array subdocs cannot carry unique indexes.)
  GDPR: cascade + export + completeness-test entries, AND the per-session
  delete path removes the session's evidence rows [R26] and **$unsets the
  affected applications' readiness snapshots** (Codex #538 r2: a band
  derived from deleted answers must not survive; shared/** cannot reach
  the band math, and an absent snapshot = "no claims" — the safe
  direction; the next attribution write rebuilds it). Session deletion is
  ordered before its evidence sweep. The worker also rechecks the owner-scoped
  session, User and application after all writes; a concurrent deletion causes
  evidence deletion plus readiness/ticker compensation and is never marked
  processed. Snapshot publication uses an application-level
  `readinessRevision` compare-and-swap. Every evidence deletion increments the
  same revision, so a worker that read rows before another session was deleted
  cannot resurrect an aggregate containing the deleted answers. After persist,
  Legacy evidence rows remain exportable but lack handoff provenance and are
  excluded from both snapshot recomputation and the candidate-facing verified
  session ticker. The worker recomputes and **denormalizes a readiness snapshot onto
  JobApplication**: `readiness: {handoffVersion: 1, band, sessions, practicedCount,
  mustHaveTotal, quality, strongCoverage, xrayHash, scoringEpoch, at}`
  [R22] — every consumer reads the snapshot; nothing recomputes bands
  per-request. `quality` and `strongCoverage` are IN the snapshot (Codex
  #537): the blocked-state copy ("quality below the bar") and the
  segmented dashboard read them, and without them consumers would be
  forced into per-request recomputation or coverage-only mis-explanations.

**Calibration gate before anything renders** [R10]: grouped, production-shaped
cases preserve the full answers + must-have context sent by the worker, while
the founder labels every pair in each case's complete
`answers × must-haves` matrix. Only explicitly consented founder sessions may
enter the release corpus. Each case is manually redacted, points to its source
with a random opaque UUIDv4 (never a deterministic hash of user data), and has
its consent record held outside Git. The committed fixture asserts that both
manual redaction and the off-repo consent record exist; it does not claim that
a regex made the source anonymous.

The release corpus requires at least 30 labeled pairs across at least five
cases, at least eight labels for each of `strong | partial | none`, both
fresher/professional segments with at least eight labels each, and at least
three domains with at least five labels in every represented domain. It must
include a negation case and a prompt-injection case. Challenge cases include an
explicit `none` label so false evidence is measurable. It must also include a
founder-consented session marked as observed production upper-tail with more
than 40 answers. This deliberately crosses v1's single-response 40-group limit:
the calibration cannot pass until attribution chunks long sessions
deterministically or an explicit smaller bound is enforced end-to-end. Fixtures
accept the interview contract's full 0–500 answer-index range rather than
hiding this production gap behind a 30-answer test cap.

The v1 prompt assigns one strength group per answer. A no-evidence answer is
represented only as `{requirementIds: [], strength: "none"}`; strong/partial
groups require ids, avoiding paid retries on an ambiguous empty group. V1 does not
claim to distinguish `strong` for one requirement and `partial` for another in
the same answer; the parser and corpus shape both reject that unversioned shape.
A versioned pair-level contract,
persisted provenance and legacy quarantine/replay remain activation blockers
before A14.2b can show readiness, regardless of a v1 calibration result.

`npm run eval:jobs-evidence` invokes the same production prompt, parser,
schema and retry path. The operator must name the intended CMS slot model via
`JOBS_EVIDENCE_EVAL_EXPECTED_MODEL` and
`JOBS_EVIDENCE_EVAL_EXPECTED_PROVIDER`, and supplies `MONGODB_URI` so the
router is compared with authoritative CMS state. The worktree must be clean
before any model call. The harness captures the full effective slot plus the
authoritative ModelConfig revision/digest before and after the run, and fails
if they differ.

The technical gates are: exact-strength agreement ≥ 80%; evidence-vs-none
agreement ≥ 90%; `none` recall ≥ 90%; strong precision ≥ 80%; per-case
macro exact agreement ≥ 75%; binary agreement ≥ 85% in each segment and
≥ 80% in each represented domain; evaluator errors < 5%; and zero challenge
false-evidence, upper-tail case failures, fallback use, model/provider drift,
contract violations, or ModelConfig drift. The zero-tolerance upper-tail gate
prevents a mandatory long-session failure from being diluted by a larger corpus.
The same failure function has always-on boundary and dilution tests.

Every artifact records the thresholds, technical `gatePassed` decision and
failure codes, prompt/fixture/commit digests, and start/end ModelConfig
revisions and full slot contracts. It contains only safe case/pair ids,
predictions and aggregate metrics—never answer, question, requirement, or JD
text. Failed diagnostics use ignored `evidence-failed-*` files. A technical
pass uses reviewable `baseline-evidence-*` and carries
`founderApproval.status = blocked`, `activation.eligible = false`, and a
machine-readable blocker list. It cannot authorize a band until a later
version removes those blockers and the founder approves that exact artifact.

**Gate state (2026-07-22): CLOSED.** `evidenceGoldenSet.json` is intentionally
empty and the manual command exits non-zero. Making the harness executable
does not approve a model, corpus, historical evidence, band names or thresholds.
A14.2 / PR-R2 does not ship until a passing founder-approved artifact exists,
actual scoring + attribution provenance is persisted, legacy rows are
quarantined/replayed without guessed epochs, and the relevant AI-data
disclosure is accurate. Until then no readiness band renders, no readiness or
outcome label changes feed order, PR-R3 remains frozen, and cross-job evidence
or outcome transfer remains off.

**Cost**: one bounded call per scored jobs session (version mismatch =
terminal counted skip, no second parse in v1); never per-user×job. Module budgets: PR-R1
adds a `modules/jobs` budget row + ADR, and the new shared model file
bumps shared maxFiles with the paired ADR [R27].

## 2. PR-R2 — Bands (deterministic, computed at evidence-write time)

`computeReadiness(evidenceRows, currentParse, currentEpoch)` — pure, zero LLM:

- Rows counted only when: `xrayHash` = the posting's current
  `parsedJDHash` [R2], `answerScore ≥ 40` [R0], `scoringEpoch` = current
  [R8] (epoch = `resolveModel('interview.evaluate-answer').model` at
  attribution time — the RESOLVED model, honoring CMS overrides, since
  AnswerEvaluation never persists its judge model; Codex #538 r1+r2),
  and `requirementId ∈ current parse's MUST-HAVE id set` — the
  numerator's universe must equal the denominator's (Codex #537): a
  nice-to-have id inflating practicedCount against a must-have total is a
  silent over-claim. Belt at persist too: the worker rejects any returned
  id outside the must-have set it was given (intersection, never raw
  distinct count [R11]).
- `practicedCount` = distinct counted requirement ids;
  `mustHaveTotal` = current parse's must-have count.
- `sessions` = distinct sessions among COUNTED rows — NOT the
  application's total practice count. Two stale-JD sessions plus one
  current one is ONE session of current evidence, not three; stale
  sessions can never unlock the sessions ≥ 3 gate (Codex #538 r2).
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

**A14.1 ships independently as label collection only:** the owner can close
the interview lifecycle and correct the latest factual outcome, but no
readiness consumer is enabled by that data.

1. **PR-R0 (this doc)** — approve: band names + criteria + thresholds
   (incl. the fresher-segment question), the boost ordering-invariant X,
   the small-N guard, the new task slot.
2. **PR-R1** attribution (dark) → prod verification on the founder's own
   sessions.
3. **A14.2a** calibration integrity (dark): executable production-parity
   harness → actual scoring/attribution provenance → legacy quarantine/replay
   → founder-approved passing artifact. The empty corpus keeps this gate
   closed; a passing harness alone cannot activate a surface.
4. **A14.2b / PR-R2** bands + surfaces (visible, no rank change) + segment
   telemetry + chip-vocabulary reconciliation.
5. **PR-R3 — FROZEN until A14.2 passes its calibration gate** — re-ranking
   + fact chips.

## 5. Explicitly out of scope

Verdict-chip band-rule activation (own decision after R2); readiness
history (Pro, ruling #13); embeddings (ruling #16 rejection stands);
generation-time FOCUS targeting (hot-path); cross-job evidence transfer
(claims-honesty minefield, deliberately deferred); cross-job outcome transfer
and any ranking use of outcome labels.

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

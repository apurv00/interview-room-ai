import { gunzipSync } from 'zlib'
import type { ClientSession } from 'mongoose'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import {
  JOB_SOURCE_LINEAGE_UNKNOWN,
  JobPosting,
  JobSourceConfig,
  JobIngestCycle,
  JobsVerdictConfig,
  type JobsVerdictConfigValues,
} from '@shared/db/models'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { PROMPT_VERSION, epochOf } from '../config/verdictSchema'
import { evaluatePosting, expectedVerdictModel, resolveExpectedVerdictModel, type EvaluatorDeps } from '../services/postingEvaluator'
import { verdictInputHash, stripRecruiterPii, sliceBody } from '../config/verdictPrompt'
import { neutralizePromptLine } from '@shared/services/promptSecurity'
import { makeLlmBudget } from '../services/llmBudget'
import { reconcileVerdict } from '../services/verdictReconciler'
import { hostOf } from '../services/qualityGate'
import { jobPostingStateOf, NORMAL_ARCHIVE_CLOSED_REASONS } from '../services/postingAccess'
import { controlRevisionOf, operationalRevisionOf } from '../services/sourceControl'
import {
  fenceQualityDecisionSources,
  hasRestoredQualityDecision,
  recordAutomaticQualityDecision,
  withQualityDecisionTransaction,
} from '../services/qualityDecisionService'
import {
  fenceJobsVerdictConfigRevision,
  getJobsVerdictConfigSnapshot,
} from '../services/verdictConfigControl'

/**
 * LLM verdict worker + sweeper (INGESTION §4.5 layer 2, ruling #16).
 *
 * Worker: `jobs/verdict.requested` carries ids ONLY (≤40/event, 512KB
 * discipline); each step.run evaluates 2 postings — worst case 2 × (12s
 * call + 12s repair) = 48s < the 60s Vercel Hobby step budget. Verdicts are
 * idempotent on verdictInputHash: a step retry skips already-scored rows.
 *
 * Sweeper: hourly cron + manual `jobs/verdict.sweep` kick. Feeds the worker
 * from BOTH the pending partial index (steady state) and eligible open/normal-
 * archive rows with no llmVerdict sub-doc at all (pre-flip corpus / missed
 * enqueues / backfill), so no survivor sits unevaluated indefinitely. Oldest-first, budget-aware
 * (80% → halve, 95% → pending-only), attempts <5.
 *
 * Every switch here is DATA (JobsVerdictConfig singleton — founder ruling
 * 2026-07-13, no flags): collection OFF = worker + sweeper no-op.
 */

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

const POSTINGS_PER_STEP = 2
const IDS_PER_EVENT = 40
const SWEEP_LIMIT_DEFAULT = 400
const MAX_ATTEMPTS = 5
const BREAKER_CONSECUTIVE_FAILURES = 6
const VERDICT_DECISION_POLICY_REVISION = `jobs-verdict:${PROMPT_VERSION}:reconcile-v1`

interface LlmCycleCounters {
  requested: number
  scored: number
  cacheHits: number
  errors: number
  timeouts: number
  softClosed: number
  verdictDistribution: { genuine: number; suspicious: number; fraud: number }
  reasonCodeCounts: Record<string, number>
  bySource: Record<string, Record<string, number>>
  llmFlaggedCleanRow: number
  llmClearedFlaggedRow: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  epoch: string
  /** WHY rows didn't score (2026-07-16 incident: requested-40/scored-0
   *  cycles with every other counter zero were indistinguishable from
   *  outside — budget skips were deliberately uncounted and pre-evaluate
   *  skips invisible). Labels: ineligible / attempts-cap / opted-out /
   *  hash-match / superseded / budget:<reason>. */
  skips: Record<string, number>
}

function emptyLlmCounters(epochModel = expectedVerdictModel()): LlmCycleCounters {
  return {
    requested: 0, scored: 0, cacheHits: 0, errors: 0, timeouts: 0, softClosed: 0,
    verdictDistribution: { genuine: 0, suspicious: 0, fraud: 0 },
    reasonCodeCounts: {}, bySource: {}, skips: {},
    llmFlaggedCleanRow: 0, llmClearedFlaggedRow: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0,
    // The RESOLVED model, not the code default — a CMS cutover must not
    // attribute cycles to the wrong epoch on the dashboard (Codex on #515).
    epoch: `${epochModel}:${PROMPT_VERSION}`,
  }
}

function mergeLlmCounters(total: LlmCycleCounters, c: LlmCycleCounters): void {
  total.requested += c.requested
  total.scored += c.scored
  total.cacheHits += c.cacheHits
  total.errors += c.errors
  total.timeouts += c.timeouts
  total.softClosed += c.softClosed
  total.verdictDistribution.genuine += c.verdictDistribution.genuine
  total.verdictDistribution.suspicious += c.verdictDistribution.suspicious
  total.verdictDistribution.fraud += c.verdictDistribution.fraud
  for (const [k, v] of Object.entries(c.reasonCodeCounts)) total.reasonCodeCounts[k] = (total.reasonCodeCounts[k] ?? 0) + v
  // c may be a MEMOIZED pre-deploy step output without `skips` — a run
  // spanning the deploy/retry boundary must still merge and finish
  // (Codex #545 round 2).
  for (const [k, v] of Object.entries(c.skips ?? {})) total.skips[k] = (total.skips[k] ?? 0) + v
  for (const [src, dist] of Object.entries(c.bySource)) {
    const t = total.bySource[src] ?? (total.bySource[src] = {})
    for (const [k, v] of Object.entries(dist)) t[k] = (t[k] ?? 0) + v
  }
  total.llmFlaggedCleanRow += c.llmFlaggedCleanRow
  total.llmClearedFlaggedRow += c.llmClearedFlaggedRow
  total.inputTokens += c.inputTokens
  total.outputTokens += c.outputTokens
  total.costUsd += c.costUsd
}

function jdBodyOf(doc: { jdCompressed?: unknown }): string {
  const raw = doc.jdCompressed
  if (!raw) return ''
  try {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from((raw as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)
    return gunzipSync(buf).toString('utf8')
  } catch {
    return ''
  }
}

export interface EvaluateHandlerDeps {
  /** Test seam — defaults to the real evaluator. */
  evaluateFn?: typeof evaluatePosting
}

export async function runEvaluatePostingsHandler(
  event: { data: { postingIds: string[] } },
  step: StepRunner,
  handlerDeps: EvaluateHandlerDeps = {}
): Promise<{ skipped: string } | { evaluated: number; scored: number; breakerTripped: boolean }> {
  await connectDB()
  const cfg = await JobsVerdictConfig.getConfig()
  if (!cfg.collectionEnabled) return { skipped: 'collection-disabled' }
  const evaluate = handlerDeps.evaluateFn ?? evaluatePosting
  const budget = makeLlmBudget(redis, cfg)
  // CMS-resolved once per run — the epoch must be the model completion()
  // will actually serve, not the code default (a CMS cutover would
  // otherwise wedge every verdict as paid model-mismatch).
  const epochModel = await resolveExpectedVerdictModel()

  // ToS lever (§4.5): a posting with ANY opted-out contributing source never
  // reaches the model. Loaded once per run.
  const optedOut = new Set(
    (await JobSourceConfig.find({ llmVerdictOptOut: true }).select('sourceId').lean()).map((s) => s.sourceId)
  )

  const ids = event.data.postingIds ?? []
  const total = emptyLlmCounters(epochModel)
  const startedAt = new Date()
  let evaluated = 0
  let consecutiveFailures = 0
  let breakerTripped = false

  for (let i = 0; i < ids.length && !breakerTripped; i += POSTINGS_PER_STEP) {
    const chunk = ids.slice(i, i + POSTINGS_PER_STEP)
    const stepResult = await step.run(`evaluate-${Math.floor(i / POSTINGS_PER_STEP)}`, async () => {
      const c = emptyLlmCounters(epochModel)
      let stepEvaluated = 0
      let fails = consecutiveFailures
      let tripped = false
      for (const id of chunk) {
        const doc = await JobPosting.findById(id).lean()
        // LLM tombstones stay eligible for changed-input re-verdicts. A
        // normal archive is eligible while its verdict is missing or pending:
        // this is the recovery rail when a safety upgrade CAS lost to a
        // harmless retention-pin write, including legacy rows whose first
        // evaluation started without a verdict subdocument. Restricted and
        // unknown closures stay out.
        const eligible = doc && (
          doc.status === 'open' ||
          doc.closedReason === 'llm-verdict' ||
          (jobPostingStateOf(doc) === 'archived' &&
            (!doc.llmVerdict || doc.llmVerdict.status === 'pending'))
        )
        if (!doc || !eligible) {
          c.skips['ineligible'] = (c.skips['ineligible'] ?? 0) + 1
          continue
        }
        // The attempts cap bounds consecutive FAILURES on one input — a
        // successfully-scored row re-entering for an epoch refresh must not
        // be strangled by its historical failure count (its failure path
        // flips it back to pending, where the cap re-applies).
        if (doc.llmVerdict?.status === 'pending' && (doc.llmVerdict.attempts ?? 0) >= MAX_ATTEMPTS) {
          c.skips['attempts-cap'] = (c.skips['attempts-cap'] ?? 0) + 1
          continue
        }
        const durableSources = doc.sourceIds ?? []
        const sources = Array.from(new Set([
          ...durableSources,
          ...(doc.provenance ?? []).map((entry) => entry.sourceId),
        ]))
        // During rolling migration, absence of durable lineage cannot prove
        // eligibility. UNKNOWN means the old cap may have evicted a source.
        if (
          durableSources.length === 0 ||
          sources.includes(JOB_SOURCE_LINEAGE_UNKNOWN) ||
          sources.some((source) => optedOut.has(source))
        ) {
          c.skips['opted-out'] = (c.skips['opted-out'] ?? 0) + 1
          continue
        }
        const primarySource = sources.find((source) => source !== JOB_SOURCE_LINEAGE_UNKNOWN) ?? 'unknown'
        const applyHosts = Array.from(new Set(
          (doc.provenance ?? []).map((e) => (e.applyUrl ? hostOf(e.applyUrl) : '')).filter(Boolean)
        )).sort()
        const body = jdBodyOf(doc)
        // Skip on HASH match, not on status: a scored row whose inputs
        // changed since scoring MUST re-verdict (§4.5 'input change
        // re-enqueues'; adversarial review of Wave 2.3). Deterministic:
        // same slice+strip the evaluator applies.
        if (doc.llmVerdict?.status === 'scored') {
          const currentHash = verdictInputHash({
            companyKey: doc.companyKey,
            titleKey: doc.titleKey,
            locationKey: doc.locationKeys?.[0] ?? '',
            normalizedBody: stripRecruiterPii(sliceBody(body)),
            applyHosts,
            salaryText: doc.salaryText ?? null,
            epochModel,
          })
          if (doc.llmVerdict.verdictInputHash === currentHash) {
            c.skips['hash-match'] = (c.skips['hash-match'] ?? 0) + 1
            continue
          }
        }

        c.requested++
        stepEvaluated++
        const outcome = await evaluate(
          {
            companyKey: doc.companyKey,
            titleKey: doc.titleKey,
            locationKey: doc.locationKeys?.[0] ?? '',
            sourceId: primarySource,
            prompt: {
              title: doc.title,
              company: doc.company,
              city: doc.locations?.[0] ?? '',
              isRemote: !!doc.isRemote,
              salaryText: doc.salaryText ?? null,
              applyHosts,
              body,
            },
          },
          {
            cache: redis,
            checkBudget: (ck, src) => budget.check(ck, src),
            recordSpend: (ck, src, usd) => budget.record(ck, src, usd),
            pricing: { inputUsdPerMTok: cfg.inputUsdPerMTok, outputUsdPerMTok: cfg.outputUsdPerMTok },
            expectedModel: epochModel,
            beforeModelCall: async () => {
              // This is the final authorization point before each external
              // model request (primary and JSON repair). Re-read both the
              // exact posting snapshot and every durable source: a committed
              // revoke advances updatedAt + closes the row in the same
              // transaction that marks its source revoked, so either side
              // blocks stale JD egress. Missing/unknown lineage fails closed.
              const sourceIds = Array.from(new Set(durableSources))
              if (sourceIds.length === 0 || sourceIds.includes(JOB_SOURCE_LINEAGE_UNKNOWN)) return false
              const lifecycleFilter = doc.status === 'open'
                ? { status: 'open' }
                : { status: 'closed', closedReason: doc.closedReason }
              const [currentPosting, currentSources] = await Promise.all([
                JobPosting.exists({ _id: doc._id, updatedAt: doc.updatedAt, ...lifecycleFilter }),
                JobSourceConfig.find({ sourceId: { $in: sourceIds } })
                  .select('sourceId health llmVerdictOptOut')
                  .lean(),
              ])
              if (!currentPosting) return false
              const sourceById = new Map(currentSources.map((source) => [source.sourceId, source]))
              return sourceIds.every((sourceId) => {
                const source = sourceById.get(sourceId)
                return !!source && source.health !== 'revoked' && !source.llmVerdictOptOut
              })
            },
          } as EvaluatorDeps
        )

        if (outcome.ok) {
          fails = 0
          const rec = reconcileVerdict(outcome.verdict, {
            anyDemotionFlag: !!(doc.flags?.staffing || doc.flags?.shortJd || doc.flags?.repost || doc.confidentialCompany),
          })
          const candidateSoftClose = cfg.enforceEnabled && rec.wouldSoftClose
          const candidateReopen = cfg.enforceEnabled && doc.status === 'closed' &&
            doc.closedReason === 'llm-verdict' && !rec.wouldSoftClose
          const persist = async (session?: ClientSession) => {
            let softClose = candidateSoftClose
            let reopen = candidateReopen
            let decisionConfigRevision = cfg.revision
            let sourceRevisions: Array<{ sourceId: string; controlRevision: number; operationalRevision: number }> = []
            if (candidateSoftClose || candidateReopen) {
              if (!session) throw new Error('verdict lifecycle decisions require a quality-decision transaction')
              const currentConfig = await getJobsVerdictConfigSnapshot(session)
              if (!currentConfig.collectionEnabled) {
                return { matched: false, softClose: false, authorityChanged: false, configChanged: true }
              }
              if (currentConfig.enforceEnabled && currentConfig.revision !== cfg.revision) {
                // The model call, pricing, and budget authorization used cfg.
                // Do not attribute a serving mutation to a later revision;
                // leave the posting pending so the next run evaluates under
                // one reproducible config snapshot end to end.
                return { matched: false, softClose: false, authorityChanged: false, configChanged: true }
              }
              decisionConfigRevision = currentConfig.revision
              if (!currentConfig.enforceEnabled) {
                softClose = false
                reopen = false
              } else if (!(await fenceJobsVerdictConfigRevision(currentConfig.revision, session))) {
                // A legacy/non-canonical row or a concurrent CMS transition
                // cannot authorize serving changes. Keep the paid score only.
                softClose = false
                reopen = false
              }
              if (softClose || reopen) {
                const authorityRows = await JobSourceConfig.find(
                  { sourceId: { $in: sources } },
                  null,
                  { session },
                ).select('sourceId health llmVerdictOptOut controlRevision operationalRevision').lean()
                const bySource = new Map(authorityRows.map((source) => [source.sourceId, source]))
                if (!sources.every((sourceId) => {
                  const source = bySource.get(sourceId)
                  return !!source && source.health !== 'revoked' && !source.llmVerdictOptOut
                })) return { matched: false, softClose: false, authorityChanged: true }
                sourceRevisions = sources.map((sourceId) => {
                  const source = bySource.get(sourceId)!
                  return {
                    sourceId,
                    controlRevision: controlRevisionOf(source),
                    operationalRevision: operationalRevisionOf(source),
                  }
                })
                await fenceQualityDecisionSources(sourceRevisions, session, {
                  requireVerdictEligibility: true,
                })
                if (softClose) {
                  softClose = !(await hasRestoredQualityDecision({
                    domain: 'llm-verdict',
                    action: 'close',
                    subjectKey: String(doc._id),
                    postingId: doc._id,
                    inputHash: outcome.inputHash,
                    policyRevision: VERDICT_DECISION_POLICY_REVISION,
                    configRevision: decisionConfigRevision,
                    sourceRevisions,
                  }, session))
                }
              }
            }

            const scoredAt = new Date()
            const set: Record<string, unknown> = {
              llmVerdict: {
                status: 'scored',
                verdict: outcome.verdict.verdict,
                reasonCodes: outcome.verdict.reasonCodes,
                genuineness: outcome.verdict.genuineness,
                quality: outcome.verdict.quality,
                completeness: outcome.verdict.completeness,
                domain: outcome.verdict.domain,
                domainConfidence: outcome.verdict.domainConfidence,
                seniority: outcome.verdict.seniority,
                fresherFriendly: outcome.verdict.fresherFriendly,
                geo: {
                  locations: outcome.verdict.geo.locations.map((l) => neutralizePromptLine(l, 80)).filter(Boolean),
                  workMode: outcome.verdict.geo.workMode,
                },
                verdictInputHash: outcome.inputHash,
                epoch: outcome.epoch,
                model: outcome.model,
                promptVersion: PROMPT_VERSION,
                inputTokens: outcome.inputTokens,
                outputTokens: outcome.outputTokens,
                costUsd: outcome.costUsd,
                ranAt: scoredAt,
                attempts: (doc.llmVerdict?.attempts ?? 0) + 1,
                disagreesWithRules: rec.disagreesWithRules,
              },
            }
            let unset: Record<string, 1> | undefined
            if (softClose) {
              set.status = 'closed'
              set.closedReason = 'llm-verdict'
              set.closedAt = scoredAt
              unset = { purgeAt: 1 }
            } else if (reopen) {
              set.status = 'open'
              unset = { closedReason: 1, closedAt: 1, purgeAt: 1 }
            }
            const lifecycleFilter = doc.status === 'open'
              ? { status: 'open' }
              : { status: 'closed', closedReason: doc.closedReason }
            const writeOptions = session ? { session } : undefined
            let res = await JobPosting.updateOne(
              { _id: doc._id, updatedAt: doc.updatedAt, ...lifecycleFilter },
              unset ? { $set: set, $unset: unset } : { $set: set },
              writeOptions,
            )
            if ((res?.matchedCount ?? 1) === 0 && softClose) {
              let latestQuery = JobPosting.findById(doc._id)
              if (session) latestQuery = latestQuery.session(session)
              const latest = await latestQuery.lean()
              if (latest && jobPostingStateOf(latest) === 'archived') {
                const latestApplyHosts = Array.from(new Set(
                  (latest.provenance ?? []).map((e) => (e.applyUrl ? hostOf(e.applyUrl) : '')).filter(Boolean)
                )).sort()
                const latestInputHash = verdictInputHash({
                  companyKey: latest.companyKey,
                  titleKey: latest.titleKey,
                  locationKey: latest.locationKeys?.[0] ?? '',
                  normalizedBody: stripRecruiterPii(sliceBody(jdBodyOf(latest))),
                  applyHosts: latestApplyHosts,
                  salaryText: latest.salaryText ?? null,
                  epochModel,
                })
                if (latestInputHash === outcome.inputHash) {
                  res = await JobPosting.updateOne(
                    {
                      _id: latest._id,
                      updatedAt: latest.updatedAt,
                      status: 'closed',
                      closedReason: latest.closedReason,
                    },
                    unset ? { $set: set, $unset: unset } : { $set: set },
                    writeOptions,
                  )
                }
              }
            }
            if ((res?.matchedCount ?? 1) === 0) {
              return { matched: false, softClose, authorityChanged: false }
            }
            if (softClose || reopen) {
              await recordAutomaticQualityDecision({
                domain: 'llm-verdict',
                action: softClose ? 'close' : 'reopen',
                subjectKey: String(doc._id),
                postingId: doc._id,
                inputHash: outcome.inputHash,
                policyRevision: VERDICT_DECISION_POLICY_REVISION,
                configRevision: decisionConfigRevision,
                sourceRevisions,
                occurredAt: scoredAt,
                evidence: {
                  kind: 'llm-verdict',
                  verdict: outcome.verdict.verdict,
                  reasonCodes: outcome.verdict.reasonCodes,
                  genuineness: outcome.verdict.genuineness,
                  model: outcome.model,
                  promptVersion: PROMPT_VERSION,
                  epoch: outcome.epoch,
                },
              }, session)
            }
            return { matched: true, softClose, authorityChanged: false, configChanged: false }
          }
          const persisted = candidateSoftClose || candidateReopen
            ? await withQualityDecisionTransaction((session) => persist(session))
            : await persist()
          if (persisted.authorityChanged) {
            c.skips['authority-changed'] = (c.skips['authority-changed'] ?? 0) + 1
            continue
          }
          if (persisted.configChanged) {
            c.skips['config-changed'] = (c.skips['config-changed'] ?? 0) + 1
            continue
          }
          if (!persisted.matched) {
            c.skips['superseded'] = (c.skips['superseded'] ?? 0) + 1
            continue // superseded mid-flight — not scored
          }
          c.scored++
          if (outcome.cached) c.cacheHits++
          c.verdictDistribution[outcome.verdict.verdict]++
          for (const code of outcome.verdict.reasonCodes) c.reasonCodeCounts[code] = (c.reasonCodeCounts[code] ?? 0) + 1
          const src = c.bySource[primarySource] ?? (c.bySource[primarySource] = {})
          src[outcome.verdict.verdict] = (src[outcome.verdict.verdict] ?? 0) + 1
          if (rec.llmFlaggedCleanRow) c.llmFlaggedCleanRow++
          if (rec.llmClearedFlaggedRow) c.llmClearedFlaggedRow++
          if (persisted.softClose) c.softClosed++
          c.inputTokens += outcome.inputTokens
          c.outputTokens += outcome.outputTokens
          c.costUsd += outcome.costUsd
        } else if (outcome.kind === 'budget' || outcome.kind === 'authority') {
          // Not the posting's fault — no attempts bump, no breaker count,
          // and NOT an error (it would pollute the shadow-exit 'error <5%'
          // metric during throttling); the backlog gauge shows the queue.
          // But it must be VISIBLE: the 2026-07-16 stall (requested-40/
          // scored-0, every other counter zero) was undiagnosable from
          // telemetry precisely because this branch counted nothing.
          const label = outcome.kind === 'budget'
            ? `budget:${outcome.message ?? 'denied'}`
            : 'authority-changed'
          c.skips[label] = (c.skips[label] ?? 0) + 1
        } else {
          fails++
          if (outcome.kind === 'timeout') c.timeouts++
          else c.errors++
          c.costUsd += outcome.costUsd
          // Same freshness guard: never stomp a mid-flight merge reset
          // (attempts:0 for NEW inputs) with a failure bump for OLD inputs.
          await JobPosting.updateOne(
            {
              _id: doc._id,
              updatedAt: doc.updatedAt,
              ...(doc.status === 'open'
                ? { status: 'open' }
                : { status: 'closed', closedReason: doc.closedReason }),
            },
            {
              $set: {
                'llmVerdict.status': 'pending',
                'llmVerdict.attempts': (doc.llmVerdict?.attempts ?? 0) + 1,
                'llmVerdict.lastError': `${outcome.kind}:${outcome.message}`.slice(0, 300),
              },
            }
          )
          if (fails >= BREAKER_CONSECUTIVE_FAILURES) {
            await budget.setDegraded()
            tripped = true
            break
          }
        }
      }
      return { counters: c, evaluated: stepEvaluated, consecutiveFailures: fails, breakerTripped: tripped }
    })
    mergeLlmCounters(total, stepResult.counters as LlmCycleCounters)
    evaluated += stepResult.evaluated
    consecutiveFailures = stepResult.consecutiveFailures
    breakerTripped = stepResult.breakerTripped
  }

  await step.run('write-cycle', async () => {
    try {
      await JobIngestCycle.create({
        kind: 'llm-verdict',
        sourceId: 'llm-verdict',
        startedAt,
        finishedAt: new Date(),
        llm: total,
        healthTransitions: breakerTripped ? ['verdict-breaker-tripped'] : [],
      })
    } catch (err) {
      logger.warn({ err }, 'verdict cycle telemetry write failed')
    }
    return true
  })

  return { evaluated, scored: total.scored, breakerTripped }
}

/** A sweeper-level denial must leave a diagnosable trace (Codex #545):
 *  the preflight gate exiting silently is exactly the invisible-stall
 *  class this PR eliminates for the worker. Best-effort — telemetry
 *  failure never blocks the return. */
async function writeSweeperSkipCycle(reason: string): Promise<void> {
  try {
    const now = new Date()
    const counters = emptyLlmCounters()
    counters.skips[`sweeper:${reason}`] = 1
    await JobIngestCycle.create({
      kind: 'llm-verdict',
      sourceId: 'llm-verdict',
      startedAt: now,
      finishedAt: now,
      llm: counters,
    })
  } catch (err) {
    logger.warn({ err, reason }, 'sweeper skip telemetry write failed')
  }
}

export async function runVerdictSweeperHandler(
  step: StepRunner,
  opts: { limit?: number } = {}
): Promise<{ skipped: string } | { enqueued: number; batches: number }> {
  await connectDB()
  const cfg = await JobsVerdictConfig.getConfig()
  if (!cfg.collectionEnabled) return { skipped: 'collection-disabled' }
  const budget = makeLlmBudget(redis, cfg)
  if (await budget.isDegraded()) {
    await writeSweeperSkipCycle('circuit-breaker-degraded')
    return { skipped: 'circuit-breaker-degraded' }
  }
  const gate = await budget.check('__sweeper__', '__sweeper__')
  if (!gate.allowed) {
    await writeSweeperSkipCycle(gate.reason ?? 'budget')
    return { skipped: gate.reason ?? 'budget' }
  }
  const limit = Math.max(1, Math.floor((opts.limit ?? SWEEP_LIMIT_DEFAULT) / (gate.softening ? 2 : 1)))

  // Derive one complete authority allow-set for every sweeper lane. Paused
  // sources stay eligible; only missing, revoked, or explicit LLM opt-out
  // lineage is excluded. Checking the entire durable sourceIds set in Mongo
  // prevents permanently unauthorized rows from pinning a bounded window.
  const sourceAuthority = await JobSourceConfig.find({})
    .select('sourceId health llmVerdictOptOut')
    .lean()
  const optedOut = Array.from(new Set(
    sourceAuthority
      .filter((source) => source.llmVerdictOptOut)
      .map((source) => source.sourceId)
  )).sort()
  const eligibleSourceIds = Array.from(new Set(
    sourceAuthority
      .filter((source) => source.health !== 'revoked' && !source.llmVerdictOptOut)
      .map((source) => source.sourceId)
  )).sort()
  const currentEpoch = epochOf(await resolveExpectedVerdictModel())

  const ids = await step.run('find-due', async () => {
    const statusScope = {
      $or: [
        { status: 'open' },
        // §4.3: llm-verdict tombstones whose inputs changed re-verdict
        // (the merge resets them to pending) and may reopen.
        { status: 'closed', closedReason: 'llm-verdict' },
        // A safety-verdict upgrade can lose its fallback CAS to a benign
        // ownership-pin write. Missing/pending normal archives must re-enter
        // so the exact-input verdict eventually wins once lifecycle writes
        // quiesce. Keeping this verdict predicate inside the lifecycle branch
        // prevents stale-epoch scored archives from joining the backfill below.
        {
          status: 'closed',
          closedReason: { $in: NORMAL_ARCHIVE_CLOSED_REASONS },
          $or: [
            { 'llmVerdict.status': 'pending' },
            { llmVerdict: { $exists: false } },
          ],
        },
      ],
    }
    const authorityScope = [
      // Missing/empty/unknown lineage is permanently ineligible for model
      // egress. Keep this in the oldest-first query even when no source has an
      // explicit opt-out, otherwise skipped legacy rows pin the bounded window.
      { 'sourceIds.0': { $exists: true } },
      { sourceIds: { $nin: [JOB_SOURCE_LINEAGE_UNKNOWN, ...optedOut] } },
      {
        $expr: {
          $setIsSubset: [
            { $cond: [{ $isArray: '$sourceIds' }, '$sourceIds', []] },
            eligibleSourceIds,
          ],
        },
      },
      ...(optedOut.length
        ? [
            // Defense in depth for a partially repaired row. The lineage
            // migration also verifies provenance is a subset of sourceIds.
            { 'provenance.sourceId': { $nin: optedOut } },
          ]
        : []),
    ]
    const rows = await JobPosting.find({
      $and: [
        statusScope,
        {
          $or: [
            // Steady state: rides the §4.3 pending partial index.
            { 'llmVerdict.status': 'pending', 'llmVerdict.attempts': { $lt: MAX_ATTEMPTS } },
            // Catch-all net: pre-flip corpus / missed enqueues (bounded ≤25k scan).
            { llmVerdict: { $exists: false } },
          ],
        },
        ...authorityScope,
      ],
    })
      .sort({ _id: 1 }) // oldest-first
      .limit(limit)
      .select('_id')
      .lean()
    const due = rows.map((row) => String(row._id))
    // Epoch-cutover backfill (§4.5 'rolling, budget-capped re-classification';
    // Codex on #515): scored rows from a stale epoch re-enter ONLY with the
    // limit left over after live pending work, so cutover rolls through the
    // corpus across sweeps under the same budget tiers. The worker's hash
    // check (epoch is a hash component) re-scores them.
    const remainder = limit - due.length
    if (remainder > 0) {
      const stale = await JobPosting.find({
        $and: [
          statusScope,
          { 'llmVerdict.status': 'scored', 'llmVerdict.epoch': { $ne: currentEpoch } },
          ...authorityScope,
        ],
      })
        .sort({ _id: 1 })
        .limit(remainder)
        .select('_id')
        .lean()
      due.push(...stale.map((r) => String(r._id)))
    }
    return due
  })

  let batches = 0
  for (let i = 0; i < ids.length; i += IDS_PER_EVENT) {
    const batch = ids.slice(i, i + IDS_PER_EVENT)
    await step.run(`enqueue-${batches}`, async () => {
      await inngest.send({ name: 'jobs/verdict.requested', data: { postingIds: batch } })
      return batch.length
    })
    batches++
  }
  return { enqueued: ids.length, batches }
}

// ── Inngest wrappers ─────────────────────────────────────────────────────────

export const jobsEvaluatePostingsJob = inngest.createFunction(
  {
    id: 'jobs-evaluate-postings',
    name: 'Jobs: LLM posting verdicts',
    retries: 2, // infra throws only — scored-at-hash postings skip on re-run
    concurrency: [{ limit: 1 }], // one verdict worker at a time (Atlas + spend discipline)
    triggers: [{ event: 'jobs/verdict.requested' }],
  },
  async ({ event, step }) =>
    runEvaluatePostingsHandler(event as unknown as { data: { postingIds: string[] } }, step as StepRunner)
)

export const jobsVerdictSweeperJob = inngest.createFunction(
  {
    id: 'jobs-verdict-sweeper',
    name: 'Jobs: verdict sweeper',
    retries: 1,
    triggers: [{ cron: '45 * * * *' }, { event: 'jobs/verdict.sweep' }],
  },
  async ({ event, step }) =>
    runVerdictSweeperHandler(step as StepRunner, {
      limit: (event as unknown as { data?: { limit?: number } })?.data?.limit,
    })
)

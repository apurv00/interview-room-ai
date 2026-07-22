import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobPosting, JobIngestCycle, type IJobProvenance } from '@shared/db/models'
import { logger } from '@shared/logger'
import {
  checkApplyLink,
  LinkCheckAuthorityChangedError,
  nextApplyCheckState,
  nextClosedApplyCheckState,
  isCheckableUrl,
  MIN_RESTRIKE_MS,
  type ApplyCheckState,
  type ApplyRecoveryObservation,
  type LinkOutcome,
} from '../services/linkCheckService'
import { safeLinkRequest, type LinkRequestImpl } from '../services/safeLinkNetwork'
import { isBlockedApplyUrl } from '../services/qualityGate'
import {
  groupApplyLinkSubjects,
  linkDispositionOf,
  nextMachineGovernance,
  withReplicatedLinkGovernance,
  type ApplyLinkSubjectGroup,
} from '../services/linkGovernance'

/**
 * Hourly apply-link liveness sweep (founder directive 2026-07-16, ruling
 * #22): machine-checks apply URLs so dead-link spam dies without a human,
 * on ANY host — the scalable layer above the observed-abuse blocklist.
 *
 * Pick order per run (cap 150):
 *  1. explicit crowd check requests, capped at 50 so report traffic cannot
 *     starve independent machine evidence;
 *  2. dead restrikes and closed dead-link recovery rows whose spacing window
 *     has elapsed, ordered together so recovery cannot starve;
 *  3. never-checked open rows, oldest first;
 *  4. unverifiable and alive rows after their normal recheck intervals.
 * Posting-level outcome: dead ONLY if EVERY (non-blocklisted, checkable)
 * apply URL is dead — one alive rung keeps the posting alive. Closing
 * requires TWO dead sweeps ≥20h apart (linkCheckService policy).
 */

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

const RUN_CAP = 150
const CROWD_REQUEST_CAP = 50
// Chunk math vs the route's maxDuration=300 (Codex #543 rounds 2/5/6):
// worst case per URL = one 12s DNS+redirect+body deadline + 0.4s pacing
// ≈ 12.4s. Chunks are packed by URL COUNT (≤15 URL-slots ≈ 186s worst),
// NOT by posting count — so a posting with many apply URLs gets EVERY url
// checked in one step (round 6: always slicing the same first three made
// 4-URL spam permanently uncloseable) while the envelope still holds.
const URL_SLOTS_PER_STEP = 15
const RECHECK_ALIVE_MS = 14 * 24 * 3600 * 1000
/** Transient outcomes (timeouts, bot-blocks) re-enter the pool after 48h —
 *  a single flaky response must not permanently exempt a posting from
 *  liveness validation (Codex #543 round 3). Slower than the restrike lane
 *  so bot-blocking ATS hosts are not hammered hourly. */
const RECHECK_UNVERIFIABLE_MS = 48 * 3600 * 1000
const PACING_MS = 400

const PICK_PROJECTION = '_id provenance applyCheck userReferenced status closedReason linkCheckRequestedAt'

type PickedPosting = {
  _id: unknown
  provenance?: IJobProvenance[]
  applyCheck?: Record<string, unknown>
  userReferenced?: boolean
  status?: 'open' | 'closed'
  closedReason?: string
  linkCheckRequestedAt?: Date
}

function excludingPicked(docs: PickedPosting[]): Record<string, unknown> {
  return docs.length > 0
    ? { _id: { $nin: docs.map((doc) => doc._id) } }
    : {}
}

export async function pickPostingsToCheck(now: Date): Promise<PickedPosting[]> {
  const requested = await JobPosting.find({
    linkCheckRequestedAt: { $type: 'date' },
    $or: [
      { status: 'open' },
      { status: 'closed', closedReason: 'dead-apply-link' },
    ],
  })
    .select(PICK_PROJECTION)
    .sort({ linkCheckRequestedAt: 1 })
    .limit(CROWD_REQUEST_CAP)
    .lean()
  // Strike-1 rows and closed dead-link rows share one age-ordered lane. This
  // both makes strike 2 reachable and gives temporary-outage closures a fair
  // path back to the two-alive recovery policy.
  const remaining0 = RUN_CAP - requested.length
  const machineDue = remaining0 > 0
    ? await JobPosting.find({
        ...excludingPicked(requested as PickedPosting[]),
        $or: [
          {
            status: 'open',
            'applyCheck.status': 'dead',
            'applyCheck.lastDeadAt': { $lt: new Date(now.getTime() - MIN_RESTRIKE_MS) },
          },
          {
            status: 'closed',
            closedReason: 'dead-apply-link',
            'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - MIN_RESTRIKE_MS) },
          },
        ],
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastCheckedAt': 1 })
        .limit(remaining0)
        .lean()
    : []
  const selected1 = [...requested, ...machineDue] as PickedPosting[]
  const remaining1 = RUN_CAP - selected1.length
  const unchecked = remaining1 > 0
    ? await JobPosting.find({
        ...excludingPicked(selected1),
        status: 'open',
        applyCheck: { $exists: false },
      })
        .select(PICK_PROJECTION)
        .sort({ createdAt: 1 })
        .limit(remaining1)
        .lean()
    : []
  const selected2 = [...selected1, ...unchecked] as PickedPosting[]
  const remaining2 = RUN_CAP - selected2.length
  // Transient results re-enter the pool — a lone timeout must not exempt a
  // row from validation forever (Codex #543 round 3).
  const staleUnverifiable = remaining2 > 0
    ? await JobPosting.find({
        ...excludingPicked(selected2),
        status: 'open',
        'applyCheck.status': 'unverifiable',
        'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - RECHECK_UNVERIFIABLE_MS) },
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastCheckedAt': 1 })
        .limit(remaining2)
        .lean()
    : []
  const selected3 = [...selected2, ...staleUnverifiable] as PickedPosting[]
  const remaining3 = RUN_CAP - selected3.length
  const stale = remaining3 > 0
    ? await JobPosting.find({
        ...excludingPicked(selected3),
        status: 'open',
        'applyCheck.status': 'alive',
        'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - RECHECK_ALIVE_MS) },
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastCheckedAt': 1 })
        .limit(remaining3)
        .lean()
    : []
  const seen = new Set<string>()
  return [...requested, ...machineDue, ...unchecked, ...staleUnverifiable, ...stale].filter((d) => {
    const id = String(d._id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }) as never
}

/** Posting-level outcome from per-URL outcomes: one alive rung = alive;
 *  all checkable rungs dead = dead; otherwise unverifiable. Blocklisted
 *  URLs are skipped — they are never served as apply paths anyway. */
export function postingOutcome(outcomes: LinkOutcome[]): LinkOutcome {
  if (outcomes.length === 0) return 'unverifiable'
  if (outcomes.some((o) => o === 'alive')) return 'alive'
  if (outcomes.every((o) => o === 'dead')) return 'dead'
  return 'unverifiable'
}

function recoveryObservationOf(
  previous: ApplyCheckState | undefined,
  observations: ReadonlyArray<{ group: ApplyLinkSubjectGroup; outcome: LinkOutcome }>,
): ApplyRecoveryObservation | undefined {
  const previousObservation =
    typeof previous?.recoverySubject === 'string' &&
    typeof previous?.recoveryGeneration === 'string'
      ? observations.find(({ group }) => (
          group.subject === previous.recoverySubject &&
          group.generation === previous.recoveryGeneration
        ))
      : undefined
  // Advance an existing streak only when its exact link is positively alive.
  if (previousObservation?.outcome === 'alive') {
    return {
      subject: previousObservation.group.subject,
      generation: previousObservation.group.generation,
      outcome: previousObservation.outcome,
    }
  }

  // If another current URL is alive, it starts a new independent recovery
  // streak. This is the critical alternating-URL guard.
  const alive = observations.find((observation) => observation.outcome === 'alive')
  if (alive) {
    return {
      subject: alive.group.subject,
      generation: alive.group.generation,
      outcome: alive.outcome,
    }
  }

  // Preserve one same-link strike across an ambiguous observation, while a
  // positive death, removal, or generation replacement clears it.
  if (previousObservation) {
    return {
      subject: previousObservation.group.subject,
      generation: previousObservation.group.generation,
      outcome: previousObservation.outcome,
    }
  }
  return undefined
}

export async function runLinkCheckHandler(
  step: StepRunner,
  requestImpl: LinkRequestImpl = safeLinkRequest,
  now = new Date(),
  pacingMs = PACING_MS,
): Promise<{ checked: number; closed: number }> {
  await connectDB()
  const picked = await step.run('pick', () => pickPostingsToCheck(now))
  const counters = {
    checked: 0,
    dead: 0,
    alive: 0,
    unverifiable: 0,
    closedNow: 0,
    requestedProcessed: 0,
    crowdDispositionChanged: 0,
    machineDispositionChanged: 0,
    incidentsCleared: 0,
    casMisses: 0,
    reopenedNow: 0,
  }

  // Checkable = non-blocklisted AND passes the URL-shape guard — a stored
  // non-http/malformed string (ingested but never served by feedService's
  // safe-http filter) must not poison an otherwise all-dead outcome
  // (Codex #543 round 3).
  const groupsOf = (doc: (typeof picked)[number]): ApplyLinkSubjectGroup[] =>
    groupApplyLinkSubjects(doc.provenance ?? [])
      .filter((group) => !isBlockedApplyUrl(group.canonicalUrl) && isCheckableUrl(group.canonicalUrl))
  const urlsOf = (doc: (typeof picked)[number]) =>
    groupsOf(doc).map((group) => group.canonicalUrl)
  // Pack chunks by URL-slot budget so EVERY url of a posting is checked in
  // one step (round 6) while the timeout envelope holds.
  const chunks: Array<Array<(typeof picked)[number]>> = []
  let current: Array<(typeof picked)[number]> = []
  let slots = 0
  for (const doc of picked) {
    const n = Math.max(1, urlsOf(doc).length)
    if (current.length > 0 && slots + n > URL_SLOTS_PER_STEP) {
      chunks.push(current)
      current = []
      slots = 0
    }
    current.push(doc)
    slots += n
  }
  if (current.length) chunks.push(current)

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    await step.run(`check-${ci}`, async () => {
      for (const doc of chunk) {
        const groups = groupsOf(doc)
        const observations: Array<{ group: ApplyLinkSubjectGroup; outcome: LinkOutcome }> = []
        const recovering = doc.status === 'closed' && doc.closedReason === 'dead-apply-link'
        // Exact provenance snapshot binds every DNS/HTTP authorization and
        // the eventual result write to the lifecycle that was picked. A
        // source revoke, URL replacement/addition, or closure makes it miss.
        const lifecycleFilter = {
          _id: doc._id as never,
          ...(recovering
            ? { status: 'closed', closedReason: 'dead-apply-link' }
            : { status: 'open' }),
          provenance: doc.provenance ?? [],
          ...(doc.linkCheckRequestedAt
            ? { linkCheckRequestedAt: doc.linkCheckRequestedAt }
            : { linkCheckRequestedAt: { $exists: false } }),
        }
        let authorityChanged = false
        for (const group of groups) {
          try {
            const outcome = await checkApplyLink(
              group.canonicalUrl,
              requestImpl,
              async () => !!(await JobPosting.exists(lifecycleFilter as never)),
            )
            observations.push({ group, outcome })
          } catch (error) {
            if (!(error instanceof LinkCheckAuthorityChangedError)) throw error
            authorityChanged = true
            break
          }
          if (pacingMs > 0) await new Promise((r) => setTimeout(r, pacingMs))
        }
        // Never derive or persist a posting-level result from a partial URL
        // set after authority has been withdrawn.
        if (authorityChanged) {
          counters.casMisses += 1
          continue
        }
        const outcome = postingOutcome(observations.map((observation) => observation.outcome))
        const checkedAt = new Date()
        let governedProvenance = (doc.provenance ?? []).map((entry) => ({ ...entry }))
        let crowdDispositionChanged = 0
        let machineDispositionChanged = 0
        let incidentsCleared = 0
        for (const observation of observations) {
          const current = observation.group.governance
          const next = nextMachineGovernance(current, observation.outcome, checkedAt)
          if (!!current.crowdDemotedAt !== !!next.crowdDemotedAt) {
            crowdDispositionChanged += 1
          }
          if (!!current.machineDemotedAt !== !!next.machineDemotedAt) {
            machineDispositionChanged += 1
          }
          if (
            next.incidentVersion > current.incidentVersion &&
            (current.reportCount > 0 || linkDispositionOf(current) !== 'pending-verification')
          ) {
            incidentsCleared += 1
          }
          governedProvenance = withReplicatedLinkGovernance(
            governedProvenance,
            observation.group.subject,
            next,
          ) as IJobProvenance[]
        }

        const prev = doc.applyCheck as ApplyCheckState | undefined
        const openTransition = recovering
          ? null
          : nextApplyCheckState(prev as never, outcome, checkedAt)
        const recoveryTransition = recovering
          ? nextClosedApplyCheckState(
              prev,
              outcome,
              checkedAt,
              recoveryObservationOf(prev, observations),
            )
          : null
        const state = openTransition?.state ?? recoveryTransition!.state
        const shouldClose = openTransition?.shouldClose === true
        const shouldReopen = recoveryTransition?.shouldReopen === true
        const update: Record<string, unknown> = {
          $set: { applyCheck: state, provenance: governedProvenance },
          $unset: { linkCheckRequestedAt: 1 },
        }
        let closedAt: Date | null = null
        if (shouldClose) {
          closedAt = checkedAt
          ;(update.$set as Record<string, unknown>).status = 'closed'
          ;(update.$set as Record<string, unknown>).closedReason = 'dead-apply-link'
          ;(update.$set as Record<string, unknown>).closedAt = closedAt
          // Close without a TTL first. Purge eligibility is stamped only by
          // a second update that observes the current retention pin.
          ;(update.$unset as Record<string, unknown>).purgeAt = 1
        } else if (shouldReopen) {
          ;(update.$set as Record<string, unknown>).status = 'open'
          ;(update.$unset as Record<string, unknown>).closedReason = 1
          ;(update.$unset as Record<string, unknown>).closedAt = 1
          ;(update.$unset as Record<string, unknown>).purgeAt = 1
        }
        // Optimistic token (Codex #543 round 6): if ingestion replaced the
        // apply URL (and cleared applyCheck) between our pick and this
        // write, the evidence below was computed against the OLD link —
        // the filter must miss and the next sweep re-verifies fresh.
        // Status guard keeps a row closed by another path closed.
        const token = prev?.lastCheckedAt
          ? { 'applyCheck.lastCheckedAt': prev.lastCheckedAt }
          : { applyCheck: { $exists: false } }
        const write = await JobPosting.updateOne(
          { ...lifecycleFilter, ...token } as never,
          update,
          { runValidators: true },
        )
        if ((write?.matchedCount ?? 0) === 0) {
          counters.casMisses += 1
          continue
        }

        counters.checked += 1
        counters[outcome] += 1
        counters.crowdDispositionChanged += crowdDispositionChanged
        counters.machineDispositionChanged += machineDispositionChanged
        counters.incidentsCleared += incidentsCleared
        if (doc.linkCheckRequestedAt) counters.requestedProcessed += 1
        if (shouldReopen) counters.reopenedNow += 1

        if (closedAt) {
          // Resolve TTL eligibility from the CURRENT retention pin. A
          // concurrent first Save/Apply/Tailor either makes the true branch
          // clear a stale purgeAt or runs after this and clears it itself.
          const closeFilter = {
            _id: doc._id as never,
            status: 'closed',
            closedReason: 'dead-apply-link',
            closedAt,
          }
          await JobPosting.updateOne(
            { ...closeFilter, userReferenced: true } as never,
            { $unset: { purgeAt: 1 } },
          )
          await JobPosting.updateOne(
            { ...closeFilter, userReferenced: { $ne: true } } as never,
            { $set: { purgeAt: new Date(closedAt.getTime() + 7 * 24 * 3600 * 1000) } },
          )
          counters.closedNow += 1
        }
      }
      return chunk.length
    })
  }

  await step.run('telemetry', async () => {
    await JobIngestCycle.create({
      kind: 'link-check',
      sourceId: 'link-check',
      startedAt: now,
      finishedAt: new Date(),
      linkCheck: {
        checked: counters.checked,
        dead: counters.dead,
        alive: counters.alive,
        unverifiable: counters.unverifiable,
        closedNow: counters.closedNow,
        requestedProcessed: counters.requestedProcessed,
        crowdDispositionChanged: counters.crowdDispositionChanged,
        machineDispositionChanged: counters.machineDispositionChanged,
        incidentsCleared: counters.incidentsCleared,
        casMisses: counters.casMisses,
        reopenedNow: counters.reopenedNow,
      },
    })
  })
  logger.info({ ...counters }, 'link-check sweep complete')
  return { checked: counters.checked, closed: counters.closedNow }
}

export const jobsLinkCheckJob = inngest.createFunction(
  // :40 offsets the hourly ingest scheduler (:15) and verdict sweeper (:45).
  { id: 'jobs-link-check', name: 'Jobs: apply-link liveness sweep', retries: 1, triggers: [{ cron: '40 * * * *' }] },
  async ({ step }) => runLinkCheckHandler(step as StepRunner)
)

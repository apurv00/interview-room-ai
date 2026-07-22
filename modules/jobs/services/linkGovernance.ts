import { createHash } from 'node:crypto'
import { canonicalizeCheckableLink } from './safeLinkNetwork'

export const BROKEN_LINK_CROWD_QUORUM = 3
export const BROKEN_LINK_REPORT_WINDOW_MS = 7 * 24 * 60 * 60_000
export const APPLY_OPEN_ATTEMPT_TTL_MS = 24 * 60 * 60_000

export type LinkMachineOutcome = 'dead' | 'alive' | 'unverifiable'
export type BrokenLinkDisposition =
  | 'pending-verification'
  | 'crowd-demoted'
  | 'machine-demoted'

export interface ApplyLinkGovernance {
  subject: string
  generation: string
  incidentVersion: number
  reportWindowStartedAt?: Date
  reportCount: number
  lastReportedAt?: Date
  crowdDemotedAt?: Date
  machineDemotedAt?: Date
  machineOutcome?: LinkMachineOutcome
  machineCheckedAt?: Date
}

export interface ApplyLinkSourceLike {
  applyUrl?: unknown
  applyUrlFirstSeenAt?: unknown
  firstSeenAt?: unknown
  linkGovernance?: unknown
}

export interface ApplyLinkSubjectGroup {
  subject: string
  canonicalUrl: string
  generation: string
  governance: ApplyLinkGovernance
  entries: ApplyLinkSourceLike[]
}

function opaqueId(namespace: string, prefix: string, value: unknown): string {
  const digest = createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('base64url')
  return `${prefix}${digest}`
}

function asDate(value: unknown): Date | undefined {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function latestDate(values: unknown[]): Date | undefined {
  return values
    .map(asDate)
    .filter((value): value is Date => !!value)
    .sort((a, b) => b.getTime() - a.getTime())[0]
}

function earliestDate(values: unknown[]): Date | undefined {
  return values
    .map(asDate)
    .filter((value): value is Date => !!value)
    .sort((a, b) => a.getTime() - b.getTime())[0]
}

export function canonicalApplyUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return canonicalizeCheckableLink(value)?.toString() ?? null
}

export function applyLinkSubjectOf(canonicalUrl: string): string {
  return opaqueId('jobs.apply-link.subject.v1', 'ls1_', canonicalUrl)
}

export function applyLinkGenerationOf(
  subject: string,
  entries: readonly ApplyLinkSourceLike[],
): string {
  // Once a URL group has been materialized, its replicated generation is
  // the continuity token. Preserve it when one duplicate provider disappears
  // or a later provider joins; ingestion clears governance on a true URL
  // replacement, so remove/re-add still creates a new generation.
  const stored = entries
    .map((entry) => entry.linkGovernance)
    .filter((value): value is Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return record.subject === subject &&
        typeof record.generation === 'string' &&
        /^lg1_[A-Za-z0-9_-]{43}$/.test(record.generation)
    })
    .sort((left, right) => (
      (Number(right.incidentVersion) || 0) - (Number(left.incidentVersion) || 0) ||
      String(left.generation).localeCompare(String(right.generation))
    ))[0]
  if (stored) return stored.generation as string

  const firstSeenValues = entries.map((entry) => asDate(entry.applyUrlFirstSeenAt))
  // If any member is an unmaterialized legacy row, the whole exact-URL group
  // remains on the stable legacy generation. A later duplicate provider must
  // not silently mint a new public option identity before ingestion has
  // replicated governance across the group.
  const firstSeen = firstSeenValues.some((value) => !value)
    ? undefined
    : earliestDate(firstSeenValues)
  return opaqueId(
    'jobs.apply-link.generation.v1',
    'lg1_',
    [subject, firstSeen?.toISOString() ?? 'legacy'],
  )
}

export function initialLinkGovernance(
  subject: string,
  generation: string,
): ApplyLinkGovernance {
  return { subject, generation, incidentVersion: 1, reportCount: 0 }
}

function matchingGovernance(
  entry: ApplyLinkSourceLike,
  subject: string,
  generation: string,
): ApplyLinkGovernance | null {
  const value = entry.linkGovernance
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.subject !== subject || record.generation !== generation) return null
  const reportWindowStartedAt = asDate(record.reportWindowStartedAt)
  const storedReportCount =
    typeof record.reportCount === 'number' &&
    Number.isSafeInteger(record.reportCount) &&
    record.reportCount >= 0 &&
    record.reportCount <= BROKEN_LINK_CROWD_QUORUM
      ? record.reportCount
      : 0
  const storedCrowdDemotedAt = asDate(record.crowdDemotedAt)
  const crowdDemotionOffset = reportWindowStartedAt && storedCrowdDemotedAt
    ? storedCrowdDemotedAt.getTime() - reportWindowStartedAt.getTime()
    : -1
  const validCrowdDemotion =
    storedReportCount === BROKEN_LINK_CROWD_QUORUM &&
    !!storedCrowdDemotedAt &&
    crowdDemotionOffset >= 0 &&
    crowdDemotionOffset < BROKEN_LINK_REPORT_WINDOW_MS
  // The quorum write stores count=3 and its timestamp atomically. A quorum
  // count without coherent authority is therefore corruption, not progress.
  const crowdSnapshotValid =
    storedReportCount < BROKEN_LINK_CROWD_QUORUM || validCrowdDemotion
  // Crowd ordering is suppressive authority. Never infer it from an isolated
  // timestamp or count: all three reports and a coherent seven-day incident
  // must be present. Machine evidence remains independent below.
  const reportCount = reportWindowStartedAt && crowdSnapshotValid
    ? storedReportCount
    : 0
  const crowdDemotedAt = validCrowdDemotion ? storedCrowdDemotedAt : undefined
  const machineCheckedAt = asDate(record.machineCheckedAt)
  const machineOutcome = machineCheckedAt && (
    record.machineOutcome === 'dead' ||
    record.machineOutcome === 'alive' ||
    record.machineOutcome === 'unverifiable'
  )
    ? record.machineOutcome
    : undefined
  const storedMachineDemotedAt = asDate(record.machineDemotedAt)
  // Alive is explicit recovery and clears demotion. Dead/unverifiable may
  // carry prior dead authority, but it cannot post-date the observation.
  const machineDemotedAt =
    machineOutcome &&
    machineOutcome !== 'alive' &&
    storedMachineDemotedAt &&
    machineCheckedAt &&
    storedMachineDemotedAt.getTime() <= machineCheckedAt.getTime()
      ? storedMachineDemotedAt
      : undefined
  return {
    subject,
    generation,
    incidentVersion: Math.max(1, Math.floor(Number(record.incidentVersion) || 1)),
    reportCount,
    reportWindowStartedAt: reportCount > 0 ? reportWindowStartedAt : undefined,
    lastReportedAt: reportCount > 0 ? asDate(record.lastReportedAt) : undefined,
    crowdDemotedAt,
    machineDemotedAt,
    machineOutcome,
    machineCheckedAt: machineOutcome ? machineCheckedAt : undefined,
  }
}

function mergedGovernance(
  subject: string,
  generation: string,
  entries: readonly ApplyLinkSourceLike[],
): ApplyLinkGovernance {
  const candidates = entries
    .map((entry) => matchingGovernance(entry, subject, generation))
    .filter((value): value is ApplyLinkGovernance => !!value)
  if (candidates.length === 0) return initialLinkGovernance(subject, generation)
  const incidentVersion = Math.max(...candidates.map((value) => value.incidentVersion))
  const current = candidates.filter((value) => value.incidentVersion === incidentVersion)
  const machineLatest = [...current]
    .filter((value) => value.machineCheckedAt)
    .sort((a, b) => (
      b.machineCheckedAt!.getTime() - a.machineCheckedAt!.getTime() ||
      Number(!!a.machineDemotedAt) - Number(!!b.machineDemotedAt) ||
      String(a.machineOutcome).localeCompare(String(b.machineOutcome))
    ))[0]
  // Replicas are normally identical. On drift, the lowest valid count is the
  // only progress every copy proves; taking a maximum could let one malformed
  // copy turn the next reporter into a fabricated quorum.
  const reportCount = Math.min(...current.map((value) => value.reportCount))
  const reportWindowStartedAt = reportCount > 0
    ? earliestDate(current.map((value) => value.reportWindowStartedAt))
    : undefined
  const coherentCrowdDates = reportWindowStartedAt
    ? current
        .map((value) => value.crowdDemotedAt)
        .filter((value): value is Date => {
          if (!value) return false
          const offset = value.getTime() - reportWindowStartedAt.getTime()
          return offset >= 0 && offset < BROKEN_LINK_REPORT_WINDOW_MS
        })
    : []
  return {
    subject,
    generation,
    incidentVersion,
    reportCount,
    // Drift must never extend an abuse window. The earliest replicated start
    // is the conservative authority when malformed legacy copies disagree.
    reportWindowStartedAt,
    lastReportedAt: latestDate(current.map((value) => value.lastReportedAt)),
    // Keep quorum, window, and demotion coherent. Independent maxima across
    // drifted replicas could otherwise manufacture an eight-day incident
    // that no stored copy ever authorized.
    crowdDemotedAt: reportCount === BROKEN_LINK_CROWD_QUORUM
      ? earliestDate(coherentCrowdDates)
      : undefined,
    // Machine fields are one observation snapshot. Never pair the latest
    // outcome with an older replica's stale demotion flag.
    machineDemotedAt: machineLatest?.machineDemotedAt,
    machineOutcome: machineLatest?.machineOutcome,
    machineCheckedAt: machineLatest?.machineCheckedAt,
  }
}

/** Groups exact canonical URLs, so duplicated providers share one incident. */
export function groupApplyLinkSubjects(
  provenance: readonly ApplyLinkSourceLike[] | null | undefined,
): ApplyLinkSubjectGroup[] {
  const grouped = new Map<string, ApplyLinkSourceLike[]>()
  for (const entry of provenance ?? []) {
    const canonicalUrl = canonicalApplyUrl(entry.applyUrl)
    if (!canonicalUrl) continue
    const entries = grouped.get(canonicalUrl) ?? []
    entries.push(entry)
    grouped.set(canonicalUrl, entries)
  }
  return Array.from(grouped.entries()).map(([canonicalUrl, entries]) => {
    const subject = applyLinkSubjectOf(canonicalUrl)
    const generation = applyLinkGenerationOf(subject, entries)
    return {
      subject,
      canonicalUrl,
      generation,
      governance: mergedGovernance(subject, generation, entries),
      entries,
    }
  })
}

export function linkDispositionOf(
  governance: Pick<ApplyLinkGovernance, 'crowdDemotedAt' | 'machineDemotedAt'>,
): BrokenLinkDisposition {
  if (governance.machineDemotedAt) return 'machine-demoted'
  if (governance.crowdDemotedAt) return 'crowd-demoted'
  return 'pending-verification'
}

export function nextCrowdReportGovernance(
  current: ApplyLinkGovernance,
  now: Date,
): ApplyLinkGovernance {
  const windowExpired = !!current.reportWindowStartedAt &&
    now.getTime() - current.reportWindowStartedAt.getTime() >= BROKEN_LINK_REPORT_WINDOW_MS
  // Incident rollover belongs to the trusted open transaction. A report may
  // never validate an old incident and silently write into a new one.
  if (windowExpired) return { ...current }
  const reportCount = Math.min(BROKEN_LINK_CROWD_QUORUM, current.reportCount + 1)
  return {
    ...current,
    reportWindowStartedAt: current.reportWindowStartedAt ?? now,
    reportCount,
    lastReportedAt: now,
    crowdDemotedAt: reportCount >= BROKEN_LINK_CROWD_QUORUM
      ? current.crowdDemotedAt ?? now
      : undefined,
  }
}

/** A fresh trusted open starts the next crowd incident after window expiry. */
export function normalizeExpiredCrowdIncident(
  current: ApplyLinkGovernance,
  now: Date,
): ApplyLinkGovernance {
  if (
    !current.reportWindowStartedAt ||
    now.getTime() - current.reportWindowStartedAt.getTime() < BROKEN_LINK_REPORT_WINDOW_MS
  ) return { ...current }
  return {
    ...current,
    incidentVersion: current.incidentVersion + 1,
    reportWindowStartedAt: undefined,
    reportCount: 0,
    lastReportedAt: undefined,
    crowdDemotedAt: undefined,
  }
}

export function nextMachineGovernance(
  current: ApplyLinkGovernance,
  outcome: LinkMachineOutcome,
  checkedAt: Date,
): ApplyLinkGovernance {
  if (outcome === 'alive') {
    return {
      subject: current.subject,
      generation: current.generation,
      incidentVersion: current.incidentVersion + 1,
      reportCount: 0,
      machineOutcome: outcome,
      machineCheckedAt: checkedAt,
    }
  }
  if (outcome === 'dead') {
    return {
      ...current,
      machineOutcome: outcome,
      machineCheckedAt: checkedAt,
      machineDemotedAt: current.machineDemotedAt ?? checkedAt,
    }
  }
  return { ...current, machineOutcome: outcome, machineCheckedAt: checkedAt }
}

/** Replicates anonymous aggregate state to every current duplicate URL rung. */
export function withReplicatedLinkGovernance<T extends ApplyLinkSourceLike>(
  provenance: readonly T[],
  subject: string,
  governance: ApplyLinkGovernance,
): T[] {
  return provenance.map((entry) => {
    const canonicalUrl = canonicalApplyUrl(entry.applyUrl)
    return canonicalUrl && applyLinkSubjectOf(canonicalUrl) === subject
      ? { ...entry, linkGovernance: { ...governance } }
      : { ...entry }
  })
}

import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, InterviewSession, PathwayPlan, ServedProblem, JobApplication, ProductEvent, JobsEmailSend, JobPracticeEvidence } from '@shared/db/models'
import { UserCompetencyState } from '@shared/db/models/UserCompetencyState'
import { WeaknessCluster } from '@shared/db/models/WeaknessCluster'
import { SessionSummary } from '@shared/db/models/SessionSummary'
import { XpEvent } from '@shared/db/models/XpEvent'
import { UserBadge } from '@shared/db/models/UserBadge'
import { logger } from '@shared/logger'
import {
  isAnswerScoringReceipt,
  isModelExecutionProvenance,
  type ModelExecutionProvenance,
} from '@shared/services/scoringProvenance'

const EXPORT_BATCH_SIZE = 500
const HEX_64 = /^[a-f0-9]{64}$/

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? null : date
}

function safeModelExecution(value: unknown): ModelExecutionProvenance | null {
  if (!isModelExecutionProvenance(value)) return null
  return {
    schemaVersion: value.schemaVersion,
    taskSlot: value.taskSlot,
    contractVersion: value.contractVersion,
    model: value.model,
    provider: value.provider,
    usedFallback: value.usedFallback,
    attemptKind: value.attemptKind,
    configDigest: value.configDigest,
    fingerprint: value.fingerprint,
  }
}

function safeAnswerScoringReceipt(value: unknown): Record<string, unknown> | null {
  if (!isAnswerScoringReceipt(value)) return null
  const execution = safeModelExecution(value.execution)
  const recordedAt = safeDate(value.recordedAt)
  if (!execution || !recordedAt) return null
  return {
    schemaVersion: value.schemaVersion,
    bindingHash: value.bindingHash,
    execution,
    recordedAt,
  }
}

function safeEvidenceProvenance(
  value: unknown,
  scoringEpoch: string,
): Record<string, unknown> | null {
  const provenance = recordOf(value)
  if (!provenance || provenance.schemaVersion !== 1) return null
  if (provenance.status === 'attested') {
    const scoring = safeModelExecution(provenance.scoring)
    const attribution = safeModelExecution(provenance.attribution)
    if (!scoring || !attribution || scoringEpoch !== scoring.fingerprint) return null
    return { schemaVersion: 1, status: 'attested', scoring, attribution }
  }
  if (provenance.status === 'legacy-unverifiable') {
    const quarantinedAt = safeDate(provenance.quarantinedAt)
    if (
      provenance.quarantineReason !== 'pre-provenance-contract' ||
      !quarantinedAt ||
      provenance.scoring != null ||
      provenance.attribution != null
    ) return null
    return {
      schemaVersion: 1,
      status: 'legacy-unverifiable',
      quarantineReason: 'pre-provenance-contract',
      quarantinedAt,
    }
  }
  return null
}

function safeExecutionArray(value: unknown): ModelExecutionProvenance[] | null {
  if (!Array.isArray(value)) return null
  const executions = value.map(safeModelExecution)
  return executions.every((execution): execution is ModelExecutionProvenance => execution !== null)
    ? executions
    : null
}

function safeReadinessSnapshot(value: unknown): Record<string, unknown> | null {
  const readiness = recordOf(value)
  const provenance = recordOf(readiness?.provenance)
  if (!readiness || !provenance || provenance.schemaVersion !== 1) return null
  const scoring = safeExecutionArray(provenance.scoring)
  const attribution = safeExecutionArray(provenance.attribution)
  const at = safeDate(readiness.at)
  if (
    !scoring || !attribution || !at ||
    readiness.handoffVersion !== 1 ||
    !['none', 'building', 'practiced', 'strong-evidence'].includes(String(readiness.band)) ||
    typeof readiness.scoringEpoch !== 'string' || !HEX_64.test(readiness.scoringEpoch)
  ) return null
  return {
    handoffVersion: 1,
    band: readiness.band,
    sessions: readiness.sessions,
    practicedCount: readiness.practicedCount,
    mustHaveTotal: readiness.mustHaveTotal,
    quality: readiness.quality,
    strongCoverage: readiness.strongCoverage,
    xrayHash: readiness.xrayHash,
    scoringEpoch: readiness.scoringEpoch,
    provenance: { schemaVersion: 1, scoring, attribution },
    at,
  }
}

async function allInterviewSessions(userId: mongoose.Types.ObjectId): Promise<Array<Record<string, unknown>>> {
  const sessions: Array<Record<string, unknown>> = []
  let cursor: mongoose.Types.ObjectId | null = null
  for (;;) {
    const batch = await InterviewSession.find({
      userId,
      ...(cursor ? { _id: { $lt: cursor } } : {}),
    })
      // Do not hydrate transcripts, evaluations, JD/resume context, or other
      // large session fields that this export projection never returns.
      .select('_id config status feedback answerScoringReceipts createdAt completedAt')
      .sort({ _id: -1 })
      .limit(EXPORT_BATCH_SIZE)
      .lean() as unknown as Array<Record<string, unknown>>
    sessions.push(...batch)
    if (batch.length < EXPORT_BATCH_SIZE) return sessions
    const lastId = batch[batch.length - 1]._id
    if (!lastId) throw new Error('InterviewSession export page is missing its cursor id')
    cursor = lastId as mongoose.Types.ObjectId
  }
}

/**
 * Generate a comprehensive data export for a user (GDPR Article 20).
 * Returns all personal data in a structured JSON format.
 */
export async function generateDataExport(userId: string): Promise<Record<string, unknown>> {
  await connectDB()
  const uid = new mongoose.Types.ObjectId(userId)

  const [
    user,
    sessions,
    pathwayPlan,
    competencies,
    weaknesses,
    summaries,
    xpEvents,
    badges,
    servedProblems,
  ] = await Promise.all([
    User.findById(uid).select('-password -__v').lean(),
    allInterviewSessions(uid),
    PathwayPlan.findOne({ userId: uid }).sort({ generatedAt: -1 }).lean(),
    UserCompetencyState.find({ userId: uid }).select('-__v').lean(),
    WeaknessCluster.find({ userId: uid }).select('-__v').lean(),
    SessionSummary.find({ userId: uid }).sort({ sessionDate: -1 }).limit(50).lean(),
    XpEvent.find({ userId: uid }).sort({ createdAt: -1 }).limit(200).lean(),
    UserBadge.find({ userId: uid }).lean(),
    // GDPR completeness: the served-problem ledger holds per-user interview
    // metadata and (for AI picks) the full generated problem body.
    ServedProblem.find({ userId: uid }).select('-__v').sort({ servedAt: -1 }).limit(300).lean(),
  ])

  // GDPR completeness (jobs Wave 1b): application outcomes are Article-20
  // core. Fetch ALL rows via _id-cursor batches — the model has no
  // retention cap, so a fixed limit silently truncates active users'
  // tracker history (Codex #508).
  type LeanJobApplication = {
    _id: mongoose.Types.ObjectId
    jobSnapshot?: Record<string, unknown>
    status?: string
    statusHistory?: unknown[]
    appliedAt?: Date
    appliedWith?: { resumeId?: string; wasTailored: boolean; tailoredFromResumeId?: string }
    interviewDate?: Date
    interviewDateConfidence?: 'exact' | 'week' | 'unknown'
    interviewDatePreference?: 'this-week' | 'next-week' | 'unknown'
    outcome?: Record<string, unknown>
    notes?: string
    clickedApplyOptionIds?: string[]
    applyOpenAttempts?: Array<{
      optionId: string
      subject: string
      generation: string
      incidentVersion: number
      openedAt: Date
    }>
    brokenLinkReports?: Array<{
      optionId?: string
      url: string
      tier?: string
      reportedAt: Date
      subject?: string
      generation?: string
      incidentVersion?: number
      disposition?: 'pending-verification' | 'crowd-demoted' | 'machine-demoted'
    }>
    tailoredVersion?: {
      sourceResumeId: string
      tailoredText: string
      structured?: unknown
      matchScore?: number
      addedKeywords: string[]
      missingKeywords: string[]
      jdHash: string
      createdAt: Date
    }
    atsResult?: Record<string, unknown>
    readiness?: Record<string, unknown>
    createdAt?: Date
  }
  const jobApplications: LeanJobApplication[] = []
  let appCursor: mongoose.Types.ObjectId | null = null
  for (;;) {
    const batch = (await JobApplication.find({
      userId: uid,
      ...(appCursor ? { _id: { $lt: appCursor } } : {}),
    })
      .select('-__v')
      .sort({ _id: -1 })
      .limit(500)
      .lean()) as unknown as LeanJobApplication[]
    jobApplications.push(...batch)
    if (batch.length < 500) break
    appCursor = batch[batch.length - 1]._id
  }

  // Product events: paginated fetch-ALL — a fixed cap silently truncates
  // the behavioral record for active users (180d retention x 300/day
  // ceiling >> any single-query limit; Codex #508). _id-cursor batches
  // keep memory bounded without skip() degradation.
  type LeanProductEvent = {
    _id: mongoose.Types.ObjectId
    name: string
    jobPostingId?: mongoose.Types.ObjectId
    applicationId?: mongoose.Types.ObjectId
    sessionId?: mongoose.Types.ObjectId
    props?: Record<string, unknown>
    ts: Date
  }
  const productEvents: LeanProductEvent[] = []
  let eventCursor: mongoose.Types.ObjectId | null = null
  for (;;) {
    const batch = (await ProductEvent.find({
      userId: uid,
      ...(eventCursor ? { _id: { $lt: eventCursor } } : {}),
    })
      .select('-__v')
      .sort({ _id: -1 })
      .limit(2000)
      .lean()) as unknown as LeanProductEvent[]
    productEvents.push(...batch)
    if (batch.length < 2000) break
    eventCursor = batch[batch.length - 1]._id
  }

  if (!user) {
    throw new Error('User not found')
  }

  // Jobs email send history (EMAILS.md ledger) — personal data: which
  // emails we sent this user and when. Cursor-paginated to exhaustion like
  // every other per-user collection here — a GDPR export must never
  // silently truncate (Codex #531; cap-exempt E0/E2 make the row count
  // unbounded over a user's lifetime).
  interface LeanEmailSend {
    _id: mongoose.Types.ObjectId
    stream: string
    dedupeKey: string
    incidentKind?: string
    sentAt?: Date
    operatorResolution?: {
      kind: string
      at: Date
    }
    createdAt: Date
  }
  const jobsEmailSendRows: LeanEmailSend[] = []
  let emailCursor: mongoose.Types.ObjectId | null = null
  for (;;) {
    const batch = (await JobsEmailSend.find({
      userId: uid,
      ...(emailCursor ? { _id: { $lt: emailCursor } } : {}),
    })
      .select(
        'stream dedupeKey incidentKind sentAt operatorResolution.kind operatorResolution.at createdAt',
      )
      .sort({ _id: -1 })
      .limit(2000)
      .lean()) as unknown as LeanEmailSend[]
    jobsEmailSendRows.push(...batch)
    if (batch.length < 2000) break
    emailCursor = batch[batch.length - 1]._id
  }
  const jobsEmailSends = jobsEmailSendRows.map(({
    stream,
    dedupeKey,
    incidentKind,
    sentAt,
    operatorResolution,
    createdAt,
  }) => ({
    stream,
    dedupeKey,
    ...(incidentKind ? { incidentKind } : {}),
    sentAt,
    ...(operatorResolution
      ? {
          operatorResolution: {
            kind: operatorResolution.kind,
            at: operatorResolution.at,
          },
        }
      : {}),
    createdAt,
  }))

  // Readiness evidence (READINESS.md §1) — cursor-paginated to exhaustion
  // like every per-user collection here.
  interface LeanEvidence { _id: mongoose.Types.ObjectId; requirementId: string; xrayHash: string; handoffVersion?: number; handoffJdHash?: string; strength: string; answerScore: number; scoringEpoch: string; provenance?: Record<string, unknown>; at: Date; sessionId: mongoose.Types.ObjectId; jobPostingId: mongoose.Types.ObjectId }
  const practiceEvidenceRows: LeanEvidence[] = []
  let evidenceCursor: mongoose.Types.ObjectId | null = null
  for (;;) {
    const batch = (await JobPracticeEvidence.find({
      userId: uid,
      ...(evidenceCursor ? { _id: { $lt: evidenceCursor } } : {}),
    })
      .select('requirementId xrayHash handoffVersion handoffJdHash strength answerScore scoringEpoch provenance at sessionId jobPostingId')
      .sort({ _id: -1 })
      .limit(2000)
      .lean()) as unknown as LeanEvidence[]
    practiceEvidenceRows.push(...batch)
    if (batch.length < 2000) break
    evidenceCursor = batch[batch.length - 1]._id
  }
  const jobPracticeEvidence = practiceEvidenceRows.map(({ _id, provenance, scoringEpoch, ...rest }) => {
    const safeProvenance = safeEvidenceProvenance(provenance, scoringEpoch)
    return {
      ...rest,
      scoringEpoch,
      // Historical or malformed values remain visible as unverified epoch
      // strings but are never relabelled as attested execution facts.
      scoringEpochStatus: safeProvenance?.status === 'attested'
        ? 'attested-execution-fingerprint'
        : 'legacy-unverified',
      provenance: safeProvenance,
    }
  })

  return {
    exportedAt: new Date().toISOString(),
    exportVersion: '1.1',
    userId: user._id?.toString(),

    profile: {
      name: user.name,
      email: user.email,
      role: user.role,
      plan: user.plan,
      currentTitle: user.currentTitle,
      currentIndustry: user.currentIndustry,
      targetRole: user.targetRole,
      interviewGoal: user.interviewGoal,
      weakAreas: user.weakAreas,
      topSkills: user.topSkills,
      createdAt: user.createdAt,
    },

    resumes: (user.savedResumes || []).map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      targetRole: r.targetRole,
      experience: r.experience,
      education: r.education,
      skills: r.skills,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),

    starStories: user.starStories || [],

    interviewSessions: sessions.map(s => ({
      id: s._id?.toString(),
      config: s.config,
      status: s.status,
      feedback: recordOf(s.feedback) ? {
        overallScore: recordOf(s.feedback)!.overall_score,
        passProb: recordOf(s.feedback)!.pass_probability,
        improvements: recordOf(s.feedback)!.top_3_improvements,
      } : null,
      answerScoringReceipts: (Array.isArray(s.answerScoringReceipts) ? s.answerScoringReceipts : [])
        .map(safeAnswerScoringReceipt)
        .filter((receipt): receipt is Record<string, unknown> => receipt !== null),
      createdAt: s.createdAt,
      completedAt: s.completedAt,
    })),

    learningProgress: {
      xp: user.xp,
      level: user.level,
      currentStreak: user.currentStreak,
      longestStreak: user.longestStreak,
      practiceStats: user.practiceStats,
    },

    competencyScores: competencies.map(c => ({
      competency: c.competencyName,
      domain: c.domain,
      score: c.currentScore,
      trend: c.trend,
      confidence: c.confidenceInterval,
    })),

    weaknessClusters: weaknesses.map(w => ({
      name: w.weaknessName,
      severity: w.severity,
      recurrenceCount: w.recurrenceCount,
      linkedCompetencies: w.linkedCompetencies,
    })),

    pathwayPlan: pathwayPlan ? {
      readinessLevel: pathwayPlan.readinessLevel,
      readinessScore: pathwayPlan.readinessScore,
      planType: pathwayPlan.planType,
      dailySchedule: pathwayPlan.dailySchedule,
      generatedAt: pathwayPlan.generatedAt,
    } : null,

    sessionSummaries: summaries.map(s => ({
      domain: s.domain,
      overallScore: s.overallScore,
      strengths: s.strengths,
      weaknesses: s.weaknesses,
      sessionDate: s.sessionDate,
    })),

    badges: badges.map(b => ({
      badgeId: b.badgeId,
      earnedAt: b.earnedAt,
    })),

    servedProblems: servedProblems.map(p => ({
      kind: p.kind,
      problemId: p.problemId,
      title: p.title,
      domain: p.domain,
      difficulty: p.difficulty,
      source: p.source,
      problemBody: p.problemBody ?? null,
      servedAt: p.servedAt,
    })),

    xpHistory: xpEvents.map(e => ({
      type: e.type,
      amount: e.amount,
      createdAt: e.createdAt,
    })),

    jobApplications: jobApplications.map(a => ({
      id: a._id?.toString(),
      job: a.jobSnapshot,
      status: a.status,
      statusHistory: a.statusHistory,
      appliedAt: a.appliedAt,
      // The per-application submission record — which resume, tailored or
      // not (Codex #508).
      appliedWith: a.appliedWith ?? null,
      // A coarse week answer is a user-authored preference, not an event
      // date. Historical rows may carry a synthetic date or no confidence,
      // so an explicit `exact` confidence is required before a date can be
      // presented as the interview date. The raw legacy value is retained
      // separately for export completeness.
      ...(a.interviewDateConfidence === 'exact' && a.interviewDate
        ? { interviewDate: a.interviewDate }
        : {}),
      ...(a.interviewDateConfidence !== 'exact' && a.interviewDate
        ? { legacyInterviewDateAnchor: a.interviewDate }
        : {}),
      interviewDateConfidence: a.interviewDateConfidence ?? null,
      interviewDatePreference: a.interviewDatePreference ?? null,
      outcome: a.outcome,
      notes: a.notes,
      // Apply-option ids and dead-link reports are behavioral records. Keep
      // the stored ids for portability and make legacy reports explicit: old
      // rows predate canonical option ids/tiers, so null means "not recorded"
      // rather than silently dropping those fields during JSON serialization.
      clickedApplyOptionIds: a.clickedApplyOptionIds ?? [],
      applyOpenAttempts: (a.applyOpenAttempts ?? []).map((attempt) => ({
        optionId: attempt.optionId,
        subject: attempt.subject,
        generation: attempt.generation,
        incidentVersion: attempt.incidentVersion,
        openedAt: attempt.openedAt,
      })),
      brokenLinkReports: (a.brokenLinkReports ?? []).map((report) => ({
        optionId: report.optionId ?? null,
        url: report.url,
        tier: report.tier ?? null,
        reportedAt: report.reportedAt,
        subject: report.subject ?? null,
        generation: report.generation ?? null,
        incidentVersion: report.incidentVersion ?? null,
        disposition: report.disposition ?? null,
      })),
      // The tailored resume is the user's ONLY per-job copy — export it
      // in full, not just its metadata (Codex #508).
      tailoredVersion: a.tailoredVersion ? {
        sourceResumeId: a.tailoredVersion.sourceResumeId,
        tailoredText: a.tailoredVersion.tailoredText,
        structured: a.tailoredVersion.structured ?? null,
        matchScore: a.tailoredVersion.matchScore,
        addedKeywords: a.tailoredVersion.addedKeywords,
        missingKeywords: a.tailoredVersion.missingKeywords,
        jdHash: a.tailoredVersion.jdHash,
        createdAt: a.tailoredVersion.createdAt,
      } : null,
      atsResult: a.atsResult ?? null,
      readiness: safeReadinessSnapshot(a.readiness),
      createdAt: a.createdAt,
    })),

    jobsEmailSends,
    jobPracticeEvidence,
    productEvents: productEvents.map((e) => ({
      name: e.name,
      jobPostingId: e.jobPostingId?.toString(),
      applicationId: e.applicationId?.toString(),
      sessionId: e.sessionId?.toString(),
      // props ARE the behavioral record (method/tier/trigger/outcomes) —
      // Article-20 core, bounded by the closed input schema (Codex #508).
      props: e.props ?? null,
      ts: e.ts,
    })),
  }
}

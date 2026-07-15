import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, InterviewSession, PathwayPlan, ServedProblem, JobApplication, ProductEvent, JobsEmailSend } from '@shared/db/models'
import { UserCompetencyState } from '@shared/db/models/UserCompetencyState'
import { WeaknessCluster } from '@shared/db/models/WeaknessCluster'
import { SessionSummary } from '@shared/db/models/SessionSummary'
import { XpEvent } from '@shared/db/models/XpEvent'
import { UserBadge } from '@shared/db/models/UserBadge'
import { logger } from '@shared/logger'

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
    InterviewSession.find({ userId: uid })
      .select('-__v')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
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
    outcome?: Record<string, unknown>
    notes?: string
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
  // emails we sent this user and when. Small per user (hard budgets), so a
  // single bounded read suffices.
  const jobsEmailSends = await JobsEmailSend.find({ userId: uid })
    .select('stream dedupeKey sentAt createdAt -_id')
    .sort({ createdAt: -1 })
    .limit(1000)
    .lean()

  return {
    exportedAt: new Date().toISOString(),
    exportVersion: '1.0',
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
      feedback: s.feedback ? {
        overallScore: s.feedback.overall_score,
        passProb: s.feedback.pass_probability,
        improvements: s.feedback.top_3_improvements,
      } : null,
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
      interviewDate: a.interviewDate,
      outcome: a.outcome,
      notes: a.notes,
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
      createdAt: a.createdAt,
    })),

    jobsEmailSends,
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

import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, InterviewSession, PathwayPlan, ServedProblem, JobApplication, ProductEvent } from '@shared/db/models'
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
    jobApplications,
    productEvents,
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
    // GDPR completeness (jobs Wave 1b): application outcomes are Article-20
    // core; product events are the user's behavioral record.
    JobApplication.find({ userId: uid }).select('-__v').sort({ updatedAt: -1 }).limit(500).lean(),
    ProductEvent.find({ userId: uid }).select('-__v').sort({ ts: -1 }).limit(1000).lean(),
  ])

  if (!user) {
    throw new Error('User not found')
  }

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
      interviewDate: a.interviewDate,
      outcome: a.outcome,
      notes: a.notes,
      tailoredVersion: a.tailoredVersion ? {
        matchScore: a.tailoredVersion.matchScore,
        addedKeywords: a.tailoredVersion.addedKeywords,
        missingKeywords: a.tailoredVersion.missingKeywords,
        createdAt: a.tailoredVersion.createdAt,
      } : null,
      atsResult: a.atsResult ?? null,
      createdAt: a.createdAt,
    })),

    productEvents: productEvents.map(e => ({
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

import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { UserCompetencyState, WeaknessCluster } from '@shared/db/models'
import type { AnswerEvaluation } from '@shared/types'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

// ─── Competency Taxonomy ─────────────────────────────────────────────────────

export const UNIVERSAL_COMPETENCIES = [
  'relevance', 'structure', 'specificity', 'ownership', 'communication',
  'self_awareness', 'confidence', 'composure',
] as const

export const DOMAIN_COMPETENCIES: Record<string, string[]> = {
  // General
  general: ['communication', 'problem_solving', 'leadership', 'teamwork', 'adaptability'],
  // Engineering
  frontend: ['ui_architecture', 'css_mastery', 'web_performance', 'accessibility', 'component_design', 'collaboration'],
  backend: ['technical_accuracy', 'system_design', 'problem_solving', 'debugging', 'code_quality', 'collaboration', 'infrastructure_knowledge', 'reliability_thinking'],
  sdet: ['test_strategy', 'automation_depth', 'quality_mindset', 'ci_cd_expertise', 'debugging', 'collaboration'],
  'data-science': ['statistical_knowledge', 'ml_depth', 'experiment_design', 'data_storytelling', 'business_impact'],
  // Product & Design
  pm: ['product_sense', 'prioritization', 'metrics_thinking', 'stakeholder_management', 'execution', 'tradeoff_reasoning'],
  design: ['design_thinking', 'user_empathy', 'craft', 'prototyping', 'accessibility'],
  // Business
  business: ['strategic_thinking', 'structured_thinking', 'leadership', 'analytical_skills', 'framework_usage', 'client_management', 'persuasion', 'financial_modeling'],
}

export function getCompetenciesForDomain(domain: string): string[] {
  return [
    ...UNIVERSAL_COMPETENCIES,
    ...(DOMAIN_COMPETENCIES[domain] || []),
  ]
}

// ─── Update Competency State from Evaluations ────────────────────────────────

interface CompetencyUpdate {
  userId: string
  sessionId: string
  domain: string
  evaluations: AnswerEvaluation[]
  additionalScores?: Record<string, number>  // from structured evaluation
}

export async function updateCompetencyState(input: CompetencyUpdate): Promise<void> {
  if (!isFeatureEnabled('competency_tracking')) return

  try {
    await connectDB()
    const { userId, sessionId, domain, evaluations, additionalScores } = input

    // Extract scores from evaluations
    const scoreMap: Record<string, number[]> = {}

    for (const ev of evaluations) {
      if (ev.relevance !== undefined) pushScore(scoreMap, 'relevance', ev.relevance)
      if (ev.structure !== undefined) pushScore(scoreMap, 'structure', ev.structure)
      if (ev.specificity !== undefined) pushScore(scoreMap, 'specificity', ev.specificity)
      if (ev.ownership !== undefined) pushScore(scoreMap, 'ownership', ev.ownership)
    }

    // Merge additional scores from evaluation engine
    if (additionalScores) {
      for (const [key, value] of Object.entries(additionalScores)) {
        pushScore(scoreMap, key, value)
      }
    }

    // Update each competency
    const userObjectId = new mongoose.Types.ObjectId(userId)
    const sessionObjectId = new mongoose.Types.ObjectId(sessionId)

    for (const [competency, scores] of Object.entries(scoreMap)) {
      const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)

      const existing = await UserCompetencyState.findOne({
        userId: userObjectId,
        competencyName: competency,
        domain,
      })

      if (existing) {
        // Exponential moving average: weight recent scores more
        const alpha = 0.3  // new data weight
        const newScore = Math.round(alpha * avgScore + (1 - alpha) * existing.currentScore)

        // Calculate trend from history
        existing.scoreHistory.push({
          score: avgScore,
          sessionId: sessionObjectId,
          timestamp: new Date(),
        })

        // Keep last 20 data points
        if (existing.scoreHistory.length > 20) {
          existing.scoreHistory = existing.scoreHistory.slice(-20)
        }

        const trend = calculateTrend(existing.scoreHistory.map(h => h.score))
        const confidence = Math.min(1, existing.evidenceCount / 10)

        await UserCompetencyState.updateOne(
          { _id: existing._id },
          {
            $set: {
              currentScore: newScore,
              trend,
              confidenceInterval: confidence,
              lastUpdated: new Date(),
              scoreHistory: existing.scoreHistory,
            },
            $inc: { evidenceCount: 1 },
          }
        )
      } else {
        await UserCompetencyState.create({
          userId: userObjectId,
          competencyName: competency,
          domain,
          currentScore: avgScore,
          confidenceInterval: 0.1,
          trend: 'stable',
          evidenceCount: 1,
          lastUpdated: new Date(),
          scoreHistory: [{
            score: avgScore,
            sessionId: sessionObjectId,
            timestamp: new Date(),
          }],
        })
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to update competency state')
  }
}

// ─── Get User Competency Summary ────────────────────────────────────────────

export interface CompetencySummary {
  competencies: Array<{
    name: string
    score: number
    trend: 'improving' | 'stable' | 'declining'
    confidence: number
  }>
  strongAreas: string[]
  weakAreas: string[]
  overallReadiness: number
}

export async function getUserCompetencySummary(
  userId: string,
  domain?: string
): Promise<CompetencySummary | null> {
  if (!isFeatureEnabled('competency_tracking')) return null

  try {
    await connectDB()

    const filter: Record<string, unknown> = { userId: new mongoose.Types.ObjectId(userId) }
    if (domain) filter.domain = { $in: [domain, '*'] }

    const states = await UserCompetencyState.find(filter)
      .sort({ currentScore: -1 })
      .lean()

    if (!states.length) return null

    const competencies = states.map(s => ({
      name: s.competencyName,
      score: s.currentScore,
      trend: s.trend,
      confidence: s.confidenceInterval,
    }))

    const strongAreas = competencies
      .filter(c => c.score >= 70 && c.confidence >= 0.3)
      .map(c => c.name)
      .slice(0, 5)

    const weakAreas = competencies
      .filter(c => c.score < 55 && c.confidence >= 0.2)
      .map(c => c.name)
      .slice(0, 5)

    const overallReadiness = Math.round(
      competencies.reduce((sum, c) => sum + c.score * c.confidence, 0) /
      Math.max(1, competencies.reduce((sum, c) => sum + c.confidence, 0))
    )

    return { competencies, strongAreas, weakAreas, overallReadiness }
  } catch (err) {
    logger.error({ err }, 'Failed to get competency summary')
    return null
  }
}

// ─── Update Weakness Clusters ────────────────────────────────────────────────

interface WeaknessInput {
  userId: string
  sessionId: string
  weaknesses: Array<{
    name: string
    description: string
    linkedCompetencies: string[]
    questionIndex: number
    observation: string
  }>
}

export async function updateWeaknessClusters(input: WeaknessInput): Promise<void> {
  if (!isFeatureEnabled('weakness_clusters')) return

  try {
    await connectDB()
    const { userId, sessionId, weaknesses } = input
    const userObjectId = new mongoose.Types.ObjectId(userId)
    const sessionObjectId = new mongoose.Types.ObjectId(sessionId)

    for (const weakness of weaknesses) {
      const existing = await WeaknessCluster.findOne({
        userId: userObjectId,
        weaknessName: weakness.name,
      })

      if (existing) {
        // Update existing cluster
        existing.recurrenceCount += 1
        existing.lastSeen = new Date()
        existing.evidence.push({
          sessionId: sessionObjectId,
          questionIndex: weakness.questionIndex,
          observation: weakness.observation,
          timestamp: new Date(),
        })

        // Keep last 10 evidence items
        if (existing.evidence.length > 10) {
          existing.evidence = existing.evidence.slice(-10)
        }

        // Update severity based on recurrence
        if (existing.recurrenceCount >= 5) existing.severity = 'critical'
        else if (existing.recurrenceCount >= 3) existing.severity = 'moderate'

        await existing.save()
      } else {
        await WeaknessCluster.create({
          userId: userObjectId,
          weaknessName: weakness.name,
          description: weakness.description,
          severity: 'minor',
          recurrenceCount: 1,
          lastSeen: new Date(),
          firstSeen: new Date(),
          linkedCompetencies: weakness.linkedCompetencies,
          evidence: [{
            sessionId: sessionObjectId,
            questionIndex: weakness.questionIndex,
            observation: weakness.observation,
            timestamp: new Date(),
          }],
        })
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to update weakness clusters')
  }
}

export async function getUserWeaknesses(userId: string, limit = 5): Promise<Array<{
  name: string
  description: string
  severity: string
  recurrenceCount: number
  linkedCompetencies: string[]
}>> {
  if (!isFeatureEnabled('weakness_clusters')) return []

  try {
    await connectDB()
    const clusters = await WeaknessCluster.find({
      userId: new mongoose.Types.ObjectId(userId),
    })
      .sort({ severity: -1, recurrenceCount: -1 })
      .limit(limit)
      .lean()

    return clusters.map(c => ({
      name: c.weaknessName,
      description: c.description,
      severity: c.severity,
      recurrenceCount: c.recurrenceCount,
      linkedCompetencies: c.linkedCompetencies,
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get user weaknesses')
    return []
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pushScore(map: Record<string, number[]>, key: string, value: number) {
  if (!map[key]) map[key] = []
  map[key].push(value)
}

function calculateTrend(scores: number[]): 'improving' | 'stable' | 'declining' {
  if (scores.length < 3) return 'stable'

  const recent = scores.slice(-3)
  const earlier = scores.slice(-6, -3)

  if (earlier.length === 0) return 'stable'

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length
  const diff = recentAvg - earlierAvg

  if (diff > 5) return 'improving'
  if (diff < -5) return 'declining'
  return 'stable'
}

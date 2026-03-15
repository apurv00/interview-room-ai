import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { SessionSummary } from '@shared/db/models'
import { redis } from '@shared/redis'
import { computePercentile } from '@learn/lib/peerComparison'
import { aiLogger as logger } from '@shared/logger'

export interface BenchmarkResult {
  available: boolean
  peerCount: number
  overallPercentile: number | null
  overallAvg: number | null
  dimensionPercentiles: Array<{
    dimension: string
    percentile: number
    userScore: number
    peerAvg: number
  }>
  distribution: Array<{
    bucket: string
    count: number
  }>
}

const CACHE_TTL = 21600 // 6h
const MIN_PEERS = 5

export async function getPeerBenchmark(
  userId: string,
  userOverallScore: number,
  userDimensionScores: Record<string, number>,
  domain?: string,
  interviewType?: string,
): Promise<BenchmarkResult> {
  const empty: BenchmarkResult = {
    available: false,
    peerCount: 0,
    overallPercentile: null,
    overallAvg: null,
    dimensionPercentiles: [],
    distribution: [],
  }

  try {
    await connectDB()

    const cacheKey = `benchmark:${domain || 'all'}:${interviewType || 'all'}`

    // Check cache
    let cached: {
      peerCount: number
      overallScores: number[]
      dimensionScores: Record<string, number[]>
      overallAvg: number
      dimensionAvgs: Record<string, number>
    } | null = null

    try {
      const raw = await redis.get(cacheKey)
      if (raw) cached = JSON.parse(raw)
    } catch { /* continue */ }

    if (!cached) {
      // Aggregate from SessionSummary
      const filter: Record<string, unknown> = {
        userId: { $ne: new mongoose.Types.ObjectId(userId) }, // exclude self
      }
      if (domain) filter.domain = domain
      if (interviewType) filter.interviewType = interviewType

      const summaries = await SessionSummary.find(filter)
        .select('overallScore competencyScores')
        .lean()

      if (summaries.length < MIN_PEERS) {
        return { ...empty, peerCount: summaries.length }
      }

      const overallScores = summaries
        .map(s => s.overallScore)
        .filter(s => s > 0)
        .sort((a, b) => a - b)

      const dimensionKeys = ['relevance', 'structure', 'specificity', 'ownership']
      const dimensionScores: Record<string, number[]> = {}
      const dimensionAvgs: Record<string, number> = {}

      for (const key of dimensionKeys) {
        const scores = summaries
          .map(s => (s.competencyScores as Record<string, number>)?.[key])
          .filter((v): v is number => v != null && v > 0)
          .sort((a, b) => a - b)
        dimensionScores[key] = scores
        dimensionAvgs[key] = scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0
      }

      const overallAvg = overallScores.length > 0
        ? Math.round(overallScores.reduce((a, b) => a + b, 0) / overallScores.length)
        : 0

      cached = {
        peerCount: summaries.length,
        overallScores,
        dimensionScores,
        overallAvg,
        dimensionAvgs,
      }

      // Cache
      try {
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(cached))
      } catch { /* non-critical */ }
    }

    // Compute user percentiles
    const overallPercentile = computePercentile(cached.overallScores, userOverallScore)

    const dimensionPercentiles = Object.entries(cached.dimensionScores).map(([dim, scores]) => ({
      dimension: dim,
      percentile: computePercentile(scores, userDimensionScores[dim] ?? 0),
      userScore: userDimensionScores[dim] ?? 0,
      peerAvg: cached!.dimensionAvgs[dim] ?? 0,
    }))

    // Distribution buckets
    const buckets = ['0-20', '21-40', '41-60', '61-80', '81-100']
    const distribution = buckets.map(bucket => {
      const [lo, hi] = bucket.split('-').map(Number)
      const count = cached!.overallScores.filter(s => s >= lo && s <= hi).length
      return { bucket, count }
    })

    return {
      available: true,
      peerCount: cached.peerCount,
      overallPercentile,
      overallAvg: cached.overallAvg,
      dimensionPercentiles,
      distribution,
    }
  } catch (err) {
    logger.error({ err }, 'Failed to compute peer benchmark')
    return empty
  }
}

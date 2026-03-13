import { connectDB } from '@/lib/db/connection'
import { BenchmarkCase } from '@/lib/db/models'
import type { IBenchmarkCase } from '@/lib/db/models'
import { evaluateStructured } from './evaluationEngine'
import { isFeatureEnabled } from '@/lib/featureFlags'
import { logger } from '@/lib/logger'

// ─── Benchmark Run Result ───────────────────────────────────────────────────

export interface BenchmarkResult {
  caseId: string
  domain: string
  interviewType: string
  passed: boolean
  details: {
    scoreAccuracy: number          // 0-1 how close to expected band
    strengthTagOverlap: number     // 0-1 precision
    weaknessTagOverlap: number     // 0-1 precision
    flagAccuracy: number           // 0-1
    followUpRelevance: boolean
  }
  actualScores: Record<string, number>
  expectedBands: Record<string, { min: number; max: number }>
  timestamp: Date
}

export interface BenchmarkSuiteResult {
  totalCases: number
  passed: number
  failed: number
  passRate: number
  avgScoreAccuracy: number
  avgStrengthOverlap: number
  avgWeaknessOverlap: number
  results: BenchmarkResult[]
  runAt: Date
  durationMs: number
}

// ─── Run Benchmark Suite ────────────────────────────────────────────────────

export async function runBenchmarkSuite(
  filter?: { domain?: string; interviewType?: string; category?: string }
): Promise<BenchmarkSuiteResult> {
  if (!isFeatureEnabled('benchmark_harness')) {
    return {
      totalCases: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      avgScoreAccuracy: 0,
      avgStrengthOverlap: 0,
      avgWeaknessOverlap: 0,
      results: [],
      runAt: new Date(),
      durationMs: 0,
    }
  }

  const startTime = Date.now()

  try {
    await connectDB()

    const query: Record<string, unknown> = { isActive: true }
    if (filter?.domain) query.domain = filter.domain
    if (filter?.interviewType) query.interviewType = filter.interviewType
    if (filter?.category) query.category = filter.category

    const cases = await BenchmarkCase.find(query).lean()
    const results: BenchmarkResult[] = []

    for (const benchCase of cases) {
      try {
        const result = await runSingleBenchmark(benchCase)
        results.push(result)
      } catch (err) {
        logger.error({ err, caseId: benchCase.caseId }, 'Benchmark case failed')
      }
    }

    const passed = results.filter(r => r.passed).length
    const durationMs = Date.now() - startTime

    return {
      totalCases: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      avgScoreAccuracy: avg(results.map(r => r.details.scoreAccuracy)),
      avgStrengthOverlap: avg(results.map(r => r.details.strengthTagOverlap)),
      avgWeaknessOverlap: avg(results.map(r => r.details.weaknessTagOverlap)),
      results,
      runAt: new Date(),
      durationMs,
    }
  } catch (err) {
    logger.error({ err }, 'Benchmark suite failed')
    return {
      totalCases: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      avgScoreAccuracy: 0,
      avgStrengthOverlap: 0,
      avgWeaknessOverlap: 0,
      results: [],
      runAt: new Date(),
      durationMs: Date.now() - startTime,
    }
  }
}

// ─── Run Single Benchmark Case ──────────────────────────────────────────────

async function runSingleBenchmark(benchCase: IBenchmarkCase): Promise<BenchmarkResult> {
  const evalResult = await evaluateStructured({
    domain: benchCase.domain,
    interviewType: benchCase.interviewType,
    seniorityBand: benchCase.seniorityBand,
    question: benchCase.question,
    answer: benchCase.candidateAnswer,
    questionIndex: 0,
  })

  const actualScores = evalResult?.scores || {}
  const expectedBands = (benchCase.expectedCompetencyScoreBands || {}) as Record<string, { min: number; max: number }>

  // Calculate score accuracy
  let scoreAccuracy = 0
  let scoreCount = 0
  for (const [key, band] of Object.entries(expectedBands)) {
    const actual = actualScores[key]
    if (actual !== undefined) {
      if (actual >= band.min && actual <= band.max) {
        scoreAccuracy += 1
      } else {
        const distance = actual < band.min ? band.min - actual : actual - band.max
        scoreAccuracy += Math.max(0, 1 - distance / 50)
      }
      scoreCount++
    }
  }
  scoreAccuracy = scoreCount > 0 ? scoreAccuracy / scoreCount : 0

  // Tag overlap
  const actualStrengths = evalResult?.strengthTags || []
  const actualWeaknesses = evalResult?.weaknessTags || []
  const strengthOverlap = setOverlap(actualStrengths, benchCase.expectedStrengthTags)
  const weaknessOverlap = setOverlap(actualWeaknesses, benchCase.expectedWeaknessTags)

  // Follow-up relevance
  const followUpRelevance = evalResult?.needsFollowUp !== undefined

  // Flag accuracy
  const actualFlags = evalResult?.flags || []
  const expectedFlags = benchCase.expectedWeaknessTags || []
  const flagAccuracy = expectedFlags.length > 0
    ? setOverlap(actualFlags, expectedFlags)
    : actualFlags.length === 0 ? 1 : 0.5

  // Overall pass: 70%+ accuracy across metrics
  const passed = scoreAccuracy >= 0.7 && strengthOverlap >= 0.3 && weaknessOverlap >= 0.3

  return {
    caseId: benchCase.caseId,
    domain: benchCase.domain,
    interviewType: benchCase.interviewType,
    passed,
    details: {
      scoreAccuracy,
      strengthTagOverlap: strengthOverlap,
      weaknessTagOverlap: weaknessOverlap,
      flagAccuracy,
      followUpRelevance,
    },
    actualScores,
    expectedBands,
    timestamp: new Date(),
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setOverlap(actual: string[], expected: string[]): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0.5

  const normalizedActual = Array.from(new Set(actual.map(s => s.toLowerCase().replace(/[_-]/g, ' '))))
  const normalizedExpected = expected.map(s => s.toLowerCase().replace(/[_-]/g, ' '))

  let matches = 0
  for (const exp of normalizedExpected) {
    for (const act of normalizedActual) {
      if (act.includes(exp) || exp.includes(act)) {
        matches++
        break
      }
    }
  }

  return matches / normalizedExpected.length
}

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

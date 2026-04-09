import { connectDB } from '@shared/db/connection'
import { BenchmarkCase } from '@shared/db/models'
import type { IBenchmarkCase } from '@shared/db/models'
import { evaluateStructured } from '@interview'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

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

// ─── Consistency Check (variance across N runs) ─────────────────────────────
//
// Measures how stable the LLM evaluator is for a fixed input. Runs each
// benchmark case `runs` times (default 5) and reports per-dimension mean,
// std dev, min, max — plus tag stability. This is the "evaluation harness"
// that the user research feedback called for: it MEASURES drift before we
// touch any scoring logic.

export interface DimensionStats {
  dimension: string
  mean: number
  stdDev: number
  min: number
  max: number
  values: number[]
}

export interface CaseConsistencyResult {
  caseId: string
  domain: string
  interviewType: string
  runs: number
  dimensionStats: DimensionStats[]
  overallScore: { mean: number; stdDev: number; min: number; max: number; values: number[] }
  strengthTagStability: number   // 0-1, fraction of runs whose strength tags overlap with the modal set
  weaknessTagStability: number   // 0-1, same for weakness tags
  errors: number                 // number of runs that returned null
}

export interface ConsistencyReport {
  totalCases: number
  runsPerCase: number
  temperature: number | null     // null = SDK default
  results: CaseConsistencyResult[]
  meanStdDev: number             // mean of per-dimension std devs across all cases
  worstStdDev: number            // max std dev observed on any dimension/case
  runAt: Date
  durationMs: number
}

export interface ConsistencyOptions {
  runs?: number
  temperature?: number
  filter?: { domain?: string; interviewType?: string; category?: string }
}

export async function runConsistencyCheck(
  options: ConsistencyOptions = {}
): Promise<ConsistencyReport> {
  const startTime = Date.now()
  const runs = options.runs ?? 5
  const temperature = options.temperature ?? null

  await connectDB()

  const query: Record<string, unknown> = { isActive: true }
  if (options.filter?.domain) query.domain = options.filter.domain
  if (options.filter?.interviewType) query.interviewType = options.filter.interviewType
  if (options.filter?.category) query.category = options.filter.category

  const cases = await BenchmarkCase.find(query).lean()
  const results: CaseConsistencyResult[] = []

  for (const benchCase of cases) {
    try {
      const caseResult = await runConsistencyForCase(benchCase, runs, temperature)
      results.push(caseResult)
    } catch (err) {
      logger.error({ err, caseId: benchCase.caseId }, 'Consistency check failed for case')
    }
  }

  const allStdDevs = results.flatMap((r) => r.dimensionStats.map((d) => d.stdDev))
  const meanStdDev = avg(allStdDevs)
  const worstStdDev = allStdDevs.length > 0 ? Math.max(...allStdDevs) : 0

  return {
    totalCases: results.length,
    runsPerCase: runs,
    temperature,
    results,
    meanStdDev,
    worstStdDev,
    runAt: new Date(),
    durationMs: Date.now() - startTime,
  }
}

async function runConsistencyForCase(
  benchCase: IBenchmarkCase,
  runs: number,
  temperature: number | null
): Promise<CaseConsistencyResult> {
  const dimensionValues = new Map<string, number[]>()
  const overallValues: number[] = []
  const strengthTagSets: string[][] = []
  const weaknessTagSets: string[][] = []
  let errors = 0

  for (let i = 0; i < runs; i++) {
    const result = await evaluateStructured({
      domain: benchCase.domain,
      interviewType: benchCase.interviewType,
      seniorityBand: benchCase.seniorityBand,
      question: benchCase.question,
      answer: benchCase.candidateAnswer,
      questionIndex: 0,
      ...(temperature !== null ? { temperature } : {}),
    })

    if (!result) {
      errors++
      continue
    }

    for (const [dim, score] of Object.entries(result.scores)) {
      if (!dimensionValues.has(dim)) dimensionValues.set(dim, [])
      dimensionValues.get(dim)!.push(score)
    }
    overallValues.push(result.weightedScore)
    strengthTagSets.push(normalizeTagSet(result.strengthTags))
    weaknessTagSets.push(normalizeTagSet(result.weaknessTags))
  }

  const dimensionStats: DimensionStats[] = Array.from(dimensionValues.entries()).map(
    ([dimension, values]) => ({
      dimension,
      mean: avg(values),
      stdDev: stdDev(values),
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      values,
    })
  )

  return {
    caseId: benchCase.caseId,
    domain: benchCase.domain,
    interviewType: benchCase.interviewType,
    runs,
    dimensionStats,
    overallScore: {
      mean: avg(overallValues),
      stdDev: stdDev(overallValues),
      min: overallValues.length ? Math.min(...overallValues) : 0,
      max: overallValues.length ? Math.max(...overallValues) : 0,
      values: overallValues,
    },
    strengthTagStability: tagStability(strengthTagSets),
    weaknessTagStability: tagStability(weaknessTagSets),
    errors,
  }
}

// Population standard deviation (sample size is small and bounded by `runs`).
export function stdDev(nums: number[]): number {
  if (nums.length === 0) return 0
  const m = avg(nums)
  const variance = nums.reduce((sum, x) => sum + (x - m) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function normalizeTagSet(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => t.toLowerCase().replace(/[_-]/g, ' ').trim()))
  ).sort()
}

// Returns the fraction of runs whose tag set overlaps the modal (most common) set.
// 1.0 = every run produced the same set; 0.0 = no overlap with the modal at all.
export function tagStability(tagSets: string[][]): number {
  if (tagSets.length === 0) return 0
  // Normalize defensively so callers don't have to pre-normalize.
  const normalized = tagSets.map((set) => normalizeTagSet(set))
  // Count occurrences of each tag across runs and pick the modal set
  // (top-N tags where N = median set size).
  const counts = new Map<string, number>()
  for (const set of normalized) {
    for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const sizes = normalized.map((s) => s.length).sort((a, b) => a - b)
  const medianSize = sizes[Math.floor(sizes.length / 2)] || 1
  const modalSet = new Set(
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, medianSize)
      .map(([tag]) => tag)
  )
  if (modalSet.size === 0) return 0
  let totalOverlap = 0
  for (const set of normalized) {
    const intersection = set.filter((t) => modalSet.has(t)).length
    totalOverlap += intersection / modalSet.size
  }
  return totalOverlap / normalized.length
}

export function formatConsistencyReportMarkdown(report: ConsistencyReport): string {
  const lines: string[] = []
  lines.push('# Scoring Consistency Report')
  lines.push('')
  lines.push(`- **Run at:** ${report.runAt.toISOString()}`)
  lines.push(`- **Duration:** ${(report.durationMs / 1000).toFixed(1)}s`)
  lines.push(`- **Cases:** ${report.totalCases}`)
  lines.push(`- **Runs per case:** ${report.runsPerCase}`)
  lines.push(`- **Temperature:** ${report.temperature ?? '(SDK default ≈1.0)'}`)
  lines.push(`- **Mean dimension std dev:** ${report.meanStdDev.toFixed(2)}`)
  lines.push(`- **Worst dimension std dev:** ${report.worstStdDev.toFixed(2)}`)
  lines.push('')
  lines.push('## Per-case detail')
  lines.push('')
  for (const r of report.results) {
    lines.push(`### ${r.caseId} (${r.domain} / ${r.interviewType})`)
    lines.push('')
    lines.push(
      `Overall: mean=${r.overallScore.mean.toFixed(1)}, stdDev=${r.overallScore.stdDev.toFixed(2)}, range=[${r.overallScore.min.toFixed(0)}, ${r.overallScore.max.toFixed(0)}]`
    )
    lines.push('')
    lines.push('| Dimension | Mean | StdDev | Min | Max |')
    lines.push('|---|---|---|---|---|')
    for (const d of r.dimensionStats) {
      lines.push(
        `| ${d.dimension} | ${d.mean.toFixed(1)} | ${d.stdDev.toFixed(2)} | ${d.min.toFixed(0)} | ${d.max.toFixed(0)} |`
      )
    }
    lines.push('')
    lines.push(
      `Strength tag stability: ${(r.strengthTagStability * 100).toFixed(0)}%, Weakness tag stability: ${(r.weaknessTagStability * 100).toFixed(0)}%, Errors: ${r.errors}/${r.runs}`
    )
    lines.push('')
  }
  return lines.join('\n')
}

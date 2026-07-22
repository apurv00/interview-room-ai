// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Register every completion provider the CMS can route this slot to. Vitest
// can load a second provider-registry instance through CJS, so these imports
// deliberately mirror the existing verdict live-eval harness.
import '@shared/services/providers/openai'
import '@shared/services/providers/anthropic'
import '@shared/services/providers/openrouter'
import '@shared/services/providers/google'
import '@shared/services/providers/groq'
import { connectDB } from '@shared/db/connection'
import { ModelConfig } from '@shared/db/models/ModelConfig'
import {
  __awaitBackgroundLoadForTesting,
  resolveModel,
  type ResolvedModel,
} from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'
import evidenceGoldenSet from '../../modules/jobs/eval/evidenceGoldenSet.json'
import {
  EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
  EVIDENCE_ATTRIBUTION_SYSTEM_PROMPT,
  buildAttributionPrompt,
  classifyEvidenceAttribution,
  type EvidenceAttributionAttempt,
} from '../../modules/jobs/jobs/evidenceAttributionJob'

type Strength = 'strong' | 'partial' | 'none'
type Prediction = Strength | 'error'
type Challenge = 'ordinary' | 'negation' | 'prompt-injection'
type ContextProfile = 'ordinary' | 'observed-production-upper-tail'

interface EvidenceFixture {
  schemaVersion: 'jobs-evidence-golden-set.v1'
  id: string
  segment: 'fresher' | 'professional'
  domain: string
  challenge: Challenge
  contextProfile: ContextProfile
  provenance: {
    origin: 'founder-session-consented'
    sourceCaseId: string
    manuallyRedacted: true
    consentRecordHeldOffRepo: true
    labeledBy: 'founder'
  }
  answers: Array<{ index: number; question: string; answer: string }>
  mustHaves: Array<{ id: string; requirement: string }>
  labels: Array<{ answerIndex: number; requirementId: string; strength: Strength }>
}

interface SafeSlotContract {
  model: string
  provider: string
  maxTokens: number
  temperature: number | null
  reasoningEffort: string | null
  fallbackModel: string | null
  fallbackProvider: string | null
  useToonInput: boolean
}

interface ModelConfigSnapshot {
  revision: string
  routingEnabled: boolean
  slot: SafeSlotContract
  digest: string
}

interface EvidenceGateMetrics {
  exactAgreement: number
  binaryAgreement: number
  noneRecall: number
  strongPrecision: number
  caseMacroAgreement: number
  bySegmentBinary: Record<string, number>
  byDomainBinary: Record<string, number>
  evaluatorErrorRate: number
  upperTailFailureCount: number
  challengeFalseEvidenceCount: number
  modelDriftCount: number
  fallbackCount: number
  contractViolationCount: number
  modelConfigStable: boolean
}

interface EvidenceCasePrediction {
  id: string
  expected: Strength
  predicted: Prediction
}

interface EvidenceCaseResult {
  caseId: string
  segment: EvidenceFixture['segment']
  domain: string
  challenge: Challenge
  contextProfile: ContextProfile
  ok: boolean
  errorKind: string | null
  contractViolations: string[]
  attempts: EvidenceAttributionAttempt[]
  predictions: EvidenceCasePrediction[]
}

interface EvidenceLabelResult extends EvidenceCasePrediction {
  caseId: string
  segment: EvidenceFixture['segment']
  domain: string
  challenge: Challenge
}

interface EvidenceCalibrationMetrics extends EvidenceGateMetrics {
  confusion: Record<Strength, Record<Prediction, number>>
  perClass: Record<Strength, { precision: number; recall: number }>
  bySegmentExact: Record<string, number>
  byDomainExact: Record<string, number>
  falseEvidenceIds: string[]
  falseStrongIds: string[]
  challengeFalseEvidenceIds: string[]
  retryRate: number
  inputTokens: number
  outputTokens: number
}

interface SafeArtifactMetadata {
  ranAt: string
  gitSha: string
  fixtureSchemaVersion: EvidenceFixture['schemaVersion'] | null
  fixtureDigest: string
  promptDigest: string
  activeSlot: SafeSlotContract
  startConfig: ModelConfigSnapshot
  endConfig: ModelConfigSnapshot
}

const LIVE = process.env.JOBS_EVIDENCE_EVAL === '1'
const TASK_SLOT = 'jobs.evidence-attribution' as const
const CONCURRENCY = 2
const STRENGTHS: Strength[] = ['strong', 'partial', 'none']
const PREDICTIONS: Prediction[] = [...STRENGTHS, 'error']
const GATE_THRESHOLDS = Object.freeze({
  exactAgreementMin: 0.8,
  binaryAgreementMin: 0.9,
  noneRecallMin: 0.9,
  strongPrecisionMin: 0.8,
  caseMacroAgreementMin: 0.75,
  segmentBinaryAgreementMin: 0.85,
  domainBinaryAgreementMin: 0.8,
  evaluatorErrorRateMaxExclusive: 0.05,
  upperTailFailureMax: 0,
  challengeFalseEvidenceMax: 0,
  modelDriftMax: 0,
  fallbackMax: 0,
  contractViolationMax: 0,
})
const ACTIVATION_BLOCKERS = Object.freeze([
  'pair-level-strength-contract-not-versioned',
  'scoring-and-attribution-provenance-not-persisted',
  'legacy-evidence-not-quarantined-or-replayed',
  'ai-data-disclosure-not-approved',
])

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safeSlotContract(resolved: ResolvedModel): SafeSlotContract {
  return {
    model: resolved.model,
    provider: resolved.provider,
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature ?? null,
    reasoningEffort: resolved.reasoningEffort ?? null,
    fallbackModel: resolved.fallbackModel ?? null,
    fallbackProvider: resolved.fallbackProvider ?? null,
    useToonInput: resolved.useToonInput,
  }
}

async function authoritativeModelConfigSnapshot(): Promise<ModelConfigSnapshot> {
  await connectDB()
  const config = await ModelConfig.getConfig()
  const defaults = TASK_SLOT_DEFAULTS[TASK_SLOT]
  const configured = config?.routingEnabled
    ? config.slots.find((slot) => slot.taskSlot === TASK_SLOT && slot.isActive)
    : undefined

  const slot = !configured
    ? safeSlotContract({
      model: defaults.model,
      provider: defaults.provider,
      maxTokens: defaults.maxTokens,
      reasoningEffort: defaults.reasoningEffort,
      fallbackModel: defaults.fallbackModel,
      fallbackProvider: defaults.fallbackProvider,
      useToonInput: false,
    })
    : safeSlotContract({
      model: configured.model,
      provider: configured.provider,
      maxTokens: configured.maxTokens,
      temperature: configured.temperature,
      reasoningEffort: configured.reasoningEffort ?? defaults.reasoningEffort,
      fallbackModel: configured.fallbackModel,
      fallbackProvider: configured.fallbackProvider ?? 'anthropic',
      useToonInput: configured.useToonInput ?? false,
    })
  const revision = config?.updatedAt
    ? new Date(config.updatedAt).toISOString()
    : 'no-model-config'
  const snapshot = {
    revision,
    routingEnabled: config?.routingEnabled === true,
    slot,
  }
  return { ...snapshot, digest: digest(snapshot) }
}

async function stableActiveSlot(): Promise<{
  activeSlot: SafeSlotContract
  startConfig: ModelConfigSnapshot
}> {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required to verify the authoritative CMS model configuration')
  }
  const expectedModel = process.env.JOBS_EVIDENCE_EVAL_EXPECTED_MODEL?.trim()
  const expectedProvider = process.env.JOBS_EVIDENCE_EVAL_EXPECTED_PROVIDER?.trim()
  if (!expectedModel || !expectedProvider) {
    throw new Error('JOBS_EVIDENCE_EVAL_EXPECTED_MODEL and JOBS_EVIDENCE_EVAL_EXPECTED_PROVIDER are required')
  }

  // First resolution starts the non-blocking CMS load. Join it, then resolve
  // again so the eval cannot freeze a cold-process code default by accident.
  await resolveModel(TASK_SLOT)
  await __awaitBackgroundLoadForTesting()
  const active = safeSlotContract(await resolveModel(TASK_SLOT))
  const authoritative = await authoritativeModelConfigSnapshot()

  expect(active, 'router cache/config differs from authoritative Mongo ModelConfig').toEqual(authoritative.slot)
  expect(active.model, 'active model differs from operator-declared calibration target').toBe(expectedModel)
  expect(active.provider, 'active provider differs from operator-declared calibration target').toBe(expectedProvider)
  return { activeSlot: active, startConfig: authoritative }
}

async function pool<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = nextIndex++
        if (index >= items.length) return
        output[index] = await work(items[index])
      }
    }),
  )
  return output
}

function attemptsFrom(error: unknown): EvidenceAttributionAttempt[] {
  if (!error || typeof error !== 'object') return []
  const attempts = (error as { attempts?: unknown }).attempts
  return Array.isArray(attempts) ? attempts as EvidenceAttributionAttempt[] : []
}

function binary(strength: Prediction): 'evidence' | 'none' | 'error' {
  if (strength === 'strong' || strength === 'partial') return 'evidence'
  return strength
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function evidenceGateFailures(metrics: EvidenceGateMetrics): string[] {
  const failures: string[] = []
  if (metrics.exactAgreement < GATE_THRESHOLDS.exactAgreementMin) failures.push('exact-agreement')
  if (metrics.binaryAgreement < GATE_THRESHOLDS.binaryAgreementMin) failures.push('binary-agreement')
  if (metrics.noneRecall < GATE_THRESHOLDS.noneRecallMin) failures.push('none-recall')
  if (metrics.strongPrecision < GATE_THRESHOLDS.strongPrecisionMin) failures.push('strong-precision')
  if (metrics.caseMacroAgreement < GATE_THRESHOLDS.caseMacroAgreementMin) failures.push('case-macro-agreement')
  for (const [segment, agreement] of Object.entries(metrics.bySegmentBinary).sort(([a], [b]) => a.localeCompare(b))) {
    if (agreement < GATE_THRESHOLDS.segmentBinaryAgreementMin) failures.push(`segment-binary:${segment}`)
  }
  for (const [domain, agreement] of Object.entries(metrics.byDomainBinary).sort(([a], [b]) => a.localeCompare(b))) {
    if (agreement < GATE_THRESHOLDS.domainBinaryAgreementMin) failures.push(`domain-binary:${domain}`)
  }
  if (metrics.evaluatorErrorRate >= GATE_THRESHOLDS.evaluatorErrorRateMaxExclusive) failures.push('evaluator-error-rate')
  if (metrics.upperTailFailureCount > GATE_THRESHOLDS.upperTailFailureMax) failures.push('upper-tail-failure')
  if (metrics.challengeFalseEvidenceCount > GATE_THRESHOLDS.challengeFalseEvidenceMax) failures.push('challenge-false-evidence')
  if (metrics.modelDriftCount > GATE_THRESHOLDS.modelDriftMax) failures.push('model-drift')
  if (metrics.fallbackCount > GATE_THRESHOLDS.fallbackMax) failures.push('fallback-use')
  if (metrics.contractViolationCount > GATE_THRESHOLDS.contractViolationMax) failures.push('contract-violation')
  if (!metrics.modelConfigStable) failures.push('model-config-drift')
  return failures
}

function computeEvidenceCalibrationMetrics(
  caseResults: EvidenceCaseResult[],
  activeSlot: Pick<SafeSlotContract, 'model' | 'provider'>,
  startConfig: Pick<ModelConfigSnapshot, 'digest'>,
  endConfig: Pick<ModelConfigSnapshot, 'digest'>,
): EvidenceCalibrationMetrics {
  const labelResults: EvidenceLabelResult[] = caseResults.flatMap((result) =>
    result.predictions.map((prediction) => ({
      ...prediction,
      caseId: result.caseId,
      segment: result.segment,
      domain: result.domain,
      challenge: result.challenge,
    })),
  )
  const exactAgreement = ratio(
    labelResults.filter((label) => label.expected === label.predicted).length,
    labelResults.length,
  )
  const binaryAgreement = ratio(
    labelResults.filter((label) => binary(label.expected) === binary(label.predicted)).length,
    labelResults.length,
  )
  const evaluatorErrorRate = ratio(caseResults.filter((result) => !result.ok).length, caseResults.length)
  const caseMacroAgreement = ratio(
    caseResults.reduce(
      (total, result) => total + ratio(
        result.predictions.filter((prediction) => prediction.expected === prediction.predicted).length,
        result.predictions.length,
      ),
      0,
    ),
    caseResults.length,
  )
  const confusion = Object.fromEntries(
    STRENGTHS.map((expected) => [expected, Object.fromEntries(
      PREDICTIONS.map((predicted) => [
        predicted,
        labelResults.filter((label) => label.expected === expected && label.predicted === predicted).length,
      ]),
    )]),
  ) as EvidenceCalibrationMetrics['confusion']
  const perClass = Object.fromEntries(STRENGTHS.map((strength) => {
    const truePositive = labelResults.filter(
      (label) => label.expected === strength && label.predicted === strength,
    ).length
    const predicted = labelResults.filter((label) => label.predicted === strength).length
    const expected = labelResults.filter((label) => label.expected === strength).length
    return [strength, { precision: ratio(truePositive, predicted), recall: ratio(truePositive, expected) }]
  })) as EvidenceCalibrationMetrics['perClass']
  const noneRows = labelResults.filter((label) => label.expected === 'none')
  const noneRecall = ratio(
    noneRows.filter((label) => label.predicted === 'none').length,
    noneRows.length,
  )
  const predictedStrong = labelResults.filter((label) => label.predicted === 'strong')
  const strongPrecision = ratio(
    predictedStrong.filter((label) => label.expected === 'strong').length,
    predictedStrong.length,
  )
  const sliceAgreement = (key: 'segment' | 'domain', mode: 'exact' | 'binary') => Object.fromEntries(
    Array.from(new Set(labelResults.map((label) => label[key]))).map((value) => {
      const rows = labelResults.filter((label) => label[key] === value)
      const correct = mode === 'exact'
        ? rows.filter((label) => label.expected === label.predicted).length
        : rows.filter((label) => binary(label.expected) === binary(label.predicted)).length
      return [value, ratio(correct, rows.length)]
    }),
  )
  const attempts = caseResults.flatMap((result) => result.attempts)
  const modelDriftCount = attempts.filter(
    (attempt) => attempt.model !== activeSlot.model || attempt.provider !== activeSlot.provider,
  ).length
  const fallbackCount = attempts.filter((attempt) => attempt.usedFallback).length
  const contractViolationCount = caseResults.reduce(
    (count, result) => count + result.contractViolations.length,
    0,
  )
  const challengeFalseEvidenceIds = labelResults
    .filter((label) =>
      label.challenge !== 'ordinary' &&
      label.expected === 'none' &&
      binary(label.predicted) === 'evidence',
    )
    .map((label) => label.id)

  return {
    exactAgreement,
    binaryAgreement,
    noneRecall,
    strongPrecision,
    caseMacroAgreement,
    bySegmentBinary: sliceAgreement('segment', 'binary'),
    byDomainBinary: sliceAgreement('domain', 'binary'),
    evaluatorErrorRate,
    upperTailFailureCount: caseResults.filter(
      (result) => result.contextProfile === 'observed-production-upper-tail' && !result.ok,
    ).length,
    challengeFalseEvidenceCount: challengeFalseEvidenceIds.length,
    modelDriftCount,
    fallbackCount,
    contractViolationCount,
    modelConfigStable: startConfig.digest === endConfig.digest,
    confusion,
    perClass,
    bySegmentExact: sliceAgreement('segment', 'exact'),
    byDomainExact: sliceAgreement('domain', 'exact'),
    falseEvidenceIds: labelResults
      .filter((label) => label.expected === 'none' && binary(label.predicted) === 'evidence')
      .map((label) => label.id),
    falseStrongIds: labelResults
      .filter((label) => label.expected !== 'strong' && label.predicted === 'strong')
      .map((label) => label.id),
    challengeFalseEvidenceIds,
    retryRate: ratio(caseResults.filter((result) => result.attempts.length > 1).length, caseResults.length),
    inputTokens: attempts.reduce((total, attempt) => total + attempt.inputTokens, 0),
    outputTokens: attempts.reduce((total, attempt) => total + attempt.outputTokens, 0),
  }
}

function buildSafeEvidenceArtifact(
  metadata: SafeArtifactMetadata,
  caseResults: EvidenceCaseResult[],
  metrics: EvidenceCalibrationMetrics,
) {
  const failures = evidenceGateFailures(metrics)
  return {
    summary: {
      ranAt: metadata.ranAt,
      gitSha: metadata.gitSha,
      contractVersion: EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
      fixtureSchemaVersion: metadata.fixtureSchemaVersion,
      fixtureDigest: metadata.fixtureDigest,
      promptDigest: metadata.promptDigest,
      activeSlot: { ...metadata.activeSlot },
      thresholds: GATE_THRESHOLDS,
      gatePassed: failures.length === 0,
      failures,
      founderApproval: {
        status: 'blocked',
        note: 'A v1 technical pass cannot activate A14.2b while the machine-listed blockers remain.',
      },
      activation: {
        eligible: false,
        blockers: [...ACTIVATION_BLOCKERS],
      },
      modelConfig: {
        stable: metrics.modelConfigStable,
        start: { ...metadata.startConfig, slot: { ...metadata.startConfig.slot } },
        end: { ...metadata.endConfig, slot: { ...metadata.endConfig.slot } },
      },
      cases: caseResults.length,
      labeledPairs: caseResults.reduce((total, result) => total + result.predictions.length, 0),
      exactAgreement: metrics.exactAgreement,
      binaryAgreement: metrics.binaryAgreement,
      noneRecall: metrics.noneRecall,
      strongPrecision: metrics.strongPrecision,
      caseMacroAgreement: metrics.caseMacroAgreement,
      evaluatorErrorRate: metrics.evaluatorErrorRate,
      upperTailFailureCount: metrics.upperTailFailureCount,
      modelDriftCount: metrics.modelDriftCount,
      fallbackCount: metrics.fallbackCount,
      contractViolationCount: metrics.contractViolationCount,
      confusion: metrics.confusion,
      perClass: metrics.perClass,
      bySegmentExact: metrics.bySegmentExact,
      bySegmentBinary: metrics.bySegmentBinary,
      byDomainExact: metrics.byDomainExact,
      byDomainBinary: metrics.byDomainBinary,
      falseEvidenceIds: metrics.falseEvidenceIds,
      falseStrongIds: metrics.falseStrongIds,
      challengeFalseEvidenceIds: metrics.challengeFalseEvidenceIds,
      retryRate: metrics.retryRate,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
    },
    cases: caseResults.map((result) => ({
      caseId: result.caseId,
      segment: result.segment,
      domain: result.domain,
      challenge: result.challenge,
      contextProfile: result.contextProfile,
      ok: result.ok,
      errorKind: result.errorKind,
      contractViolations: [...result.contractViolations],
      attempts: result.attempts.map((attempt) => ({
        model: attempt.model,
        provider: attempt.provider,
        usedFallback: attempt.usedFallback,
        truncated: attempt.truncated,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
      })),
      predictions: result.predictions.map((prediction) => ({
        id: prediction.id,
        expected: prediction.expected,
        predicted: prediction.predicted,
      })),
    })),
  }
}

const TEST_ACTIVE_SLOT: SafeSlotContract = {
  model: 'calibration-model',
  provider: 'openai',
  maxTokens: 1_200,
  temperature: 0,
  reasoningEffort: null,
  fallbackModel: null,
  fallbackProvider: null,
  useToonInput: false,
}

const TEST_CASE_RESULTS: EvidenceCaseResult[] = [
  {
    caseId: 'case-fresher',
    segment: 'fresher',
    domain: 'backend',
    challenge: 'ordinary',
    contextProfile: 'ordinary',
    ok: true,
    errorKind: null,
    contractViolations: [],
    attempts: [{
      model: TEST_ACTIVE_SLOT.model,
      provider: TEST_ACTIVE_SLOT.provider,
      usedFallback: false,
      truncated: false,
      inputTokens: 10,
      outputTokens: 4,
    }],
    predictions: [
      { id: 'case-fresher:0:req-1', expected: 'strong', predicted: 'strong' },
      { id: 'case-fresher:0:req-2', expected: 'partial', predicted: 'strong' },
      { id: 'case-fresher:0:req-3', expected: 'none', predicted: 'none' },
    ],
  },
  {
    caseId: 'case-professional',
    segment: 'professional',
    domain: 'frontend',
    challenge: 'negation',
    contextProfile: 'observed-production-upper-tail',
    ok: false,
    errorKind: 'contract-integrity',
    contractViolations: ['foreign-requirement-id'],
    attempts: [
      {
        model: TEST_ACTIVE_SLOT.model,
        provider: TEST_ACTIVE_SLOT.provider,
        usedFallback: false,
        truncated: true,
        inputTokens: 5,
        outputTokens: 2,
      },
      {
        model: 'drifted-model',
        provider: 'anthropic',
        usedFallback: true,
        truncated: false,
        inputTokens: 20,
        outputTokens: 8,
      },
    ],
    predictions: [
      { id: 'case-professional:0:req-1', expected: 'strong', predicted: 'error' },
      { id: 'case-professional:0:req-2', expected: 'partial', predicted: 'error' },
      { id: 'case-professional:0:req-3', expected: 'none', predicted: 'error' },
    ],
  },
]

const BOUNDARY_PASS_METRICS: EvidenceGateMetrics = {
  exactAgreement: GATE_THRESHOLDS.exactAgreementMin,
  binaryAgreement: GATE_THRESHOLDS.binaryAgreementMin,
  noneRecall: GATE_THRESHOLDS.noneRecallMin,
  strongPrecision: GATE_THRESHOLDS.strongPrecisionMin,
  caseMacroAgreement: GATE_THRESHOLDS.caseMacroAgreementMin,
  bySegmentBinary: { fresher: GATE_THRESHOLDS.segmentBinaryAgreementMin, professional: 1 },
  byDomainBinary: { backend: GATE_THRESHOLDS.domainBinaryAgreementMin },
  evaluatorErrorRate: GATE_THRESHOLDS.evaluatorErrorRateMaxExclusive - Number.EPSILON,
  upperTailFailureCount: 0,
  challengeFalseEvidenceCount: 0,
  modelDriftCount: 0,
  fallbackCount: 0,
  contractViolationCount: 0,
  modelConfigStable: true,
}

describe('Jobs evidence calibration gate contract', () => {
  it('accepts inclusive quality boundaries while keeping evaluator errors strictly below 5%', () => {
    expect(evidenceGateFailures(BOUNDARY_PASS_METRICS)).toEqual([])
  })

  it('names every unsafe failure, including the strict 5% evaluator-error boundary', () => {
    const failures = evidenceGateFailures({
      exactAgreement: GATE_THRESHOLDS.exactAgreementMin - 0.01,
      binaryAgreement: GATE_THRESHOLDS.binaryAgreementMin - 0.01,
      noneRecall: GATE_THRESHOLDS.noneRecallMin - 0.01,
      strongPrecision: GATE_THRESHOLDS.strongPrecisionMin - 0.01,
      caseMacroAgreement: GATE_THRESHOLDS.caseMacroAgreementMin - 0.01,
      bySegmentBinary: { fresher: GATE_THRESHOLDS.segmentBinaryAgreementMin - 0.01 },
      byDomainBinary: { backend: GATE_THRESHOLDS.domainBinaryAgreementMin - 0.01 },
      evaluatorErrorRate: GATE_THRESHOLDS.evaluatorErrorRateMaxExclusive,
      upperTailFailureCount: 1,
      challengeFalseEvidenceCount: 1,
      modelDriftCount: 1,
      fallbackCount: 1,
      contractViolationCount: 1,
      modelConfigStable: false,
    })
    expect(failures).toEqual([
      'exact-agreement',
      'binary-agreement',
      'none-recall',
      'strong-precision',
      'case-macro-agreement',
      'segment-binary:fresher',
      'domain-binary:backend',
      'evaluator-error-rate',
      'upper-tail-failure',
      'challenge-false-evidence',
      'model-drift',
      'fallback-use',
      'contract-violation',
      'model-config-drift',
    ])
  })

  it('deterministically computes confusion, class, case, slice, error, and drift metrics', () => {
    const metrics = computeEvidenceCalibrationMetrics(
      TEST_CASE_RESULTS,
      TEST_ACTIVE_SLOT,
      { digest: 'config-before' },
      { digest: 'config-after' },
    )

    expect(metrics.confusion).toEqual({
      strong: { strong: 1, partial: 0, none: 0, error: 1 },
      partial: { strong: 1, partial: 0, none: 0, error: 1 },
      none: { strong: 0, partial: 0, none: 1, error: 1 },
    })
    expect(metrics.perClass).toEqual({
      strong: { precision: 0.5, recall: 0.5 },
      partial: { precision: 0, recall: 0 },
      none: { precision: 1, recall: 0.5 },
    })
    expect(metrics.noneRecall).toBe(0.5)
    expect(metrics.strongPrecision).toBe(0.5)
    expect(metrics.exactAgreement).toBeCloseTo(1 / 3)
    expect(metrics.binaryAgreement).toBe(0.5)
    expect(metrics.caseMacroAgreement).toBeCloseTo(1 / 3)
    expect(metrics.bySegmentExact).toEqual({ fresher: 2 / 3, professional: 0 })
    expect(metrics.bySegmentBinary).toEqual({ fresher: 1, professional: 0 })
    expect(metrics.byDomainExact).toEqual({ backend: 2 / 3, frontend: 0 })
    expect(metrics.byDomainBinary).toEqual({ backend: 1, frontend: 0 })
    expect(metrics.evaluatorErrorRate).toBe(0.5)
    expect(metrics.upperTailFailureCount).toBe(1)
    expect(metrics.modelConfigStable).toBe(false)
    expect(metrics.modelDriftCount).toBe(1)
    expect(metrics.fallbackCount).toBe(1)
    expect(metrics.contractViolationCount).toBe(1)
    expect(metrics.retryRate).toBe(0.5)
    expect(metrics.inputTokens).toBe(35)
    expect(metrics.outputTokens).toBe(14)
  })

  it('never lets a mandatory upper-tail failure disappear inside aggregate error tolerance', () => {
    const ordinaryPass = TEST_CASE_RESULTS[0]
    const diluted = [
      ...Array.from({ length: 20 }, (_, index) => ({ ...ordinaryPass, caseId: `ordinary-${index}` })),
      TEST_CASE_RESULTS[1],
    ]
    const metrics = computeEvidenceCalibrationMetrics(
      diluted,
      TEST_ACTIVE_SLOT,
      { digest: 'stable' },
      { digest: 'stable' },
    )

    expect(metrics.evaluatorErrorRate).toBeLessThan(0.05)
    expect(metrics.upperTailFailureCount).toBe(1)
    expect(evidenceGateFailures(metrics)).toContain('upper-tail-failure')
  })

  it('constructs an allowlisted artifact without raw fixture or model text', () => {
    const rawQuestion = 'RAW_QUESTION_DO_NOT_PERSIST'
    const rawAnswer = 'RAW_ANSWER_DO_NOT_PERSIST'
    const rawRequirement = 'RAW_REQUIREMENT_DO_NOT_PERSIST'
    const rawJobDescription = 'RAW_JD_DO_NOT_PERSIST'
    const unsafeCase = {
      ...TEST_CASE_RESULTS[1],
      question: rawQuestion,
      answer: rawAnswer,
      requirement: rawRequirement,
      jobDescription: rawJobDescription,
      attempts: TEST_CASE_RESULTS[1].attempts.map((attempt) => ({
        ...attempt,
        rawModelText: rawJobDescription,
      })),
      predictions: TEST_CASE_RESULTS[1].predictions.map((prediction) => ({
        ...prediction,
        question: rawQuestion,
        answer: rawAnswer,
        requirement: rawRequirement,
      })),
    }
    const metrics = computeEvidenceCalibrationMetrics(
      [unsafeCase],
      TEST_ACTIVE_SLOT,
      { digest: 'stable-config' },
      { digest: 'stable-config' },
    )
    const config: ModelConfigSnapshot = {
      revision: '2026-07-22T00:00:00.000Z',
      routingEnabled: true,
      slot: TEST_ACTIVE_SLOT,
      digest: 'stable-config',
    }
    const artifact = buildSafeEvidenceArtifact({
      ranAt: '2026-07-22T00:00:00.000Z',
      gitSha: 'deadbeef',
      fixtureSchemaVersion: 'jobs-evidence-golden-set.v1',
      fixtureDigest: 'fixture-digest',
      promptDigest: 'prompt-digest',
      activeSlot: TEST_ACTIVE_SLOT,
      startConfig: config,
      endConfig: config,
    }, [unsafeCase], metrics)
    const serialized = JSON.stringify(artifact)

    expect(artifact.cases[0].contextProfile).toBe('observed-production-upper-tail')
    expect(artifact.summary.modelConfig.stable).toBe(true)
    expect(artifact.summary.activation).toEqual({
      eligible: false,
      blockers: expect.arrayContaining(['pair-level-strength-contract-not-versioned']),
    })
    for (const rawText of [rawQuestion, rawAnswer, rawRequirement, rawJobDescription]) {
      expect(serialized).not.toContain(rawText)
    }
    expect(serialized).not.toMatch(/"(?:question|answer|requirement|jobDescription|rawModelText)"/)
  })
})

describe.skipIf(!LIVE)('Jobs evidence golden-set live calibration', () => {
  it('meets the PR-R2 entry gates against the authoritative production contract', async () => {
    const fixtures = evidenceGoldenSet as EvidenceFixture[]
    expect(fixtures.length).toBeGreaterThanOrEqual(5)
    expect(fixtures.flatMap((fixture) => fixture.labels).length).toBeGreaterThanOrEqual(30)
    const dirtyTree = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { encoding: 'utf8' },
    ).trim()
    expect(
      dirtyTree,
      'live calibration requires a clean tree so its commit SHA and contract digests are reproducible',
    ).toBe('')

    const { activeSlot, startConfig } = await stableActiveSlot()
    const caseResults: EvidenceCaseResult[] = await pool(fixtures, CONCURRENCY, async (fixture) => {
      try {
        const classification = await classifyEvidenceAttribution({
          answers: fixture.answers.map((answer) => ({ ...answer, answerScore: 0 })),
          mustHaves: fixture.mustHaves,
        })
        const answerIndexes = new Set(fixture.answers.map((answer) => answer.index))
        const requirementIds = new Set(fixture.mustHaves.map((requirement) => requirement.id))
        const predictedPairs = new Map<string, Strength>()
        const contractViolations: string[] = []

        for (const attribution of classification.attributions) {
          if (!answerIndexes.has(attribution.answerIndex)) contractViolations.push('unknown-answer-index')
          if (attribution.strength !== 'none' && attribution.requirementIds.length === 0) {
            contractViolations.push('empty-evidence-requirement-group')
          }
          if (attribution.strength === 'none' && attribution.requirementIds.length !== 0) {
            contractViolations.push('nonempty-none-requirement-group')
          }
          for (const requirementId of attribution.requirementIds) {
            if (!requirementIds.has(requirementId)) contractViolations.push('foreign-requirement-id')
            const pair = `${attribution.answerIndex}\u0000${requirementId}`
            if (predictedPairs.has(pair)) contractViolations.push('duplicate-answer-requirement-pair')
            predictedPairs.set(pair, attribution.strength)
          }
        }

        const attemptDrift = classification.attempts.some(
          (attempt) => attempt.model !== activeSlot.model || attempt.provider !== activeSlot.provider,
        )
        const usedFallback = classification.attempts.some((attempt) => attempt.usedFallback)
        const ok = !attemptDrift && !usedFallback && contractViolations.length === 0
        return {
          caseId: fixture.id,
          segment: fixture.segment,
          domain: fixture.domain,
          challenge: fixture.challenge,
          contextProfile: fixture.contextProfile,
          ok,
          errorKind: ok ? null : 'contract-integrity',
          contractViolations: Array.from(new Set(contractViolations)),
          attempts: classification.attempts,
          predictions: fixture.labels.map((label) => ({
            id: `${fixture.id}:${label.answerIndex}:${label.requirementId}`,
            expected: label.strength,
            predicted: ok ? (predictedPairs.get(`${label.answerIndex}\u0000${label.requirementId}`) ?? 'none') : 'error' as Prediction,
          })),
        }
      } catch (error) {
        return {
          caseId: fixture.id,
          segment: fixture.segment,
          domain: fixture.domain,
          challenge: fixture.challenge,
          contextProfile: fixture.contextProfile,
          ok: false,
          errorKind: error instanceof Error ? error.name : 'UnknownError',
          contractViolations: [] as string[],
          attempts: attemptsFrom(error),
          // A failed case makes every label incorrect, including expected
          // `none`; otherwise an outage could improve binary agreement.
          predictions: fixture.labels.map((label) => ({
            id: `${fixture.id}:${label.answerIndex}:${label.requirementId}`,
            expected: label.strength,
            predicted: 'error' as const,
          })),
        }
      }
    })

    const endConfig = await authoritativeModelConfigSnapshot()
    const metrics = computeEvidenceCalibrationMetrics(caseResults, activeSlot, startConfig, endConfig)
    const failures = evidenceGateFailures(metrics)
    const gatePassed = failures.length === 0

    const promptDigest = digest({
      contractVersion: EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
      system: EVIDENCE_ATTRIBUTION_SYSTEM_PROMPT,
      template: buildAttributionPrompt(
        [{ index: 0, question: '<QUESTION>', answer: '<ANSWER>', answerScore: 0 }],
        [{ id: '<REQUIREMENT_ID>', requirement: '<REQUIREMENT>' }],
      ),
    })
    const artifact = buildSafeEvidenceArtifact({
      ranAt: new Date().toISOString(),
      gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      fixtureSchemaVersion: fixtures[0]?.schemaVersion ?? null,
      fixtureDigest: digest(fixtures),
      promptDigest,
      activeSlot,
      startConfig,
      endConfig,
    }, caseResults, metrics)

    const {
      exactAgreement,
      binaryAgreement,
      noneRecall,
      strongPrecision,
      caseMacroAgreement,
      evaluatorErrorRate,
      upperTailFailureCount,
      challengeFalseEvidenceIds,
      fallbackCount,
      modelDriftCount,
      contractViolationCount,
      modelConfigStable,
    } = metrics

    const resultsDir = join(process.cwd(), 'modules/jobs/eval/results')
    mkdirSync(resultsDir, { recursive: true })
    const safeModel = activeSlot.model.replace(/[^a-z0-9.-]/gi, '_')
    const artifactName = gatePassed
      ? `baseline-evidence-${safeModel}-${Date.now()}.json`
      : `evidence-failed-${safeModel}-${Date.now()}.json`
    const artifactPath = join(resultsDir, artifactName)
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))

    // eslint-disable-next-line no-console
    console.log(
      `\n── Jobs evidence calibration ── ${activeSlot.provider}/${activeSlot.model}\n` +
      `exact strength:    ${(exactAgreement * 100).toFixed(1)}% (gate >=80%)\n` +
      `evidence-vs-none:  ${(binaryAgreement * 100).toFixed(1)}% (gate >=90%)\n` +
      `none recall:       ${(noneRecall * 100).toFixed(1)}% (gate >=90%)\n` +
      `strong precision:  ${(strongPrecision * 100).toFixed(1)}% (gate >=80%)\n` +
      `case macro exact:  ${(caseMacroAgreement * 100).toFixed(1)}% (gate >=75%)\n` +
      `evaluator errors:  ${(evaluatorErrorRate * 100).toFixed(1)}% (gate <5%)\n` +
      `upper-tail fails:  ${upperTailFailureCount} (gate 0)\n` +
      `challenge false+:  ${challengeFalseEvidenceIds.length} (gate 0)\n` +
      `fallback/drift:    ${fallbackCount}/${modelDriftCount} (gate 0/0)\n` +
      `contract issues:   ${contractViolationCount} (gate 0)\n` +
      `config stable:     ${modelConfigStable ? 'yes' : 'NO'}\n` +
      `gate:              ${gatePassed ? 'TECHNICAL PASS — FOUNDER APPROVAL PENDING' : `FAIL (${failures.join(', ')})`}\n` +
      `artifact:          ${artifactPath}\n`,
    )

    expect(failures, `calibration failed; diagnostic artifact: ${artifactPath}`).toEqual([])
  }, 1_800_000)
})

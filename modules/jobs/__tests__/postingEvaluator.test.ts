import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))

import { evaluatePosting, expectedVerdictModel, type EvaluatorDeps } from '../services/postingEvaluator'
import { JOB_DOMAINS } from '../config/domains'
import { PROMPT_VERSION } from '../config/verdictSchema'

const MODEL = expectedVerdictModel()

const VALID_VERDICT = {
  verdict: 'genuine',
  reasonCodes: ['ok'],
  genuineness: 0.9,
  quality: 0.7,
  completeness: 0.8,
  domain: JOB_DOMAINS[0].id,
  domainConfidence: 0.8,
  seniority: 'mid',
  fresherFriendly: false,
  geo: { locations: ['Pune'], workMode: 'onsite' },
}

const INPUT = {
  companyKey: 'phonepe',
  titleKey: 'backend engineer',
  locationKey: 'bengaluru',
  sourceId: 'jsearch',
  prompt: {
    title: 'Backend Engineer',
    company: 'PhonePe',
    city: 'Bengaluru',
    isRemote: false,
    salaryText: null,
    applyHosts: ['boards.greenhouse.io'],
    body: 'Build services. Contact hr@x.co or 9876543210.',
  },
}

function completionOf(text: string, over: Partial<{ model: string; usedFallback: boolean }> = {}) {
  return { text, model: over.model ?? MODEL, provider: 'openai', inputTokens: 4000, outputTokens: 300, usedFallback: over.usedFallback ?? false }
}

function makeDeps(over: Partial<EvaluatorDeps> = {}): EvaluatorDeps & { recorded: number[] } {
  const recorded: number[] = []
  return {
    completionFn: vi.fn().mockResolvedValue(completionOf(JSON.stringify(VALID_VERDICT))) as never,
    checkBudget: vi.fn().mockResolvedValue({ allowed: true, softening: false }),
    recordSpend: vi.fn(async (_c: string, _s: string, usd: number) => { recorded.push(usd) }),
    pricing: { inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.0 },
    recorded,
    ...over,
  } as never
}

afterEach(() => vi.useRealTimers())

describe('postingEvaluator (§4.5 — never throws, never fabricates)', () => {
  it('happy path: validated verdict + cost from token pricing + spend recorded', async () => {
    const deps = makeDeps()
    const out = await evaluatePosting(INPUT, deps)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.verdict.verdict).toBe('genuine')
      expect(out.epoch).toBe(`${MODEL}:${PROMPT_VERSION}`)
      expect(out.costUsd).toBeCloseTo((4000 * 0.5 + 300 * 2.0) / 1_000_000)
      expect(out.cached).toBe(false)
    }
    expect(deps.recorded).toHaveLength(1)
    // PII was stripped BEFORE the prompt reached the model (ruling #9)
    const sent = (deps.completionFn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.messages[0].content).not.toContain('hr@x.co')
    expect(sent.messages[0].content).not.toContain('9876543210')
  })

  it('cache hit: no model call, no budget check, zero cost', async () => {
    const deps = makeDeps({
      cache: { get: vi.fn().mockResolvedValue(JSON.stringify(VALID_VERDICT)), set: vi.fn() },
    })
    const out = await evaluatePosting(INPUT, deps)
    expect(out.ok && out.cached).toBe(true)
    expect(deps.completionFn).not.toHaveBeenCalled()
    expect(deps.checkBudget).not.toHaveBeenCalled()
  })

  it('budget denied: no model call, kind=budget', async () => {
    const deps = makeDeps({ checkBudget: vi.fn().mockResolvedValue({ allowed: false, softening: true, reason: 'daily-95pct' }) })
    const out = await evaluatePosting(INPUT, deps)
    expect(out).toMatchObject({ ok: false, kind: 'budget', message: 'daily-95pct' })
    expect(deps.completionFn).not.toHaveBeenCalled()
  })

  it('12s timeout → kind=timeout, verdict stays pending semantics', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({ completionFn: vi.fn(() => new Promise(() => {})) as never })
    const pending = evaluatePosting(INPUT, deps)
    await vi.advanceTimersByTimeAsync(12_001)
    const out = await pending
    expect(out).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('unparseable text → ONE repair completion; repair success = verdict, both costs counted', async () => {
    const completionFn = vi.fn()
      .mockResolvedValueOnce(completionOf('Sure! Here is the verdict: {broken'))
      .mockResolvedValueOnce(completionOf(JSON.stringify(VALID_VERDICT)))
    const deps = makeDeps({ completionFn: completionFn as never })
    const out = await evaluatePosting(INPUT, deps)
    expect(out.ok).toBe(true)
    expect(completionFn).toHaveBeenCalledTimes(2)
    if (out.ok) expect(out.costUsd).toBeCloseTo(2 * (4000 * 0.5 + 300 * 2.0) / 1_000_000)
  })

  it('repair also unparseable → kind=parse, exactly two attempts, spend still recorded', async () => {
    const completionFn = vi.fn().mockResolvedValue(completionOf('not json at all'))
    const deps = makeDeps({ completionFn: completionFn as never })
    const out = await evaluatePosting(INPUT, deps)
    expect(out).toMatchObject({ ok: false, kind: 'parse' })
    expect(completionFn).toHaveBeenCalledTimes(2)
    expect(deps.recorded).toHaveLength(1)
  })

  it('valid JSON failing Zod → kind=schema, never a fabricated verdict', async () => {
    const deps = makeDeps({
      completionFn: vi.fn().mockResolvedValue(completionOf(JSON.stringify({ ...VALID_VERDICT, verdict: 'excellent' }))) as never,
    })
    const out = await evaluatePosting(INPUT, deps)
    expect(out).toMatchObject({ ok: false, kind: 'schema' })
  })

  it('fallback-served or wrong-model results are REJECTED — epochs stay homogeneous', async () => {
    const fallback = makeDeps({ completionFn: vi.fn().mockResolvedValue(completionOf(JSON.stringify(VALID_VERDICT), { usedFallback: true })) as never })
    expect(await evaluatePosting(INPUT, fallback)).toMatchObject({ ok: false, kind: 'model-mismatch' })
    const wrongModel = makeDeps({ completionFn: vi.fn().mockResolvedValue(completionOf(JSON.stringify(VALID_VERDICT), { model: 'claude-haiku-4-5' })) as never })
    expect(await evaluatePosting(INPUT, wrongModel)).toMatchObject({ ok: false, kind: 'model-mismatch' })
  })

  it('deps.expectedModel (CMS-resolved epoch) overrides the code default', async () => {
    // served model matches the CMS-resolved model but NOT the code default → accepted
    const deps = makeDeps({
      expectedModel: 'gpt-7-nova',
      completionFn: vi.fn().mockResolvedValue(completionOf(JSON.stringify(VALID_VERDICT), { model: 'gpt-7-nova' })) as never,
    })
    const out = await evaluatePosting(INPUT, deps)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.epoch).toBe(`gpt-7-nova:${PROMPT_VERSION}`)
  })

  it('the hash binds to the model-visible slice: a middle-only change re-uses the verdict', async () => {
    const head = 'H'.repeat(3000)
    const tail = 'T'.repeat(1500)
    const a = await evaluatePosting({ ...INPUT, prompt: { ...INPUT.prompt, body: head + 'M'.repeat(9000) + tail } }, makeDeps())
    const b = await evaluatePosting({ ...INPUT, prompt: { ...INPUT.prompt, body: head + 'X'.repeat(9000) + tail } }, makeDeps())
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.inputHash).toBe(b.inputHash) // content the model never sees cannot invalidate its verdict
  })

  it('successful verdicts are cached under the input hash', async () => {
    const set = vi.fn()
    const deps = makeDeps({ cache: { get: vi.fn().mockResolvedValue(null), set } })
    const out = await evaluatePosting(INPUT, deps)
    expect(out.ok).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    if (out.ok) expect(set.mock.calls[0][0]).toBe(`jobs:verdict:v1:${out.inputHash}`) // cache namespace is independent of PROMPT_VERSION (the hash embeds it)
  })
})

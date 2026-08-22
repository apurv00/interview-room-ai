import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import goldenSet from '../eval/goldenSet.json'
import evidenceGoldenSet from '../eval/evidenceGoldenSet.json'
import { REASON_CODES } from '../config/verdictSchema'
import { JOB_DOMAIN_IDS } from '../config/domains'

/**
 * ALWAYS-ON shape guard for the golden set (the live eval itself is
 * env-gated and never runs in CI). Keeps the corpus honest: valid shape,
 * unique ids, category floors per the §4.5 gate design, plain-text bodies
 * (the pipeline stores tag-stripped text — a tagged fixture would test an
 * input the classifier can never receive), and no fixture that would make
 * the fraud-FP gate unmeasurable.
 */

const FixtureSchema = z.object({
  id: z.string().min(3),
  category: z.enum(['adversarial-fraud', 'labeled-genuine', 'injection']),
  expect: z.object({
    verdicts: z.array(z.enum(['genuine', 'suspicious', 'fraud'])).min(1),
    genuinenessMax: z.number().min(0).max(1).optional(),
    genuinenessMin: z.number().min(0).max(1).optional(),
    reasonCodesInclude: z.array(z.enum(REASON_CODES as unknown as [string, ...string[]])).optional(),
  }),
  posting: z.object({
    title: z.string().min(3).max(300),
    company: z.string().min(1).max(300),
    city: z.string(),
    isRemote: z.boolean(),
    salaryText: z.string().max(200).nullable().optional(),
    applyHosts: z.array(z.string()),
    body: z.string().min(100).max(6000),
  }),
  note: z.string().min(5),
  informational: z.boolean().optional(),
})

const EVIDENCE_FIXTURE_SCHEMA_VERSION = 'jobs-evidence-golden-set.v1' as const
const EVIDENCE_STRENGTHS = ['strong', 'partial', 'none'] as const
const MIN_EVIDENCE_CASES = 5
const MIN_LABELED_PAIRS = 30
const MIN_PER_STRENGTH = 8
const MIN_PER_SEGMENT = 8
const MIN_PER_DOMAIN = 5
const MIN_DISTINCT_DOMAINS = 3
const MAX_PRODUCTION_ANSWER_INDEX = 500
const MAX_PRODUCTION_ANSWERS = MAX_PRODUCTION_ANSWER_INDEX + 1
const V1_SINGLE_RESPONSE_GROUP_LIMIT = 40
const SOURCE_CASE_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const EvidenceFixtureSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_FIXTURE_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    segment: z.enum(['fresher', 'professional']),
    domain: z.enum(JOB_DOMAIN_IDS as unknown as [string, ...string[]]),
    challenge: z.enum(['ordinary', 'negation', 'prompt-injection']),
    contextProfile: z.enum(['ordinary', 'observed-production-upper-tail']),
    provenance: z
      .object({
        origin: z.literal('founder-session-consented'),
        sourceCaseId: z.string().regex(SOURCE_CASE_ID_V4),
        manuallyRedacted: z.literal(true),
        consentRecordHeldOffRepo: z.literal(true),
        labeledBy: z.literal('founder'),
      })
      .strict(),
    answers: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(MAX_PRODUCTION_ANSWER_INDEX),
            question: z.string().min(1).max(500),
            answer: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PRODUCTION_ANSWERS),
    mustHaves: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            requirement: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    /** Complete labels over answers × must-haves. Requiring the full matrix
     * makes every false evidence claim measurable instead of hiding it in an
     * unlabelled pair, including measured long-session cases. */
    labels: z
      .array(
        z
          .object({
            answerIndex: z.number().int().min(0).max(MAX_PRODUCTION_ANSWER_INDEX),
            requirementId: z.string().min(1).max(120),
            strength: z.enum(EVIDENCE_STRENGTHS),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const answerIndexes = fixture.answers.map((answer) => answer.index)
    const requirementIds = fixture.mustHaves.map((requirement) => requirement.id)
    if (new Set(answerIndexes).size !== answerIndexes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: 'answer indexes must be unique' })
    }
    if (new Set(requirementIds).size !== requirementIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mustHaves'], message: 'requirement ids must be unique' })
    }

    const answerSet = new Set(answerIndexes)
    const requirementSet = new Set(requirementIds)
    const labeledPairs = new Set<string>()
    fixture.labels.forEach((label, index) => {
      if (!answerSet.has(label.answerIndex)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labels', index, 'answerIndex'], message: 'unknown answer index' })
      }
      if (!requirementSet.has(label.requirementId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labels', index, 'requirementId'], message: 'unknown requirement id' })
      }
      const pair = `${label.answerIndex}\u0000${label.requirementId}`
      if (labeledPairs.has(pair)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labels', index], message: 'duplicate labeled pair' })
      }
      labeledPairs.add(pair)
    })
    if (labeledPairs.size !== answerIndexes.length * requirementIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels'],
        message: 'labels must cover every answer × must-have pair exactly once',
      })
    }
    if (hasMixedEvidenceDepth(fixture.labels)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels'],
        message: 'v1 permits only one non-none evidence depth per answer',
      })
    }
    if (
      fixture.challenge !== 'ordinary' &&
      !fixture.labels.some((label) => label.strength === 'none')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels'],
        message: 'challenge cases need at least one none label so false evidence is measurable',
      })
    }
  })

const RAW_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const RAW_URL = /\b(?:https?:\/\/|www\.)\S+/i
const RAW_PHONE = /(?:^|\D)(?:\+?\d[\s().-]*){10,15}(?:\D|$)/
const RAW_DATABASE_ID = /\b[a-f0-9]{24}\b/i

function hasMixedEvidenceDepth(labels: Array<{ answerIndex: number; strength: string }>): boolean {
  const byAnswer = new Map<number, Set<string>>()
  for (const label of labels) {
    if (label.strength === 'none') continue
    const depths = byAnswer.get(label.answerIndex) ?? new Set<string>()
    depths.add(label.strength); byAnswer.set(label.answerIndex, depths)
  }
  return Array.from(byAnswer.values()).some((depths) => depths.size > 1)
}

function containsUnsanitizedIdentifier(text: string): boolean {
  return RAW_EMAIL.test(text) || RAW_URL.test(text) || RAW_PHONE.test(text) || RAW_DATABASE_ID.test(text)
}

const SYNTHETIC_VALID_EVIDENCE_FIXTURE = {
  schemaVersion: EVIDENCE_FIXTURE_SCHEMA_VERSION,
  id: 'synthetic-valid-case',
  segment: 'fresher',
  domain: 'backend',
  challenge: 'ordinary',
  contextProfile: 'ordinary',
  provenance: {
    origin: 'founder-session-consented',
    sourceCaseId: '00000000-0000-4000-8000-000000000001',
    manuallyRedacted: true,
    consentRecordHeldOffRepo: true,
    labeledBy: 'founder',
  },
  answers: [{
    index: 0,
    question: 'How did you make a production change safer?',
    answer: 'I added a transaction boundary, exercised the race, and monitored the rollout.',
  }],
  mustHaves: [{ id: 'safe-delivery', requirement: 'Demonstrates safe production delivery' }],
  labels: [{ answerIndex: 0, requirementId: 'safe-delivery', strength: 'strong' }],
} as const

describe('golden set shape (CI guard for the env-gated live eval)', () => {
  const fixtures = goldenSet as Array<z.infer<typeof FixtureSchema>>

  it('every fixture validates', () => {
    for (const f of fixtures) {
      const r = FixtureSchema.safeParse(f)
      expect(r.success, `${(f as { id?: string }).id}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true)
    }
  })

  it('ids are unique and category floors hold (37/40/50 design targets)', () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length)
    const count = (c: string) => fixtures.filter((f) => f.category === c).length
    expect(count('adversarial-fraud')).toBeGreaterThanOrEqual(30)
    expect(count('labeled-genuine')).toBeGreaterThanOrEqual(35)
    expect(count('injection')).toBeGreaterThanOrEqual(40)
  })

  it('bodies are plain text — the classifier never receives tags', () => {
    for (const f of fixtures) {
      expect(/<[^>]+>/.test(f.posting.body), `${f.id} contains a markup tag`).toBe(false)
    }
  })

  it('no labeled-genuine fixture expects only fraud — the FP gate must stay measurable', () => {
    for (const f of fixtures.filter((x) => x.category === 'labeled-genuine')) {
      expect(f.expect.verdicts.includes('genuine') || f.expect.verdicts.includes('suspicious'), f.id).toBe(true)
    }
  })
})

describe('evidence golden set shape (CI guard for the PR-R2 calibration gate)', () => {
  const fixtures = evidenceGoldenSet as unknown[]

  it('accepts a complete synthetic fixture while the release corpus is closed', () => {
    expect(EvidenceFixtureSchema.safeParse(SYNTHETIC_VALID_EVIDENCE_FIXTURE).success).toBe(true)
  })

  it('rejects synthetic fixtures with incomplete or unsafe label contracts', () => {
    const unknownAnswer = {
      ...SYNTHETIC_VALID_EVIDENCE_FIXTURE,
      labels: [{ answerIndex: 1, requirementId: 'safe-delivery', strength: 'strong' as const }],
    }
    const challengeWithoutNone = {
      ...SYNTHETIC_VALID_EVIDENCE_FIXTURE,
      challenge: 'prompt-injection' as const,
    }
    const unexpectedField = {
      ...SYNTHETIC_VALID_EVIDENCE_FIXTURE,
      rawCandidateEmail: 'must-not-be-accepted',
    }

    for (const fixture of [unknownAnswer, challengeWithoutNone, unexpectedField]) {
      expect(EvidenceFixtureSchema.safeParse(fixture).success).toBe(false)
    }
  })

  it.each([
    'candidate@example.com',
    'https://example.com/private/session',
    '+1 (415) 555-2671',
    '507f1f77bcf86cd799439011',
  ])('detects an unsanitized identifier in synthetic candidate text: %s', (rawIdentifier) => {
    expect(containsUnsanitizedIdentifier(`Candidate detail: ${rawIdentifier}`)).toBe(true)
  })

  it('accepts explicitly redacted synthetic candidate text', () => {
    expect(
      containsUnsanitizedIdentifier(
        'Candidate contact, profile link, phone, and database identifier were manually redacted.',
      ),
    ).toBe(false)
  })

  it('keeps v1 labels to one non-none evidence depth per answer', () => {
    expect(hasMixedEvidenceDepth([{ answerIndex: 0, strength: 'strong' }, { answerIndex: 0, strength: 'partial' }])).toBe(true)
    expect(hasMixedEvidenceDepth([{ answerIndex: 0, strength: 'strong' }, { answerIndex: 0, strength: 'none' }])).toBe(false)
  })

  it('is exactly empty while the gate is closed, or is a complete release-gate corpus', () => {
    if (fixtures.length === 0) {
      const gateState = {
        state: 'closed',
        cases: fixtures.length,
        labeledPairs: 0,
      }
      expect(gateState).toEqual({ state: 'closed', cases: 0, labeledPairs: 0 })
      return
    }

    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_EVIDENCE_CASES)
    for (const fixture of fixtures) {
      const result = EvidenceFixtureSchema.safeParse(fixture)
      expect(
        result.success,
        `${String((fixture as { id?: unknown }).id)}: ${result.success ? '' : JSON.stringify(result.error.issues)}`,
      ).toBe(true)
    }

    const parsed = fixtures as Array<z.infer<typeof EvidenceFixtureSchema>>
    expect(new Set(parsed.map((fixture) => fixture.id)).size).toBe(parsed.length)
    expect(new Set(parsed.map((fixture) => fixture.provenance.sourceCaseId)).size).toBe(parsed.length)

    const labels = parsed.flatMap((fixture) => fixture.labels)
    expect(labels.length).toBeGreaterThanOrEqual(MIN_LABELED_PAIRS)
    for (const strength of EVIDENCE_STRENGTHS) {
      expect(labels.filter((label) => label.strength === strength).length, strength).toBeGreaterThanOrEqual(MIN_PER_STRENGTH)
    }
    expect(new Set(parsed.map((fixture) => fixture.segment))).toEqual(new Set(['fresher', 'professional']))
    for (const segment of ['fresher', 'professional'] as const) {
      expect(
        parsed.filter((fixture) => fixture.segment === segment).flatMap((fixture) => fixture.labels).length,
        segment,
      ).toBeGreaterThanOrEqual(MIN_PER_SEGMENT)
    }
    const domains = new Set(parsed.map((fixture) => fixture.domain))
    expect(domains.size).toBeGreaterThanOrEqual(MIN_DISTINCT_DOMAINS)
    for (const domain of domains) {
      expect(
        parsed.filter((fixture) => fixture.domain === domain).flatMap((fixture) => fixture.labels).length,
        domain,
      ).toBeGreaterThanOrEqual(MIN_PER_DOMAIN)
    }
    for (const challenge of ['negation', 'prompt-injection'] as const) {
      expect(parsed.some((fixture) => fixture.challenge === challenge), challenge).toBe(true)
    }
    expect(
      parsed.some((fixture) =>
        fixture.contextProfile === 'observed-production-upper-tail' &&
        fixture.answers.length > V1_SINGLE_RESPONSE_GROUP_LIMIT,
      ),
      'corpus must include a measured upper-tail session beyond the v1 single-response group limit',
    ).toBe(true)
  })

  it('contains no raw contact details, URLs, or database/session ids', () => {
    for (const fixture of fixtures as Array<Record<string, unknown>>) {
      const candidateText = JSON.stringify({
        id: fixture.id,
        challenge: fixture.challenge,
        provenance: fixture.provenance,
        answers: fixture.answers,
        mustHaves: fixture.mustHaves,
        labels: fixture.labels,
      })
      expect(containsUnsanitizedIdentifier(candidateText), String(fixture.id)).toBe(false)
    }
  })
})

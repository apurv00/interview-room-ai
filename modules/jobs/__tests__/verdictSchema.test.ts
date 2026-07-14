import { describe, it, expect } from 'vitest'
import {
  JobVerdictSchema,
  REASON_CODES,
  FRAUD_REASON_CODES,
  SUSPICIOUS_REASON_CODES,
  CLEAN_REASON_CODES,
  VERDICT_DOMAIN_IDS,
  PROMPT_VERSION,
  epochOf,
} from '../config/verdictSchema'
import { JOB_DOMAINS } from '../config/domains'

const valid = {
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

describe('JobVerdictSchema (§4.5 layer 2 output contract)', () => {
  it('accepts a fully-formed verdict', () => {
    expect(JobVerdictSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects free-text smuggling: unknown keys are refused (strict)', () => {
    expect(JobVerdictSchema.safeParse({ ...valid, rationale: 'trust me' }).success).toBe(false)
  })

  it('rejects out-of-enum values everywhere', () => {
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'maybe' }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, reasonCodes: ['made_up_code'] }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, domain: 'astrology' }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, seniority: 'principal' }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, geo: { locations: [], workMode: 'wfh' } }).success).toBe(false)
  })

  it('bounds every scalar to [0,1] and reasonCodes to 1-4', () => {
    expect(JobVerdictSchema.safeParse({ ...valid, genuineness: 1.2 }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, quality: -0.1 }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, reasonCodes: [] }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, reasonCodes: ['ok', 'ok', 'ok', 'ok', 'ok'] }).success).toBe(false)
  })

  it('rejects missing required fields — a partial verdict is no verdict', () => {
    const { fresherFriendly: _omit, ...partial } = valid
    expect(JobVerdictSchema.safeParse(partial).success).toBe(false)
  })

  it('FROZEN enums — additions require a PROMPT_VERSION bump (snapshot)', () => {
    expect(FRAUD_REASON_CODES).toEqual(['fee_fraud', 'contact_harvest', 'pii_harvest', 'mlm_pyramid', 'training_bait', 'fake_company', 'not_a_job'])
    expect(SUSPICIOUS_REASON_CODES).toEqual(['mass_repost_shell', 'title_body_mismatch', 'vague_jd', 'salary_unrealistic', 'walk_in_funnel', 'consultancy_funnel'])
    expect(CLEAN_REASON_CODES).toEqual(['legit_staffing', 'thin_but_genuine', 'ok'])
    expect(REASON_CODES).toHaveLength(16)
    expect(PROMPT_VERSION).toBe('v1')
  })

  it('domain vocabulary IS the unified taxonomy + other — never a parallel list', () => {
    expect(VERDICT_DOMAIN_IDS).toEqual([...JOB_DOMAINS.map((d) => d.id), 'other'])
  })

  it('reason codes must justify the verdict class — contradictory output is invalid (Codex #515)', () => {
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'genuine', reasonCodes: ['fee_fraud'] }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'fraud', reasonCodes: ['ok'] }).success).toBe(false)
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'fraud', reasonCodes: ['vague_jd'] }).success).toBe(false) // no fraud-class code
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'suspicious', reasonCodes: ['legit_staffing'] }).success).toBe(false)
    // coherent combinations pass
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'fraud', reasonCodes: ['fee_fraud', 'vague_jd'], genuineness: 0.1 }).success).toBe(true)
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'suspicious', reasonCodes: ['vague_jd'] }).success).toBe(true)
    expect(JobVerdictSchema.safeParse({ ...valid, verdict: 'genuine', reasonCodes: ['legit_staffing'] }).success).toBe(true)
  })

  it('epochOf = model:promptVersion', () => {
    expect(epochOf('gpt-5.6-luna')).toBe(`gpt-5.6-luna:${PROMPT_VERSION}`)
  })
})

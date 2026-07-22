import { describe, expect, it } from 'vitest'
import {
  applyOptionIdOf,
  canonicalApplyOptionsOf,
  parseApplyOptionMutation,
  resolveApplyOption,
} from '../services/applyOptionIdentity'

const SOURCE = {
  sourceKey: 'greenhouse:company:123',
  applyUrl: 'https://boards.greenhouse.io/company/jobs/123',
  applyTier: 'direct-ats' as const,
  viaSite: 'Greenhouse',
}

describe('canonical apply-option identity', () => {
  it('is opaque and binds the exact canonical URL generation, not provider presentation', () => {
    const id = applyOptionIdOf({ url: SOURCE.applyUrl })

    expect(id).toMatch(/^ao2_[A-Za-z0-9_-]{43}$/)
    expect(applyOptionIdOf({ url: SOURCE.applyUrl })).toBe(id)
    expect(id).not.toContain('greenhouse')
    expect(id).not.toContain('boards')
    expect(applyOptionIdOf({
      sourceKey: 'other:source',
      url: SOURCE.applyUrl,
      tier: 'employer',
    })).toBe(id)
    expect(applyOptionIdOf({ url: `${SOURCE.applyUrl}?new=1` })).not.toBe(id)
    expect(applyOptionIdOf({ url: SOURCE.applyUrl, generation: `lg1_${'A'.repeat(43)}` }))
      .not.toBe(id)
  })

  it('deduplicates exact canonical URLs, selects the best tier, and ignores legacy counts', () => {
    const duplicate = {
      ...SOURCE,
      sourceKey: 'employer:company:123',
      applyUrl: 'https://BOARDS.greenhouse.io/company/jobs/123#apply',
      applyTier: 'employer' as const,
      brokenReportCount: 99,
    }
    const options = canonicalApplyOptionsOf([
      duplicate,
      SOURCE,
      SOURCE,
      { ...SOURCE, sourceKey: '', applyUrl: 'https://example.com/missing-key' },
      { ...SOURCE, sourceKey: 'evil:1', applyUrl: 'javascript:alert(1)' },
      { ...SOURCE, sourceKey: 'private:1', applyUrl: 'http://127.0.0.1/admin' },
      { ...SOURCE, sourceKey: 'metadata:1', applyUrl: 'http://169.254.169.254/latest' },
      { ...SOURCE, sourceKey: 'credentials:1', applyUrl: 'https://user:secret@example.com/apply' },
      { ...SOURCE, sourceKey: 'port:1', applyUrl: 'https://example.com:8443/apply' },
      { ...SOURCE, sourceKey: 'blocklisted:1', applyUrl: 'https://wa.me/919876543210' },
      { ...SOURCE, sourceKey: 'bad-tier:1', applyTier: 'sponsored' },
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      sourceKey: SOURCE.sourceKey,
      sourceKeys: [duplicate.sourceKey, SOURCE.sourceKey],
      url: SOURCE.applyUrl,
      tier: SOURCE.applyTier,
      viaSite: SOURCE.viaSite,
      incidentVersion: 1,
      broken: false,
    })
    expect(resolveApplyOption([SOURCE], options[0].optionId)).toEqual({
      ...options[0],
      sourceKeys: [SOURCE.sourceKey],
    })
    expect(resolveApplyOption([{ ...SOURCE, applyUrl: 'https://example.com/replaced' }], options[0].optionId)).toBeNull()
  })

  it('rejects a stale id when the same URL starts a new generation', () => {
    const firstSeen = new Date('2026-07-20T00:00:00.000Z')
    const oldSource = { ...SOURCE, applyUrlFirstSeenAt: firstSeen }
    const oldOption = canonicalApplyOptionsOf([oldSource])[0]
    const replacement = {
      ...SOURCE,
      applyUrlFirstSeenAt: new Date('2026-07-21T00:00:00.000Z'),
    }
    const currentOption = canonicalApplyOptionsOf([replacement])[0]

    expect(currentOption.optionId).not.toBe(oldOption.optionId)
    expect(resolveApplyOption([replacement], oldOption.optionId)).toBeNull()
    expect(resolveApplyOption([replacement], currentOption.optionId)).toEqual(currentOption)
  })

  it('keeps group generation stable when one duplicate provider disappears', () => {
    const early = { ...SOURCE, applyUrlFirstSeenAt: new Date('2026-07-20T00:00:00.000Z') }
    const later = {
      ...SOURCE,
      sourceKey: 'duplicate:later',
      applyUrlFirstSeenAt: new Date('2026-07-21T00:00:00.000Z'),
    }
    const initial = canonicalApplyOptionsOf([early, later])[0]
    const remaining = {
      ...later,
      linkGovernance: initial.governance,
    }

    expect(canonicalApplyOptionsOf([remaining])[0].optionId).toBe(initial.optionId)
  })

  it('keeps a mixed legacy and newly observed duplicate on the legacy generation', () => {
    const legacy = { ...SOURCE }
    const first = canonicalApplyOptionsOf([legacy])[0]
    const duplicate = {
      ...SOURCE,
      sourceKey: 'duplicate:new',
      applyUrlFirstSeenAt: new Date('2026-07-21T00:00:00.000Z'),
    }

    expect(canonicalApplyOptionsOf([legacy, duplicate])[0].optionId).toBe(first.optionId)
  })

  it('demotes only from current governance and shares it across duplicate URLs', () => {
    const clean = canonicalApplyOptionsOf([{ ...SOURCE, brokenReportCount: 500 }])[0]
    expect(clean.broken).toBe(false)
    const governance = {
      subject: clean.subject,
      generation: clean.generation,
      incidentVersion: 1,
      reportWindowStartedAt: new Date('2026-07-21T00:00:00.000Z'),
      reportCount: 3,
      crowdDemotedAt: new Date('2026-07-21T00:00:00.000Z'),
    }
    const options = canonicalApplyOptionsOf([
      { ...SOURCE, linkGovernance: governance },
      { ...SOURCE, sourceKey: 'duplicate:2', applyTier: 'employer' as const, linkGovernance: governance },
    ])
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ broken: true, incidentVersion: 1 })
  })

  it.each([
    {
      name: 'a missing report window',
      governance: {
        reportCount: 3,
        crowdDemotedAt: new Date('2026-07-21T03:00:00.000Z'),
      },
      expectedReportCount: 0,
    },
    {
      name: 'an invalid report window',
      governance: {
        reportWindowStartedAt: 'not-a-date',
        reportCount: 3,
        crowdDemotedAt: new Date('2026-07-21T03:00:00.000Z'),
      },
      expectedReportCount: 0,
    },
    {
      name: 'fewer than three reports',
      governance: {
        reportWindowStartedAt: new Date('2026-07-21T00:00:00.000Z'),
        reportCount: 2,
        crowdDemotedAt: new Date('2026-07-21T03:00:00.000Z'),
      },
      expectedReportCount: 2,
    },
    {
      name: 'an out-of-range report count',
      governance: {
        reportWindowStartedAt: new Date('2026-07-21T00:00:00.000Z'),
        reportCount: 4,
        crowdDemotedAt: new Date('2026-07-21T03:00:00.000Z'),
      },
      expectedReportCount: 0,
    },
    {
      name: 'a demotion timestamp before its window',
      governance: {
        reportWindowStartedAt: new Date('2026-07-21T03:00:00.000Z'),
        reportCount: 3,
        crowdDemotedAt: new Date('2026-07-21T02:59:59.999Z'),
      },
      expectedReportCount: 0,
    },
    {
      name: 'an invalid demotion timestamp',
      governance: {
        reportWindowStartedAt: new Date('2026-07-21T00:00:00.000Z'),
        reportCount: 3,
        crowdDemotedAt: 'not-a-date',
      },
      expectedReportCount: 0,
    },
    {
      name: 'a demotion timestamp outside its seven-day window',
      governance: {
        reportWindowStartedAt: new Date('2026-07-14T03:00:00.000Z'),
        reportCount: 3,
        crowdDemotedAt: new Date('2026-07-21T03:00:00.000Z'),
      },
      expectedReportCount: 0,
    },
  ])('fails clean on crowd authority with $name', ({ governance, expectedReportCount }) => {
    const clean = canonicalApplyOptionsOf([SOURCE])[0]
    const option = canonicalApplyOptionsOf([{
      ...SOURCE,
      linkGovernance: {
        subject: clean.subject,
        generation: clean.generation,
        incidentVersion: 1,
        ...governance,
      },
    }])[0]

    expect(option.broken).toBe(false)
    expect(option.governance.reportCount).toBe(expectedReportCount)
    expect(option.governance.crowdDemotedAt).toBeUndefined()
  })

  it('preserves valid machine authority while malformed crowd authority fails clean', () => {
    const clean = canonicalApplyOptionsOf([SOURCE])[0]
    const checkedAt = new Date('2026-07-21T04:00:00.000Z')
    const option = canonicalApplyOptionsOf([{
      ...SOURCE,
      linkGovernance: {
        subject: clean.subject,
        generation: clean.generation,
        incidentVersion: 1,
        reportCount: 3,
        crowdDemotedAt: new Date('2026-07-21T03:00:00.000Z'),
        machineDemotedAt: checkedAt,
        machineOutcome: 'dead',
        machineCheckedAt: checkedAt,
      },
    }])[0]

    expect(option.broken).toBe(true)
    expect(option.governance).toMatchObject({
      reportCount: 0,
      machineDemotedAt: checkedAt,
      machineOutcome: 'dead',
      machineCheckedAt: checkedAt,
    })
    expect(option.governance.crowdDemotedAt).toBeUndefined()
  })

  it('never synthesizes crowd authority across drifted duplicate replicas', () => {
    const clean = canonicalApplyOptionsOf([SOURCE])[0]
    const firstWindow = new Date('2026-07-01T00:00:00.000Z')
    const laterWindow = new Date('2026-07-09T00:00:00.000Z')
    const option = canonicalApplyOptionsOf([
      {
        ...SOURCE,
        linkGovernance: {
          subject: clean.subject,
          generation: clean.generation,
          incidentVersion: 1,
          reportWindowStartedAt: firstWindow,
          reportCount: 1,
        },
      },
      {
        ...SOURCE,
        sourceKey: 'duplicate:drifted',
        linkGovernance: {
          subject: clean.subject,
          generation: clean.generation,
          incidentVersion: 1,
          reportWindowStartedAt: laterWindow,
          reportCount: 3,
          crowdDemotedAt: laterWindow,
        },
      },
    ])[0]

    expect(option.broken).toBe(false)
    expect(option.governance).toMatchObject({
      reportWindowStartedAt: firstWindow,
      reportCount: 1,
    })
    expect(option.governance.crowdDemotedAt).toBeUndefined()
  })

  it('retains the earliest coherent crowd authority when duplicate windows drift', () => {
    const clean = canonicalApplyOptionsOf([SOURCE])[0]
    const firstWindow = new Date('2026-07-01T00:00:00.000Z')
    const laterWindow = new Date('2026-07-07T00:00:00.000Z')
    const laterDemotion = new Date('2026-07-13T00:00:00.000Z')
    const option = canonicalApplyOptionsOf([
      {
        ...SOURCE,
        linkGovernance: {
          subject: clean.subject,
          generation: clean.generation,
          incidentVersion: 1,
          reportWindowStartedAt: firstWindow,
          reportCount: 3,
          crowdDemotedAt: firstWindow,
        },
      },
      {
        ...SOURCE,
        sourceKey: 'duplicate:drifted',
        linkGovernance: {
          subject: clean.subject,
          generation: clean.generation,
          incidentVersion: 1,
          reportWindowStartedAt: laterWindow,
          reportCount: 3,
          crowdDemotedAt: laterDemotion,
        },
      },
    ])[0]

    expect(option.broken).toBe(true)
    expect(option.governance).toMatchObject({
      reportWindowStartedAt: firstWindow,
      reportCount: 3,
      crowdDemotedAt: firstWindow,
    })
  })

  it('takes a newer alive machine snapshot without an older replica demotion', () => {
    const clean = canonicalApplyOptionsOf([SOURCE])[0]
    const deadAt = new Date('2026-07-20T00:00:00.000Z')
    const aliveAt = new Date('2026-07-21T00:00:00.000Z')
    const option = canonicalApplyOptionsOf([
      {
        ...SOURCE,
        linkGovernance: {
          subject: clean.subject,
          generation: clean.generation,
          incidentVersion: 2,
          reportCount: 0,
          machineOutcome: 'dead',
          machineCheckedAt: deadAt,
          machineDemotedAt: deadAt,
        },
      },
      {
        ...SOURCE,
        sourceKey: 'duplicate:recovered',
        linkGovernance: {
          subject: clean.subject,
          generation: clean.generation,
          incidentVersion: 2,
          reportCount: 0,
          machineOutcome: 'alive',
          machineCheckedAt: aliveAt,
        },
      },
    ])[0]

    expect(option.broken).toBe(false)
    expect(option.governance).toMatchObject({
      machineOutcome: 'alive',
      machineCheckedAt: aliveAt,
    })
    expect(option.governance.machineDemotedAt).toBeUndefined()
  })

  it('accepts exactly one current optionId and rejects legacy/spoofed fields', () => {
    const optionId = applyOptionIdOf({ url: SOURCE.applyUrl })
    expect(parseApplyOptionMutation({ optionId })).toEqual({ optionId })

    for (const invalid of [
      null,
      undefined,
      '',
      [],
      {},
      { optionId: '' },
      { optionId: `ao1_${'A'.repeat(43)}` },
      { optionId: 'ao2_short' },
      { optionId, url: SOURCE.applyUrl },
      { optionId, tier: 'direct-ats' },
      { url: SOURCE.applyUrl, tier: 'direct-ats' },
    ]) {
      expect(parseApplyOptionMutation(invalid)).toBeNull()
    }
  })
})

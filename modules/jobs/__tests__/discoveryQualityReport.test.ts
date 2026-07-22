import { describe, expect, it } from 'vitest'
import {
  buildDiscoveryQualityReport,
  canonicalUsablePostingRows,
  discoveryQualityPostingPipeline,
  jsearchQuotaPipeline,
  type DiscoveryQualityPostingRow,
} from '../services/discoveryQualityReport'

const NOW = new Date('2026-07-22T00:00:00.000Z')

function posting(
  id: string,
  overrides: Partial<DiscoveryQualityPostingRow> = {},
): DiscoveryQualityPostingRow {
  return {
    _id: id,
    title: `Engineer ${id}`,
    company: 'Acme',
    companyKey: 'acme',
    confidentialCompany: false,
    locations: ['Remote'],
    isRemote: true,
    domain: 'backend',
    postedAt: '2026-07-21T00:00:00.000Z',
    createdAt: '2026-07-21T12:00:00.000Z',
    sourceIds: ['jsearch'],
    ...overrides,
  }
}

describe('A12 discovery-quality report', () => {
  it('reports domain supply, freshness percentiles, and employer concentration with explicit denominators', () => {
    const rows = [
      posting('a', { postedAt: '2026-07-21T00:00:00.000Z' }),
      posting('b', { postedAt: '2026-07-19T00:00:00.000Z' }),
      posting('c', { postedAt: '2026-07-16T00:00:00.000Z' }),
      posting('d', { company: 'Beta', companyKey: 'beta', postedAt: '2026-07-12T00:00:00.000Z' }),
      posting('e', {
        company: 'Confidential', companyKey: 'confidential', confidentialCompany: true,
        domain: 'frontend', postedAt: null, sourceIds: ['unstop'],
      }),
    ]

    const report = buildDiscoveryQualityReport(
      rows,
      { quotaSpent: 12, cycleCount: 3, cyclesWithQuota: 2 },
      NOW,
      { configuredDomains: ['backend', 'frontend', 'design'], samplePerSource: 2 },
    )

    expect(report.overall.supply).toBe(5)
    expect(report.overall.freshness).toEqual({
      totalCount: 5,
      knownCount: 4,
      knownRate: 0.8,
      medianAgeDays: 4.5,
      p90AgeDays: 10,
      within7DaysCount: 3,
      within7DaysRateOfKnown: 0.75,
    })
    expect(report.overall.employerConcentration).toMatchObject({
      denominatorKnownEmployerCount: 4,
      excludedUnknownOrConfidentialCount: 1,
      top1Count: 3,
      top1ShareOfKnownEmployers: 0.75,
      top5Count: 4,
      top5ShareOfKnownEmployers: 1,
    })
    expect(report.byDomain.map(({ domain, supply }) => [domain, supply])).toEqual([
      ['backend', 4],
      ['frontend', 1],
      ['design', 0],
    ])
  })

  it('labels incomplete source-level JSearch quota as a lower bound and refuses per-domain attribution', () => {
    const rows = [
      posting('a'),
      posting('b', { sourceIds: ['jsearch', 'unstop'] }),
      posting('c', { sourceIds: ['unstop'] }),
    ]
    const report = buildDiscoveryQualityReport(
      rows,
      { quotaSpent: 9, cycleCount: 3, cyclesWithQuota: 2 },
      NOW,
      { configuredDomains: [] },
    )

    expect(report.jsearchQuotaEfficiency).toMatchObject({
      quotaSpent: 9,
      syncCycleCount: 3,
      syncCyclesWithQuota: 2,
      quotaTelemetryComplete: false,
      usableJobsWithJsearchLineage: 2,
      quotaSpentPerUsableJob: 4.5,
      measurementStatus: 'lower-bound',
      perDomainAttribution: { available: false },
    })
    expect(report.jsearchQuotaEfficiency.perDomainAttribution.reason).toContain('does not retain domain')
  })

  it('emits a deterministic source-stratified audit queue with blank manual labels and no sensitive content', () => {
    const rows = [
      posting('a', { sourceIds: ['jsearch', 'unstop'] }),
      posting('b', { sourceIds: ['jsearch'] }),
      posting('c', { sourceIds: ['jsearch'] }),
      posting('d', { isRemote: false, sourceIds: ['unstop'] }),
    ]
    const quota = { quotaSpent: 3, cycleCount: 1, cyclesWithQuota: 1 }
    const first = buildDiscoveryQualityReport(rows, quota, NOW, {
      configuredDomains: [], samplePerSource: 2,
    })
    const second = buildDiscoveryQualityReport([...rows].reverse(), quota, NOW, {
      configuredDomains: [], samplePerSource: 2,
    })

    expect(first.remoteManualAudit).toEqual(second.remoteManualAudit)
    expect(first.remoteManualAudit).toMatchObject({
      status: 'manual-labels-required',
      requestedPerSource: 2,
      uniqueRemoteCandidates: 3,
      strata: [
        { sourceId: 'jsearch', candidateCount: 3, selectedCount: 2 },
        { sourceId: 'unstop', candidateCount: 1, selectedCount: 1 },
      ],
    })
    expect(first.remoteManualAudit.rows.every((row) => (
      row.manualLabel === null && row.manualNotes === null
    ))).toBe(true)
    expect(first.remoteManualAudit.precisionStatement).toContain('No remote precision is calculated automatically')
    expect(JSON.stringify(first)).not.toContain('applyUrl')
    expect(JSON.stringify(first)).not.toContain('jdCompressed')
  })

  it('returns null ratios rather than inventing precision for empty populations or absent cycles', () => {
    const report = buildDiscoveryQualityReport(
      [],
      { quotaSpent: 0, cycleCount: 0, cyclesWithQuota: 0 },
      NOW,
      { configuredDomains: ['backend'] },
    )

    expect(report.overall.freshness).toMatchObject({
      knownRate: null,
      medianAgeDays: null,
      p90AgeDays: null,
      within7DaysRateOfKnown: null,
    })
    expect(report.overall.employerConcentration.top1ShareOfKnownEmployers).toBeNull()
    expect(report.jsearchQuotaEfficiency).toMatchObject({
      quotaSpentPerUsableJob: null,
      quotaTelemetryComplete: false,
      measurementStatus: 'unavailable-no-cycles',
    })
    expect(report.byDomain).toHaveLength(1)
    expect(report.byDomain[0].supply).toBe(0)
  })

  it('counts supply only when production canonical apply authority accepts an option', () => {
    const valid = {
      sourceKey: 'jsearch:valid',
      applyUrl: 'https://jobs.acme.example/apply/1',
      applyTier: 'employer',
    }
    const candidates = [
      { ...posting('valid'), provenance: [valid] },
      { ...posting('blocked'), provenance: [{ ...valid, sourceKey: 'jsearch:blocked', applyUrl: 'https://forms.gle/scam' }] },
      { ...posting('private'), provenance: [{ ...valid, sourceKey: 'jsearch:private', applyUrl: 'http://127.0.0.1/job' }] },
      { ...posting('missing-key'), provenance: [{ applyUrl: valid.applyUrl, applyTier: 'employer' }] },
      { ...posting('missing-tier'), provenance: [{ sourceKey: 'jsearch:no-tier', applyUrl: valid.applyUrl }] },
    ]

    const safeRows = canonicalUsablePostingRows(candidates)

    expect(safeRows.map((row) => row._id)).toEqual(['valid'])
    expect(JSON.stringify(safeRows)).not.toContain('applyUrl')
    expect(JSON.stringify(safeRows)).not.toContain(valid.applyUrl)
  })

  it('uses read-only pipelines and projects neither JD bodies nor apply URLs', () => {
    const start = new Date('2026-07-15T00:00:00.000Z')
    const postingPipeline = discoveryQualityPostingPipeline(start, NOW)
    const quotaPipeline = jsearchQuotaPipeline(start, NOW)
    const serialized = JSON.stringify({ postingPipeline, quotaPipeline })

    expect(postingPipeline[0]).toMatchObject({
      $match: {
        status: 'open',
        createdAt: { $gte: start, $lt: NOW },
        jdLength: { $gte: 400 },
      },
    })
    expect(postingPipeline[1]).toMatchObject({
      $project: { title: 1, company: 1, sourceIds: 1 },
    })
    expect(serialized).not.toContain('$out')
    expect(serialized).not.toContain('$merge')
    expect(serialized).not.toContain('jdCompressed')
    expect(serialized).not.toContain('jdDisplayCompressed')
    // Query-only authority fields may enter process memory; report building
    // strips the full provenance object before anything is emitted.
    expect(JSON.stringify(postingPipeline[1])).toContain('applyUrl')
    expect(quotaPipeline[0]).toMatchObject({
      $match: { kind: 'sync', sourceId: 'jsearch' },
    })
  })
})

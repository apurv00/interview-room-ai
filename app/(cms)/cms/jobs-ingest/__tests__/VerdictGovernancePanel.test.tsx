import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VerdictGovernancePanel } from '../VerdictGovernancePanel'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('VerdictGovernancePanel', () => {
  it('shows the bounded hard-drop review overlay without rendering source URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      config: {
        revision: 3,
        collectionEnabled: true,
        enforceEnabled: false,
        rankingEnabled: false,
        dailyVerdictCap: 900,
        dailyBudgetUsd: 2.5,
        monthlyBudgetUsd: 75,
        perCompanyDailyCap: 25,
        perSourceDailyCap: 500,
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2,
        notes: 'Reviewed shadow cohort',
      },
      history: [],
      reviewStatus: 'unreviewed',
      decisions: [{
        id: '507f1f77bcf86cd799439016',
        decisionKey: `quality:v1:${'a'.repeat(64)}`,
        domain: 'hard-drop',
        outcome: 'drop',
        reviewStatus: 'unreviewed',
        reviewRevision: 0,
        occurredAt: '2026-07-22T10:00:00.000Z',
        lastSeenAt: '2026-07-22T10:00:00.000Z',
        seenCount: 1,
        serviceActor: 'jobs-ingest',
        inputHash: 'b'.repeat(64),
        policyRevision: 'jobs-quality-gate:v1',
        sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
        evidenceSummary: 'short_jd; 72 normalized characters',
        reviewOverlay: {
          title: 'Staff Engineer',
          company: 'Example Labs',
          city: 'Bengaluru',
          isRemote: true,
          descriptionExcerpt: 'Build the interview platform.',
          viaSite: 'JSearch',
          domainHint: 'example.test',
          applyUrl: 'https://secret.example/jobs/42',
        },
      }],
    })))

    render(<VerdictGovernancePanel />)

    fireEvent.click(await screen.findByText('Review retained excerpt'))
    expect(screen.getByText('Staff Engineer')).toBeTruthy()
    expect(screen.getByText('Example Labs')).toBeTruthy()
    expect(screen.getByText('Bengaluru · Remote · JSearch')).toBeTruthy()
    expect(screen.getByText('Build the interview platform.')).toBeTruthy()
    expect(screen.queryByText(/secret\.example/)).toBeNull()
  })

  it('shows hard bounds and blocks an invalid related cap before submit', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      config: {
        revision: 3,
        collectionEnabled: true,
        enforceEnabled: false,
        rankingEnabled: false,
        dailyVerdictCap: 900,
        dailyBudgetUsd: 2.5,
        monthlyBudgetUsd: 75,
        perCompanyDailyCap: 25,
        perSourceDailyCap: 500,
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2,
      },
      history: [],
      reviewStatus: 'unreviewed',
      decisions: [],
    }))
    vi.stubGlobal('fetch', fetch)

    render(<VerdictGovernancePanel />)

    const dailyCap = await screen.findByRole('spinbutton', { name: /Daily verdict cap/i })
    const companyCap = screen.getByRole('spinbutton', { name: /Per-company daily cap/i })
    const inputPrice = screen.getByRole('spinbutton', { name: /Minimum input USD/i })
    expect(dailyCap.getAttribute('min')).toBe('0')
    expect(dailyCap.getAttribute('max')).toBe('25000')
    expect(inputPrice.getAttribute('min')).toBe('0.01')
    expect(inputPrice.getAttribute('max')).toBe('100')

    fireEvent.change(dailyCap, { target: { value: '10' } })
    fireEvent.change(companyCap, { target: { value: '11' } })

    expect(screen.getByRole('alert').textContent).toContain('perCompanyDailyCap')
    expect(companyCap.getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByRole('button', { name: /Save as revision 4/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps enforcement and collection in a coherent rollout state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      config: {
        revision: 3,
        collectionEnabled: true,
        enforceEnabled: false,
        rankingEnabled: false,
        dailyVerdictCap: 900,
        dailyBudgetUsd: 2.5,
        monthlyBudgetUsd: 75,
        perCompanyDailyCap: 25,
        perSourceDailyCap: 500,
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2,
      },
      history: [],
      reviewStatus: 'unreviewed',
      decisions: [],
    })))

    render(<VerdictGovernancePanel />)

    const collection = await screen.findByRole('checkbox', { name: /Collect verdicts/i })
    const enforcement = screen.getByRole('checkbox', { name: /Restrict confirmed fraud/i })

    fireEvent.click(enforcement)
    expect((collection as HTMLInputElement).checked).toBe(true)
    expect((enforcement as HTMLInputElement).checked).toBe(true)

    fireEvent.click(collection)
    expect((collection as HTMLInputElement).checked).toBe(false)
    expect((enforcement as HTMLInputElement).checked).toBe(false)
  })

  it('restores an exact older config revision instead of limiting rollback to visible history', async () => {
    const payload = {
      config: {
        revision: 30,
        collectionEnabled: true,
        enforceEnabled: false,
        rankingEnabled: false,
        dailyVerdictCap: 900,
        dailyBudgetUsd: 2.5,
        monthlyBudgetUsd: 75,
        perCompanyDailyCap: 25,
        perSourceDailyCap: 500,
        inputUsdPerMTok: 0.5,
        outputUsdPerMTok: 2,
      },
      history: [],
      reviewStatus: 'unreviewed',
      decisions: [],
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(payload))
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ ...payload, config: { ...payload.config, revision: 31 } }))
    vi.stubGlobal('fetch', fetch)

    render(<VerdictGovernancePanel />)

    fireEvent.change(await screen.findByRole('textbox', { name: /Change reason/i }), {
      target: { value: 'Restore reviewed incident baseline' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: /Exact revision to restore/i }), {
      target: { value: '2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore revision' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({
      action: 'rollback-config',
      expectedRevision: 30,
      targetRevision: 2,
      reason: 'Restore reviewed incident baseline',
    })
  })

  it('loads the upheld queue and one decision audit trail on demand', async () => {
    const config = {
      revision: 3,
      collectionEnabled: true,
      enforceEnabled: false,
      rankingEnabled: false,
      dailyVerdictCap: 900,
      dailyBudgetUsd: 2.5,
      monthlyBudgetUsd: 75,
      perCompanyDailyCap: 25,
      perSourceDailyCap: 500,
      inputUsdPerMTok: 0.5,
      outputUsdPerMTok: 2,
    }
    const upheldDecision = {
      id: '507f1f77bcf86cd799439016',
      decisionKey: `quality:v1:${'a'.repeat(64)}`,
      domain: 'llm-verdict',
      outcome: 'close',
      reviewStatus: 'upheld',
      reviewRevision: 1,
      occurredAt: '2026-07-22T10:00:00.000Z',
      lastSeenAt: '2026-07-22T10:00:00.000Z',
      seenCount: 1,
      serviceActor: 'jobs-verdict',
      inputHash: 'b'.repeat(64),
      policyRevision: 'jobs-verdict:v2',
      configRevision: 3,
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      evidenceSummary: 'fraud (10% genuine); fee_fraud',
      postingId: '507f1f77bcf86cd799439017',
      posting: {
        id: '507f1f77bcf86cd799439017',
        title: 'Backend Engineer',
        company: 'Example Labs',
        locations: ['Pune'],
        isRemote: false,
        status: 'closed',
        closedReason: 'llm-verdict',
      },
    } as const
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ config, history: [], reviewStatus: 'unreviewed', decisions: [] }))
      .mockResolvedValueOnce(response({ config, history: [], reviewStatus: 'upheld', decisions: [upheldDecision] }))
      .mockResolvedValueOnce(response({
        audit: {
          decision: upheldDecision,
          reviewHistory: [{
            id: '507f1f77bcf86cd799439018',
            operationId: '550e8400-e29b-41d4-a716-446655440000',
            action: 'uphold',
            actorUserId: '507f1f77bcf86cd799439011',
            reason: 'Confirmed against current source evidence',
            fromReviewStatus: 'unreviewed',
            toReviewStatus: 'upheld',
            previousReviewRevision: 0,
            resultingReviewRevision: 1,
            occurredAt: '2026-07-22T11:00:00.000Z',
          }],
        },
      }))
    vi.stubGlobal('fetch', fetch)

    render(<VerdictGovernancePanel />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'Queue' }), { target: { value: 'upheld' } })
    expect(await screen.findByText('Backend Engineer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View audit history' }))

    expect(await screen.findByText('Confirmed against current source evidence')).toBeTruthy()
    expect(String(fetch.mock.calls[1][0])).toContain('reviewStatus=upheld')
    expect(String(fetch.mock.calls[2][0])).toContain(`decisionId=${upheldDecision.id}`)
  })
})

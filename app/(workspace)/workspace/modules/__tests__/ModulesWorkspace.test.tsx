import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModulesWorkspace from '../ModulesWorkspace'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const catalog = {
  catalogVersion: 'hire-commercial-v1',
  enforcement: 'shadow',
  source: 'compatibility_default',
  pilotStatus: 'not_requested',
  usage: {
    screenAssessmentsCompleted: 0,
    measurementStartedAt: null,
    scope: 'shadow_era',
  },
  modules: [
    {
      id: 'core',
      name: 'Core',
      summary: 'The shared hiring workspace and system of record.',
      capabilities: ['Jobs, candidates, and applications'],
      available: true,
      commercialState: 'included',
    },
    {
      id: 'screen',
      name: 'Screen',
      summary: 'Structured screening.',
      capabilities: ['Recorded assessment evidence'],
      available: true,
      commercialState: 'included',
    },
    {
      id: 'decide',
      name: 'Decide',
      summary: 'Human-owned decisions.',
      capabilities: ['Candidate comparison'],
      available: true,
      commercialState: 'included',
    },
    {
      id: 'operate',
      name: 'Operate',
      summary: 'Operational visibility.',
      capabilities: ['Audit trail and reports'],
      available: true,
      commercialState: 'included',
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModulesWorkspace', () => {
  it('renders the four-module compatibility preview with no checkout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(catalog))
    vi.stubGlobal('fetch', fetchMock)

    render(<ModulesWorkspace />)

    expect(
      await screen.findByRole('heading', { name: 'Hire modules' }),
    ).toBeTruthy()
    for (const name of ['Core', 'Screen', 'Decide', 'Operate']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy()
    }
    expect(screen.getByText('Compatibility mode is active')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Request pilot' })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:contact@interviewprep.guru'),
    )
    expect(document.body.textContent).toContain('there is no checkout')
    expect(screen.getByText('Screen assessments completed')).toBeTruthy()
    expect(
      screen.getByText(
        'No shadow-era completions measured yet; earlier historical activity is not included.',
      ),
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/buy now|credit card/i)
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/modules', {
      cache: 'no-store',
    })
  })

  it('shows the admin-only response without rendering catalog content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: 'Forbidden' }, 403)),
    )

    render(<ModulesWorkspace />)

    expect(
      await screen.findByText(
        'Only the workspace administrator can view modules.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Request pilot' })).toBeNull()
  })

  it.each([
    ['requested', 'Pilot requested'],
    ['active', 'Pilot active'],
  ] as const)('renders %s pilot state without another request action', async (pilotStatus, label) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ ...catalog, pilotStatus })),
    )

    render(<ModulesWorkspace />)

    expect(await screen.findByText(label)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Request pilot' })).toBeNull()
  })

  it('fails closed on a malformed successful commercial response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...catalog,
          usage: {
            ...catalog.usage,
            screenAssessmentsCompleted: -1,
            measurementStartedAt: 'not-a-date',
          },
          modules: catalog.modules.map((module, index) =>
            index === 0
              ? { ...module, commercialState: 'locked', available: false }
              : module,
          ),
        }),
      ),
    )

    render(<ModulesWorkspace />)

    expect(
      await screen.findByText('The module catalog response was not valid.'),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Request pilot' })).toBeNull()
  })
})

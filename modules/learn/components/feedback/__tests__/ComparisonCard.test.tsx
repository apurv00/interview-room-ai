import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import ComparisonCard from '../ComparisonCard'

const props = {
  currentScores: {
    relevance: 80,
    structure: 75,
    specificity: 70,
    ownership: 85,
  },
  overallScore: 78,
}

function response(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ComparisonCard account lifecycle', () => {
  it('reports only exact account-unavailable responses to its parent', async () => {
    const onAccountUnavailable = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ code: 'ACCOUNT_UNAVAILABLE' }, 401),
    ))

    const { container } = render(
      <ComparisonCard {...props} onAccountUnavailable={onAccountUnavailable} />,
    )

    await waitFor(() => expect(onAccountUnavailable).toHaveBeenCalledOnce())
    expect(container.querySelector('section')).toBeNull()
  })

  it('does not classify a generic 401 as account deletion', async () => {
    const onAccountUnavailable = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Unauthorized' }, 401),
    ))

    const { container } = render(
      <ComparisonCard {...props} onAccountUnavailable={onAccountUnavailable} />,
    )

    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull())
    expect(onAccountUnavailable).not.toHaveBeenCalled()
    expect(container.querySelector('section')).toBeNull()
  })
})

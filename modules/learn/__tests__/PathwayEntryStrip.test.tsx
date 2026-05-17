/**
 * Pathway P2 Wave 5 (5A) — PathwayEntryStrip tests.
 *
 * The strip is intentionally invisible in many states (direct visit,
 * stale taskId, missing returnTo). These tests lock the "render
 * nothing" contract so future refactors don't silently start showing
 * the strip on direct-visit cold loads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import PathwayEntryStrip from '../components/drill/PathwayEntryStrip'

const { mockDeduplicatedFetch } = vi.hoisted(() => ({
  mockDeduplicatedFetch: vi.fn(),
}))
vi.mock('@shared/cachedFetch', () => ({
  deduplicatedFetch: (...a: unknown[]) => mockDeduplicatedFetch(...a),
}))

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

beforeEach(() => {
  mockDeduplicatedFetch.mockReset()
})

describe('PathwayEntryStrip', () => {
  it('renders nothing when source is not "pathway"', () => {
    const { container } = render(
      <PathwayEntryStrip source="direct" actionId="task-1" returnTo="/learn/pathway" />,
    )
    expect(container.firstChild).toBeNull()
    expect(mockDeduplicatedFetch).not.toHaveBeenCalled()
  })

  it('renders nothing when source is undefined', () => {
    const { container } = render(
      <PathwayEntryStrip source={undefined} actionId="task-1" returnTo="/learn/pathway" />,
    )
    expect(container.firstChild).toBeNull()
    expect(mockDeduplicatedFetch).not.toHaveBeenCalled()
  })

  it('renders nothing when actionId is missing (no taskId to look up)', () => {
    const { container } = render(
      <PathwayEntryStrip source="pathway" actionId={undefined} returnTo="/learn/pathway" />,
    )
    expect(container.firstChild).toBeNull()
    expect(mockDeduplicatedFetch).not.toHaveBeenCalled()
  })

  it('renders nothing when the task lookup returns 404 (stale URL after Inngest regen)', async () => {
    mockDeduplicatedFetch.mockResolvedValue(jsonResponse({ error: 'Task not found' }, false))

    const { container } = render(
      <PathwayEntryStrip source="pathway" actionId="stale-task" returnTo="/learn/pathway" />,
    )

    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('renders task description + Back link when everything resolves', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        taskId: 'task-1',
        title: null,
        description: 'Practice adding metrics to your strongest story.',
      }),
    )

    render(
      <PathwayEntryStrip source="pathway" actionId="task-1" returnTo="/learn/pathway" />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pathway-entry-strip')).toBeTruthy()
    })
    expect(screen.getByText(/Practice adding metrics/)).toBeTruthy()
    const back = screen.getByRole('link', { name: /Back to pathway/i })
    expect(back.getAttribute('href')).toBe('/learn/pathway')
  })

  it('hides the Back link when returnTo fails validation (open-redirect guard)', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        taskId: 'task-1',
        title: null,
        description: 'A pathway task',
      }),
    )

    render(
      <PathwayEntryStrip
        source="pathway"
        actionId="task-1"
        returnTo="https://evil.example.com"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pathway-entry-strip')).toBeTruthy()
    })
    expect(screen.queryByRole('link', { name: /Back to pathway/i })).toBeNull()
  })

  it('hides the Back link when returnTo is missing entirely', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        taskId: 'task-1',
        title: null,
        description: 'A pathway task',
      }),
    )

    render(<PathwayEntryStrip source="pathway" actionId="task-1" returnTo={undefined} />)

    await waitFor(() => {
      expect(screen.getByTestId('pathway-entry-strip')).toBeTruthy()
    })
    expect(screen.queryByRole('link', { name: /Back to pathway/i })).toBeNull()
  })
})

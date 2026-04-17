import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UniversalPathwayView from '../components/pathway/UniversalPathwayView'

function mockFetchSequence(responses: Array<{ ok?: boolean; body: unknown }>) {
  const spy = vi.spyOn(global, 'fetch')
  for (const r of responses) {
    spy.mockResolvedValueOnce({
      ok: r.ok !== false,
      json: async () => r.body,
    } as Response)
  }
  return spy
}

const planWithLessons = {
  plan: {
    _id: 'p1',
    planType: 'universal',
    sessionsCompleted: 4,
    currentPhase: 'foundation',
    lessons: [
      { lessonId: 'L1', competency: 'specificity', completed: false },
      { lessonId: 'L2', competency: 'structure', completed: true },
    ],
  },
  phaseStatus: {
    currentPhase: 'foundation',
    sessionsCompleted: 4,
    sessionsInPhase: 2,
    sessionsUntilNextPhase: 2,
    progressInPhasePct: 50,
    nextPhase: 'building',
  },
}

describe('UniversalPathwayView', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('shows empty-state CTA when no plan exists', async () => {
    fetchSpy = mockFetchSequence([{ body: { plan: null, phaseStatus: null } }])
    render(<UniversalPathwayView domain="general" depth="behavioral" />)

    await waitFor(() => {
      expect(screen.getByText(/Start your guided pathway/)).toBeInTheDocument()
    })
    expect(screen.getByText('Generate my pathway')).toBeInTheDocument()
  })

  it('posts to create a plan when user clicks CTA', async () => {
    fetchSpy = mockFetchSequence([
      { body: { plan: null, phaseStatus: null } },
      { body: planWithLessons },
    ])
    render(<UniversalPathwayView domain="pm" depth="behavioral" />)

    await waitFor(() => screen.getByText('Generate my pathway'))
    fireEvent.click(screen.getByText('Generate my pathway'))

    await waitFor(() => {
      expect(screen.getByText(/Phase 2 of 6 · Foundation/)).toBeInTheDocument()
    })
    const postCall = fetchSpy.mock.calls[1]
    expect(postCall[0]).toBe('/api/learn/pathway/universal')
    expect((postCall[1] as RequestInit).method).toBe('POST')
    const body = JSON.parse((postCall[1] as RequestInit).body as string)
    expect(body).toEqual({ domain: 'pm', depth: 'behavioral' })
  })

  it('renders phase progress and lesson list when plan is loaded', async () => {
    fetchSpy = mockFetchSequence([{ body: planWithLessons }])
    render(<UniversalPathwayView domain="pm" depth="behavioral" />)

    await waitFor(() => {
      expect(screen.getByText(/Phase 2 of 6 · Foundation/)).toBeInTheDocument()
    })
    expect(screen.getByText('Lessons (1/2)')).toBeInTheDocument()
    expect(screen.getByText(/Lesson 1: specificity/)).toBeInTheDocument()
    expect(screen.getByText(/Lesson 2: structure/)).toBeInTheDocument()
  })

  it('optimistically marks a lesson complete on PATCH success', async () => {
    fetchSpy = mockFetchSequence([
      { body: planWithLessons },
      { body: { lesson: {
        lessonId: 'L1', competency: 'specificity', title: 'X',
        conceptSummary: 'S', conceptDeepDive: '', example: { question: 'Q', goodAnswer: 'A', annotations: [] },
        keyTakeaways: [],
      } } },
      { body: { success: true } },
    ])
    render(<UniversalPathwayView domain="pm" depth="behavioral" />)

    await waitFor(() => screen.getByText('Lessons (1/2)'))

    const firstLessonToggle = screen.getByText(/Lesson 1: specificity/).closest('button')!
    fireEvent.click(firstLessonToggle)
    await waitFor(() => screen.getByText('Mark complete'))

    fireEvent.click(screen.getByText('Mark complete'))
    await waitFor(() => {
      expect(screen.getByText('Lessons (2/2)')).toBeInTheDocument()
    })
    const patchCall = fetchSpy.mock.calls[2]
    expect((patchCall[1] as RequestInit).method).toBe('PATCH')
  })

  it('renders skeleton while loading', () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}))
    const { container } = render(<UniversalPathwayView domain="general" depth="behavioral" />)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('shows error message when GET fails', async () => {
    fetchSpy = mockFetchSequence([{ ok: false, body: {} }])
    render(<UniversalPathwayView domain="general" depth="behavioral" />)
    await waitFor(() => {
      expect(screen.getByText(/Could not load your pathway/)).toBeInTheDocument()
    })
  })
})

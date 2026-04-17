import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import LessonCard from '../components/pathway/LessonCard'

const lessonDetail = {
  lessonId: 'L1',
  competency: 'specificity',
  title: 'Be specific',
  conceptSummary: 'Numbers beat adjectives.',
  conceptDeepDive: 'When you quantify, listeners trust you more.',
  example: {
    question: 'Tell me about a project.',
    goodAnswer: 'Shipped X, reduced Y by 30%.',
    annotations: ['Uses a metric', 'Names a concrete outcome'],
  },
  keyTakeaways: ['Add numbers', 'Name outcomes'],
}

describe('LessonCard', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ lesson: lessonDetail, completed: false }),
    } as Response)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('renders collapsed header with placeholder title', () => {
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'specificity', completed: false }}
        index={0}
        domain="general"
        depth="behavioral"
        onComplete={vi.fn()}
      />,
    )
    expect(screen.getByText(/Lesson 1: specificity/i)).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lazy-fetches lesson content on expand and renders body', async () => {
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'specificity', completed: false }}
        index={0}
        domain="pm"
        depth="behavioral"
        onComplete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    await waitFor(() => {
      expect(screen.getByText('Numbers beat adjectives.')).toBeInTheDocument()
    })
    expect(screen.getByText('Shipped X, reduced Y by 30%.')).toBeInTheDocument()
    expect(screen.getByText('Uses a metric')).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledOnce()
    const calledUrl = String(fetchSpy.mock.calls[0][0])
    expect(calledUrl).toContain('/api/learn/pathway/lesson/L1')
    expect(calledUrl).toContain('domain=pm')
    expect(calledUrl).toContain('depth=behavioral')
  })

  it('calls onComplete when user marks complete', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined)
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'structure', completed: false }}
        index={0}
        domain="general"
        depth="behavioral"
        onComplete={onComplete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => screen.getByText('Numbers beat adjectives.'))

    fireEvent.click(screen.getByText('Mark complete'))
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith('L1')
    })
  })

  it('shows completed state when entry.completed is true', () => {
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'ownership', completed: true }}
        index={2}
        domain="general"
        depth="behavioral"
        onComplete={vi.fn()}
      />,
    )
    expect(screen.queryByText('Mark complete')).toBeNull()
  })

  it('shows error message when fetch fails', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'relevance', completed: false }}
        index={0}
        domain="general"
        depth="behavioral"
        onComplete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => {
      expect(screen.getByText(/Could not load this lesson/)).toBeInTheDocument()
    })
  })

  it('renders overrideContent instead of generated body when present', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        lesson: { ...lessonDetail, overrideContent: 'Editor-curated version.' },
      }),
    } as Response)
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'specificity', completed: false }}
        index={0}
        domain="general"
        depth="behavioral"
        onComplete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    await waitFor(() => {
      expect(screen.getByText('Editor-curated version.')).toBeInTheDocument()
    })
    expect(screen.queryByText('Numbers beat adjectives.')).toBeNull()
  })
})

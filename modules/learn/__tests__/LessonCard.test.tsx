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

  it('renders collapsed header with placeholder title and competency subtitle', () => {
    // UAT-018: the collapsed fallback no longer doubles the competency
    // into the title. Title is "Lesson N"; the competency lives only in
    // the subtitle below.
    render(
      <LessonCard
        entry={{ lessonId: 'L1', competency: 'specificity', completed: false }}
        index={0}
        domain="general"
        depth="behavioral"
        onComplete={vi.fn()}
      />,
    )
    expect(screen.getByText('Lesson 1')).toBeInTheDocument()
    // Competency surfaces once, in the subtitle — not stacked into the title.
    expect(screen.queryByText(/Lesson 1:/i)).toBeNull()
    expect(screen.getByText('specificity')).toBeInTheDocument()
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

  it('shows generic error message + Try again button on unknown server error (5xx)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)
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
      expect(screen.getByText(/Could not load this lesson \(HTTP 500\)/)).toBeInTheDocument()
    })
    // 5xx is retryable.
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })

  // Wave 5 deferred cleanup — the previous error UX collapsed all
  // failure shapes to "Could not load this lesson. Try again in a
  // moment." so the user couldn't tell whether refreshing the page
  // would help (stale lessonId, 404) vs. tapping retry (LLM hiccup,
  // 502). These tests lock the per-status classification + the
  // retryable flag that gates the Try-again button.
  describe('Per-status error classification', () => {
    it('502 (lesson generation failed) → retryable error with Try again button', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: 'Lesson generation failed' }),
      } as Response)
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
        expect(screen.getByTestId('lesson-card-error')).toBeInTheDocument()
      })
      expect(screen.getByText(/Lesson generation hit a snag/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
    })

    it('404 "Lesson not in plan" (stale lessonId) → NON-retryable, no Try again button', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Lesson not in plan' }),
      } as Response)
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
        expect(screen.getByTestId('lesson-card-error')).toBeInTheDocument()
      })
      expect(screen.getByText(/Refresh the page/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull()
    })

    it('404 "No universal plan" → directs user to set up a plan', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'No universal plan' }),
      } as Response)
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
        expect(screen.getByText(/No active pathway plan/i)).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull()
    })

    // Codex P2 on PR #389 — only KNOWN 404 payloads are treated as
    // non-retryable. An unknown 404 (Vercel/edge proxy returning a
    // non-JSON HTML 404, or a future route copy change) must fall
    // through to the generic retryable HTTP branch so the user gets
    // a Try-again button rather than being told to refresh on a
    // problem that refresh won't fix.
    it('unknown 404 payload → retryable generic HTTP error (not the stale-plan branch)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        // Some unfamiliar error string we haven't keyed on.
        json: async () => ({ error: 'Unknown not-found reason' }),
      } as Response)
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
        expect(screen.getByText(/Could not load this lesson \(HTTP 404\)/)).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
    })

    it('non-JSON 404 (edge/proxy HTML) → retryable generic HTTP error', async () => {
      // serverMessage parse fails → serverMessage stays null → my old
      // fallthrough would have mapped this to "Refresh the page"
      // non-retryable. With the fix it lands on the generic retryable.
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => {
          throw new Error('Unexpected token < in JSON')
        },
      } as unknown as Response)
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
        expect(screen.getByText(/Could not load this lesson \(HTTP 404\)/)).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
    })

    it('network error (fetch throws) → retryable with connection-specific copy', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'))
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
        expect(screen.getByText(/Couldn(?:'|’)t reach the server/i)).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
    })

    it('clicking Try again re-fires the fetch and recovers on success', async () => {
      // First call: 502, second call: success.
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          json: async () => ({ error: 'Lesson generation failed' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ lesson: lessonDetail, completed: false }),
        } as Response)

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
      await waitFor(() => expect(screen.getByTestId('lesson-card-error')).toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
      await waitFor(() => {
        expect(screen.getByText('Numbers beat adjectives.')).toBeInTheDocument()
      })
      // Error cleared, no Try-again button anymore.
      expect(screen.queryByTestId('lesson-card-error')).toBeNull()
    })

    it('handles non-JSON error responses gracefully (defensive parse)', async () => {
      // Some error paths (Vercel platform errors, etc.) return HTML.
      // The classifier must not crash on res.json() failure.
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('Unexpected token < in JSON')
        },
      } as unknown as Response)
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
        expect(screen.getByText(/HTTP 503/)).toBeInTheDocument()
      })
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

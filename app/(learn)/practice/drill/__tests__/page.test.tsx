/**
 * Race-condition regression test for the drill page question-context fetch.
 *
 * Codex P2 on PR #388 — `startDrill` previously fired the context
 * fetch imperatively with no cancellation, so a fast click A → click B
 * sequence could land A's late `.then()` AFTER B's response, painting
 * A's coaching context next to B's question.
 *
 * Fix: effect-driven fetch tied to `activeQuestion` with a `cancelled`
 * flag in the cleanup. This test simulates the exact race scenario and
 * locks the invariant: B's response wins regardless of which fetch
 * resolves first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// --- Mocks (declared via vi.hoisted so they're constructed before the imports) ---

const {
  mockUseSearchParams,
  mockDeduplicatedFetch,
  mockFetch,
} = vi.hoisted(() => ({
  mockUseSearchParams: vi.fn(),
  mockDeduplicatedFetch: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockUseSearchParams(),
}))

vi.mock('@shared/cachedFetch', () => ({
  deduplicatedFetch: (...a: unknown[]) => mockDeduplicatedFetch(...a),
}))

// Stub framer-motion to plain divs so AnimatePresence + motion.div
// don't add async timing noise to the race test.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
          const Tag = tag as keyof JSX.IntrinsicElements
          // Drop framer-only props that React would warn about when
          // forwarded to a plain DOM tag.
          const { initial, animate, exit, transition, layout, ...safe } = props
          void initial
          void animate
          void exit
          void transition
          void layout
          return <Tag {...safe}>{children}</Tag>
        },
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Stub the three Wave 5 strip components down to identifiable testids
// so the assertions don't need to know their internal markup. The
// child components have their own dedicated tests; this test focuses
// on the page's race-prevention logic.
vi.mock('@learn/components/drill/PathwayEntryStrip', () => ({
  default: () => null,
}))
vi.mock('@learn/components/drill/QuestionInsightStrip', () => ({
  default: () => null,
}))
vi.mock('@learn/components/drill/DeltaContextNote', () => ({
  default: () => null,
}))
// Render IdealAnswerComparisonCard as a marker so we can assert which
// question's context is on screen at any moment.
vi.mock('@feedback/components/IdealAnswerComparisonCard', () => ({
  default: ({ ideal }: { ideal: { strongAnswer: string } }) => (
    <div data-testid="ideal-answer-card">{ideal.strongAnswer}</div>
  ),
}))

// Default fetch mock — the /questions list call. Returns two weak Qs
// so we can click between them and exercise the race.
const Q1 = {
  sessionId: '507f1f77bcf86cd799439001',
  questionIndex: 0,
  question: 'Question 1: Tell me about a leadership moment.',
  answer: 'Old answer for Q1',
  avgScore: 35,
  relevance: 30,
  structure: 40,
  specificity: 35,
  ownership: 35,
  competency: 'specificity',
  sessionDate: '2026-05-01T00:00:00Z',
}
const Q2 = {
  sessionId: '507f1f77bcf86cd799439002',
  questionIndex: 0,
  question: 'Question 2: Describe a hard tradeoff you made.',
  answer: 'Old answer for Q2',
  avgScore: 40,
  relevance: 45,
  structure: 50,
  specificity: 30,
  ownership: 35,
  competency: 'specificity',
  sessionDate: '2026-05-05T00:00:00Z',
}

beforeEach(() => {
  mockUseSearchParams.mockReset()
  mockDeduplicatedFetch.mockReset()
  mockFetch.mockReset()
  // No URL params for the race test — default fresh visit.
  mockUseSearchParams.mockReturnValue(new URLSearchParams())

  // /api/learn/drill/questions returns Q1 + Q2.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/learn/drill/questions')) {
        return {
          ok: true,
          json: async () => ({ questions: [Q1, Q2] }),
        } as Response
      }
      // Default for any other fetch path the page might hit
      return { ok: false, json: async () => ({}) } as Response
    }),
  )
})

import DrillPage from '../page'

describe('Drill page — question-context fetch race (Codex P2 PR #388)', () => {
  it('does NOT overwrite B context with A response when A resolves after B', async () => {
    // Set up A's and B's context fetches with manually-controlled
    // promises so we can resolve them in any order.
    let resolveA: (value: Response) => void = () => undefined
    let resolveB: (value: Response) => void = () => undefined
    const aPromise = new Promise<Response>((r) => (resolveA = r))
    const bPromise = new Promise<Response>((r) => (resolveB = r))

    mockDeduplicatedFetch.mockImplementation((url: string) => {
      // Q1 has sessionId ending in ...001, Q2 in ...002
      if (url.includes('439001')) return aPromise
      if (url.includes('439002')) return bPromise
      return Promise.resolve({ ok: false, json: async () => ({}) } as Response)
    })

    render(<DrillPage />)

    // Wait for the two question cards from /questions to render.
    await waitFor(() => {
      expect(screen.getByText(/Question 1:/)).toBeTruthy()
      expect(screen.getByText(/Question 2:/)).toBeTruthy()
    })

    // Click Q1 → triggers context fetch A (still pending).
    fireEvent.click(screen.getByText(/Question 1:/))
    await waitFor(() => {
      expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1)
      expect(mockDeduplicatedFetch.mock.calls[0][0]).toContain('439001')
    })

    // Go back, click Q2 → triggers context fetch B.
    fireEvent.click(screen.getByText(/Back/i))
    await waitFor(() => {
      expect(screen.getByText(/Question 1:/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Question 2:/))
    await waitFor(() => {
      expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(2)
      expect(mockDeduplicatedFetch.mock.calls[1][0]).toContain('439002')
    })

    // Resolve B FIRST with B's coaching context.
    resolveB({
      ok: true,
      json: async () => ({
        primaryGap: 'specificity',
        scores: { relevance: 45, structure: 50, specificity: 30, ownership: 35 },
        domain: 'pm',
        interviewType: 'behavioral',
        idealAnswer: { strongAnswer: 'B-strong-answer', keyElements: ['B-element'] },
      }),
    } as Response)

    // B's context lands → B's card visible.
    await waitFor(() => {
      expect(screen.getByText('B-strong-answer')).toBeTruthy()
    })

    // NOW resolve A's late response with DIFFERENT (A-specific) content.
    // Pre-fix this would overwrite B's context.
    resolveA({
      ok: true,
      json: async () => ({
        primaryGap: 'relevance',
        scores: { relevance: 30, structure: 40, specificity: 35, ownership: 35 },
        domain: 'pm',
        interviewType: 'behavioral',
        idealAnswer: { strongAnswer: 'A-strong-answer', keyElements: ['A-element'] },
      }),
    } as Response)

    // Give the late .then() a microtask to run.
    await new Promise((r) => setTimeout(r, 0))

    // CRITICAL: A's late response must NOT replace B's context.
    expect(screen.getByText('B-strong-answer')).toBeTruthy()
    expect(screen.queryByText('A-strong-answer')).toBeNull()
  })
})

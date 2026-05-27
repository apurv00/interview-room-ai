import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import PathwayEmptyState from '../components/pathway/PathwayEmptyState'
import TodayActionCard from '../components/pathway/TodayActionCard'
import PathwayPendingBanner from '../components/pathway/PathwayPendingBanner'
import PathwayUnchangedBanner from '../components/pathway/PathwayUnchangedBanner'
import RecentSessionsStrip from '../components/pathway/RecentSessionsStrip'
import type { PathwayAction } from '../services/pathwayViewModel'

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const baselineAction: PathwayAction = {
  id: 'baseline-interview',
  type: 'interview',
  title: 'Run a baseline interview',
  description: 'Complete one interview so Pathway can build a focused plan from your actual answers.',
  ctaLabel: 'Start baseline interview',
  href: '/interview/setup?source=pathway&actionId=baseline&returnTo=%2Flearn%2Fpathway',
}

describe('Pathway state components', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the empty Pathway baseline CTA as the single primary action', () => {
    render(<PathwayEmptyState action={baselineAction} />)

    expect(screen.getByText('No pathway yet')).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /Start baseline interview/i })
    expect(cta.getAttribute('href')).toContain('/interview/setup?')
    expect(cta.getAttribute('href')).toContain('actionId=baseline')
    expect(screen.queryByText(/Generate my pathway/i)).not.toBeInTheDocument()
  })

  it('renders unchanged banner with retake CTA', () => {
    render(
      <PathwayUnchangedBanner
        action={{
          id: 'retake-interview',
          type: 'interview',
          title: 'Finish at least three answers',
          description: 'Your current pathway plan is unchanged.',
          ctaLabel: 'Retake interview',
          href: '/interview/setup?source=pathway',
        }}
      />,
    )
    expect(screen.getByTestId('pathway-unchanged-banner')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Retake interview' })).toBeInTheDocument()
  })

  it('shows retry button when poll is exhausted on pending banner', () => {
    render(
      <PathwayPendingBanner
        action={{
          id: 'pending-feedback',
          type: 'review',
          title: 'Catching up',
          description: 'Waiting',
          ctaLabel: 'Back',
          metadata: { sessionId: '507f1f77bcf86cd799439011' },
        }}
        pollExhausted
      />,
    )
    expect(screen.getByText(/taking longer than expected/i)).toBeInTheDocument()
    expect(screen.getByTestId('pathway-pending-retry-button')).toBeInTheDocument()
  })

  it('renders the pending feedback banner with a return path', () => {
    render(
      <PathwayPendingBanner
        action={{
          id: 'pending-feedback',
          type: 'review',
          title: 'Your pathway update is catching up',
          description: 'The interview feedback is ready.',
          ctaLabel: 'Back to feedback',
          href: '/feedback/session-123',
        }}
      />,
    )

    expect(screen.getByText('Your pathway update is catching up')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to feedback' }).getAttribute('href')).toBe('/feedback/session-123')
  })

  it('renders completed state as the final rehearsal challenge', () => {
    render(
      <TodayActionCard
        state="completed"
        action={{
          id: 'challenge',
          type: 'interview',
          title: 'Start a final rehearsal',
          description: 'Your current tasks are complete. Run a tougher session to validate the improvement loop.',
          ctaLabel: 'Start final rehearsal',
          href: '/interview/setup?source=pathway&actionId=challenge&difficulty=hard&returnTo=%2Flearn%2Fpathway',
        }}
        onCompleteTask={vi.fn()}
      />,
    )

    expect(screen.getByText('Next challenge')).toBeInTheDocument()
    expect(screen.getByText('Start a final rehearsal')).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /Start final rehearsal/i })
    expect(cta.getAttribute('href')).toContain('actionId=challenge')
    expect(cta.getAttribute('href')).toContain('difficulty=hard')
  })

  it('renders RecentSessions empty state instead of disappearing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    } as Response)

    render(<RecentSessionsStrip />)

    await waitFor(() => {
      expect(screen.getByText('Recent sessions')).toBeInTheDocument()
    })
    expect(screen.getByText(/Completed interviews will appear here/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Start/i }).getAttribute('href')).toContain('/interview/setup?')
  })
})

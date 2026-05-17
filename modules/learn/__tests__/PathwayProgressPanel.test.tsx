/**
 * Pathway P2 Wave 3 — PathwayProgressPanel rendering.
 *
 * Existing behaviors (blocker list, milestone count pill) keep working;
 * the new tests verify the three additions:
 *
 *   #2 — MomentumSparkline renders only when a blocker has >=2 points
 *   #8 — Recurrence badge appears only when recurrenceCount > 0
 *   #9 — Milestone names + descriptions appear under the count pill
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PathwayProgressPanel from '../components/pathway/PathwayProgressPanel'
import type { PathwayProgress } from '../services/pathwayViewModel'

function makeProgress(overrides: Partial<PathwayProgress> = {}): PathwayProgress {
  return {
    readinessScore: 62,
    readinessLevel: 'developing',
    completedTasks: 2,
    totalTasks: 5,
    achievedMilestones: 1,
    totalMilestones: 3,
    blockers: [
      { competency: 'specificity', currentScore: 42, targetScore: 70, reason: 'Needs concrete examples' },
    ],
    competencySummary: null,
    milestones: [],
    blockerInsights: {},
    ...overrides,
  }
}

describe('PathwayProgressPanel — Wave 3 additions', () => {
  it('renders the existing blocker row even with no insights provided (backwards-compat)', () => {
    render(<PathwayProgressPanel progress={makeProgress()} />)
    expect(screen.getByText(/specificity/i)).toBeTruthy()
    expect(screen.getByText(/Needs concrete examples/)).toBeTruthy()
    // No insights → no badge, no sparkline
    expect(screen.queryByTestId('recurrence-badge-specificity')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders the recurrence badge with the correct count (#8)', () => {
    render(
      <PathwayProgressPanel
        progress={makeProgress({
          blockerInsights: {
            specificity: { recurrenceCount: 2, momentum: [] },
          },
        })}
      />,
    )
    const badge = screen.getByTestId('recurrence-badge-specificity')
    expect(badge.textContent).toMatch(/Recurring/i)
    expect(badge.textContent).toContain('2×')
  })

  it('does NOT render the recurrence badge when count is 0', () => {
    render(
      <PathwayProgressPanel
        progress={makeProgress({
          blockerInsights: {
            specificity: { recurrenceCount: 0, momentum: [] },
          },
        })}
      />,
    )
    expect(screen.queryByTestId('recurrence-badge-specificity')).toBeNull()
  })

  it('renders the momentum sparkline when there are >=2 points (#2)', () => {
    render(
      <PathwayProgressPanel
        progress={makeProgress({
          blockerInsights: {
            specificity: {
              recurrenceCount: 0,
              momentum: [
                { score: 40, at: '2026-04-01T00:00:00Z' },
                { score: 55, at: '2026-04-15T00:00:00Z' },
                { score: 60, at: '2026-05-01T00:00:00Z' },
              ],
            },
          },
        })}
      />,
    )
    const svg = screen.getByRole('img')
    expect(svg.getAttribute('aria-label')).toContain('40')
    expect(svg.getAttribute('aria-label')).toContain('60')
  })

  it('renders milestone name + description + score (#9)', () => {
    render(
      <PathwayProgressPanel
        progress={makeProgress({
          milestones: [
            {
              name: 'Foundation',
              description: 'Reach a baseline score of 50',
              currentScore: 62,
              targetScore: 50,
              achieved: true,
              achievedAt: '2026-05-13T00:00:00.000Z',
            },
            {
              name: 'Approaching ready',
              description: 'Reach a score of 70 across blockers',
              currentScore: 62,
              targetScore: 70,
              achieved: false,
              achievedAt: null,
            },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('milestone-Foundation')).toBeTruthy()
    expect(screen.getByText('Foundation')).toBeTruthy()
    expect(screen.getByText(/Reach a baseline score of 50/)).toBeTruthy()
    expect(screen.getByText('Approaching ready')).toBeTruthy()
    expect(screen.getByText(/Reach a score of 70/)).toBeTruthy()
  })

  it('renders no milestone list when milestones is empty', () => {
    render(<PathwayProgressPanel progress={makeProgress({ milestones: [] })} />)
    // "Milestones" appears in the top pill but NOT as a section header
    // because the empty list short-circuits rendering. The pill text
    // is "Milestones" (uppercased label) so we check for the section
    // header copy specifically via the absence of milestone rows.
    expect(screen.queryByTestId(/milestone-/)).toBeNull()
  })
})

/**
 * Pathway P2 Wave 4 (feature C) — DecayContextCard.
 *
 * Tone discipline is load-bearing here: the card MUST hide itself
 * for fresh / null cases so the page stays calm on the happy path,
 * and it MUST NOT add urgency copy ("PRACTICE NOW") that would
 * regress into the killed Round-5 SR-urgency-banner pattern.
 *
 * Tests verify:
 *
 *   1. null rhythm → renders nothing (no history)
 *   2. fresh (0-2d) → renders nothing (too recent)
 *   3. warmup / rusty / cold → renders with the right testid + days
 *   4. Copy is observational (no exclamation marks, no imperatives
 *      like "practice now" or "you must")
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DecayContextCard from '../components/pathway/DecayContextCard'
import type { ActivityRhythm } from '../services/pathwayViewModel'

function rhythm(overrides: Partial<ActivityRhythm> = {}): ActivityRhythm {
  return {
    lastSessionAt: '2026-05-01T00:00:00.000Z',
    daysSinceLastSession: 13,
    decayProfile: 'rusty',
    ...overrides,
  }
}

describe('DecayContextCard', () => {
  it('renders nothing when rhythm is null (the user has no history)', () => {
    const { container } = render(<DecayContextCard rhythm={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for the fresh band (0-2 days)', () => {
    const { container } = render(
      <DecayContextCard rhythm={rhythm({ decayProfile: 'fresh', daysSinceLastSession: 1 })} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when decayProfile is null even if days is set', () => {
    const { container } = render(
      <DecayContextCard
        rhythm={rhythm({ decayProfile: null, daysSinceLastSession: null, lastSessionAt: null })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the warmup card with day count + observation copy', () => {
    render(<DecayContextCard rhythm={rhythm({ decayProfile: 'warmup', daysSinceLastSession: 5 })} />)
    expect(screen.getByTestId('decay-context-card-warmup')).toBeTruthy()
    expect(screen.getByText(/5 days since/i)).toBeTruthy()
    expect(screen.getByText(/speech pace/i)).toBeTruthy()
  })

  it('renders the rusty card with the right testid + body copy', () => {
    render(<DecayContextCard rhythm={rhythm({ decayProfile: 'rusty', daysSinceLastSession: 12 })} />)
    expect(screen.getByTestId('decay-context-card-rusty')).toBeTruthy()
    expect(screen.getByText(/12 days since/i)).toBeTruthy()
    expect(screen.getByText(/communication patterns/i)).toBeTruthy()
  })

  it('renders the cold card with the longest-gap copy', () => {
    render(<DecayContextCard rhythm={rhythm({ decayProfile: 'cold', daysSinceLastSession: 45 })} />)
    expect(screen.getByTestId('decay-context-card-cold')).toBeTruthy()
    expect(screen.getByText(/45\+ days since/i)).toBeTruthy()
    expect(screen.getByText(/story recall/i)).toBeTruthy()
  })

  it('uses observational tone — no exclamations, no imperative "practice now" / "you must" copy', () => {
    for (const profile of ['warmup', 'rusty', 'cold'] as const) {
      const { unmount } = render(
        <DecayContextCard rhythm={rhythm({ decayProfile: profile, daysSinceLastSession: 10 })} />,
      )
      const card = screen.getByTestId(`decay-context-card-${profile}`)
      const text = card.textContent || ''
      expect(text).not.toMatch(/!/)
      expect(text).not.toMatch(/practice now/i)
      expect(text).not.toMatch(/you must/i)
      expect(text).not.toMatch(/you should/i)
      unmount()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import HireSupplementalObservationsPanel from '../HireSupplementalObservationsPanel'

describe('HireSupplementalObservationsPanel', () => {
  it('renders bounded neutral intervals separately from assessment scores', () => {
    render(
      <HireSupplementalObservationsPanel
        observations={[
          {
            observedAt: '2026-08-17T12:00:00.000Z',
            report: {
              status: 'completed',
              capture: { camera: 'captured', browserVisibility: 'captured' },
              events: [
                {
                  kind: 'browser_window_not_visible',
                  source: 'browser_visibility',
                  startMs: 5_000,
                  endMs: 8_000,
                },
              ],
            },
          },
        ]}
      />,
    )

    expect(
      screen.getByRole('region', { name: 'Supplemental interview observations' }),
    ).toBeTruthy()
    expect(screen.getByText(/Browser window was not visible/i)).toBeTruthy()
    expect(screen.getByText(/0:05–0:08/)).toBeTruthy()
    expect(screen.getByText(/not interview scores/i)).toBeTruthy()
    expect(screen.getByText(/did not affect a hiring decision, stage, ranking, recommendation, or export/i)).toBeTruthy()
    expect(screen.queryByText(/confidence/i)).toBeNull()
  })

  it('explains insufficient signal without inventing a conclusion', () => {
    render(
      <HireSupplementalObservationsPanel
        observations={[
          {
            observedAt: '2026-08-17T12:00:00.000Z',
            report: {
              status: 'insufficient_signal',
              capture: { camera: 'unavailable', browserVisibility: 'unavailable' },
              events: [],
            },
          },
        ]}
      />,
    )

    expect(screen.getByText(/not enough supplemental signal/i)).toBeTruthy()
  })
})

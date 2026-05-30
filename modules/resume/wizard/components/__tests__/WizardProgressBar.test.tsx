import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import WizardProgressBar from '../WizardProgressBar'
import { WIZARD_STAGES } from '../../config/wizardConfig'

// Regression guard for the off-by-one stage counter: the bar's state is
// 0-indexed (stage 0 = the first stage), but the user-facing counter and the
// node numbers must read 1-indexed. Before the fix the first stage rendered
// "Stage 0 of 7" with a node labeled "0".
describe('WizardProgressBar stage counter (1-indexed display)', () => {
  it('shows "Stage 1 of N" on the first stage, not "Stage 0 of N-1"', () => {
    render(<WizardProgressBar currentStage={0} strengthScore={0} />)
    expect(
      screen.getByText(`Stage 1 of ${WIZARD_STAGES.length}`),
    ).toBeInTheDocument()
  })

  it('shows "Stage N of N" on the last stage', () => {
    const last = WIZARD_STAGES.length - 1
    render(<WizardProgressBar currentStage={last} strengthScore={100} />)
    expect(
      screen.getByText(`Stage ${WIZARD_STAGES.length} of ${WIZARD_STAGES.length}`),
    ).toBeInTheDocument()
  })

  it('labels the first (incomplete) node "1", not "0"', () => {
    // currentStage=0 → node 0 is current (not completed), so it renders its
    // 1-indexed number rather than a checkmark. Use a non-zero strength score
    // so the strength badge (which renders the raw number) can't masquerade
    // as a node labeled "0".
    render(<WizardProgressBar currentStage={0} strengthScore={42} />)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
})

/**
 * Pathway P2 Wave 1 (feature #4) — visual confirmation that a Pathway
 * action seeded the focus list. The component is purely presentational;
 * tests verify the two behaviors that the setup-page UX depends on:
 *
 *   1. Renders nothing when no focus is supplied (so a non-pathway
 *      entry to the setup page doesn't grow an empty section).
 *   2. Renders one chip per focus item with the labelled section.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import RecommendedFocusChips from '../components/RecommendedFocusChips'

describe('RecommendedFocusChips', () => {
  it('renders nothing when focus is empty', () => {
    const { container } = render(<RecommendedFocusChips focus={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per item under a Recommended focus heading', () => {
    render(<RecommendedFocusChips focus={['Communication', 'Clarity', 'Structure']} />)
    expect(screen.getByText(/Recommended focus/i)).toBeTruthy()
    expect(screen.getByText('Communication')).toBeTruthy()
    expect(screen.getByText('Clarity')).toBeTruthy()
    expect(screen.getByText('Structure')).toBeTruthy()
    // All chips render as list items in a single <ul role="list">
    const list = screen.getByRole('list')
    expect(list.children.length).toBe(3)
  })

  it('uses singular "area" copy for a single focus item', () => {
    render(<RecommendedFocusChips focus={['Communication']} />)
    expect(screen.getByText(/area your pathway flagged/i)).toBeTruthy()
  })

  it('uses plural "areas" copy for multiple focus items', () => {
    render(<RecommendedFocusChips focus={['Communication', 'Clarity']} />)
    expect(screen.getByText(/areas your pathway flagged/i)).toBeTruthy()
  })
})

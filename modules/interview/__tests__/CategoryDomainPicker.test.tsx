import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CategoryDomainPicker from '@interview/components/CategoryDomainPicker'

// Force the component onto its static fallback (deterministic) by failing the
// background /api fetches; STATIC_CATEGORIES + STATIC_DOMAINS drive the render.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network'))))
})

describe('CategoryDomainPicker', () => {
  it('shows browseable category cards, hiding the empty Core Engineering and the General escape', () => {
    render(<CategoryDomainPicker selectedDomain={null} onSelect={() => {}} />)
    expect(screen.getByText('Programming')).toBeTruthy()
    expect(screen.getByText('Data & AI')).toBeTruthy()
    expect(screen.getByText('Design')).toBeTruthy()
    // Phase 4 seeded the Core Engineering roster — it now renders as a browseable card
    expect(screen.getByText('Core Engineering')).toBeTruthy()
    // General remains the escape, never a browse card
    expect(screen.queryByRole('button', { name: /^General \/ Other/ })).toBeNull()
  })

  it('drills into a category and selecting a role calls onSelect with the slug', () => {
    const onSelect = vi.fn()
    render(<CategoryDomainPicker selectedDomain={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /Programming/ }))
    // role screen now shows only Programming roles
    expect(screen.getByText('Frontend Engineer')).toBeTruthy()
    expect(screen.getByText('Backend / Infra Engineer')).toBeTruthy()
    expect(screen.queryByText('Product Manager')).toBeNull() // a Business/Product role is NOT here
    fireEvent.click(screen.getByRole('option', { name: /Frontend Engineer/ }))
    expect(onSelect).toHaveBeenCalledWith('frontend')
  })

  it('the "can\'t find" escape selects general', () => {
    const onSelect = vi.fn()
    render(<CategoryDomainPicker selectedDomain={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByText(/Can't find your field\? Use General/))
    expect(onSelect).toHaveBeenCalledWith('general')
  })

  it('skip-for-known: a pre-selected role opens straight into its category role list', () => {
    render(<CategoryDomainPicker selectedDomain="backend" onSelect={() => {}} />)
    // Starts on the role screen (Programming), not the category grid
    expect(screen.getByRole('option', { name: /Backend \/ Infra Engineer/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Programming/ })).toBeTruthy() // back affordance
    expect(screen.queryByRole('listbox', { name: 'Interview fields' })).toBeNull() // not the grid screen
  })

  it('skip-for-known also works when selectedDomain hydrates AFTER first render', () => {
    // Mirrors the real form: retake/pathway/onboarding set role via an effect.
    const { rerender } = render(<CategoryDomainPicker selectedDomain={null} onSelect={() => {}} />)
    expect(screen.getByRole('listbox', { name: 'Interview fields' })).toBeTruthy() // grid first (role still null)
    rerender(<CategoryDomainPicker selectedDomain="backend" onSelect={() => {}} />)
    // now opens straight into the role's category list
    expect(screen.getByRole('option', { name: /Backend \/ Infra Engineer/ })).toBeTruthy()
    expect(screen.queryByRole('listbox', { name: 'Interview fields' })).toBeNull()
  })

  it('resets to the category grid when the role is cleared (Start over)', () => {
    const { rerender } = render(<CategoryDomainPicker selectedDomain="backend" onSelect={() => {}} />)
    expect(screen.getByRole('option', { name: /Backend \/ Infra Engineer/ })).toBeTruthy() // role screen
    rerender(<CategoryDomainPicker selectedDomain={null} onSelect={() => {}} />)
    // cleared role (known → null) returns to the grid, not the stale role list
    expect(screen.getByRole('listbox', { name: 'Interview fields' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Backend \/ Infra Engineer/ })).toBeNull()
  })

  it('does not override the user after they manually navigate, even if role hydrates', () => {
    const { rerender } = render(<CategoryDomainPicker selectedDomain={null} onSelect={() => {}} />)
    // user opens Design before any role hydrates
    fireEvent.click(screen.getByRole('button', { name: /Design/ }))
    expect(screen.getByRole('option', { name: /Design \/ UX/ })).toBeTruthy()
    // role hydrates to backend — must NOT yank the user to Programming
    rerender(<CategoryDomainPicker selectedDomain="backend" onSelect={() => {}} />)
    expect(screen.getByRole('option', { name: /Design \/ UX/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Backend \/ Infra Engineer/ })).toBeNull()
  })
})

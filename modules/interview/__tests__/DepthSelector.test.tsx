import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import DepthSelector from '@interview/components/DepthSelector'

// Fail the network so only the STATIC_DEPTHS instant render is exercised — this
// is the window Codex flagged: new category-only roles must still inherit their
// depths before (or without) the /api/interview-types response.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network'))))
})

describe('DepthSelector instant render is category-aware', () => {
  it('a Programming role (fullstack) shows coding + system-design immediately', () => {
    render(<DepthSelector selectedDomain="fullstack" selectedDepth={null} onSelect={() => {}} />)
    expect(screen.getByRole('option', { name: /Coding Challenge/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /System Design/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Behavioral/ })).toBeTruthy()
  })

  it('a Core Engineering role (mechanical) does NOT show coding', () => {
    render(<DepthSelector selectedDomain="mechanical" selectedDepth={null} onSelect={() => {}} />)
    expect(screen.queryByRole('option', { name: /Coding Challenge/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Technical Deep Dive/ })).toBeTruthy()
  })
})

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

describe('DepthSelector experience gating (academics → 0-2 only)', () => {
  it('shows the Academic / Subject Viva option for a 0-2 fresher', () => {
    render(<DepthSelector selectedDomain="backend" selectedDepth={null} experience="0-2" onSelect={() => {}} />)
    expect(screen.getByRole('option', { name: /Academic/ })).toBeTruthy()
  })

  it('hides academics for 3-6 and 7+ bands', () => {
    const { unmount } = render(<DepthSelector selectedDomain="backend" selectedDepth={null} experience="3-6" onSelect={() => {}} />)
    expect(screen.queryByRole('option', { name: /Academic/ })).toBeNull()
    unmount()
    render(<DepthSelector selectedDomain="backend" selectedDepth={null} experience="7+" onSelect={() => {}} />)
    expect(screen.queryByRole('option', { name: /Academic/ })).toBeNull()
  })

  it('hides academics when no experience is set (gated depth defaults hidden)', () => {
    render(<DepthSelector selectedDomain="backend" selectedDepth={null} onSelect={() => {}} />)
    expect(screen.queryByRole('option', { name: /Academic/ })).toBeNull()
  })
})

describe('DepthSelector stale-fetch guard (P1 race)', () => {
  it('a late 0-2 fetch response cannot re-expose academics after switching to 3-6', async () => {
    const withAcademics = [
      { slug: 'academics', label: 'Academic / Subject Viva', icon: '📚', description: 'viva' },
      { slug: 'behavioral', label: 'Behavioral Interview', icon: '🧠', description: 'beh' },
    ]
    const withoutAcademics = [
      { slug: 'behavioral', label: 'Behavioral Interview', icon: '🧠', description: 'beh' },
    ]
    let releaseStale = () => {}
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((res) => { releaseStale = () => res({ json: () => Promise.resolve(withAcademics) }) }),
      )
      .mockImplementationOnce(() => Promise.resolve({ json: () => Promise.resolve(withoutAcademics) }))
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(
      <DepthSelector selectedDomain="backend" selectedDepth={null} experience="0-2" onSelect={() => {}} />,
    )
    // switch band before the 0-2 fetch resolves → the effect cleanup marks it cancelled
    rerender(<DepthSelector selectedDomain="backend" selectedDepth={null} experience="3-6" onSelect={() => {}} />)
    await screen.findByRole('option', { name: /Behavioral/ })

    // the STALE 0-2 response now lands — it must be ignored
    releaseStale()
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('option', { name: /Academic/ })).toBeNull()
  })
})

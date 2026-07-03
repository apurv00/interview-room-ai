// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResume } from '@resume/hooks/useResume'
import { getTemplateSectionOrder } from '@resume/config/sectionOrders'

// Regression: saveResume persists `sectionOrder: []` for resumes that were
// never manually reordered. [] is truthy, so `sectionOrder || default`
// treated it as a real (empty) order — the editor rendered zero sections and
// drag-reorder no-opped. The fix falls back to the template default whenever
// the persisted order is empty.

describe('useResume with persisted empty sectionOrder', () => {
  it('reorderSections falls back to the template default instead of no-opping', () => {
    const { result } = renderHook(() =>
      useResume({ name: 'R', template: 'professional', sectionOrder: [] }),
    )
    act(() => { result.current.reorderSections('experience', 'summary') })
    const order = result.current.resume.sectionOrder!
    expect(order.length).toBeGreaterThan(0)
    expect(order.indexOf('experience')).toBeLessThan(order.indexOf('summary'))
  })

  it('reorderSections still respects a real persisted order', () => {
    const custom = getTemplateSectionOrder('professional').reverse()
    const { result } = renderHook(() =>
      useResume({ name: 'R', template: 'professional', sectionOrder: custom }),
    )
    act(() => { result.current.reorderSections(custom[1], custom[2]) })
    const order = result.current.resume.sectionOrder!
    expect(order).toHaveLength(custom.length)
    expect(order[2]).toBe(custom[1])
  })
})

describe('useResume dirty semantics (draft protection #8/#9)', () => {
  it('starts clean by default', () => {
    const { result } = renderHook(() => useResume({ name: 'R' }))
    expect(result.current.isDirty).toBe(false)
  })

  it('starts dirty when initialDirty is set (imported unsaved content)', () => {
    const { result } = renderHook(() => useResume({ name: 'R' }, { initialDirty: true }))
    expect(result.current.isDirty).toBe(true)
  })

  it('loadResume leaves it clean by default (cloud load) but dirty with markDirty (import)', () => {
    const { result } = renderHook(() => useResume({ name: 'R' }))
    act(() => { result.current.loadResume({ summary: 'from cloud' }) })
    expect(result.current.isDirty).toBe(false)
    act(() => { result.current.loadResume({ summary: 'imported' }, { markDirty: true }) })
    expect(result.current.isDirty).toBe(true)
  })
})

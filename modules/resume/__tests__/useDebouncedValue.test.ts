// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedValue } from '@resume/hooks/useDebouncedValue'

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('first', 250))
    expect(result.current).toBe('first')
  })

  it('holds the old value until the delay elapses', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: 'a' } },
    )
    rerender({ value: 'b' })
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(249) })
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe('b')
  })

  it('collapses a rapid burst of changes into one trailing update', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: 'a' } },
    )
    // Simulate typing: each keystroke arrives before the previous timer fires.
    for (const v of ['ab', 'abc', 'abcd']) {
      act(() => { vi.advanceTimersByTime(100) })
      rerender({ value: v })
    }
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(250) })
    expect(result.current).toBe('abcd')
  })
})

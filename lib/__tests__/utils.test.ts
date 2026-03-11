import { describe, it, expect } from 'vitest'
import { formatTime, bisectLastLE } from '@/lib/utils'

describe('formatTime', () => {
  it('formats 0 seconds as 0:00', () => {
    expect(formatTime(0)).toBe('0:00')
  })

  it('formats seconds < 60', () => {
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(30)).toBe('0:30')
    expect(formatTime(59)).toBe('0:59')
  })

  it('formats exact minutes', () => {
    expect(formatTime(60)).toBe('1:00')
    expect(formatTime(120)).toBe('2:00')
    expect(formatTime(600)).toBe('10:00')
  })

  it('formats minutes and seconds', () => {
    expect(formatTime(90)).toBe('1:30')
    expect(formatTime(125)).toBe('2:05')
    expect(formatTime(3599)).toBe('59:59')
  })

  it('pads single-digit seconds with zero', () => {
    expect(formatTime(61)).toBe('1:01')
    expect(formatTime(69)).toBe('1:09')
  })

  it('handles fractional seconds by flooring', () => {
    expect(formatTime(90.7)).toBe('1:30')
    expect(formatTime(59.9)).toBe('0:59')
  })
})

describe('bisectLastLE', () => {
  it('returns -1 for empty array', () => {
    expect(bisectLastLE([], 5)).toBe(-1)
  })

  it('returns -1 when target is less than all elements', () => {
    expect(bisectLastLE([10, 20, 30], 5)).toBe(-1)
  })

  it('returns last index when target exceeds all elements', () => {
    expect(bisectLastLE([10, 20, 30], 40)).toBe(2)
  })

  it('returns exact match index', () => {
    expect(bisectLastLE([10, 20, 30], 20)).toBe(1)
  })

  it('returns index of largest element <= target', () => {
    expect(bisectLastLE([10, 20, 30], 25)).toBe(1)
  })

  it('handles single element array', () => {
    expect(bisectLastLE([10], 10)).toBe(0)
    expect(bisectLastLE([10], 5)).toBe(-1)
    expect(bisectLastLE([10], 15)).toBe(0)
  })

  it('handles duplicate values', () => {
    expect(bisectLastLE([10, 10, 20, 20], 10)).toBe(1)
    expect(bisectLastLE([10, 10, 20, 20], 15)).toBe(1)
  })

  it('returns first element index when target equals first', () => {
    expect(bisectLastLE([5, 10, 15], 5)).toBe(0)
  })
})

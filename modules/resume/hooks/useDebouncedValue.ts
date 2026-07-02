'use client'

import { useEffect, useState } from 'react'

/** Returns `value` debounced by `delayMs`: the returned value only catches up
 *  after `value` has been stable for the delay. Initial value is immediate.
 *  Used by ResumePreview so the synchronous measure pipeline runs once per
 *  typing pause instead of on every keystroke. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

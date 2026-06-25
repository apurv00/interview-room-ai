/**
 * flowSlotIndex (PR #468 review #3). The intro thread inflates completedThreads.length;
 * for the academics viva that would skip the fundamentals slot. This pins the academics
 * exclusion AND that every other depth keeps its legacy 1:1 indexing unchanged.
 */
import { describe, it, expect } from 'vitest'
import { flowSlotIndex } from '@interview/flow/slotIndex'

describe('flowSlotIndex', () => {
  it('excludes the intro thread for academics so the fundamentals slot is not skipped', () => {
    expect(flowSlotIndex('academics', 0)).toBe(0) // very first prefetch (no completed threads)
    expect(flowSlotIndex('academics', 1)).toBe(0) // [intro] → favourite-subject slot 0
    expect(flowSlotIndex('academics', 2)).toBe(1) // [intro, favourite] → fundamentals slot 1 (NOT derive slot 2)
    expect(flowSlotIndex('academics', 3)).toBe(2) // → derive slot 2
  })

  it('keeps legacy 1:1 indexing for every non-academics depth', () => {
    for (const depth of ['behavioral', 'technical', 'case-study', 'system-design', 'coding']) {
      expect(flowSlotIndex(depth, 0)).toBe(0)
      expect(flowSlotIndex(depth, 1)).toBe(1)
      expect(flowSlotIndex(depth, 3)).toBe(3)
    }
  })
})

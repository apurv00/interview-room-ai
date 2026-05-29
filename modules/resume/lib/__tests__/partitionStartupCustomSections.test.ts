import { describe, it, expect } from 'vitest'
import { partitionStartupCustomSections } from '../partitionStartupCustomSections'

describe('partitionStartupCustomSections', () => {
  it('routes side project and interest titles into dedicated buckets', () => {
    const result = partitionStartupCustomSections([
      { id: '1', title: 'Side Projects', content: 'Built X' },
      { id: '2', title: 'Interests', content: 'Climbing' },
      { id: '3', title: 'Volunteering', content: 'Mentor' },
    ])
    expect(result.sideProjects).toHaveLength(1)
    expect(result.interests).toHaveLength(1)
    expect(result.other).toHaveLength(1)
    expect(result.other[0].title).toBe('Volunteering')
  })
})

import { describe, it, expect } from 'vitest'
import { getStartRedirect } from '../authRedirect'

describe('getStartRedirect', () => {
  it('returns null when status is loading (block the action)', () => {
    expect(getStartRedirect('loading')).toBeNull()
  })

  it('returns signin URL with callback when unauthenticated', () => {
    expect(getStartRedirect('unauthenticated')).toBe('/signin?callbackUrl=/lobby')
  })

  it('returns /lobby when authenticated', () => {
    expect(getStartRedirect('authenticated')).toBe('/lobby')
  })
})

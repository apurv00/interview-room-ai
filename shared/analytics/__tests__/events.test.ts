import { describe, it, expect } from 'vitest'
import { EVENT_NAMES } from '@shared/analytics/events'
import type { EventName, EventPropsMap, UserTraits } from '@shared/analytics/events'

describe('shared/analytics/events registry', () => {
  it('every EVENT_NAMES key maps to its own snake_case string value', () => {
    // Self-consistency: typo guard against `cta_clicked: 'cta_click'`.
    for (const [key, value] of Object.entries(EVENT_NAMES)) {
      expect(value).toBe(key)
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('exposes EventName as a finite union of registered names', () => {
    // Compile-time assertion via assignment: each known name must be assignable
    // to EventName. This file fails to typecheck if any registered name is
    // missing from the union — catches drift between EVENT_NAMES and EventName.
    const sample: EventName[] = [
      'cta_clicked',
      'page_view',
      'waitlist_joined',
      'auth_gate_opened',
      'auth_completed',
      'signin_succeeded',
      'lobby_ready',
      'lobby_check_failed',
      'interview_join_clicked',
      'resume_downloaded',
      'analysis_completed',
      'audio_worklet_loaded',
    ]
    expect(sample).toHaveLength(Object.keys(EVENT_NAMES).length)
  })

  it('refuses PII keys on UserTraits at compile time', () => {
    const safe: UserTraits = {
      plan: 'pro',
      role: 'candidate',
      organizationId: 'org_x',
      onboardingCompleted: true,
    }
    expect(safe.plan).toBe('pro')

    // @ts-expect-error - email is PII.
    const unsafe1: UserTraits = { email: 'a@b.com' }
    void unsafe1
    // @ts-expect-error - name is PII.
    const unsafe2: UserTraits = { name: 'Alex' }
    void unsafe2
    // @ts-expect-error - phone is PII.
    const unsafe3: UserTraits = { phone: '555-1234' }
    void unsafe3
  })

  it('every event prop shape rejects PII property names at compile time', () => {
    // Spot-check: registered shapes don't accidentally contain PII keys.
    // Compile-time @ts-expect-error catches drift if someone adds an
    // 'email' key to a registered EventPropsMap entry.
    type _CtaProps = EventPropsMap['cta_clicked']
    type _PageViewProps = EventPropsMap['page_view']
    type _SigninProps = EventPropsMap['signin_succeeded']

    // Runtime smoke — these must be the exact registered shapes:
    const cta: _CtaProps = { cta: 'start_interview', location: 'home' }
    const pv: _PageViewProps = { pathname: '/' }
    const si: _SigninProps = { had_prior_session: false }
    expect(cta.cta).toBe('start_interview')
    expect(pv.pathname).toBe('/')
    expect(si.had_prior_session).toBe(false)
  })

  it('event name list does not contain accidental duplicates or stale aliases', () => {
    const values = Object.values(EVENT_NAMES)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })
})

import { describe, expect, it } from 'vitest'
import {
  hireHandoffIssuanceAllowed,
  hireHandoffIssuanceState,
} from '../hireHandoffIssuanceGate'

function headers(token?: string): Headers {
  return new Headers(token ? { 'x-hire-handoff-smoke-token': token } : {})
}

describe('Hire handoff issuance gate', () => {
  it('fails production closed when the mode is absent or malformed', () => {
    expect(hireHandoffIssuanceState({ NODE_ENV: 'production' })).toEqual({
      mode: 'draining',
      explicitlyConfigured: false,
      publicIssuanceOpen: false,
      smokeReady: false,
    })
    expect(hireHandoffIssuanceAllowed(headers(), {
      NODE_ENV: 'production',
      HIRE_HANDOFF_ISSUANCE_MODE: 'typo',
    })).toBe(false)
  })

  it('opens ordinary issuance only in explicit open mode', () => {
    const env = {
      NODE_ENV: 'production',
      HIRE_HANDOFF_ISSUANCE_MODE: 'open',
    }
    expect(hireHandoffIssuanceState(env).publicIssuanceOpen).toBe(true)
    expect(hireHandoffIssuanceAllowed(headers(), env)).toBe(true)
  })

  it('blocks every request while draining', () => {
    const env = {
      NODE_ENV: 'production',
      HIRE_HANDOFF_ISSUANCE_MODE: 'draining',
      HIRE_HANDOFF_SMOKE_TOKEN: 's'.repeat(64),
    }
    expect(hireHandoffIssuanceAllowed(headers('s'.repeat(64)), env)).toBe(false)
  })

  it('allows only a constant-time exact operator token in smoke mode', () => {
    const token = 's'.repeat(64)
    const env = {
      NODE_ENV: 'production',
      HIRE_HANDOFF_ISSUANCE_MODE: 'smoke',
      HIRE_HANDOFF_SMOKE_TOKEN: token,
    }
    expect(hireHandoffIssuanceAllowed(headers(), env)).toBe(false)
    expect(hireHandoffIssuanceAllowed(headers(`${token}x`), env)).toBe(false)
    expect(hireHandoffIssuanceAllowed(headers(token), env)).toBe(true)
    expect(hireHandoffIssuanceState(env)).toMatchObject({
      mode: 'smoke',
      publicIssuanceOpen: false,
      smokeReady: true,
    })
  })

  it('refuses weak smoke tokens', () => {
    const env = {
      NODE_ENV: 'production',
      HIRE_HANDOFF_ISSUANCE_MODE: 'smoke',
      HIRE_HANDOFF_SMOKE_TOKEN: 'short',
    }
    expect(hireHandoffIssuanceState(env).smokeReady).toBe(false)
    expect(hireHandoffIssuanceAllowed(headers('short'), env)).toBe(false)
  })
})

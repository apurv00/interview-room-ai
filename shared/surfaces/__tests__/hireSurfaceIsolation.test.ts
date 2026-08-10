import { describe, expect, it } from 'vitest'
import { isHireIsolatedSurface, resolveDeploymentSurface } from '../hireSurfaceIsolation'

describe('Hire deployment resolution', () => {
  it('treats the explicit control and runtime roles as authoritative', () => {
    expect(resolveDeploymentSurface({ configuredSurface: 'hire-control' })).toBe('hire-control')
    expect(resolveDeploymentSurface({ configuredSurface: 'hire-engine' })).toBe('hire-runtime')
  })

  it('recognizes the production control host without relying on deployment config', () => {
    expect(resolveDeploymentSurface({ hostname: 'Hire.InterviewPrep.Guru:443' })).toBe(
      'hire-control',
    )
  })

  it('recognizes an explicitly configured runtime host', () => {
    expect(
      resolveDeploymentSurface({
        hostname: 'interview-appliance.example.net:443',
        runtimeUrl: 'https://interview-appliance.example.net/handoff',
      }),
    ).toBe('hire-runtime')
  })

  it('leaves the consumer host on the B2C surface', () => {
    expect(resolveDeploymentSurface({ hostname: 'www.interviewprep.guru' })).toBe('b2c')
  })
})

describe('Hire path isolation', () => {
  it.each([
    '/workspace',
    '/workspace/jobs/123',
    '/candidate/round-1',
    '/apply/invite-secret',
    '/handoff',
    '/hire-signin',
  ])('isolates %s even when exercised on the shared B2C deployment', (pathname) => {
    expect(isHireIsolatedSurface({ deploymentSurface: 'b2c', pathname })).toBe(true)
  })

  it.each(['/lobby', '/interview', '/interview/session-1'])(
    'preserves B2C behavior on %s',
    (pathname) => {
      expect(isHireIsolatedSurface({ deploymentSurface: 'b2c', pathname })).toBe(false)
    },
  )

  it.each(['/', '/lobby', '/interview/session-1', '/feedback/session-1'])(
    'isolates every runtime path, including %s',
    (pathname) => {
      expect(isHireIsolatedSurface({ deploymentSurface: 'hire-runtime', pathname })).toBe(true)
    },
  )
})

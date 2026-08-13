import { describe, expect, it } from 'vitest'
import {
  currentDeploymentSurface,
  hireDeploymentConfigurationIssues,
} from '../hireDeploymentReadiness'

const base = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://mongo.example/ipg-hire-control',
  REDIS_URL: 'rediss://redis.example',
  HEALTH_CHECK_TOKEN: 'health-secret',
  DEPLOYMENT_COMMIT_SHA: '0123456789abcdef',
  HIRE_ENGINE_BRIDGE_KEY_ID: 'hire-bridge-2026-08',
  HIRE_ENGINE_BRIDGE_SECRET: 'b'.repeat(64),
  B2C_DATABASE_NAME: 'ipg-b2c',
  HIRE_CONTROL_DATABASE_NAME: 'ipg-hire-control',
  HIRE_RUNTIME_DATABASE_NAME: 'ipg-hire-runtime',
  B2C_INNGEST_APP_ID: 'ipg-b2c-production',
  HIRE_CONTROL_INNGEST_APP_ID: 'ipg-hire-control-production',
  HIRE_RUNTIME_INNGEST_APP_ID: 'ipg-hire-runtime-production',
  INNGEST_SIGNING_KEY: 'signkey-test',
}

const control = {
  ...base,
  IPG_SURFACE: 'hire-control',
  INNGEST_APP_ID: 'ipg-hire-control-production',
  INNGEST_EVENT_KEY: 'event-key',
  NEXTAUTH_SECRET: 'c'.repeat(64),
  HIRE_PUBLIC_URL: 'https://hire.interviewprep.guru',
  HIRE_ENGINE_RUNTIME_URL: 'https://engine.hire.interviewprep.guru',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'IPG Hire <hire@send.interviewprep.guru>',
  HIRE_REENGAGEMENT_OPT_OUT_SECRET: 'o'.repeat(64),
  HIRE_INVITE_DELIVERY_KEY_ID: 'invite-delivery-2026-08',
  HIRE_INVITE_DELIVERY_KEY: Buffer.alloc(32, 7).toString('base64'),
  R2_ACCOUNT_ID: 'control-account',
  R2_ACCESS_KEY_ID: 'control-key',
  R2_SECRET_ACCESS_KEY: 'control-secret',
  R2_BUCKET_NAME: 'ipg-hire-control-media',
  HIRE_RUNTIME_R2_ACCOUNT_ID: 'runtime-account',
  HIRE_RUNTIME_R2_ACCESS_KEY_ID: 'runtime-key',
  HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: 'runtime-secret',
  HIRE_RUNTIME_R2_BUCKET_NAME: 'ipg-hire-runtime-staging',
}

const runtime = {
  ...base,
  IPG_SURFACE: 'hire-engine',
  MONGODB_URI: 'mongodb://mongo.example/ipg-hire-runtime',
  INNGEST_APP_ID: 'ipg-hire-runtime-production',
  NEXTAUTH_SECRET: 'runtime-middleware-secret'.repeat(3),
  NEXTAUTH_URL: 'https://engine.hire.interviewprep.guru',
  HIRE_RUNTIME_NEXTAUTH_SECRET: 'r'.repeat(64),
  HIRE_RUNTIME_FENCE_SECRET: 'f'.repeat(64),
  HIRE_CONTROL_INTERNAL_URL: 'https://hire.interviewprep.guru',
  HIRE_ENGINE_RUNTIME_URL: 'https://engine.hire.interviewprep.guru',
  R2_ACCOUNT_ID: 'runtime-account',
  R2_ACCESS_KEY_ID: 'runtime-key',
  R2_SECRET_ACCESS_KEY: 'runtime-secret',
  R2_BUCKET_NAME: 'ipg-hire-runtime-staging',
  HIRE_RUNTIME_R2_ACCOUNT_ID: 'runtime-account',
  HIRE_RUNTIME_R2_ACCESS_KEY_ID: 'runtime-key',
  HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: 'runtime-secret',
  HIRE_RUNTIME_R2_BUCKET_NAME: 'ipg-hire-runtime-staging',
}

describe('Hire deployment readiness', () => {
  it('leaves the existing B2C deployment untouched', () => {
    expect(currentDeploymentSurface({})).toBe('b2c')
    expect(hireDeploymentConfigurationIssues({})).toEqual([])
  })

  it('accepts an isolated production control-plane manifest', () => {
    expect(currentDeploymentSurface(control)).toBe('hire-control')
    expect(hireDeploymentConfigurationIssues(control)).toEqual([])
  })

  it('accepts bounded invite-delivery key rotation and rejects unsafe key manifests', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS: 'invite-delivery-2026-07',
      HIRE_INVITE_DELIVERY_KEY_PREVIOUS: Buffer.alloc(32, 6).toString('base64'),
    })).toEqual([])

    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_INVITE_DELIVERY_KEY: 'not-a-32-byte-key',
      HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS: control.HIRE_INVITE_DELIVERY_KEY_ID,
    })).toEqual(expect.arrayContaining([
      'invalid:HIRE_INVITE_DELIVERY_KEY',
      'incomplete:previous-invite-delivery-key',
      'collision:invite-delivery-key-ids',
    ]))
  })

  it('accepts an isolated production runtime manifest', () => {
    expect(currentDeploymentSurface(runtime)).toBe('hire-engine')
    expect(hireDeploymentConfigurationIssues(runtime)).toEqual([])
  })

  it('requires a strong runtime middleware secret distinct from the runtime session secret', () => {
    expect(
      hireDeploymentConfigurationIssues({
        ...runtime,
        NEXTAUTH_SECRET: undefined,
      }),
    ).toEqual(expect.arrayContaining([
      'missing:NEXTAUTH_SECRET',
      'weak:NEXTAUTH_SECRET',
    ]))

    expect(
      hireDeploymentConfigurationIssues({
        ...runtime,
        NEXTAUTH_SECRET: 'short',
      }),
    ).toContain('weak:NEXTAUTH_SECRET')

    expect(
      hireDeploymentConfigurationIssues({
        ...runtime,
        NEXTAUTH_SECRET: runtime.HIRE_RUNTIME_NEXTAUTH_SECRET,
      }),
    ).toContain('collision:nextauth-secrets')
  })

  it('rejects database, origin, and Inngest app collisions', () => {
    const issues = hireDeploymentConfigurationIssues({
      ...control,
      HIRE_RUNTIME_DATABASE_NAME: control.HIRE_CONTROL_DATABASE_NAME,
      HIRE_RUNTIME_INNGEST_APP_ID: control.HIRE_CONTROL_INNGEST_APP_ID,
      HIRE_ENGINE_RUNTIME_URL: control.HIRE_PUBLIC_URL,
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        'collision:database-names',
        'collision:inngest-app-ids',
        'collision:hire-origins',
      ]),
    )
  })

  it('accepts shared R2 credentials and arbitrary distinct HTTPS origins', () => {
    expect(
      hireDeploymentConfigurationIssues({
        ...control,
        HIRE_PUBLIC_URL: 'https://hire-control.161.118.191.159.sslip.io',
        HIRE_ENGINE_RUNTIME_URL:
          'https://hire-runtime.161.118.191.159.sslip.io',
        HIRE_RUNTIME_R2_ACCOUNT_ID: control.R2_ACCOUNT_ID,
        HIRE_RUNTIME_R2_ACCESS_KEY_ID: control.R2_ACCESS_KEY_ID,
        HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: control.R2_SECRET_ACCESS_KEY,
        HIRE_RUNTIME_R2_BUCKET_NAME: control.R2_BUCKET_NAME,
      }),
    ).toEqual([])
  })

  it('rejects an insecure runtime bridge and public URL', () => {
    const issues = hireDeploymentConfigurationIssues({
      ...runtime,
      HIRE_ENGINE_BRIDGE_SECRET: 'short',
      HIRE_CONTROL_INTERNAL_URL: 'http://hire-control:3000?token=secret',
      HIRE_RUNTIME_NEXTAUTH_SECRET: runtime.NEXTAUTH_SECRET,
      HIRE_RUNTIME_FENCE_SECRET: 'short',
      INNGEST_APP_ID: runtime.B2C_INNGEST_APP_ID,
      INNGEST_EVENT_KEY: 'must-not-be-present-on-runtime',
      NEXTAUTH_URL: 'https://wrong-runtime.example',
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        'weak:HIRE_ENGINE_BRIDGE_SECRET',
        'invalid:HIRE_CONTROL_INTERNAL_URL',
        'collision:nextauth-secrets',
        'weak:HIRE_RUNTIME_FENCE_SECRET',
        'mismatch:INNGEST_APP_ID',
        'mismatch:NEXTAUTH_URL',
        'unsafe:runtime-event-egress',
      ]),
    )
  })

  it('requires unchanged engine storage variables to alias the isolated runtime bucket', () => {
    const issues = hireDeploymentConfigurationIssues({
      ...runtime,
      R2_BUCKET_NAME: 'b2c-recordings',
      R2_ACCESS_KEY_ID: 'b2c-storage-key',
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        'mismatch:R2_BUCKET_NAME',
        'mismatch:R2_ACCESS_KEY_ID',
      ]),
    )
  })

  it('lists missing production dependencies without exposing values', () => {
    const issues = hireDeploymentConfigurationIssues({ IPG_SURFACE: 'hire-control' })
    expect(issues).toContain('missing:MONGODB_URI')
    expect(issues).toContain('missing:RESEND_API_KEY')
    expect(issues.join(' ')).not.toContain('mongodb://')
  })

  it('fails closed when the independent re-engagement opt-out secret is absent or weak', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_REENGAGEMENT_OPT_OUT_SECRET: undefined,
    })).toEqual(expect.arrayContaining([
      'missing:HIRE_REENGAGEMENT_OPT_OUT_SECRET',
      'weak:HIRE_REENGAGEMENT_OPT_OUT_SECRET',
    ]))
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_REENGAGEMENT_OPT_OUT_SECRET: 'short',
    })).toContain('weak:HIRE_REENGAGEMENT_OPT_OUT_SECRET')
  })

  it('rejects an insecure optional public opt-out alias before mail dispatch', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_PUBLIC_ORIGIN: 'http://hire.example.test?capability=must-not-pass',
    })).toContain('invalid:HIRE_PUBLIC_ORIGIN')
  })
})

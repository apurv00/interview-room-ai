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
  DEPLOYMENT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
  HIRE_ENGINE_BRIDGE_KEY_ID: 'hire-bridge-2026-08',
  HIRE_ENGINE_BRIDGE_SECRET: 'b'.repeat(64),
  B2C_DATABASE_NAME: 'ipg-b2c',
  HIRE_CONTROL_DATABASE_NAME: 'ipg-hire-control',
  HIRE_RUNTIME_DATABASE_NAME: 'ipg-hire-runtime',
  B2C_INNGEST_APP_ID: 'ipg-b2c-production',
  HIRE_CONTROL_INNGEST_APP_ID: 'ipg-hire-control-production',
  HIRE_RUNTIME_INNGEST_APP_ID: 'ipg-hire-runtime-production',
  INNGEST_SIGNING_KEY: 'signkey-test',
  NEXT_PUBLIC_FEATURE_MULTIMODAL: 'true',
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
  HIRE_INVITE_DELIVERY_KEY_ID: 'invite-delivery-2026-08',
  HIRE_INVITE_DELIVERY_KEY: Buffer.alloc(32, 7).toString('base64'),
  HIRE_ACCOUNT_BRIDGE_KEY_ID: 'account-bridge-2026-08',
  HIRE_ACCOUNT_BRIDGE_SECRET: 'a'.repeat(64),
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
  HIRE_CONTROL_URL: 'https://hire.interviewprep.guru',
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

  it('fails closed when a Hire manifest omits or mistypes its surface identity', () => {
    expect(hireDeploymentConfigurationIssues({
      HIRE_CONTROL_DATABASE_NAME: 'ipg-hire-control',
      HIRE_RUNTIME_DATABASE_NAME: 'ipg-hire-runtime',
    })).toEqual(['missing:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      ...control,
      IPG_SURFACE: 'hire-contorl',
    })).toEqual(['invalid:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      HIRE_ENGINE_RUNTIME_URL: 'https://engine.example.test',
    })).toEqual(['missing:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      HIRE_ENGINE_BRIDGE_SECRET_PREVIOUS: 'p'.repeat(64),
    })).toEqual(['missing:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      HIRE_HANDOFF_ISSUANCE_MODE: 'open',
    })).toEqual(['missing:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      HIRE_FUTURE_RELEASE_MARKER: 'enabled',
    })).toEqual(['missing:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      IPG_SURFACE: ' hire-engine ',
    })).toEqual(['invalid:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      IPG_SURFACE: '   ',
    })).toEqual(['invalid:IPG_SURFACE'])
    expect(hireDeploymentConfigurationIssues({
      IPG_SURFACE: 'b2c',
      HIRE_CONTROL_DATABASE_NAME: 'ipg-hire-control',
      HIRE_ENGINE_RUNTIME_URL: 'https://engine.example.test',
    })).toEqual([])
  })

  it('accepts an isolated production control-plane manifest', () => {
    expect(currentDeploymentSurface(control)).toBe('hire-control')
    expect(hireDeploymentConfigurationIssues(control)).toEqual([])
  })

  it('does not require the browser-only build flag on control', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      NEXT_PUBLIC_FEATURE_MULTIMODAL: undefined,
    })).toEqual([])
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

  it('requires the account-deletion bridge on the control plane', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_ACCOUNT_BRIDGE_KEY_ID: undefined,
      HIRE_ACCOUNT_BRIDGE_SECRET: 'short',
    })).toEqual(expect.arrayContaining([
      'missing:HIRE_ACCOUNT_BRIDGE_KEY_ID',
      'weak:HIRE_ACCOUNT_BRIDGE_SECRET',
    ]))
  })

  it('keeps account-deletion and engine bridge credentials compartmentalized', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_ACCOUNT_BRIDGE_SECRET: control.HIRE_ENGINE_BRIDGE_SECRET,
    })).toContain('collision:bridge-secrets')
  })

  it('accepts an isolated production runtime manifest', () => {
    expect(currentDeploymentSurface(runtime)).toBe('hire-engine')
    expect(hireDeploymentConfigurationIssues(runtime)).toEqual([])
  })

  it('rejects whitespace that would change the actual Inngest app identity', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      INNGEST_APP_ID: ` ${control.INNGEST_APP_ID} `,
    })).toContain('mismatch:INNGEST_APP_ID')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      HIRE_RUNTIME_INNGEST_APP_ID:
        ` ${runtime.HIRE_RUNTIME_INNGEST_APP_ID} `,
    })).toContain('mismatch:INNGEST_APP_ID')
  })

  it('requires an exact full deployment commit SHA', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      DEPLOYMENT_COMMIT_SHA: '0123456789abcdef',
    })).toContain('invalid:DEPLOYMENT_COMMIT_SHA')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      DEPLOYMENT_COMMIT_SHA: 'g'.repeat(40),
    })).toContain('invalid:DEPLOYMENT_COMMIT_SHA')
  })

  it('requires the Hire browser feature flag in the built deployment manifest', () => {
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      NEXT_PUBLIC_FEATURE_MULTIMODAL: undefined,
    })).toEqual(expect.arrayContaining([
      'missing:NEXT_PUBLIC_FEATURE_MULTIMODAL',
      'invalid:NEXT_PUBLIC_FEATURE_MULTIMODAL',
    ]))
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      NEXT_PUBLIC_FEATURE_MULTIMODAL: 'false',
    })).toContain('invalid:NEXT_PUBLIC_FEATURE_MULTIMODAL')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      NEXT_PUBLIC_FEATURE_MULTIMODAL: ' true ',
    })).toContain('invalid:NEXT_PUBLIC_FEATURE_MULTIMODAL')
  })

  it('requires an isolated HTTPS browser-facing control URL on runtime', () => {
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      HIRE_CONTROL_URL: undefined,
    })).toContain('missing:HIRE_CONTROL_URL')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      HIRE_CONTROL_URL: 'http://hire.example.test',
    })).toContain('invalid:HIRE_CONTROL_URL')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      HIRE_CONTROL_URL: `${runtime.HIRE_ENGINE_RUNTIME_URL}/control`,
    })).toContain('collision:hire-origins')
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

  it.each([
    'B2C_DATABASE_NAME',
    'HIRE_CONTROL_DATABASE_NAME',
    'HIRE_RUNTIME_DATABASE_NAME',
  ] as const)('rejects whitespace in exact database identity %s', (name) => {
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      [name]: ` ${runtime[name]} `,
    })).toContain(`invalid:${name}`)
  })

  it('compares service isolation by URL origin, not raw URL text', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_PUBLIC_URL: 'https://hire.example.test/control',
      HIRE_ENGINE_RUNTIME_URL: 'https://hire.example.test/engine',
    })).toContain('collision:hire-origins')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      HIRE_CONTROL_INTERNAL_URL: 'https://hire.example.test/control',
      HIRE_ENGINE_RUNTIME_URL: 'https://hire.example.test/engine/',
      NEXTAUTH_URL: 'https://hire.example.test/engine',
    })).toContain('collision:hire-origins')
  })

  it('rejects whitespace-normalized service URLs that consumers read raw', () => {
    expect(hireDeploymentConfigurationIssues({
      ...control,
      HIRE_PUBLIC_URL: ` ${control.HIRE_PUBLIC_URL}`,
    })).toContain('invalid:HIRE_PUBLIC_URL')
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      NEXTAUTH_URL: `${runtime.NEXTAUTH_URL} `,
    })).toEqual(expect.arrayContaining([
      'invalid:NEXTAUTH_URL',
      'mismatch:NEXTAUTH_URL',
    ]))
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

  it.each([
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ] as const)('rejects whitespace in the exact runtime storage alias %s', (name) => {
    expect(hireDeploymentConfigurationIssues({
      ...runtime,
      [name]: ` ${runtime[name]} `,
    })).toContain(`mismatch:${name}`)
  })

  it('lists missing production dependencies without exposing values', () => {
    const issues = hireDeploymentConfigurationIssues({ IPG_SURFACE: 'hire-control' })
    expect(issues).toContain('missing:MONGODB_URI')
    expect(issues).toContain('missing:RESEND_API_KEY')
    expect(issues.join(' ')).not.toContain('mongodb://')
  })

})

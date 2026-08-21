/**
 * Contract proof for the only permitted interview-engine seam.
 *
 * The browser crosses from the Hire control plane to a physically isolated
 * runtime using opaque coordinates and a frozen config. The unchanged engine
 * still receives its existing CreateSessionSchema shape, while candidate PII
 * and B2C account identifiers are rejected at the bridge boundary.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateSessionSchema } from '@interview/validators/interview'
import { isDepthAllowedForExperience } from '@interview'
import {
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
  INTERVIEW_ROLE_SLUG_MAX_CHARS,
} from '@shared/interviewContract'
import { STORAGE_KEYS } from '@shared/storageKeys'
import {
  HireEngineConfigSchema,
  HireEngineHandoffEnvelopeSchema,
  HireRuntimeBootstrapResponseSchema,
} from '@shared/contracts/hireEngineBridge'
import { runtimePrincipalEmail } from '../../hire-runtime/services/runtimePrincipalService'
import {
  AI_ROUND_INTERVIEW_TYPE,
  BuildJobDescriptionSchema,
  CreateJobSchema,
  GuestBeginSchema,
  GuestVerifyCodeSchema,
  buildJdSnapshot,
} from '..'

const IDS = {
  workspace: '111111111111111111111111',
  application: '222222222222222222222222',
  round: '333333333333333333333333',
  principal: '444444444444444444444444',
}

const frozenJd = buildJdSnapshot({
  proseJd: 'We are hiring a backend engineer to build production platform APIs.',
  version: 3,
  contentHash: 'ab'.repeat(32),
  requirements: [
    { id: 'must-1', text: 'Production TypeScript', importance: 'must_have' },
  ],
})

const engineConfig = {
  role: 'Backend Engineer',
  interviewType: AI_ROUND_INTERVIEW_TYPE,
  experience: '3-6' as const,
  duration: 15,
  jobDescription: frozenJd,
  targetCompany: 'Acme Inc.',
}

const accepted = {
  recording: true,
  identityPhoto: true,
  attentionMonitoring: true,
  aiEvaluation: true,
} as const

describe('unchanged engine provisioning contract', () => {
  it('accepts exactly the canonical config emitted by the Hire bridge', () => {
    const bridgeConfig = HireEngineConfigSchema.parse(engineConfig)
    const engineRequest = CreateSessionSchema.parse({ config: bridgeConfig })
    expect(engineRequest.config).toMatchObject(engineConfig)
  })

  it('keeps title, duration, experience, and JD within both authorities', () => {
    for (const duration of [15, 30]) {
      expect(() =>
        HireEngineConfigSchema.parse({ ...engineConfig, duration }),
      ).not.toThrow()
      expect(() =>
        CreateSessionSchema.parse({ config: { ...engineConfig, duration } }),
      ).not.toThrow()
    }
    for (const experience of ['0-2', '3-6', '7+'] as const) {
      expect(isDepthAllowedForExperience(AI_ROUND_INTERVIEW_TYPE, experience)).toBe(true)
    }
    expect(frozenJd.length).toBeLessThanOrEqual(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS)
    expect(engineConfig.role.length).toBeLessThanOrEqual(INTERVIEW_ROLE_SLUG_MAX_CHARS)
  })

  it('creates the prose and structured source before a job can become authoritative', () => {
    const builderInput = {
      title: 'Backend Engineer',
      level: 'manager',
      targetExperienceRange: { minYears: 3, maxYears: 8 },
      responsibilities: ['Own reliable backend delivery'],
      mustHaves: ['Production TypeScript'],
      niceToHaves: ['Distributed systems'],
      location: 'Bengaluru, India',
      workMode: 'hybrid' as const,
    }
    expect(BuildJobDescriptionSchema.parse(builderInput)).toEqual(builderInput)
    expect(() =>
      CreateJobSchema.parse({
        ...builderInput,
        jdText: 'Too short',
      }),
    ).toThrow()
  })
})

describe('identity-free bridge contract', () => {
  const envelope = {
    schemaVersion: 2 as const,
    workspaceId: IDS.workspace,
    applicationId: IDS.application,
    roundId: IDS.round,
    handoffGeneration: 1,
    nonce: 'cd'.repeat(32),
    issuedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:01:00.000Z',
    inviteExpiresAt: '2026-08-17T00:00:00.000Z',
    consentVersion: 'hire-ai-v1-2026-08-10',
    consentAt: '2026-08-10T00:00:00.000Z',
    config: engineConfig,
  }

  it('strictly rejects candidate email, name, and B2C user identifiers', () => {
    expect(() =>
      HireEngineHandoffEnvelopeSchema.parse({
        ...envelope,
        candidateEmail: 'same-as-b2c@example.com',
      }),
    ).toThrow()
    expect(() =>
      HireRuntimeBootstrapResponseSchema.parse({
        principalId: IDS.principal,
        roundId: IDS.round,
        config: engineConfig,
        userId: IDS.principal,
      }),
    ).toThrow()
  })

  it('derives one non-routable runtime principal from the round—not the candidate email', () => {
    const principalEmail = runtimePrincipalEmail(IDS.round)
    expect(principalEmail).toBe(`round-${IDS.round}@guests.interviewprep.internal`)
    expect(principalEmail).not.toContain('same-as-b2c@example.com')
  })

  it('keeps runtime storage compatible while clearing/setting it only on the isolated host', () => {
    expect(STORAGE_KEYS.INTERVIEW_CONFIG).toBe('interviewConfig')
    expect(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION).toBe('interviewActiveSession')
    const handoffClient = readFileSync(
      join(process.cwd(), 'app/handoff/handoff-client.tsx'),
      'utf8',
    )
    expect(handoffClient).toContain('HireRuntimeBootstrapResponseSchema')
    expect(handoffClient).toContain("router.replace('/lobby')")
    expect(handoffClient).not.toMatch(/candidate(?:Email|Name)|@shared\/db\/models\/User/)
  })
})

describe('candidate entry contract', () => {
  it('requires all four literal acknowledgements in both auth modes', () => {
    const capability = `${'1'.repeat(24)}.${'ab'.repeat(32)}`
    expect(() =>
      GuestBeginSchema.parse({ capability, accepted }),
    ).not.toThrow()
    expect(() =>
      GuestVerifyCodeSchema.parse({
        capability,
        code: '123456',
        accepted,
      }),
    ).not.toThrow()
    expect(() =>
      GuestBeginSchema.parse({
        capability,
        accepted: { ...accepted, identityPhoto: false },
      }),
    ).toThrow()
    expect(() =>
      GuestVerifyCodeSchema.parse({
        capability,
        code: '12345',
        accepted,
      }),
    ).toThrow()
  })

  it('contains no legacy synthetic-user/ticket/prepare path in the control plane', () => {
    const sourcePaths = [
      'app/api/candidate/[roundId]/begin/route.ts',
      'app/api/candidate/[roundId]/verify/route.ts',
      'app/api/candidate/[roundId]/start/route.ts',
      'app/candidate/[roundId]/CandidateFlow.tsx',
    ]
    for (const sourcePath of sourcePaths) {
      const source = readFileSync(join(process.cwd(), sourcePath), 'utf8')
      expect(source).not.toMatch(/guestEmailForRound|ensureGuestUser|issueAuthTicket|signIn\(/)
      expect(source).not.toMatch(/@shared\/db\/models(?:\/User)?/)
      expect(source).not.toMatch(/\/candidate\/[^'"`]*\/prepare/)
    }
  })
})

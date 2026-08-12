import { describe, expect, it } from 'vitest'
import {
  canonicalBridgeJson,
  HireEngineHandoffEnvelopeSchema,
  HireEngineRevocationSchema,
  HireEngineResultIngestionSchema,
  HireRuntimeBootstrapResponseSchema,
} from '../hireEngineBridge'

const ID_A = 'a'.repeat(24)
const ID_B = 'b'.repeat(24)
const ID_C = 'c'.repeat(24)
const HASH = 'd'.repeat(64)

function envelope() {
  return {
    schemaVersion: 1,
    workspaceId: ID_A,
    applicationId: ID_B,
    roundId: ID_C,
    nonce: HASH,
    issuedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:01:00.000Z',
    inviteExpiresAt: '2026-08-17T00:00:00.000Z',
    consentVersion: 'hire-ai-v1',
    consentAt: '2026-08-09T23:59:00.000Z',
    config: {
      role: 'Backend engineer',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      jobDescription: 'Build reliable APIs.',
      targetCompany: 'Example Co',
    },
  }
}

describe('Hire engine bridge contract', () => {
  it('accepts only opaque coordinates and canonical engine configuration', () => {
    expect(HireEngineHandoffEnvelopeSchema.parse(envelope())).toMatchObject({
      workspaceId: ID_A,
      applicationId: ID_B,
      roundId: ID_C,
    })
  })

  it.each([
    ['candidateEmail', 'candidate@example.com'],
    ['candidateName', 'Candidate Name'],
    ['phone', '+911234567890'],
    ['b2cUserId', ID_A],
  ])('rejects runtime identity field %s', (key, value) => {
    expect(() =>
      HireEngineHandoffEnvelopeSchema.parse({ ...envelope(), [key]: value }),
    ).toThrow()
  })

  it('accepts only explicit ISO-8601 timestamps on the signed wire', () => {
    expect(() =>
      HireEngineHandoffEnvelopeSchema.parse({
        ...envelope(),
        issuedAt: 'August 10, 2026 12:00:00',
      }),
    ).toThrow()
  })

  it('rejects unkeyed result ingestion', () => {
    const payload = {
      schemaVersion: 1,
      eventId: HASH,
      workspaceId: ID_A,
      applicationId: ID_B,
      roundId: ID_C,
      runtimeSessionId: ID_A,
      attempt: 1,
      revision: 1,
      status: 'completed',
      startedAt: '2026-08-09T23:55:00.000Z',
      completedAt: '2026-08-10T00:00:00.000Z',
      durationMs: 300_000,
      resultDigest: HASH,
      results: { overallScore: 80 },
      transcript: [],
      media: [],
    }
    expect(HireEngineResultIngestionSchema.parse(payload).roundId).toBe(ID_C)
    const { workspaceId: _workspaceId, ...withoutWorkspace } = payload
    expect(() => HireEngineResultIngestionSchema.parse(withoutWorkspace)).toThrow()
  })

  it('canonicalizes object keys recursively while preserving array order', () => {
    const left = { z: [{ b: 2, a: 1 }], a: true }
    const right = { a: true, z: [{ a: 1, b: 2 }] }
    expect(canonicalBridgeJson(left)).toBe(canonicalBridgeJson(right))
  })

  it('defaults ordinary revocation to retention and accepts an explicit privacy purge', () => {
    const revocation = {
      schemaVersion: 1,
      workspaceId: ID_A,
      applicationId: ID_B,
      roundId: ID_C,
      revokedAt: '2026-08-10T00:00:00.000Z',
      reason: 'Candidate request',
    }
    expect(HireEngineRevocationSchema.parse(revocation).purgePersonalData).toBe(false)
    expect(
      HireEngineRevocationSchema.parse({
        ...revocation,
        purgePersonalData: true,
      }).purgePersonalData,
    ).toBe(true)
  })

  it('keeps bootstrap identity pseudonymous and rejects engine-invalid durations', () => {
    const bootstrap = {
      principalId: ID_A,
      roundId: ID_C,
      config: envelope().config,
    }
    expect(HireRuntimeBootstrapResponseSchema.parse(bootstrap)).toEqual(bootstrap)
    expect(() =>
      HireRuntimeBootstrapResponseSchema.parse({
        ...bootstrap,
        candidateEmail: 'candidate@example.com',
      }),
    ).toThrow()
    expect(() =>
      HireRuntimeBootstrapResponseSchema.parse({
        ...bootstrap,
        config: { ...bootstrap.config, duration: 60 },
      }),
    ).toThrow()
  })
})

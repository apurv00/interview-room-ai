import { describe, expect, it } from 'vitest'
import {
  HIRE_RUNTIME_EXACT_WRITE_TARGETS,
  resolveHireRuntimeWriteTarget,
} from '@shared/contracts/hireRuntimeWriteFence'
import {
  assertRuntimeWriteTargetBound,
  type RuntimeWriteTargetBinding,
} from '../services/runtimeWriteTargetGuard'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
} from '@hire-multimodal-boundary'

const ids = {
  workspaceA: '1'.repeat(24),
  workspaceB: '2'.repeat(24),
  applicationA: '3'.repeat(24),
  applicationB: '4'.repeat(24),
  roundA: '5'.repeat(24),
  roundB: '6'.repeat(24),
  principalA: '7'.repeat(24),
  principalB: '8'.repeat(24),
  sessionA: '9'.repeat(24),
  sessionB: 'a'.repeat(24),
  bindingA: 'b'.repeat(24),
  bindingB: 'c'.repeat(24),
}

const keyA = `recordings/${ids.principalA}/${ids.sessionA}-1723248000000.webm`
const screenKeyA = `recordings/${ids.principalA}/${ids.sessionA}-screen-1723248000000.webm`
const keyB = `recordings/${ids.principalB}/${ids.sessionB}-1723248000000.webm`
const now = new Date('2026-08-10T00:00:00.000Z')
const expiresAt = new Date('2026-08-10T01:00:00.000Z')

function binding(
  tenant: 'A' | 'B',
  overrides: Partial<RuntimeWriteTargetBinding> = {},
): RuntimeWriteTargetBinding {
  const suffix = tenant === 'A' ? 'A' : 'B'
  const principalId = ids[`principal${suffix}`]
  const runtimeSessionId = ids[`session${suffix}`]
  const key = tenant === 'A' ? keyA : keyB
  return {
    bindingId: ids[`binding${suffix}`],
    status: 'active',
    consentVersion: HIRE_AI_CONSENT_VERSION,
    workspaceId: ids[`workspace${suffix}`],
    applicationId: ids[`application${suffix}`],
    roundId: ids[`round${suffix}`],
    principalId,
    runtimeSessionId,
    issuedObjectCapabilities: [{ key, runtimeSessionId, expiresAt }],
    issuedMultipartCapabilities: [{
      key,
      runtimeSessionId,
      uploadId: `upload-${tenant}`,
      expiresAt,
    }],
    ...overrides,
  }
}

function assertBound(input: {
  pathname: string
  body?: Record<string, unknown>
  binding?: RuntimeWriteTargetBinding
  method?: string
}): void {
  const body = input.body
  assertRuntimeWriteTargetBound({
    pathname: input.pathname,
    method: input.method ?? 'POST',
    bodyPresent: body !== undefined,
    requestBody: body ?? null,
    binding: input.binding ?? binding('A'),
    now,
  })
}

describe('Hire runtime write target inventory', () => {
  it('has one exact entry per pathname and admits only methods implemented upstream', () => {
    const paths = HIRE_RUNTIME_EXACT_WRITE_TARGETS.map((target) => target.pathname)
    expect(new Set(paths).size).toBe(paths.length)
    expect(resolveHireRuntimeWriteTarget('/api/storage/multipart', 'PUT')).toBeNull()
    expect(resolveHireRuntimeWriteTarget(`/api/interviews/${ids.sessionA}`, 'POST')).toBeNull()
    expect(resolveHireRuntimeWriteTarget(`/api/interviews/${ids.sessionA}`, 'PATCH')).toMatchObject({
      coordinates: 'path-session',
      pathSessionId: ids.sessionA,
    })
    expect(resolveHireRuntimeWriteTarget('/api/account', 'POST')).toBeNull()
  })

  it('documents and requires sessionId on every session-reading route shape', () => {
    const sessionTargets = HIRE_RUNTIME_EXACT_WRITE_TARGETS.filter(
      (target) => target.coordinates === 'required-session',
    )
    expect(sessionTargets.map((target) => target.pathname)).toEqual([
      '/api/generate-question',
      '/api/evaluate-answer',
      '/api/evaluate-code',
      '/api/evaluate-design',
      '/api/generate-feedback',
      '/api/interview/answer-candidate-question',
      '/api/interview/clarify-case-context',
      '/api/interview/clarify-coding',
      '/api/hire-engine/multimodal-observations/capture',
      '/api/hire-engine/multimodal-analysis/capture',
    ])
    for (const target of sessionTargets) {
      expect(target.guardedCoordinates).toContain('sessionId')
      expect(() => assertBound({ pathname: target.pathname, body: {} })).toThrow(/session/)
    }
  })

  it('requires an attached active runtime session even for coordinate-free writes', () => {
    expect(() => assertBound({
      pathname: '/api/tts',
      body: { text: 'hello' },
      binding: binding('A', { status: 'provisioned' }),
    })).toThrow(/active session/)
    expect(() => assertBound({
      pathname: '/api/tts',
      body: { text: 'hello' },
      binding: binding('A', { runtimeSessionId: undefined }),
    })).toThrow(/active session/)
  })
})

describe('Hire runtime two-tenant coordinate guard', () => {
  it.each([
    '/api/interview/clarify-case-context',
    '/api/interview/clarify-coding',
  ])('accepts tenant A clarification and rejects tenant B session on %s', (pathname) => {
    expect(() => assertBound({ pathname, body: { sessionId: ids.sessionA } })).not.toThrow()
    expect(() => assertBound({ pathname, body: { sessionId: ids.sessionB } })).toThrow(/crossed/)
    expect(() => assertBound({
      pathname,
      body: { sessionId: ids.sessionB },
      binding: binding('B'),
    })).not.toThrow()
  })

  it('binds generate-feedback to the one runtime session', () => {
    expect(() => assertBound({
      pathname: '/api/generate-feedback',
      body: { sessionId: ids.sessionA },
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/generate-feedback',
      body: { sessionId: ids.sessionB },
    })).toThrow(/crossed/)
  })

  it('rejects foreign IDs hidden in otherwise accepted nested config', () => {
    expect(() => assertBound({
      pathname: '/api/generate-question',
      body: {
        sessionId: ids.sessionA,
        config: { organizationId: ids.workspaceB },
      },
    })).toThrow(/crossed/)
    expect(() => assertBound({
      pathname: '/api/generate-question',
      body: {
        sessionId: ids.sessionA,
        config: { attribution: { source: 'jobs', jobId: ids.applicationB } },
      },
    })).toThrow(/unsupported/)
  })

  it.each([
    'session_id',
    'interviewSessionId',
    'interview_session_id',
    'runtime_session_id',
  ])('fails closed on a foreign session alias %s even when upstream would strip it', (alias) => {
    expect(() => assertBound({
      pathname: '/api/generate-question',
      body: { sessionId: ids.sessionA, [alias]: ids.sessionB },
    })).toThrow(/crossed/)
  })

  it('binds dynamic interview paths and legacy recording coordinates', () => {
    expect(() => assertBound({
      pathname: `/api/interviews/${ids.sessionA}`,
      method: 'PATCH',
      body: { status: 'in_progress' },
    })).not.toThrow()
    expect(() => assertBound({
      pathname: `/api/interviews/${ids.sessionB}`,
      method: 'PATCH',
      body: { status: 'in_progress' },
    })).toThrow(/path crossed/)
    expect(() => assertBound({
      pathname: `/api/interviews/${ids.sessionA}`,
      method: 'PATCH',
      body: { recordingR2Key: keyB, recordingSizeBytes: 10 },
    })).toThrow(/recording key crossed/)
  })

  it('binds direct recording finalization to principal, session, and issued object', () => {
    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'recording',
        sessionId: ids.sessionA,
        key: keyA,
        sizeBytes: 10,
      },
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'recording',
        sessionId: ids.sessionB,
        key: keyB,
        sizeBytes: 10,
      },
    })).toThrow(/crossed/)
    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'screen-recording',
        sessionId: ids.sessionA,
        key: keyA,
        sizeBytes: 10,
      },
    })).toThrow(/crossed/)
  })

  it('binds presign and multipart storage shapes before an engine or R2 call', () => {
    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: { action: 'upload', type: 'recording', sessionId: ids.sessionA },
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: { action: 'upload', type: 'recording', sessionId: ids.sessionB },
    })).toThrow(/crossed/)
    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: { action: 'download', key: keyB },
    })).toThrow(/recording key crossed/)

    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'sign-part',
        type: 'recording',
        sessionId: ids.sessionA,
        key: keyA,
        uploadId: 'upload-A',
        partNumber: 1,
      },
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'sign-part',
        type: 'recording',
        sessionId: ids.sessionA,
        key: keyB,
        uploadId: 'upload-B',
        partNumber: 1,
      },
    })).toThrow(/recording key crossed/)
    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'sign-part',
        type: 'recording',
        sessionId: ids.sessionA,
        key: keyA,
        uploadId: 'upload-B',
        partNumber: 1,
      },
    })).toThrow(/not issued/)
  })

  it('does not accept a recording kind that disagrees with the key shape', () => {
    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'screen-recording',
        sessionId: ids.sessionA,
        key: screenKeyA,
        sizeBytes: 10,
      },
      binding: binding('A', {
        issuedObjectCapabilities: [{
          key: screenKeyA,
          runtimeSessionId: ids.sessionA,
          expiresAt,
        }],
      }),
    })).not.toThrow()
  })

  it('admits display recording only for the exact V6 consent version', () => {
    const v5Binding = binding('A', {
      consentVersion: HIRE_AI_V5_CONSENT_VERSION,
      issuedObjectCapabilities: [{
        key: screenKeyA,
        runtimeSessionId: ids.sessionA,
        expiresAt,
      }],
      issuedMultipartCapabilities: [{
        key: screenKeyA,
        runtimeSessionId: ids.sessionA,
        uploadId: 'screen-upload-A',
        expiresAt,
      }],
    })

    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: {
        action: 'upload',
        type: 'screen-recording',
        sessionId: ids.sessionA,
      },
      binding: v5Binding,
    })).toThrow(/not consented/)
    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'create',
        type: 'screen-recording',
        sessionId: ids.sessionA,
      },
      binding: v5Binding,
    })).toThrow(/not consented/)
    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'sign-part',
        type: 'screen-recording',
        sessionId: ids.sessionA,
        key: screenKeyA,
        uploadId: 'screen-upload-A',
        partNumber: 1,
      },
      binding: v5Binding,
    })).toThrow(/not consented/)
    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'complete',
        type: 'screen-recording',
        sessionId: ids.sessionA,
        key: screenKeyA,
        uploadId: 'screen-upload-A',
        parts: [{ ETag: 'etag', PartNumber: 1 }],
      },
      binding: v5Binding,
    })).toThrow(/not consented/)
    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'screen-recording',
        sessionId: ids.sessionA,
        key: screenKeyA,
        sizeBytes: 10,
      },
      binding: v5Binding,
    })).toThrow(/not consented/)
    expect(() => assertBound({
      pathname: `/api/interviews/${ids.sessionA}`,
      method: 'PATCH',
      body: { screenRecordingR2Key: screenKeyA, screenRecordingSizeBytes: 10 },
      binding: v5Binding,
    })).toThrow(/not consented/)

    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'abort',
        type: 'screen-recording',
        key: screenKeyA,
        uploadId: 'screen-upload-A',
      },
      binding: v5Binding,
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: { action: 'upload', type: 'recording', sessionId: ids.sessionA },
      binding: v5Binding,
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: {
        action: 'upload',
        type: 'audio-recording',
        sessionId: ids.sessionA,
      },
      binding: v5Binding,
    })).not.toThrow()
  })

  it('keeps only the pending replay uploads writable after result publication', () => {
    const postResultBinding = binding('A', {
      status: 'completed',
      publishedRevision: 1,
      cameraMediaStatus: 'pending',
      screenMediaStatus: 'pending',
      issuedObjectCapabilities: [
        { key: keyA, runtimeSessionId: ids.sessionA, expiresAt },
        { key: screenKeyA, runtimeSessionId: ids.sessionA, expiresAt },
      ],
      issuedMultipartCapabilities: [{
        key: screenKeyA,
        runtimeSessionId: ids.sessionA,
        uploadId: 'screen-upload-A',
        expiresAt,
      }],
    })

    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: { action: 'upload', type: 'recording', sessionId: ids.sessionA },
      binding: postResultBinding,
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/storage/multipart',
      body: {
        action: 'sign-part',
        type: 'screen-recording',
        sessionId: ids.sessionA,
        key: screenKeyA,
        uploadId: 'screen-upload-A',
        partNumber: 1,
      },
      binding: postResultBinding,
    })).not.toThrow()
    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'recording',
        sessionId: ids.sessionA,
        key: keyA,
        sizeBytes: 10,
      },
      binding: postResultBinding,
    })).not.toThrow()
    expect(() => assertBound({
      pathname: `/api/interviews/${ids.sessionA}`,
      method: 'PATCH',
      body: { screenRecordingR2Key: screenKeyA, screenRecordingSizeBytes: 10 },
      binding: postResultBinding,
    })).toThrow(/closed/)

    for (const [pathname, body] of [
      ['/api/generate-question', { sessionId: ids.sessionA }],
      ['/api/tts', { text: 'late prompt' }],
      [
        '/api/storage/presign',
        { action: 'upload', type: 'audio-recording', sessionId: ids.sessionA },
      ],
      [
        '/api/storage/presign',
        { action: 'download', key: keyA },
      ],
    ] as const) {
      expect(() => assertBound({
        pathname,
        method: pathname.startsWith('/api/interviews/') ? 'PATCH' : 'POST',
        body,
        binding: postResultBinding,
      })).toThrow(/closed|not a replay/)
    }

    expect(() => assertBound({
      pathname: '/api/recordings/finalize',
      body: {
        type: 'recording',
        sessionId: ids.sessionA,
        key: keyA,
        sizeBytes: 10,
      },
      binding: binding('A', {
        status: 'completed',
        publishedRevision: 2,
        cameraMediaStatus: 'published',
      }),
    })).toThrow(/no longer pending/)

    expect(() => assertBound({
      pathname: '/api/storage/presign',
      body: { action: 'upload', type: 'recording', sessionId: ids.sessionA },
      binding: binding('A', {
        status: 'completed',
        publishedRevision: 10,
        cameraMediaStatus: 'pending',
      }),
    })).toThrow(/active session/)
  })
})

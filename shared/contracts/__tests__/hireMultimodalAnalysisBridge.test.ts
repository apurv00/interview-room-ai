import { describe, expect, it } from 'vitest'
import {
  HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
  HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES,
  HireMultimodalAnalysisCaptureSchema,
  HireMultimodalAnalysisIngestionSchema,
  canonicalHireMultimodalAnalysisJson,
  fitHireMultimodalAnalysisCaptureToBodyLimit,
  hireMultimodalAnalysisCaptureBodyBytes,
  hireMultimodalAnalysisDigestPayload,
} from '../hireMultimodalAnalysisBridge'
import { HIRE_RUNTIME_MAX_FENCED_BODY_BYTES } from '../hireRuntimeWriteFence'

const ids = {
  workspaceId: 'a'.repeat(24),
  applicationId: 'b'.repeat(24),
  roundId: 'c'.repeat(24),
  runtimeSessionId: 'd'.repeat(24),
}

function frame() {
  return {
    ts: 1.2,
    gazeX: 0,
    gazeY: 0,
    headPoseYaw: 2,
    headPosePitch: -1,
    expression: 'focused' as const,
    eyeContactScore: 0.92,
    blendshapes: { browDownLeft: 0.2 },
  }
}

function payload() {
  return {
    schemaVersion: 1,
    eventId: 'e'.repeat(64),
    ...ids,
    attempt: 1,
    revision: 1,
    consentVersion: 'hire-ai-v4-2026-08-17',
    policyVersion: HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
    capturedAt: '2026-08-17T12:00:00.000Z',
    durationMs: 5_000,
    landmarks: {
      kind: 'landmarks' as const,
      sourceKey: `landmarks/${'1'.repeat(24)}/${ids.runtimeSessionId}-${'2'.repeat(32)}.json`,
      contentType: 'application/json' as const,
      sizeBytes: 512,
      sha256: 'f'.repeat(64),
    },
    transcript: [{
      speaker: 'candidate' as const,
      text: 'I improved the release process.',
      timestampMs: 1_200,
      questionIndex: 0,
    }],
    liveTranscriptWords: [],
  }
}

describe('Hire multimodal analysis bridge contract', () => {
  it('accepts a separate artifact-addressed full-analysis ingestion payload', () => {
    expect(HireMultimodalAnalysisIngestionSchema.parse(payload())).toMatchObject({
      policyVersion: HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
      landmarks: { kind: 'landmarks', contentType: 'application/json' },
    })
  })

  it('sanitizes a bounded browser frame stream but rejects invalid artifact metadata', () => {
    const parsed = HireMultimodalAnalysisCaptureSchema.parse({
      sessionId: ids.runtimeSessionId,
      frames: [{ ...frame(), gazeX: 9 }, { ...frame(), eyeContactScore: Number.NaN }],
    })
    expect(parsed.frames).toEqual([{ ...frame(), gazeX: 1 }])
    expect(() => HireMultimodalAnalysisIngestionSchema.parse({
      ...payload(),
      landmarks: { ...payload().landmarks, contentType: 'video/webm' },
    })).toThrow()
  })

  it('makes event content idempotent over only immutable analysis inputs', () => {
    const parsed = HireMultimodalAnalysisIngestionSchema.parse(payload())
    expect(canonicalHireMultimodalAnalysisJson(
      hireMultimodalAnalysisDigestPayload(parsed),
    )).toContain('"landmarks"')
    expect(canonicalHireMultimodalAnalysisJson(
      hireMultimodalAnalysisDigestPayload(parsed),
    )).not.toContain('workspaceId')
  })

  it('uses the exact runtime fence limit and safely samples an oversized client payload', () => {
    expect(HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES).toBe(
      HIRE_RUNTIME_MAX_FENCED_BODY_BYTES,
    )
    const capture = HireMultimodalAnalysisCaptureSchema.parse({
      sessionId: ids.runtimeSessionId,
      frames: Array.from({ length: 100 }, (_unused, index) => ({
        ...frame(),
        ts: index,
        blendshapes: {
          veryLongBlendshapeDimensionNameForSizing: 0.123,
          browDownLeft: 0.2,
        },
      })),
    })
    const bounded = fitHireMultimodalAnalysisCaptureToBodyLimit(capture, 1_000)
    expect(bounded.frames.length).toBeLessThan(capture.frames.length)
    expect(hireMultimodalAnalysisCaptureBodyBytes(bounded)).toBeLessThanOrEqual(1_000)
    expect(bounded.frames[0]).toEqual(capture.frames[0])
  })
})

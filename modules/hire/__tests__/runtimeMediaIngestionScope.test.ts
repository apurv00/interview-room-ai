import { describe, expect, it } from 'vitest'
import { __hireRuntimeMultimodalAnalysisCapture } from '../../hire-runtime/services/multimodalAnalysisCaptureService'
import { __runtimeMediaIngestion } from '../services/runtimeMediaIngestionService'

const ROUND_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)

describe('runtime landmark source-key scope', () => {
  it('accepts the exact runtime screen-recording key for the round/session', () => {
    const principalId = __runtimeMediaIngestion.runtimePrincipalId(ROUND_ID)

    expect(() =>
      __runtimeMediaIngestion.assertRuntimeArtifactScope({
        artifact: {
          kind: 'screen',
          sourceKey: `recordings/${principalId}/${SESSION_ID}-screen-1723248000000.webm`,
          contentType: 'video/webm',
          sizeBytes: 123,
          sha256: 'd'.repeat(64),
        },
        roundId: ROUND_ID,
        runtimeSessionId: SESSION_ID,
      }),
    ).not.toThrow()
  })

  it('accepts only the exact hashed-principal/session prefix with a bounded nonce suffix', () => {
    const principalId = __runtimeMediaIngestion.runtimePrincipalId(ROUND_ID)
    const sourceKey = `landmarks/${principalId}/${SESSION_ID}-${'c'.repeat(32)}.json`

    expect(() => __runtimeMediaIngestion.assertRuntimeArtifactScope({
      artifact: {
        kind: 'landmarks',
        sourceKey,
        contentType: 'application/json',
        sizeBytes: 123,
        sha256: 'd'.repeat(64),
      },
      roundId: ROUND_ID,
      runtimeSessionId: SESSION_ID,
    })).not.toThrow()
  })

  it('accepts the opaque v2 key minted by capture and carried through the publisher artifact', () => {
    const principalId = __runtimeMediaIngestion.runtimePrincipalId(ROUND_ID)
    const objectKeyNonce = 'c'.repeat(64)
    const sourceKey =
      __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
        principalId,
        SESSION_ID,
        objectKeyNonce,
      )

    expect(() => __runtimeMediaIngestion.assertRuntimeArtifactScope({
      artifact: {
        kind: 'landmarks',
        sourceKey,
        objectKeyNonce,
        contentType: 'application/json',
        sizeBytes: 123,
        sha256: 'd'.repeat(64),
      },
      roundId: ROUND_ID,
      runtimeSessionId: SESSION_ID,
    })).not.toThrow()
  })

  it('rejects an opaque v2 digest bound to another runtime session', () => {
    const principalId = __runtimeMediaIngestion.runtimePrincipalId(ROUND_ID)
    const objectKeyNonce = 'c'.repeat(64)
    const sourceKey =
      __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
        principalId,
        'e'.repeat(24),
        objectKeyNonce,
      )

    expect(() => __runtimeMediaIngestion.assertRuntimeArtifactScope({
      artifact: {
        kind: 'landmarks',
        sourceKey,
        objectKeyNonce,
        contentType: 'application/json',
        sizeBytes: 123,
        sha256: 'd'.repeat(64),
      },
      roundId: ROUND_ID,
      runtimeSessionId: SESSION_ID,
    })).toThrow('Runtime media artifact crossed its round/session boundary')
  })

  it('rejects a v2 landmark if its temporary object-key nonce is missing or crossed', () => {
    const principalId = __runtimeMediaIngestion.runtimePrincipalId(ROUND_ID)
    const sourceKey = __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
      principalId,
      SESSION_ID,
      'c'.repeat(64),
    )
    const base = {
      kind: 'landmarks' as const,
      sourceKey,
      contentType: 'application/json' as const,
      sizeBytes: 123,
      sha256: 'd'.repeat(64),
    }

    for (const objectKeyNonce of [undefined, 'e'.repeat(64)]) {
      expect(() => __runtimeMediaIngestion.assertRuntimeArtifactScope({
        artifact: { ...base, objectKeyNonce },
        roundId: ROUND_ID,
        runtimeSessionId: SESSION_ID,
      })).toThrow('Runtime media artifact crossed its round/session boundary')
    }
  })

  it('rejects legacy/unbounded landmark keys even when their principal/session prefix matches', () => {
    const principalId = __runtimeMediaIngestion.runtimePrincipalId(ROUND_ID)

    expect(() => __runtimeMediaIngestion.assertRuntimeArtifactScope({
      artifact: {
        kind: 'landmarks',
        sourceKey: `landmarks/${principalId}/${SESSION_ID}.json`,
        contentType: 'application/json',
        sizeBytes: 123,
        sha256: 'd'.repeat(64),
      },
      roundId: ROUND_ID,
      runtimeSessionId: SESSION_ID,
    })).toThrow('Runtime media artifact crossed its round/session boundary')
  })
})

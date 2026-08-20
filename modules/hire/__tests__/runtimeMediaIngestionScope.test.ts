import { describe, expect, it } from 'vitest'
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

import { describe, expect, it } from 'vitest'
import {
  __runtimeMediaManifest,
  buildRuntimeMediaManifest,
} from '../services/runtimeMediaManifest'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)

describe('runtime media manifest boundary', () => {
  it('skips absent and zero-byte optional engine media without touching R2', async () => {
    await expect(
      buildRuntimeMediaManifest({
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
        recordingR2Key: null,
        recordingSizeBytes: null,
        audioRecordingR2Key: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000000.webm`,
        audioRecordingSizeBytes: 0,
      }),
    ).resolves.toEqual([])
  })

  it('accepts only a canonical key owned by the exact runtime principal/session', () => {
    expect(() =>
      __runtimeMediaManifest.assertRuntimeRecordingKey({
        key: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`,
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
      }),
    ).not.toThrow()
  })

  it.each([
    `recordings/${'c'.repeat(24)}/${SESSION_ID}-1723248000000.webm`,
    `recordings/${PRINCIPAL_ID}/${'d'.repeat(24)}-1723248000000.webm`,
    `recordings/${PRINCIPAL_ID}/../${SESSION_ID}-1723248000000.webm`,
    `uploads/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`,
  ])('rejects an out-of-scope or non-canonical source key: %s', (key) => {
    expect(() =>
      __runtimeMediaManifest.assertRuntimeRecordingKey({
        key,
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
      }),
    ).toThrow(/canonical|crossed its principal\/session boundary/)
  })
})

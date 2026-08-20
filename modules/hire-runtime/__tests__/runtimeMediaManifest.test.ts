import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return { Command, send: vi.fn() }
})

vi.mock('@aws-sdk/client-s3', () => ({
  AbortMultipartUploadCommand: mocks.Command,
  DeleteObjectCommand: mocks.Command,
  GetObjectCommand: mocks.Command,
  S3Client: class {
    send = mocks.send
  },
}))
import {
  __runtimeMediaManifest,
  buildRuntimeMediaManifest,
} from '../services/runtimeMediaManifest'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('R2_ACCOUNT_ID', 'runtime-account')
  vi.stubEnv('R2_ACCESS_KEY_ID', 'runtime-key')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'runtime-secret')
  vi.stubEnv('R2_BUCKET_NAME', 'runtime-bucket')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('hashes the finalized screen recording into the checksum manifest', async () => {
    const body = Buffer.from('shared display recording')
    const screenKey =
      `recordings/${PRINCIPAL_ID}/${SESSION_ID}-screen-1723248000000.webm`
    mocks.send.mockResolvedValueOnce({ Body: Readable.from([body]) })

    await expect(
      buildRuntimeMediaManifest({
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
        screenRecordingR2Key: screenKey,
        screenRecordingSizeBytes: body.byteLength,
      }),
    ).resolves.toEqual([
      {
        kind: 'screen',
        sourceKey: screenKey,
        contentType: 'video/webm',
        sizeBytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    ])
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

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    AbortMultipartUploadCommand: Command,
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
    S3Client: class {
      send = mocks.send
    },
  }
})

import {
  abortRuntimeMultipartUploads,
  deleteRuntimeMediaManifest,
  deleteRuntimePersonalObjects,
} from '../services/runtimeMediaManifest'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)
const CAMERA_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`
const SCREEN_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-screen-1723248000002.webm`
const AUDIO_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000001.webm`

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('R2_ACCOUNT_ID', 'runtime-account')
  vi.stubEnv('R2_ACCESS_KEY_ID', 'runtime-key')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'runtime-secret')
  vi.stubEnv('R2_BUCKET_NAME', 'runtime-bucket')
  mocks.send.mockResolvedValue({})
})

describe('runtime source-media cleanup', () => {
  it('deletes only checksum-manifested objects from the exact session namespace', async () => {
    await deleteRuntimeMediaManifest({
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      media: [
        {
          kind: 'recording',
          sourceKey: CAMERA_KEY,
          contentType: 'video/webm',
          sizeBytes: 100,
          sha256: 'c'.repeat(64),
        },
        {
          kind: 'screen',
          sourceKey: SCREEN_KEY,
          contentType: 'video/webm',
          sizeBytes: 80,
          sha256: 'e'.repeat(64),
        },
        {
          kind: 'audio',
          sourceKey: AUDIO_KEY,
          contentType: 'audio/webm',
          sizeBytes: 20,
          sha256: 'd'.repeat(64),
        },
      ],
    })

    expect(mocks.send).toHaveBeenCalledTimes(3)
    expect(mocks.send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: 'runtime-bucket', Key: CAMERA_KEY },
      { Bucket: 'runtime-bucket', Key: SCREEN_KEY },
      { Bucket: 'runtime-bucket', Key: AUDIO_KEY },
    ])
  })

  it('propagates a deletion failure so publication remains retryable', async () => {
    mocks.send.mockRejectedValueOnce(new Error('R2 unavailable'))
    await expect(
      deleteRuntimeMediaManifest({
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
        media: [
          {
            kind: 'recording',
            sourceKey: CAMERA_KEY,
            contentType: 'video/webm',
            sizeBytes: 100,
            sha256: 'c'.repeat(64),
          },
        ],
      }),
    ).rejects.toThrow('R2 unavailable')
  })

  it('fails closed before deletion for foreign or non-session-scoped keys', async () => {
    await expect(
      deleteRuntimeMediaManifest({
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
        media: [
          {
            kind: 'recording',
            sourceKey: `recordings/${'e'.repeat(24)}/${SESSION_ID}-1723248000000.webm`,
            contentType: 'video/webm',
            sizeBytes: 100,
            sha256: 'c'.repeat(64),
          },
        ],
      }),
    ).rejects.toThrow(/canonical|boundary/)
    expect(mocks.send).not.toHaveBeenCalled()

    await expect(
      deleteRuntimeMediaManifest({
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
        media: [
          {
            kind: 'recording',
            sourceKey: `recordings/${PRINCIPAL_ID}/${SESSION_ID}ff-1723248000000.webm`,
            contentType: 'video/webm',
            sizeBytes: 100,
            sha256: 'c'.repeat(64),
          },
        ],
      }),
    ).rejects.toThrow(/canonical|boundary/)

    await expect(
      deleteRuntimePersonalObjects({
        principalId: PRINCIPAL_ID,
        objects: [{
          key: `exports/${PRINCIPAL_ID}/${SESSION_ID}.json`,
          runtimeSessionId: SESSION_ID,
        }],
      }),
    ).rejects.toThrow(/canonical|boundary/)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('purges recording, landmarks, and owner-scoped documents idempotently', async () => {
    const landmarks = `landmarks/${PRINCIPAL_ID}/${SESSION_ID}.json`
    const resume = `documents/${PRINCIPAL_ID}/resume/1723248000000-resume.pdf`
    await deleteRuntimePersonalObjects({
      principalId: PRINCIPAL_ID,
      objects: [
        { key: CAMERA_KEY, runtimeSessionId: SESSION_ID },
        { key: landmarks, runtimeSessionId: SESSION_ID },
        { key: resume },
        { key: CAMERA_KEY, runtimeSessionId: SESSION_ID },
      ],
    })
    expect(mocks.send.mock.calls.map(([command]) => command.input.Key)).toEqual([
      CAMERA_KEY,
      landmarks,
      resume,
    ])
  })

  it('purges a nonce-scoped full-analysis landmark artifact without widening session authority', async () => {
    const landmarks = `landmarks/${PRINCIPAL_ID}/${SESSION_ID}-${'a'.repeat(32)}.json`
    await deleteRuntimePersonalObjects({
      principalId: PRINCIPAL_ID,
      objects: [{ key: landmarks, runtimeSessionId: SESSION_ID }],
    })
    expect(mocks.send.mock.calls.map(([command]) => command.input.Key)).toEqual([landmarks])
  })

  it('aborts inventoried multipart uploads and treats an expired upload as absent', async () => {
    await abortRuntimeMultipartUploads({
      principalId: PRINCIPAL_ID,
      uploads: [{
        key: CAMERA_KEY,
        runtimeSessionId: SESSION_ID,
        uploadId: 'upload-1',
      }],
    })
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      Bucket: 'runtime-bucket',
      Key: CAMERA_KEY,
      UploadId: 'upload-1',
    })

    mocks.send.mockRejectedValueOnce({ name: 'NoSuchUpload' })
    await expect(
      abortRuntimeMultipartUploads({
        principalId: PRINCIPAL_ID,
        uploads: [{
          key: CAMERA_KEY,
          runtimeSessionId: SESSION_ID,
          uploadId: 'upload-1',
        }],
      }),
    ).resolves.toBeUndefined()
  })
})

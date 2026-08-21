import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class AbortMultipartUploadCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class PutObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    send: vi.fn(),
    AbortMultipartUploadCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
  }
})

vi.mock('@aws-sdk/client-s3', () => ({
    AbortMultipartUploadCommand: mocks.AbortMultipartUploadCommand,
    DeleteObjectCommand: mocks.DeleteObjectCommand,
    GetObjectCommand: mocks.GetObjectCommand,
    PutObjectCommand: mocks.PutObjectCommand,
    S3Client: class {
      send = mocks.send
    },
}))

import {
  abortRuntimeMultipartUploads,
  deleteRuntimeMediaManifest,
  deleteRuntimePersonalObjects,
  runtimeLandmarkV2Key,
  uploadRuntimeLandmarkObject,
} from '../services/runtimeMediaManifest'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)
const CAMERA_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`
const SCREEN_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-screen-1723248000002.webm`
const AUDIO_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000001.webm`
const LANDMARK_OBJECT_KEY_NONCE = '1'.repeat(64)
const LANDMARK_V2_KEY = runtimeLandmarkV2Key({
  principalId: PRINCIPAL_ID,
  runtimeSessionId: SESSION_ID,
  objectKeyNonce: LANDMARK_OBJECT_KEY_NONCE,
})

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

  it('conditionally uploads v2 landmarks and permanently seals them on cleanup', async () => {
    const body = Buffer.from('[{"ts":1}]')
    await uploadRuntimeLandmarkObject({
      key: LANDMARK_V2_KEY,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      objectKeyNonce: LANDMARK_OBJECT_KEY_NONCE,
      body,
    })
    await deleteRuntimePersonalObjects({
      principalId: PRINCIPAL_ID,
      objects: [{
        key: LANDMARK_V2_KEY,
        runtimeSessionId: SESSION_ID,
        objectKeyNonce: LANDMARK_OBJECT_KEY_NONCE,
      }],
    })

    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(mocks.PutObjectCommand)
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      Bucket: 'runtime-bucket',
      Key: LANDMARK_V2_KEY,
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
    })
    expect(mocks.send.mock.calls[1][0]).toBeInstanceOf(mocks.PutObjectCommand)
    expect(mocks.send.mock.calls[1][0].input).toEqual({
      Bucket: 'runtime-bucket',
      Key: LANDMARK_V2_KEY,
      Body: new Uint8Array(0),
      ContentLength: 0,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
      Metadata: { 'hire-runtime-landmark-tombstone': 'v2' },
    })
  })

  it('prevents a late conditional v2 upload from replacing an acknowledged seal', async () => {
    const objects = new Map<string, Uint8Array>()
    mocks.send.mockImplementation(async (command) => {
      if (!(command instanceof mocks.PutObjectCommand)) return {}
      const input = command.input as {
        Key: string
        Body: Uint8Array
        IfNoneMatch?: string
      }
      if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
        throw Object.assign(new Error('precondition failed'), {
          name: 'PreconditionFailed',
        })
      }
      objects.set(input.Key, input.Body)
      return {}
    })

    await deleteRuntimePersonalObjects({
      principalId: PRINCIPAL_ID,
      objects: [{
        key: LANDMARK_V2_KEY,
        runtimeSessionId: SESSION_ID,
        objectKeyNonce: LANDMARK_OBJECT_KEY_NONCE,
      }],
    })
    await expect(uploadRuntimeLandmarkObject({
      key: LANDMARK_V2_KEY,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      objectKeyNonce: LANDMARK_OBJECT_KEY_NONCE,
      body: Buffer.from('private landmarks'),
    })).rejects.toMatchObject({ name: 'PreconditionFailed' })
    expect(objects.get(LANDMARK_V2_KEY)).toEqual(new Uint8Array(0))
  })

  it('rejects a v2 key whose digest belongs to another session before R2', async () => {
    await expect(deleteRuntimePersonalObjects({
      principalId: PRINCIPAL_ID,
      objects: [{
        key: LANDMARK_V2_KEY,
        runtimeSessionId: 'c'.repeat(24),
        objectKeyNonce: LANDMARK_OBJECT_KEY_NONCE,
      }],
    })).rejects.toThrow(/principal\/session boundary/)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('requires temporary nonce authority before operating on a v2 landmark key', async () => {
    await expect(deleteRuntimePersonalObjects({
      principalId: PRINCIPAL_ID,
      objects: [{ key: LANDMARK_V2_KEY, runtimeSessionId: SESSION_ID }],
    })).rejects.toThrow(/object-key nonce is required/)
    expect(mocks.send).not.toHaveBeenCalled()
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

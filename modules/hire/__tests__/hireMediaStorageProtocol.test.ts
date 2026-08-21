import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class DeleteObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  return {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    send: vi.fn(),
    sign: vi.fn(),
  }
})

vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: mocks.DeleteObjectCommand,
  GetObjectCommand: mocks.GetObjectCommand,
  PutObjectCommand: mocks.PutObjectCommand,
  S3Client: class {
    send(command: unknown, options?: { abortSignal?: AbortSignal }) {
      return mocks.send(command, options)
    }
  },
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mocks.sign,
}))

import {
  InvalidHireMediaKeyError,
  hireMediaKey,
  hireMediaStorage,
  type HireMediaCoordinate,
} from '../services/hireMediaStorage'

const COORDINATE: HireMediaCoordinate = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  roundId: '333333333333333333333333',
  attemptId: '444444444444444444444444',
  assetId: '555555555555555555555555',
}
const OBJECT_KEY_NONCE = 'a'.repeat(64)

interface StoredObject {
  body: Buffer
  contentType: string
  tombstone: boolean
}

function bodyBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new Error('Unexpected test object body')
}

describe('Hire media object-key linearization', () => {
  const objects = new Map<string, StoredObject>()

  beforeEach(() => {
    vi.clearAllMocks()
    objects.clear()
    vi.stubEnv('R2_ACCOUNT_ID', 'account')
    vi.stubEnv('R2_ACCESS_KEY_ID', 'access-key')
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret-key')
    vi.stubEnv('R2_BUCKET_NAME', 'bucket')
    mocks.send.mockImplementation(
      async (command: InstanceType<typeof mocks.PutObjectCommand>) => {
        if (command instanceof mocks.DeleteObjectCommand) {
          objects.delete(String(command.input.Key))
          return {}
        }
        if (!(command instanceof mocks.PutObjectCommand)) return {}
        const key = String(command.input.Key)
        if (command.input.IfNoneMatch === '*' && objects.has(key)) {
          throw Object.assign(new Error('precondition failed'), {
            name: 'PreconditionFailed',
          })
        }
        const body = bodyBytes(command.input.Body)
        objects.set(key, {
          body,
          contentType: String(command.input.ContentType),
          tombstone:
            command.input.Metadata &&
            (command.input.Metadata as Record<string, string>)[
              'hire-media-tombstone'
            ] === 'v2',
        })
        return {}
      },
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('conditionally creates PII only after recomputing the v2 scope', async () => {
    const key = hireMediaKey(
      COORDINATE,
      'identity-photo',
      OBJECT_KEY_NONCE,
    )
    const body = Buffer.from('candidate-photo')

    await hireMediaStorage.upload({
      key,
      coordinate: COORDINATE,
      kind: 'identity-photo',
      objectKeyNonce: OBJECT_KEY_NONCE,
      body,
      contentType: 'image/jpeg',
    })

    const command = mocks.send.mock.calls[0][0] as InstanceType<
      typeof mocks.PutObjectCommand
    >
    expect(command.input).toMatchObject({
      Key: key,
      Body: body,
      ContentType: 'image/jpeg',
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
    })
    await expect(
      hireMediaStorage.upload({
        key,
        coordinate: {
          ...COORDINATE,
          roundId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        },
        kind: 'identity-photo',
        objectKeyNonce: OBJECT_KEY_NONCE,
        body,
        contentType: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(InvalidHireMediaKeyError)
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('makes both Put-then-seal and seal-then-late-Put end in a tombstone', async () => {
    const body = Buffer.from('candidate-photo')
    const putThenSealKey = hireMediaKey(
      COORDINATE,
      'identity-photo',
      OBJECT_KEY_NONCE,
    )
    await hireMediaStorage.upload({
      key: putThenSealKey,
      coordinate: COORDINATE,
      kind: 'identity-photo',
      objectKeyNonce: OBJECT_KEY_NONCE,
      body,
      contentType: 'image/jpeg',
    })
    await hireMediaStorage.delete({
      key: putThenSealKey,
      coordinate: COORDINATE,
      kind: 'identity-photo',
      objectKeyNonce: OBJECT_KEY_NONCE,
    })
    expect(objects.get(putThenSealKey)).toEqual({
      body: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      tombstone: true,
    })

    const secondCoordinate = {
      ...COORDINATE,
      assetId: '666666666666666666666666',
    }
    const secondNonce = 'b'.repeat(64)
    const sealThenPutKey = hireMediaKey(
      secondCoordinate,
      'identity-photo',
      secondNonce,
    )
    await hireMediaStorage.delete({
      key: sealThenPutKey,
      coordinate: secondCoordinate,
      kind: 'identity-photo',
      objectKeyNonce: secondNonce,
    })
    await expect(
      hireMediaStorage.upload({
        key: sealThenPutKey,
        coordinate: secondCoordinate,
        kind: 'identity-photo',
        objectKeyNonce: secondNonce,
        body,
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ name: 'PreconditionFailed' })
    expect(objects.get(sealThenPutKey)).toEqual({
      body: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      tombstone: true,
    })

    const tombstoneCommands = mocks.send.mock.calls
      .map(([command]) => command as InstanceType<typeof mocks.PutObjectCommand>)
      .filter(
        (command) =>
          command.input.Metadata &&
          (command.input.Metadata as Record<string, string>)[
            'hire-media-tombstone'
          ] === 'v2',
      )
    expect(tombstoneCommands).toHaveLength(2)
    for (const command of tombstoneCommands) {
      expect(command.input).toMatchObject({
        Body: new Uint8Array(0),
        ContentLength: 0,
        ContentType: 'application/octet-stream',
        CacheControl: 'private, no-store',
      })
      expect(command.input).not.toHaveProperty('IfNoneMatch')
      expect(command.input).not.toHaveProperty('Expires')
    }
  })

  it('retries an ambiguously acknowledged seal without exposing media again', async () => {
    const key = hireMediaKey(
      COORDINATE,
      'identity-photo',
      OBJECT_KEY_NONCE,
    )
    await hireMediaStorage.upload({
      key,
      coordinate: COORDINATE,
      kind: 'identity-photo',
      objectKeyNonce: OBJECT_KEY_NONCE,
      body: Buffer.from('candidate-photo'),
      contentType: 'image/jpeg',
    })
    const store = mocks.send.getMockImplementation()
    let loseFirstSealAck = true
    mocks.send.mockImplementation(async (...args: unknown[]) => {
      const result = await store?.(...args)
      const command = args[0] as InstanceType<typeof mocks.PutObjectCommand>
      if (
        loseFirstSealAck &&
        command.input.Metadata &&
        (command.input.Metadata as Record<string, string>)[
          'hire-media-tombstone'
        ] === 'v2'
      ) {
        loseFirstSealAck = false
        throw new Error('seal acknowledgement lost')
      }
      return result
    })

    await expect(
      hireMediaStorage.delete({
        key,
        coordinate: COORDINATE,
        kind: 'identity-photo',
        objectKeyNonce: OBJECT_KEY_NONCE,
      }),
    ).rejects.toThrow('seal acknowledgement lost')
    expect(objects.get(key)?.tombstone).toBe(true)
    await expect(
      hireMediaStorage.delete({
        key,
        coordinate: COORDINATE,
        kind: 'identity-photo',
        objectKeyNonce: OBJECT_KEY_NONCE,
      }),
    ).resolves.toBeUndefined()
    expect(objects.get(key)).toEqual({
      body: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      tombstone: true,
    })
  })

  it('deletes legacy v1 objects while requiring nonce authority for v2 reads', async () => {
    const legacyKey = [
      'hire-media',
      COORDINATE.workspaceId,
      COORDINATE.applicationId,
      COORDINATE.roundId,
      COORDINATE.attemptId,
      `${COORDINATE.assetId}-identity-photo.jpg`,
    ].join('/')
    objects.set(legacyKey, {
      body: Buffer.from('legacy-photo'),
      contentType: 'image/jpeg',
      tombstone: false,
    })

    await expect(
      hireMediaStorage.upload({
        key: legacyKey,
        coordinate: COORDINATE,
        kind: 'identity-photo',
        objectKeyNonce: OBJECT_KEY_NONCE,
        body: Buffer.from('new-photo'),
        contentType: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(InvalidHireMediaKeyError)
    expect(mocks.send).not.toHaveBeenCalled()

    await hireMediaStorage.delete({
      key: legacyKey,
      coordinate: COORDINATE,
      kind: 'identity-photo',
      objectKeyNonce: undefined,
    })

    expect(objects.has(legacyKey)).toBe(false)
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(
      mocks.DeleteObjectCommand,
    )
    const v2Key = hireMediaKey(
      COORDINATE,
      'identity-photo',
      OBJECT_KEY_NONCE,
    )
    await expect(
      hireMediaStorage.signDownload({
        key: v2Key,
        coordinate: COORDINATE,
        kind: 'identity-photo',
        objectKeyNonce: undefined,
      }),
    ).rejects.toBeInstanceOf(InvalidHireMediaKeyError)
    expect(mocks.sign).not.toHaveBeenCalled()
    mocks.sign.mockResolvedValueOnce('https://signed.example/media')
    await expect(
      hireMediaStorage.signDownload({
        key: v2Key,
        coordinate: COORDINATE,
        kind: 'identity-photo',
        objectKeyNonce: OBJECT_KEY_NONCE,
      }),
    ).resolves.toBe('https://signed.example/media')
    expect(mocks.sign).toHaveBeenCalledOnce()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InvalidR2KeyError,
  R2DeleteAuthorityError,
  abortMultipartUpload,
  audioRecordingKey,
  completeMultipartUpload,
  createMultipartUpload,
  deleteFromR2,
  documentKey,
  getDownloadPresignedUrl,
  getMultipartPartPresignedUrl,
  getUploadPresignedUrl,
  isCanonicalR2Key,
  objectExists,
  recordingKey,
  screenRecordingKey,
  uploadToR2,
} from '@shared/storage/r2'

const USER_ID = '507f1f77bcf86cd799439010'
const FOREIGN_USER_ID = '507f1f77bcf86cd799439099'
const SESSION_ID = '507f1f77bcf86cd799439011'
const FOREIGN_SESSION_ID = '507f1f77bcf86cd799439012'
const TIMESTAMP = '1721500000000'

describe('isCanonicalR2Key', () => {
  it.each([
    ['camera recording', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['screen recording', `recordings/${USER_ID}/${SESSION_ID}-screen-${TIMESTAMP}.webm`],
    ['audio recording', `recordings/${USER_ID}/${SESSION_ID}-audio-${TIMESTAMP}.webm`],
    ['landmarks', `landmarks/${USER_ID}/${SESSION_ID}.json`],
    ['resume document', `documents/${USER_ID}/resume/${TIMESTAMP}-cv.v2-final.pdf`],
    ['job-description document', `documents/${USER_ID}/jd/${TIMESTAMP}-role_notes.txt`],
  ])('accepts an application-minted %s key', (_label, key) => {
    expect(isCanonicalR2Key(key)).toBe(true)
  })

  it.each([
    ['empty key', ''],
    ['literal parent traversal', `recordings/${USER_ID}/../${SESSION_ID}-${TIMESTAMP}.webm`],
    ['literal current-directory segment', `recordings/${USER_ID}/./${SESSION_ID}-${TIMESTAMP}.webm`],
    ['encoded parent traversal', `recordings/${USER_ID}/%2e%2e/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['double-encoded parent traversal', `recordings/${USER_ID}/%252e%252e/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['Windows separator', `recordings\\${USER_ID}\\${SESSION_ID}-${TIMESTAMP}.webm`],
    ['duplicate separator', `recordings/${USER_ID}//${SESSION_ID}-${TIMESTAMP}.webm`],
    ['leading separator', `/recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['trailing separator', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm/`],
    ['unknown namespace', `private/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['non-ObjectId owner', `recordings/not-an-object-id/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['non-ObjectId session', `recordings/${USER_ID}/not-a-session-${TIMESTAMP}.webm`],
    ['unminted camera label', `recordings/${USER_ID}/${SESSION_ID}-camera-${TIMESTAMP}.webm`],
    ['unsupported recording label', `recordings/${USER_ID}/${SESSION_ID}-transcript-${TIMESTAMP}.webm`],
    ['timestamp too short', `recordings/${USER_ID}/${SESSION_ID}-123456789.webm`],
    ['timestamp too long', `recordings/${USER_ID}/${SESSION_ID}-12345678901234567.webm`],
    ['extra recording suffix', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm.bak`],
    ['unsupported document type', `documents/${USER_ID}/profile/${TIMESTAMP}-cv.pdf`],
    ['missing document filename', `documents/${USER_ID}/resume/${TIMESTAMP}-`],
    ['encoded document filename', `documents/${USER_ID}/resume/${TIMESTAMP}-cv%2fpayload.pdf`],
    ['nested document filename', `documents/${USER_ID}/resume/${TIMESTAMP}-folder/cv.pdf`],
    ['query-like document suffix', `documents/${USER_ID}/resume/${TIMESTAMP}-cv.pdf?download=1`],
    ['overlong key', `documents/${USER_ID}/resume/${TIMESTAMP}-${'a'.repeat(1001)}`],
  ])('rejects %s', (_label, key) => {
    expect(isCanonicalR2Key(key)).toBe(false)
  })

  it('accepts every key produced by the application key builders', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Number(TIMESTAMP))

    const keys = [
      recordingKey(USER_ID, SESSION_ID),
      screenRecordingKey(USER_ID, SESSION_ID),
      audioRecordingKey(USER_ID, SESSION_ID),
      documentKey(USER_ID, 'resume', '../cv final?.pdf'),
    ]

    expect(keys).toEqual([
      `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`,
      `recordings/${USER_ID}/${SESSION_ID}-screen-${TIMESTAMP}.webm`,
      `recordings/${USER_ID}/${SESSION_ID}-audio-${TIMESTAMP}.webm`,
      `documents/${USER_ID}/resume/${TIMESTAMP}-.._cv_final_.pdf`,
    ])
    expect(keys.every(isCanonicalR2Key)).toBe(true)
  })
})

describe('R2 command canonical-key gate', () => {
  const unsafeKey = `recordings/${USER_ID}/../${SESSION_ID}-${TIMESTAMP}.webm`
  const operations = [
    ['direct upload', () => uploadToR2(unsafeKey, new Uint8Array([1]), 'video/webm')],
    ['upload presign', () => getUploadPresignedUrl(unsafeKey, 'video/webm')],
    ['multipart create', () => createMultipartUpload(unsafeKey, 'video/webm')],
    ['multipart part presign', () => getMultipartPartPresignedUrl(unsafeKey, 'upload-id', 1)],
    ['multipart complete', () => completeMultipartUpload(unsafeKey, 'upload-id', [])],
    ['multipart abort', () => abortMultipartUpload(unsafeKey, 'upload-id')],
    ['download presign', () => getDownloadPresignedUrl(unsafeKey)],
    ['existence check', () => objectExists(unsafeKey)],
    ['delete', () => deleteFromR2(unsafeKey, {
      ownerUserId: USER_ID,
      sessionId: SESSION_ID,
    })],
  ] as const

  it.each(operations)('%s rejects before reaching storage configuration', async (_label, operation) => {
    await expect(operation()).rejects.toMatchObject({
      name: 'InvalidR2KeyError',
      key: unsafeKey,
    })
    await expect(operation()).rejects.toBeInstanceOf(InvalidR2KeyError)
  })
})

describe('deleteFromR2 authority gate', () => {
  it.each([
    [
      'foreign owner',
      `recordings/${FOREIGN_USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`,
      { ownerUserId: USER_ID, sessionId: SESSION_ID },
    ],
    [
      'different session',
      `recordings/${USER_ID}/${FOREIGN_SESSION_ID}-${TIMESTAMP}.webm`,
      { ownerUserId: USER_ID, sessionId: SESSION_ID },
    ],
  ])('rejects a canonical %s key before reaching storage', async (_label, key, authority) => {
    expect(isCanonicalR2Key(key)).toBe(true)

    await expect(deleteFromR2(key, authority)).rejects.toMatchObject({
      name: 'R2DeleteAuthorityError',
      key,
    })
    await expect(deleteFromR2(key, authority)).rejects.toBeInstanceOf(
      R2DeleteAuthorityError,
    )
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

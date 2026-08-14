import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const coordinate = {
  workspaceId: '1'.repeat(24),
  applicationId: '2'.repeat(24),
  jobId: '3'.repeat(24),
  candidateId: '4'.repeat(24),
  exportId: '5'.repeat(24),
}
const key = `hire-assessment-exports/v1/${coordinate.workspaceId}/${coordinate.jobId}/${coordinate.applicationId}/${coordinate.candidateId}/${coordinate.exportId}.pdf`

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  clientOptions: [] as unknown[],
  handlerOptions: [] as unknown[],
}))

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(options: unknown) {
      mocks.clientOptions.push(options)
    }

    send = mocks.send
  }
  class PutObjectCommand {
    constructor(readonly input: unknown) {}
  }
  class GetObjectCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteObjectCommand {
    constructor(readonly input: unknown) {}
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
})

vi.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: class {
    constructor(options: unknown) {
      mocks.handlerOptions.push(options)
    }
  },
}))

vi.mock('../models/HireAssessmentExport', () => ({
  parseHireAssessmentExportObjectKey: () => coordinate,
  assertHireAssessmentExportObjectKeyScope: vi.fn(),
}))

vi.mock('../models/HireAssessmentExportCleanup', () => ({
  HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS: 100,
}))

import { hireAssessmentExportStorage } from '../services/hireAssessmentExportStorage'

function abortableSend() {
  mocks.send.mockImplementation((_command: unknown, options: { abortSignal?: AbortSignal }) => (
    new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by deadline')))
    })
  ))
}

describe('Hire assessment-export R2 deadline boundary', () => {
  const prior = {
    account: process.env.R2_ACCOUNT_ID,
    access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'))
    process.env.R2_ACCOUNT_ID = 'account'
    process.env.R2_ACCESS_KEY_ID = 'access'
    process.env.R2_SECRET_ACCESS_KEY = 'secret'
    process.env.R2_BUCKET_NAME = 'private-hire'
  })

  afterEach(() => {
    vi.useRealTimers()
    if (prior.account === undefined) delete process.env.R2_ACCOUNT_ID
    else process.env.R2_ACCOUNT_ID = prior.account
    if (prior.access === undefined) delete process.env.R2_ACCESS_KEY_ID
    else process.env.R2_ACCESS_KEY_ID = prior.access
    if (prior.secret === undefined) delete process.env.R2_SECRET_ACCESS_KEY
    else process.env.R2_SECRET_ACCESS_KEY = prior.secret
    if (prior.bucket === undefined) delete process.env.R2_BUCKET_NAME
    else process.env.R2_BUCKET_NAME = prior.bucket
  })

  it('refuses a delayed upload after its absolute worker lease without starting PutObject', async () => {
    await expect(hireAssessmentExportStorage.upload({
      key,
      coordinate,
      body: Buffer.from('%PDF-safe'),
      leaseExpiresAt: new Date('2026-08-14T09:59:59.999Z'),
    })).rejects.toThrow('worker lease expired')

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('aborts an upload at the earlier absolute lease deadline and configures bounded R2 sockets', async () => {
    abortableSend()
    const request = hireAssessmentExportStorage.upload({
      key,
      coordinate,
      body: Buffer.from('%PDF-safe'),
      leaseExpiresAt: new Date('2026-08-14T10:00:00.025Z'),
    })

    const rejected = expect(request).rejects.toThrow('aborted by deadline')
    await vi.advanceTimersByTimeAsync(26)
    await rejected
    expect(mocks.handlerOptions).toContainEqual({ connectionTimeout: 100, socketTimeout: 100 })
  })

  it('also bounds a hung idempotent delete so one cleanup cannot block the serial sweep', async () => {
    abortableSend()
    const request = hireAssessmentExportStorage.delete({ key, coordinate })

    const rejected = expect(request).rejects.toThrow('aborted by deadline')
    await vi.advanceTimersByTimeAsync(101)
    await rejected
  })
})

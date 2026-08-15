import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const coordinate = {
  workspaceId: '1'.repeat(24),
  reportId: '2'.repeat(24),
  reportKind: 'pipeline_status' as const,
  reportScope: 'workspace' as const,
  format: 'pdf' as const,
}
const key = `hire-report-exports/v1/${coordinate.workspaceId}/pipeline_status/workspace/pdf/${coordinate.reportId}.pdf`

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  clientOptions: [] as unknown[],
  handlerOptions: [] as unknown[],
  assertScope: vi.fn(),
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

vi.mock('../models/HireReportExport', () => ({
  parseHireReportExportObjectKey: () => coordinate,
  assertHireReportExportObjectKeyScope: mocks.assertScope,
}))

vi.mock('../models/HireReportExportCleanup', () => ({
  HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS: 100,
}))

import { hireReportExportStorage } from '../services/hireReportExportStorage'

function abortableSend() {
  mocks.send.mockImplementation((_command: unknown, options: { abortSignal?: AbortSignal }) => (
    new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by deadline')))
    })
  ))
}

describe('Hire report-export R2 deadline boundary', () => {
  const prior = {
    account: process.env.R2_ACCOUNT_ID,
    access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clientOptions.length = 0
    mocks.handlerOptions.length = 0
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

  it('refuses an upload after its absolute lease without starting PutObject', async () => {
    await expect(hireReportExportStorage.upload({
      key,
      coordinate,
      body: Buffer.from('%PDF-safe'),
      leaseExpiresAt: new Date('2026-08-14T09:59:59.999Z'),
    })).rejects.toThrow('worker lease expired')

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('bounds a hung upload at the earlier worker lease and configures bounded R2 sockets', async () => {
    abortableSend()
    const request = hireReportExportStorage.upload({
      key,
      coordinate,
      body: Buffer.from('%PDF-safe'),
      leaseExpiresAt: new Date('2026-08-14T10:00:00.025Z'),
    })

    const rejected = expect(request).rejects.toThrow('aborted by deadline')
    await vi.advanceTimersByTimeAsync(26)
    await rejected
    expect(mocks.assertScope).toHaveBeenCalledWith(key, coordinate)
    expect(mocks.handlerOptions).toContainEqual({ connectionTimeout: 100, socketTimeout: 100 })
  })

  it('also bounds a hung idempotent delete so one cleanup cannot block the serial sweep', async () => {
    abortableSend()
    const request = hireReportExportStorage.delete({ key, coordinate })

    const rejected = expect(request).rejects.toThrow('aborted by deadline')
    await vi.advanceTimersByTimeAsync(101)
    await rejected
  })
})

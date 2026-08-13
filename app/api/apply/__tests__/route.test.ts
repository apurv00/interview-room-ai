import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  resolveApplyToken: vi.fn(),
  enqueuePublicApplyIntake: vi.fn(),
  isSupportedDocumentType: vi.fn(),
  logger: { error: vi.fn() },
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@shared/services/documentParser', () => ({
  isSupportedDocumentType: mocks.isSupportedDocumentType,
}))
vi.mock('@shared/logger', () => ({ logger: mocks.logger }))
vi.mock('@hire/services/applyPageService', () => ({
  resolveApplyToken: mocks.resolveApplyToken,
}))
vi.mock('@hire/services/intakeQueueService', () => ({
  enqueuePublicApplyIntake: mocks.enqueuePublicApplyIntake,
}))

import { POST } from '../route'

const WORKSPACE_ID = '111111111111111111111111'
const JOB_ID = '222222222222222222222222'
const CAPABILITY = `${WORKSPACE_ID}.${'a'.repeat(64)}`

function request(input: {
  capability?: string
  contentLength?: string
  name?: string
  email?: string
  phone?: string
  file?: File | null
  ip?: string
  headers?: Record<string, string>
} = {}) {
  const form = new FormData()
  form.set('name', input.name ?? 'Ada Lovelace')
  form.set('email', input.email ?? 'ada@example.com')
  if (input.phone !== undefined) form.set('phone', input.phone)
  if (input.file !== null) {
    form.set(
      'file',
      input.file ?? new File(['resume bytes'], 'ada.pdf', { type: 'application/pdf' }),
    )
  }

  return {
    headers: new Headers({
      'content-length': input.contentLength ?? '200',
      'x-forwarded-for': input.ip ?? '203.0.113.10',
      ...(input.capability === undefined
        ? { 'x-hire-apply-capability': CAPABILITY }
        : { 'x-hire-apply-capability': input.capability }),
      ...input.headers,
    }),
    formData: vi.fn().mockResolvedValue(form),
  } as never
}

function activeView() {
  return { job: { _id: { toString: () => JOB_ID } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.resolveApplyToken.mockResolvedValue(activeView())
  mocks.enqueuePublicApplyIntake.mockResolvedValue({ taskId: 'task-1', status: 'queued' })
  mocks.isSupportedDocumentType.mockReturnValue(true)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/apply', () => {
  it('uses capability + IP/job limits only, queues the file, and returns a private 202 without task state', async () => {
    const response = await POST(request({ phone: '+91 9999999999' }))

    expect(response.status).toBe(202)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: 'Your application has been submitted.',
    })
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      '203.0.113.10',
      expect.objectContaining({ keyPrefix: 'rl:apply-submit', maxRequests: 5, failClosed: true }),
    )
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      '203.0.113.10',
      expect.objectContaining({ keyPrefix: 'rl:apply-submit:anon-day', maxRequests: 20 }),
    )
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      3,
      JOB_ID,
      expect.objectContaining({ keyPrefix: 'rl:apply-job-day', maxRequests: 300, failClosed: true }),
    )
    expect(mocks.enqueuePublicApplyIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CAPABILITY,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+91 9999999999',
        fileName: 'ada.pdf',
        contentType: 'application/pdf',
        payload: expect.any(Buffer),
      }),
    )
    expect(mocks.enqueuePublicApplyIntake.mock.calls[0][0].payload.toString()).toBe('resume bytes')
  })

  it('keeps a dead or racing apply link indistinguishable to the public caller', async () => {
    mocks.enqueuePublicApplyIntake.mockResolvedValueOnce(null)

    const response = await POST(request())

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'This application link is no longer active',
    })
  })

  it('rejects malformed capability before resolving or queuing work', async () => {
    const response = await POST(request({ capability: 'not-a-capability' }))

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.resolveApplyToken).not.toHaveBeenCalled()
    expect(mocks.enqueuePublicApplyIntake).not.toHaveBeenCalled()
  })

  it('returns the rate limiter response as private no-store before resolving a link', async () => {
    mocks.checkRateLimit.mockResolvedValueOnce(new Response('limited', { status: 429 }))

    const response = await POST(request())

    expect(response.status).toBe(429)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.resolveApplyToken).not.toHaveBeenCalled()
    expect(mocks.enqueuePublicApplyIntake).not.toHaveBeenCalled()
  })

  it('prefers the Cloudflare client IP over a spoofed forwarded chain', async () => {
    await POST(request({
      headers: {
        'cf-connecting-ip': '198.51.100.7',
        'x-forwarded-for': '203.0.113.99',
      },
    }))

    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      '198.51.100.7',
      expect.objectContaining({ keyPrefix: 'rl:apply-submit' }),
    )
  })

  it('prefers Vercel\'s client IP header over a spoofed forwarded chain', async () => {
    vi.stubEnv('VERCEL', '1')

    await POST(request({
      headers: {
        'x-vercel-forwarded-for': '198.51.100.8',
        'x-forwarded-for': '203.0.113.99',
      },
    }))

    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      '198.51.100.8',
      expect.objectContaining({ keyPrefix: 'rl:apply-submit' }),
    )
  })

  it('places malformed proxy identity in a bounded shared bucket', async () => {
    await POST(request({ ip: 'not-an-ip' }))

    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      'unknown-client',
      expect.objectContaining({ keyPrefix: 'rl:apply-submit' }),
    )
  })

  it('maps queue validation failures to a private public error without parsing or scoring inline', async () => {
    mocks.enqueuePublicApplyIntake.mockRejectedValueOnce(
      new AppError('A resume file name is required', 422, 'INVALID_FILE_NAME'),
    )

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'A resume file name is required',
      code: 'INVALID_FILE_NAME',
    })
  })

  it('never consults B2C auth or runs parse/model/intake work on the request path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/apply/route.ts'), 'utf8')

    expect(source).toContain('enqueuePublicApplyIntake')
    expect(source).not.toMatch(
      /composeApiRoute|getServerSession|next-auth|@shared\/auth|@shared\/db\/models|parseDocument|analyzeResumeForJob|intakeFromApplyPage|resolveWorkspaceWriteAuthority/,
    )
  })
})

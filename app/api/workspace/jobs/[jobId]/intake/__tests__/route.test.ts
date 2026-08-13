import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  enqueueMemberResumeIntake: vi.fn(),
  isSupportedDocumentType: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => (
    request: Request,
    context?: { params?: Record<string, string> },
  ) =>
    options.handler(request, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body: {},
      params: context?.params ?? {},
      isPrincipalActive: vi.fn(),
    }),
}))

vi.mock('@shared/services/documentParser', () => ({
  isSupportedDocumentType: mocks.isSupportedDocumentType,
}))

vi.mock('@hire', () => ({
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES: 10 * 1024 * 1024,
  requireMembership: mocks.requireMembership,
  enqueueMemberResumeIntake: mocks.enqueueMemberResumeIntake,
}))

import { POST } from '../route'

const JOB_ID = '222222222222222222222222'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}

function request(input: {
  file?: File | null
  name?: string
  email?: string
  phone?: string
} = {}) {
  const formData = new FormData()
  if (input.file !== null) {
    formData.set(
      'file',
      input.file ?? new File(['resume bytes'], 'ada.pdf', { type: 'application/pdf' }),
    )
  }
  if (input.name !== undefined) formData.set('name', input.name)
  if (input.email !== undefined) formData.set('email', input.email)
  if (input.phone !== undefined) formData.set('phone', input.phone)
  // Keep the browser File realm intact. Node's Request constructor converts
  // a jsdom FormData file into an anonymous "blob", which is not what the
  // Next route receives from a multipart browser request.
  return { formData: vi.fn().mockResolvedValue(formData) } as never
}

describe('POST /api/workspace/jobs/[jobId]/intake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.isSupportedDocumentType.mockReturnValue(true)
    mocks.enqueueMemberResumeIntake.mockResolvedValue({ taskId: 'task-1', status: 'queued' })
  })

  it('authenticates the member, stores one durable task, and returns private 202 state only', async () => {
    const response = await POST(request({
      name: 'Ada Lovelace',
      email: 'ADA@EXAMPLE.COM',
      phone: '+91 9999999999',
    }) as never, { params: { jobId: JOB_ID } })

    expect(response.status).toBe(202)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      task: { taskId: 'task-1', status: 'queued' },
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.enqueueMemberResumeIntake).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        jobId: JOB_ID,
        fileName: 'ada.pdf',
        contentType: 'application/pdf',
        suppliedName: 'Ada Lovelace',
        suppliedEmail: 'ADA@EXAMPLE.COM',
        suppliedPhone: '+91 9999999999',
        payload: expect.any(Buffer),
      }),
    )
    expect(mocks.enqueueMemberResumeIntake.mock.calls[0][1].payload.toString()).toBe('resume bytes')
  })

  it('rejects missing, unsupported, empty, and oversized files before queueing work', async () => {
    const missing = await POST(request({ file: null }) as never, { params: { jobId: JOB_ID } })
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({ code: 'INVALID_FILE' })

    mocks.isSupportedDocumentType.mockReturnValueOnce(false)
    const unsupported = await POST(
      request({ file: new File(['x'], 'resume.exe', { type: 'application/octet-stream' }) }) as never,
      { params: { jobId: JOB_ID } },
    )
    expect(unsupported.status).toBe(415)
    await expect(unsupported.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_TYPE' })

    const empty = await POST(
      request({ file: new File([], 'empty.pdf', { type: 'application/pdf' }) }) as never,
      { params: { jobId: JOB_ID } },
    )
    expect(empty.status).toBe(422)
    await expect(empty.json()).resolves.toMatchObject({ code: 'INVALID_FILE' })

    const oversized = await POST(
      request({ file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf') }) as never,
      { params: { jobId: JOB_ID } },
    )
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(mocks.enqueueMemberResumeIntake).not.toHaveBeenCalled()
  })

  it('does not parse, score, dedupe, or write candidate data in the request path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/workspace/jobs/[jobId]/intake/route.ts'), 'utf8')

    expect(source).toContain('enqueueMemberResumeIntake')
    expect(source).not.toMatch(
      /parseDocument|analyzeResumeForJob|intakeCandidate|extractAllEmails|HireJob|sha256/,
    )
  })
})

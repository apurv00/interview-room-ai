/**
 * PR "resume pagination + graceful parse" — /api/documents/upload guards.
 *
 * Two abort points that used to fail generically now fail actionably:
 * unsupported extensions → 415 with the parser's own message (drag-and-drop
 * bypasses the client accept filter, so .doc/.rtf reach the server), and
 * scanned/empty documents → 422 instead of a 200 that dies downstream as a
 * misleading "Validation failed".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  checkRateLimit: vi.fn(),
  parseDocument: vi.fn(),
  connectDB: vi.fn(),
  isJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/middleware/checkRateLimit', () => ({ checkRateLimit: mocks.checkRateLimit }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
}))
vi.mock('@shared/services/documentParser', () => {
  // Redefine the error class instead of importOriginal — the real module
  // imports unpdf/mammoth, which this route test must not load.
  class UnsupportedFileTypeError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'UnsupportedFileTypeError'
    }
  }
  return { parseDocument: mocks.parseDocument, UnsupportedFileTypeError }
})
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from '../route'
import { UnsupportedFileTypeError } from '@shared/services/documentParser'

function makeReq(fileName: string, originUserId?: string) {
  const form = new FormData()
  form.append('file', new File(['some file bytes'], fileName, { type: 'application/octet-stream' }))
  form.append('docType', 'resume')
  // JSDOM can't round-trip multipart bodies through NextRequest — stub the
  // only request member the route touches.
  return {
    headers: new Headers(originUserId !== undefined ? { 'x-origin-user-id': originUserId } : {}),
    formData: async () => form,
  } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: 'u1' } })
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
})

describe('POST /api/documents/upload', () => {
  it('preserves callers that omit originUserId', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'w '.repeat(50).trim(), wordCount: 50, docType: 'pdf' })
    const res = await POST(makeReq('resume.pdf'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.wordCount).toBe(50)
    expect(data).not.toHaveProperty('r2Key')
  })

  it('accepts an exact originating user', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'w '.repeat(50).trim(), wordCount: 50, docType: 'pdf' })

    const res = await POST(makeReq('resume.pdf', 'u1'))

    expect(res.status).toBe(200)
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.parseDocument).toHaveBeenCalledTimes(1)
  })

  it('rejects a different originating user before account, limiter, or parser work', async () => {
    mocks.getServerSession.mockResolvedValue({ user: { id: 'user-b' } })

    const res = await POST(makeReq('resume.pdf', 'user-a'))

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.isJobsAccountActive).not.toHaveBeenCalled()
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.parseDocument).not.toHaveBeenCalled()
  })

  it('rejects an inactive account before limiter or parser work', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const res = await POST(makeReq('resume.pdf'))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.parseDocument).not.toHaveBeenCalled()
  })

  it('withholds parsed private text when deletion commits during parsing', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.parseDocument.mockResolvedValue({
      text: 'PRIVATE RESUME CONTENT',
      wordCount: 50,
      docType: 'pdf',
    })

    const res = await POST(makeReq('resume.pdf'))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.parseDocument).toHaveBeenCalledTimes(1)
  })

  it('prefers account-unavailable when parsing fails during deletion', async () => {
    mocks.parseDocument.mockRejectedValue(new Error('parser interrupted'))
    mocks.isJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const res = await POST(makeReq('resume.pdf'))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('surfaces the actionable message for unsupported types as 415', async () => {
    mocks.parseDocument.mockRejectedValue(
      new UnsupportedFileTypeError('Unsupported file type: .doc. Please upload a PDF, DOCX, or TXT file.')
    )
    const res = await POST(makeReq('resume.doc'))
    expect(res.status).toBe(415)
    const data = await res.json()
    expect(data.error).toContain('.doc')
    expect(data.code).toBe('UNSUPPORTED_TYPE')
  })

  it('rejects near-empty PDFs with 422 and the scanned-image message', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'a b c', wordCount: 3, docType: 'pdf' })
    const res = await POST(makeReq('scanned.pdf'))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('EMPTY_TEXT')
    expect(data.error).toContain('scanned image')
  })

  it('rejects truly empty non-PDF files with 422 and a generic message', async () => {
    mocks.parseDocument.mockResolvedValue({ text: '', wordCount: 0, docType: 'docx' })
    const res = await POST(makeReq('blank.docx'))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('EMPTY_TEXT')
    expect(data.error).not.toContain('scanned image')
  })

  it('accepts short-but-real non-PDF text (a concise JD must not 422 as scanned) — Codex P2 on #489', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'Senior engineer role at Acme, remote.', wordCount: 6, docType: 'txt' })
    const res = await POST(makeReq('jd.txt'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.wordCount).toBe(6)
  })

  it('keeps the generic message for unexpected parser crashes', async () => {
    mocks.parseDocument.mockRejectedValue(new Error('pdf lib exploded'))
    const res = await POST(makeReq('resume.pdf'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to parse document' })
  })
})

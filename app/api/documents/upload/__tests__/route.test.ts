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
  isR2Configured: vi.fn(),
  uploadToR2: vi.fn(),
  documentKey: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/middleware/checkRateLimit', () => ({ checkRateLimit: mocks.checkRateLimit }))
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
vi.mock('@shared/storage/r2', () => ({
  isR2Configured: mocks.isR2Configured,
  uploadToR2: mocks.uploadToR2,
  documentKey: mocks.documentKey,
}))
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
  mocks.isR2Configured.mockReturnValue(false)
})

describe('POST /api/documents/upload', () => {
  it('preserves callers that omit originUserId', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'w '.repeat(50).trim(), wordCount: 50, docType: 'pdf' })
    const res = await POST(makeReq('resume.pdf'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.wordCount).toBe(50)
  })

  it('accepts an exact originating user', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'w '.repeat(50).trim(), wordCount: 50, docType: 'pdf' })

    const res = await POST(makeReq('resume.pdf', 'u1'))

    expect(res.status).toBe(200)
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.parseDocument).toHaveBeenCalledTimes(1)
  })

  it('rejects a different originating user before limiter, parser, or R2 work', async () => {
    mocks.getServerSession.mockResolvedValue({ user: { id: 'user-b' } })
    mocks.isR2Configured.mockReturnValue(true)

    const res = await POST(makeReq('resume.pdf', 'user-a'))

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.parseDocument).not.toHaveBeenCalled()
    expect(mocks.documentKey).not.toHaveBeenCalled()
    expect(mocks.uploadToR2).not.toHaveBeenCalled()
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

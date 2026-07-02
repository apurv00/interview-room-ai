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
  isR2Configured: () => false,
  uploadToR2: vi.fn(),
  documentKey: vi.fn(),
}))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from '../route'
import { UnsupportedFileTypeError } from '@shared/services/documentParser'

function makeReq(fileName: string) {
  const form = new FormData()
  form.append('file', new File(['some file bytes'], fileName, { type: 'application/octet-stream' }))
  form.append('docType', 'resume')
  // JSDOM can't round-trip multipart bodies through NextRequest — stub the
  // only request member the route touches.
  return { formData: async () => form } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: 'u1' } })
  mocks.checkRateLimit.mockResolvedValue(null)
})

describe('POST /api/documents/upload', () => {
  it('returns the parsed text for a good document', async () => {
    mocks.parseDocument.mockResolvedValue({ text: 'w '.repeat(50).trim(), wordCount: 50, docType: 'pdf' })
    const res = await POST(makeReq('resume.pdf'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.wordCount).toBe(50)
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

  it('rejects scanned/empty documents with 422 and actionable copy', async () => {
    mocks.parseDocument.mockResolvedValue({ text: '', wordCount: 0, docType: 'pdf' })
    const res = await POST(makeReq('scanned.pdf'))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('EMPTY_TEXT')
    expect(data.error).toContain('scanned image')
  })

  it('keeps the generic message for unexpected parser crashes', async () => {
    mocks.parseDocument.mockRejectedValue(new Error('pdf lib exploded'))
    const res = await POST(makeReq('resume.pdf'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to parse document' })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/jobs/parse-pdf (Codex #540 ×2): parseDocument must receive a
 * CONSTANT filename — never file.name — because (1) resume filenames
 * routinely carry the user's real name and parseDocument logs the
 * filename (the route's contract is "nothing stored", logs included), and
 * (2) parseDocument picks its parser from the extension, so a
 * MIME-accepted PDF without a .pdf name would throw despite being valid.
 */

const { mockParseDocument } = vi.hoisted(() => ({ mockParseDocument: vi.fn() }))
vi.mock('@shared/services/documentParser', () => ({
  parseDocument: mockParseDocument,
  UnsupportedFileTypeError: class UnsupportedFileTypeError extends Error {},
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(null) }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/middleware/checkRateLimit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(null) }))

import { POST } from '../route'

function pdfRequest(fileName: string, type = 'application/pdf'): Request {
  const fd = new FormData()
  fd.append('file', new File(['%PDF-1.4 content'], fileName, { type }))
  return new Request('http://localhost/api/jobs/parse-pdf', { method: 'POST', body: fd })
}

beforeEach(() => {
  mockParseDocument.mockReset().mockResolvedValue({ text: 'extracted resume text with plenty of words to pass the scan check ok', wordCount: 40, docType: 'pdf' })
})

describe('POST /api/jobs/parse-pdf', () => {
  it('passes a CONSTANT filename to the parser — never the PII-bearing original', async () => {
    const res = await POST(pdfRequest('Apurv Bhishek Resume.pdf') as never)
    expect(res.status).toBe(200)
    expect(mockParseDocument).toHaveBeenCalledWith(expect.anything(), 'resume.pdf')
  })

  it('a MIME-accepted PDF with no .pdf extension still parses as PDF', async () => {
    const res = await POST(pdfRequest('resume-final-v2') as never)
    expect(res.status).toBe(200)
    expect(mockParseDocument).toHaveBeenCalledWith(expect.anything(), 'resume.pdf')
  })

  it('non-PDF uploads are rejected before any parse', async () => {
    const res = await POST(pdfRequest('resume.docx', 'application/msword') as never)
    expect(res.status).toBe(400)
    expect(mockParseDocument).not.toHaveBeenCalled()
  })
})

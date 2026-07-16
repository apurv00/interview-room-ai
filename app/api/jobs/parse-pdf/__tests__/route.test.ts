import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/jobs/parse-pdf (Codex #540 ×2): parseDocument must receive a
 * CONSTANT filename — never file.name — because (1) resume filenames
 * routinely carry the user's real name and parseDocument logs the
 * filename (the route's contract is "nothing stored", logs included), and
 * (2) parseDocument picks its parser from the extension, so a
 * MIME-accepted PDF without a .pdf name would throw despite being valid.
 *
 * The request is a STUB at the formData() seam — constructing a real
 * Request+FormData made the suite Node-version-sensitive (passed on the
 * local Node, 500'd on the CI runner's) and the route logic under pin
 * does not depend on multipart plumbing.
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

function reqStub(fileName: string, type = 'application/pdf') {
  const file = {
    name: fileName,
    type,
    size: 1024,
    arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 content').buffer,
  }
  return {
    headers: { get: () => null },
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  } as never
}

beforeEach(() => {
  mockParseDocument.mockReset().mockResolvedValue({ text: 'extracted resume text with plenty of words to pass the scan check ok', wordCount: 40, docType: 'pdf' })
})

describe('POST /api/jobs/parse-pdf', () => {
  it('passes a CONSTANT filename to the parser — never the PII-bearing original', async () => {
    const res = await POST(reqStub('Apurv Bhishek Resume.pdf'))
    expect(res.status).toBe(200)
    expect(mockParseDocument).toHaveBeenCalledWith(expect.anything(), 'resume.pdf')
  })

  it('a MIME-accepted PDF with no .pdf extension still parses as PDF', async () => {
    const res = await POST(reqStub('resume-final-v2'))
    expect(res.status).toBe(200)
    expect(mockParseDocument).toHaveBeenCalledWith(expect.anything(), 'resume.pdf')
  })

  it('non-PDF uploads are rejected before any parse', async () => {
    const res = await POST(reqStub('resume.docx', 'application/msword'))
    expect(res.status).toBe(400)
    expect(mockParseDocument).not.toHaveBeenCalled()
  })

  it('scanned-image PDFs 422 with the paste-instead copy', async () => {
    mockParseDocument.mockResolvedValue({ text: '', wordCount: 3, docType: 'pdf' })
    const res = await POST(reqStub('scan.pdf'))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('EMPTY_TEXT')
  })
})

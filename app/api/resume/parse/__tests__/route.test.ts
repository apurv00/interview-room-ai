/**
 * PR "resume pagination + graceful parse" — /api/resume/parse contract.
 *
 * Partial-tolerant contract: 200 with { resume, importedSections, warning? }
 * for anything salvageable; 422 (not 500) with actionable copy when nothing
 * is; 500 reserved for unexpected errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  parseResumeToStructured: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (value: unknown) => unknown }
    handler: (req: NextRequest, ctx: { user: { id: string } | null; body: unknown; params: Record<string, string> }) => Promise<Response>
  }) => async (req: NextRequest) => {
    const raw = await req.json()
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, { user: { id: 'u1' }, body, params: {} })
  },
}))

vi.mock('@resume/services/resumeAIService', () => ({
  parseResumeToStructured: mocks.parseResumeToStructured,
}))

import { POST } from '../route'

const makeReq = (text: string) =>
  new NextRequest('http://localhost/api/resume/parse', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })

beforeEach(() => vi.clearAllMocks())

describe('POST /api/resume/parse', () => {
  it('returns the partial-tolerant contract for a successful parse', async () => {
    mocks.parseResumeToStructured.mockResolvedValue({
      resume: { summary: 'ok' },
      importedSections: ['summary'],
      droppedSections: [],
      truncated: false,
    })
    const res = await POST(makeReq('a real resume text here'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      resume: { summary: 'ok' },
      importedSections: ['summary'],
    })
  })

  it('surfaces dropped sections and truncation as a warning', async () => {
    mocks.parseResumeToStructured.mockResolvedValue({
      resume: { summary: 'ok' },
      importedSections: ['summary'],
      droppedSections: ['education'],
      truncated: true,
    })
    const data = await (await POST(makeReq('a real resume text here'))).json()
    expect(data.warning).toContain('Could not import: education.')
    expect(data.warning).toContain('trailing content may be missing')
  })

  it('returns 422 with actionable copy when nothing is salvageable', async () => {
    mocks.parseResumeToStructured.mockResolvedValue(null)
    const res = await POST(makeReq('gibberish text that yields nothing'))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error).toContain('fill the sections in manually')
  })

  it('returns 500 only for unexpected errors', async () => {
    mocks.parseResumeToStructured.mockRejectedValue(new Error('boom'))
    const res = await POST(makeReq('a real resume text here'))
    expect(res.status).toBe(500)
  })
})

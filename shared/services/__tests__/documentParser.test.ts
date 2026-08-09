import { describe, expect, it, vi } from 'vitest'

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  parseDocument,
  extractDocxBounded,
  UnsupportedFileTypeError,
} from '../documentParser'

describe('parseDocument extraction limits', () => {
  it('reports the original word count when text is truncated', async () => {
    const source = Array.from({ length: 8_005 }, (_, index) => `word${index}`).join(' ')

    const result = await parseDocument(Buffer.from(source), 'resume.txt')

    expect(result.wordCount).toBe(8_000)
    expect(result.originalWordCount).toBe(8_005)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('word7999...')
    expect(result.text).not.toContain('word8000')
  })
})

/**
 * The docx defence is a HARD heap ceiling on the worker that runs mammoth,
 * not a prediction about ZIP contents — so these tests exercise the real
 * thing: a genuine archive built with JSZip (the library mammoth unzips
 * with) must parse, and the ceiling must actually stop an oversized parse.
 */
describe('docx parsing runs inside a memory-bounded worker', () => {
  async function buildDocx(bodyText: string): Promise<Buffer> {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    )
    zip
      .folder('_rels')!
      .file(
        '.rels',
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      )
    zip
      .folder('word')!
      .file(
        'document.xml',
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`,
      )
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  }

  it('parses a genuine multi-entry docx end to end', async () => {
    const docx = await buildDocx('Jane Doe jane@example.com Senior Backend Engineer')

    const result = await parseDocument(docx, 'jane.docx')
    expect(result.docType).toBe('docx')
    expect(result.text).toContain('jane@example.com')
    expect(result.text).toContain('Senior Backend Engineer')
  }, 20_000)

  it('enforces the heap ceiling — an over-budget parse dies with the worker, not the server', async () => {
    const docx = await buildDocx('Jane Doe jane@example.com Senior Backend Engineer')

    // Same archive, a heap too small to parse it: V8 kills the worker
    // (ERR_WORKER_OUT_OF_MEMORY) and it surfaces as a typed file error.
    // This is the mechanism a decompression bomb hits — proven without
    // needing a multi-gigabyte fixture.
    await expect(extractDocxBounded(docx, 6)).rejects.toBeInstanceOf(UnsupportedFileTypeError)

    // The parent process is unharmed and still parses normally afterwards.
    const after = await parseDocument(docx, 'jane.docx')
    expect(after.text).toContain('jane@example.com')
  }, 30_000)
})

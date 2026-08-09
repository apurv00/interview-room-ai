import { describe, expect, it, vi } from 'vitest'

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  parseDocument,
  docxInflationWithinLimit,
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
 * The docx defence measures real inflation with JSZip — mammoth's own
 * unzip library — so these tests use REAL archives, including an actual
 * decompression bomb. A synthetic zip could only prove the guard agrees
 * with itself.
 */
describe('docx inflation budget (measured with the real parser)', () => {
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

  it('accepts a normal résumé well inside the budget', async () => {
    const docx = await buildDocx('Jane Doe jane@example.com Senior Backend Engineer')
    expect(await docxInflationWithinLimit(docx)).toBe(true)
  }, 20_000)

  it('REJECTS a real decompression bomb — 0.4MB upload, ~120MB inflated', async () => {
    // An actual bomb, not a synthetic header: highly compressible body that
    // JSZip really does inflate. The earlier V8-heap-capped worker parsed a
    // bomb like this to completion (external memory is not heap), which is
    // why the guard measures bytes instead.
    const bomb = await buildDocx('A'.repeat(120 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024)

    expect(await docxInflationWithinLimit(bomb, 50 * 1024 * 1024)).toBe(false)
    await expect(parseDocument(bomb, 'bomb.docx')).rejects.toBeInstanceOf(UnsupportedFileTypeError)
  }, 60_000)

  it('a corrupt archive is left for mammoth to report, not treated as a bomb', async () => {
    expect(await docxInflationWithinLimit(Buffer.from('not a zip at all'))).toBe(true)
  })
})

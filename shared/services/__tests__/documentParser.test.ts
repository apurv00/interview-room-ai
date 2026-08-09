import { describe, expect, it, vi } from 'vitest'

vi.mock('@shared/logger', () => ({ logger: { info: vi.fn() } }))

import { deflateRawSync } from 'zlib'
import {
  parseDocument,
  docxInflatedWithinLimit,
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

describe('docx decompression-bomb guard (measures REAL inflation, offset-free)', () => {
  /**
   * Build a single-entry zip: local header + deflate payload + central
   * directory entry. Every field a bomb can lie about is a parameter:
   * `declaredUncompressed` (size lie) and `cdLocalOffset` (ZIP64 sentinel
   * or otherwise unresolvable offset).
   */
  function zipWithDeflateEntry(
    content: Buffer,
    declaredUncompressed: number,
    cdLocalOffset = 0,
    methods: { local?: number; central?: number } = {},
  ): Buffer {
    const compressed = deflateRawSync(content)
    const name = Buffer.from('word/document.xml')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(methods.local ?? 8, 8) // method (lie-able)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declaredUncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    const localHeader = Buffer.concat([local, name])

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(methods.central ?? 8, 10) // method (lie-able)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(declaredUncompressed, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(cdLocalOffset, 42) // local header offset (lie-able)
    const cdEntry = Buffer.concat([cd, name])

    return Buffer.concat([localHeader, compressed, cdEntry])
  }

  /** Zero-length STORED entry — what JSZip emits for a directory record. */
  function storedDirectoryEntry(name: string): Buffer {
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt32LE(0, 18) // compressed size 0
    local.writeUInt32LE(0, 22) // uncompressed size 0
    local.writeUInt16LE(nameBuf.length, 26)
    return Buffer.concat([local, nameBuf])
  }

  it('accepts a normal small docx (real inflated size under the cap)', () => {
    const zip = zipWithDeflateEntry(Buffer.from('a real resume '.repeat(100)), 1400)
    expect(docxInflatedWithinLimit(zip, 50 * 1024 * 1024)).toBe(true)
  })

  it('rejects a bomb that LIES about uncompressed size — measured output wins', () => {
    // Declares 1 byte; actually inflates to ~2MB. With a 1MB cap the
    // measured inflate must reject despite the tiny declared size.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41)
    const zip = zipWithDeflateEntry(big, 1)
    expect(docxInflatedWithinLimit(zip, 1024 * 1024)).toBe(false)
  })

  it('rejects a bomb hiding behind a ZIP64 sentinel offset (Codex P1 #613 round 2)', () => {
    // 0xffffffff in the central directory means "real offset is in the
    // ZIP64 extra field" — the previous offset-resolving guard skipped
    // this entry while JSZip resolved and inflated it. Scanning local
    // headers makes the directory's claim irrelevant.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x42)
    const zip = zipWithDeflateEntry(big, 1, 0xffffffff)
    expect(docxInflatedWithinLimit(zip, 1024 * 1024)).toBe(false)
  })

  it('rejects a bomb marked STORED locally but DEFLATED centrally (Codex P1 #614)', () => {
    // JSZip takes compressionMethod from the CENTRAL directory while
    // deriving the data start from the local header, so a "stored" local
    // method is not a promise that nothing inflates. The guard ignores
    // both method fields and inflates on sight.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x44)
    const zip = zipWithDeflateEntry(big, 1, 0, { local: 0, central: 8 })
    expect(docxInflatedWithinLimit(zip, 1024 * 1024)).toBe(false)
  })

  it('does not charge zero-length stored directory records (Codex P2 #614)', () => {
    // Seven directory records + a small real entry: the archive must pass
    // comfortably. Charging dir entries by "declared size or the rest of
    // the file" used to exhaust the budget and 415 ordinary DOCX files.
    const dirs = ['word/', '_rels/', 'docProps/', 'customXml/', 'word/_rels/', 'word/media/', 'word/theme/']
    const zip = Buffer.concat([
      ...dirs.map(storedDirectoryEntry),
      zipWithDeflateEntry(Buffer.from('real content '.repeat(50)), 650),
    ])
    expect(docxInflatedWithinLimit(zip, 2 * 1024 * 1024)).toBe(true)
  })

  it('rejects a bomb with NO central directory at all (payload is still found)', () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x43)
    const full = zipWithDeflateEntry(big, 1)
    // Truncate the trailing central-directory entry entirely.
    const headerOnly = full.subarray(0, full.length - (46 + 'word/document.xml'.length))
    expect(docxInflatedWithinLimit(headerOnly, 1024 * 1024)).toBe(false)
  })

  it('parseDocument rejects the lying bomb before mammoth sees it', async () => {
    const big = Buffer.alloc(60 * 1024 * 1024, 0x41)
    const zip = zipWithDeflateEntry(big, 1)
    await expect(parseDocument(zip, 'cv.docx')).rejects.toBeInstanceOf(UnsupportedFileTypeError)
  })

  it('treats a buffer with no zip structure as within limit (mammoth handles the rest)', () => {
    expect(docxInflatedWithinLimit(Buffer.from('just some words'))).toBe(true)
  })

  it('does not reject on a stray PK\\x03\\x04 byte pattern that is not a real entry', () => {
    const noise = Buffer.concat([
      Buffer.from('resume text '),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64, 0x7a),
    ])
    expect(docxInflatedWithinLimit(noise, 1024 * 1024)).toBe(true)
  })
})

/**
 * The synthetic zips above pin the guard's logic; these use JSZip — the
 * SAME library mammoth unzips with — to prove the guard agrees with the
 * real parser on real multi-entry archives. Without this, an
 * over-eager guard could silently reject every genuine résumé.
 */
describe('docx guard against real JSZip-built archives', () => {
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

    // The guard must not reject a real archive...
    expect(docxInflatedWithinLimit(docx)).toBe(true)
    // ...and the text must still come out for intake to use.
    const result = await parseDocument(docx, 'jane.docx')
    expect(result.docType).toBe('docx')
    expect(result.text).toContain('jane@example.com')
    expect(result.text).toContain('Senior Backend Engineer')
  })

  it('rejects a real JSZip archive whose content inflates past the cap', async () => {
    const docx = await buildDocx('A'.repeat(3 * 1024 * 1024))
    expect(docxInflatedWithinLimit(docx, 1024 * 1024)).toBe(false)
  })
})

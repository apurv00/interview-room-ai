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

describe('docx decompression-bomb guard (measures REAL inflation)', () => {
  /**
   * Build a single-entry zip: local header + deflate payload + central
   * directory entry. `declaredUncompressed` is written into BOTH size
   * fields independently of the real payload so tests can lie the way a
   * bomb would.
   */
  function zipWithDeflateEntry(content: Buffer, declaredUncompressed: number): Buffer {
    const compressed = deflateRawSync(content)
    const name = Buffer.from('word/document.xml')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declaredUncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    const localHeader = Buffer.concat([local, name])
    const dataStart = 0 // local header sits at offset 0

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(8, 10) // method: deflate
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(declaredUncompressed, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(dataStart, 42) // local header offset
    const cdEntry = Buffer.concat([cd, name])

    return Buffer.concat([localHeader, compressed, cdEntry])
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

  it('parseDocument rejects the lying bomb before mammoth sees it', async () => {
    const big = Buffer.alloc(60 * 1024 * 1024, 0x41)
    const zip = zipWithDeflateEntry(big, 1)
    await expect(parseDocument(zip, 'cv.docx')).rejects.toBeInstanceOf(UnsupportedFileTypeError)
  })

  it('treats a buffer with no central directory as within limit (mammoth handles the rest)', () => {
    expect(docxInflatedWithinLimit(Buffer.from('just some words'))).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('@shared/logger', () => ({ logger: { info: vi.fn() } }))

import {
  parseDocument,
  docxDeclaredUncompressedBytes,
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

describe('docx decompression-bomb guard', () => {
  /** Minimal zip central-directory entry declaring `size` uncompressed bytes. */
  function centralDirEntry(size: number): Buffer {
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0) // central directory signature
    entry.writeUInt32LE(size, 24) // uncompressed size field
    return entry
  }

  it('sums declared uncompressed sizes across entries', () => {
    const buf = Buffer.concat([
      Buffer.from('junk'),
      centralDirEntry(10 * 1024 * 1024),
      centralDirEntry(15 * 1024 * 1024),
    ])
    expect(docxDeclaredUncompressedBytes(buf)).toBe(25 * 1024 * 1024)
  })

  it('treats the zip64 sentinel as declared-enormous', () => {
    expect(
      docxDeclaredUncompressedBytes(centralDirEntry(0xffffffff)),
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects a docx declaring more than the inflate ceiling BEFORE inflating', async () => {
    const bomb = Buffer.concat([Buffer.from('PK'), centralDirEntry(60 * 1024 * 1024)])
    await expect(parseDocument(bomb, 'cv.docx')).rejects.toBeInstanceOf(UnsupportedFileTypeError)
  })

  it('returns 0 for buffers with no central directory (plain text renamed .docx)', () => {
    expect(docxDeclaredUncompressedBytes(Buffer.from('just some words'))).toBe(0)
  })
})

import { inflateRawSync } from 'zlib'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import { logger } from '@shared/logger'

export interface ParseResult {
  text: string
  /** Word count represented in `text` (capped at the extraction limit). */
  wordCount: number
  /** Original count before the extraction limit was applied. */
  originalWordCount?: number
  /** True when `text` contains only the leading extraction window. */
  truncated?: boolean
  docType: 'pdf' | 'docx' | 'txt'
}

/**
 * Thrown for extensions parseDocument cannot handle. Typed so API routes can
 * surface the actionable message (415) instead of collapsing it into their
 * generic catch-all — users dropping .doc/.rtf/.odt used to get a bare
 * "Failed to parse document" with no hint of what to do.
 */
export class UnsupportedFileTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedFileTypeError'
  }
}

/**
 * Decompression-bomb guard for .docx. Callers cap the COMPRESSED upload
 * size, but mammoth inflates the zip fully in memory — a 10MB docx can
 * expand to gigabytes.
 *
 * TWO things here are deliberately NOT trusted, both learned the hard way
 * (Codex P1 ×2 on #613):
 *
 * 1. Declared uncompressed sizes — a bomb simply declares 1 byte. So we
 *    MEASURE: every deflate stream is inflated under zlib's
 *    `maxOutputLength`, which stops allocating and throws the instant
 *    output would exceed the shared budget. Peak memory is bounded by the
 *    limit no matter what the metadata claims.
 *
 * 2. Central-directory OFFSETS — resolving them means re-implementing a zip
 *    parser and matching JSZip's quirks exactly; the first attempt did that
 *    and a ZIP64 sentinel offset (0xffffffff + real offset in an extra
 *    field) walked straight past the cap because we skipped the entry while
 *    JSZip resolved it. So we no longer read offsets AT ALL: we scan for
 *    LOCAL file headers, which sit immediately before the compressed bytes
 *    they describe. The payload has to physically exist somewhere in the
 *    file, so signature-scanning finds it regardless of what any directory
 *    claims — ZIP64, mismatched, or absent. Parser-differential bugs of
 *    this class cannot recur, because there is no offset arithmetic left.
 *
 * Charging every deflate stream found against ONE budget is deliberately
 * conservative (a stream JSZip would ignore still counts) — over-counting
 * rejects a pathological file; under-counting exhausts the process.
 *
 * Exported for tests.
 */
const ZIP_LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ZIP_LOCAL_HEADER_BYTES = 30
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
const ZIP_METHOD_STORE = 0
const ZIP_METHOD_DEFLATE = 8

export function docxInflatedWithinLimit(
  buffer: Buffer,
  limit: number = MAX_DOCX_UNCOMPRESSED_BYTES,
): boolean {
  let remaining = limit
  let cursor = 0

  while (cursor < buffer.length) {
    const header = buffer.indexOf(ZIP_LOCAL_HEADER_SIG, cursor)
    if (header === -1 || header + ZIP_LOCAL_HEADER_BYTES > buffer.length) break
    // Advance past this signature before any `continue` so a malformed
    // header can never spin the loop.
    cursor = header + 4

    const method = buffer.readUInt16LE(header + 8)
    const compSize = buffer.readUInt32LE(header + 18)
    const nameLen = buffer.readUInt16LE(header + 26)
    const extraLen = buffer.readUInt16LE(header + 28)
    const dataStart = header + ZIP_LOCAL_HEADER_BYTES + nameLen + extraLen
    if (dataStart >= buffer.length) continue

    if (method === ZIP_METHOD_STORE) {
      // Stored: output === input, and the input cannot exceed the bytes
      // physically present (already bounded by the caller's size cap).
      remaining -= Math.min(compSize || buffer.length - dataStart, buffer.length - dataStart)
    } else if (method === ZIP_METHOD_DEFLATE) {
      // Always slice to EOF: a declared compressed size may be 0
      // (data-descriptor form), a ZIP64 sentinel, or a lie. inflateRawSync
      // stops at the deflate stream's own terminus and ignores trailing
      // bytes, so EOF is both safe and offset-free.
      try {
        const out = inflateRawSync(buffer.subarray(dataStart), {
          maxOutputLength: Math.max(1, remaining),
        })
        remaining -= out.length
      } catch (err) {
        // Budget exceeded ⇒ this file inflates past the cap: REJECT.
        // Anything else ⇒ not a real deflate stream (a PK\x03\x04 byte
        // pattern occurring inside compressed data) or a corrupt entry:
        // skip it. Corrupt files then fail in mammoth with its own error;
        // this guard's only job is bounding memory.
        if (isOutputBudgetError(err)) return false
        continue
      }
    }
    // Other methods are not inflated by JSZip either — nothing to charge.

    if (remaining <= 0) return false
  }
  return true
}

/** zlib signals an exceeded `maxOutputLength` as ERR_BUFFER_TOO_LARGE. */
function isOutputBudgetError(err: unknown): boolean {
  return (
    err instanceof RangeError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
  )
}

const MAX_WORDS = 8000

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/)
  if (words.length <= maxWords) return text
  return words.slice(0, maxWords).join(' ') + '...'
}

function getExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.')
  return parts.length > 1 ? `.${parts[parts.length - 1]}` : ''
}

export async function parseDocument(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = getExtension(filename)

  let rawText: string

  switch (ext) {
    case '.pdf': {
      const pdf = await getDocumentProxy(new Uint8Array(buffer))
      const { text } = await extractText(pdf, { mergePages: true })
      rawText = text as string
      break
    }
    case '.docx': {
      if (!docxInflatedWithinLimit(buffer)) {
        throw new UnsupportedFileTypeError(
          'This DOCX file expands too large to process safely. Please export it as PDF or plain text.',
        )
      }
      const result = await mammoth.extractRawText({ buffer })
      rawText = result.value
      break
    }
    case '.txt': {
      rawText = buffer.toString('utf-8')
      break
    }
    default:
      throw new UnsupportedFileTypeError(`Unsupported file type: ${ext}. Please upload a PDF, DOCX, or TXT file.`)
  }

  const normalized = normalizeText(rawText)
  const wordCount = normalized.split(/\s+/).filter(Boolean).length
  const text = truncateToWords(normalized, MAX_WORDS)

  logger.info({ filename, ext, wordCount, truncated: wordCount > MAX_WORDS }, 'Document parsed')

  return {
    text,
    wordCount: Math.min(wordCount, MAX_WORDS),
    originalWordCount: wordCount,
    truncated: wordCount > MAX_WORDS,
    docType: ext.slice(1) as ParseResult['docType'],
  }
}

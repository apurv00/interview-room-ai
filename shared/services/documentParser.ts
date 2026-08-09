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
 * 2. Any DECLARED metadata about where or how an entry is compressed.
 *    Two rounds of parser-differential bugs came from reading it:
 *    resolving central-directory offsets missed a ZIP64 sentinel entry
 *    that JSZip resolved and inflated; then trusting the LOCAL header's
 *    compression method missed a bomb marked "stored" locally and
 *    "deflated" centrally — JSZip takes `compressionMethod` and
 *    `compressedSize` from the CENTRAL directory (jszip/lib/zipEntry.js
 *    readLocalPart) while deriving the data START from the local header.
 *
 *    So this guard reads exactly ONE thing from the archive: where each
 *    entry's payload begins — from the local header's name/extra lengths,
 *    which is the same derivation JSZip uses and the only one the physical
 *    layout permits. It then ATTEMPTS TO INFLATE at that position
 *    regardless of any declared method. If the bytes are a deflate stream,
 *    their real output counts against the budget no matter what either
 *    header claims; if they are not, inflation simply fails and the entry
 *    is skipped. There is no method, size, or offset field left to lie
 *    about.
 *
 * Stored (uncompressed) entries need no budget at all: their output equals
 * their input, which is bounded by the caller's upload-size cap — the
 * budget here exists solely to bound INFLATION. Charging them by declared
 * size was itself a bug: zero-length directory records report size 0 and a
 * fallback charged the rest of the archive, rejecting ordinary DOCX files.
 *
 * Exported for tests.
 */
const ZIP_LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ZIP_LOCAL_HEADER_BYTES = 30
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

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

    // The ONLY fields read: local name/extra lengths, which is exactly how
    // JSZip locates the payload (readLocalPart). Method and sizes are
    // deliberately ignored — see the header comment.
    const nameLen = buffer.readUInt16LE(header + 26)
    const extraLen = buffer.readUInt16LE(header + 28)
    const dataStart = header + ZIP_LOCAL_HEADER_BYTES + nameLen + extraLen
    if (dataStart >= buffer.length) continue

    // Slice to EOF: inflateRawSync stops at the deflate stream's own
    // terminus and ignores trailing bytes (verified), so no length field
    // is needed here either.
    try {
      const out = inflateRawSync(buffer.subarray(dataStart), {
        maxOutputLength: Math.max(1, remaining),
      })
      remaining -= out.length
    } catch (err) {
      // Budget exceeded ⇒ this file inflates past the cap: REJECT.
      // Anything else ⇒ these bytes are not a deflate stream (a stored
      // entry, a directory record, or a stray PK\x03\x04 pattern inside
      // compressed data): skip. Genuinely corrupt archives still fail
      // inside mammoth with its own error; bounding memory is this
      // guard's only job.
      if (isOutputBudgetError(err)) return false
    }
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

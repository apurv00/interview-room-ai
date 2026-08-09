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
 * The declared uncompressed size in the zip headers is ATTACKER-CONTROLLED
 * (a bomb can claim 1 byte), so we do NOT trust it. Instead we measure real
 * output: inflate each entry's deflate stream with zlib's `maxOutputLength`
 * budget, which stops allocating and throws the moment output would exceed
 * the cap — so peak memory is bounded by the limit regardless of any lie in
 * the metadata (Codex P1 on #613). Only if every entry inflates within the
 * shared budget do we hand the buffer to mammoth (which then re-inflates
 * content we've proven is bounded). Exported for tests.
 */
const ZIP_CENTRAL_DIR_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02])
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
const ZIP_METHOD_STORE = 0
const ZIP_METHOD_DEFLATE = 8

export function docxInflatedWithinLimit(
  buffer: Buffer,
  limit: number = MAX_DOCX_UNCOMPRESSED_BYTES,
): boolean {
  let remaining = limit
  let offset = 0
  while (offset < buffer.length) {
    const cd = buffer.indexOf(ZIP_CENTRAL_DIR_SIG, offset)
    if (cd === -1 || cd + 46 > buffer.length) break
    const method = buffer.readUInt16LE(cd + 10)
    const compSize = buffer.readUInt32LE(cd + 20)
    const localOff = buffer.readUInt32LE(cd + 42)
    offset = cd + 4

    if (localOff + 30 > buffer.length) continue
    const nameLen = buffer.readUInt16LE(localOff + 26)
    const extraLen = buffer.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + nameLen + extraLen
    if (dataStart > buffer.length) continue

    if (method === ZIP_METHOD_STORE) {
      // Stored: output === input; charge the real bytes present.
      remaining -= Math.min(compSize, buffer.length - dataStart)
    } else if (method === ZIP_METHOD_DEFLATE) {
      // Slice by declared compressed size when plausible, else to EOF —
      // inflateRawSync stops at the deflate terminus and ignores the rest.
      const end =
        compSize > 0 && dataStart + compSize <= buffer.length
          ? dataStart + compSize
          : buffer.length
      try {
        const out = inflateRawSync(buffer.subarray(dataStart, end), {
          maxOutputLength: Math.max(1, remaining),
        })
        remaining -= out.length
      } catch {
        // RangeError = exceeded the budget; any other = corrupt stream.
        // Either way this file is not safe/parseable — reject.
        return false
      }
    }
    // Unknown methods aren't inflated by mammoth's unzip either — skip.

    if (remaining < 0) return false
  }
  return true
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

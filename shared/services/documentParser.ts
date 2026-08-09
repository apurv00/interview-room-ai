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
 * Decompression-bomb guard for .docx: callers cap the COMPRESSED upload
 * size, but mammoth inflates the zip fully in memory — a 10MB docx can
 * expand to gigabytes. Sum the uncompressed sizes declared in the zip
 * central directory and refuse before inflating (Codex-class finding on
 * hire intake, applies to every docx caller). Exported for tests.
 */
const ZIP_CENTRAL_DIR_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02])
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

export function docxDeclaredUncompressedBytes(buffer: Buffer): number {
  let total = 0
  let offset = 0
  while (offset < buffer.length) {
    const idx = buffer.indexOf(ZIP_CENTRAL_DIR_SIG, offset)
    if (idx === -1 || idx + 28 > buffer.length) break
    const size = buffer.readUInt32LE(idx + 24)
    // 0xFFFFFFFF is the zip64 sentinel — treat as "declared enormous".
    total += size === 0xffffffff ? Number.MAX_SAFE_INTEGER : size
    if (total >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
    offset = idx + 4
  }
  return total
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
      if (docxDeclaredUncompressedBytes(buffer) > MAX_DOCX_UNCOMPRESSED_BYTES) {
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

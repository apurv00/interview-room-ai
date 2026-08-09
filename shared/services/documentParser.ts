import { Readable } from 'stream'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
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
 * Decompression-bomb defence for .docx — MEASURED with the same parser
 * mammoth uses, streamed, with a hard byte budget.
 *
 * Four review rounds landed here, and the discarded approaches are worth
 * recording because each looked right:
 *
 *  1. Trust the ZIP's declared uncompressed sizes → a bomb declares 1 byte.
 *  2. Resolve central-directory offsets ourselves → a ZIP64 sentinel offset
 *     made us skip an entry JSZip happily resolved and inflated.
 *  3. Ignore offsets, read the local header's compression method → JSZip
 *     takes method/size from the CENTRAL directory, so "stored" locally and
 *     "deflated" centrally slipped through. (1–3 are the same mistake:
 *     re-implementing a zip parser to predict another zip parser.)
 *  4. Run mammoth in a worker with a capped V8 heap → MEASURED INEFFECTIVE:
 *     pako inflates into Uint8Array backing stores, which are external
 *     memory and are not governed by old/young generation limits. A
 *     128MB-heap worker parsed a 400MB bomb from a 0.39MB upload to
 *     completion. It also broke tracing: a string `require` inside worker
 *     source is invisible to Next output tracing, so mammoth was absent
 *     from the standalone build and every DOCX would have 415'd in prod.
 *
 * What actually works: decompress with JSZip — the very library mammoth
 * parses with, so there is no parser to disagree with — as a STREAM,
 * counting bytes as they materialize and destroying the stream the moment
 * the budget is exceeded. Nothing declared is trusted (bytes are counted,
 * not read from a header), memory stays bounded (chunk-sized buffering plus
 * early abort), and the import is static so output tracing keeps mammoth
 * and jszip in the standalone image.
 *
 * Cost: a docx is inflated twice on the happy path (once to measure, once
 * by mammoth). Measured at ~150ms for a bomb and single-digit ms for a real
 * résumé — worth it for a bound that is actually a bound.
 */
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

export async function docxInflationWithinLimit(
  buffer: Buffer,
  limit: number = MAX_DOCX_UNCOMPRESSED_BYTES,
): Promise<boolean> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    // Not a readable archive — mammoth will fail with its own error; this
    // guard only decides whether inflation is safe to attempt.
    return true
  }

  let total = 0
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]
    if (entry.dir) continue
    const withinBudget = await new Promise<boolean>((resolve) => {
      // JSZip types this as its own ReadableStream; at runtime it is a
      // Node Readable, and destroy() is what stops pako mid-inflation.
      const stream = entry.nodeStream('nodebuffer') as unknown as Readable
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > limit) {
          stream.destroy()
          resolve(false)
        }
      })
      stream.on('end', () => resolve(true))
      // A corrupt entry is not a bomb: let mammoth report it.
      stream.on('error', () => resolve(true))
    })
    if (!withinBudget) return false
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
      // Measure inflation with JSZip (mammoth's own unzip library) before
      // letting mammoth inflate it — see the guard's header comment.
      if (!(await docxInflationWithinLimit(buffer))) {
        logger.warn({ filename, bytes: buffer.length }, 'docx rejected: inflation over budget')
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

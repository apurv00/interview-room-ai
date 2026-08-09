import { Worker } from 'worker_threads'
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
 * Decompression-bomb defence for .docx — a HARD memory ceiling, not a
 * prediction.
 *
 * History (three review rounds, one lesson): earlier versions inspected the
 * ZIP structure to estimate how much mammoth would inflate. Every version
 * was bypassed by metadata the attacker writes — declared uncompressed
 * sizes, then central-directory offsets (a ZIP64 sentinel), then the
 * compression method (JSZip takes method/size from the CENTRAL directory
 * but the data start from the LOCAL header). Each fix modelled the other
 * parser slightly better and was wrong slightly differently, and the
 * accounting could never be both complete and free of false rejections.
 *
 * So we stopped predicting the allocation and started BOUNDING it: mammoth
 * runs inside a worker whose V8 heap is capped. A bomb exhausts that heap
 * and the worker dies with ERR_WORKER_OUT_OF_MEMORY — the request fails
 * cleanly, the server is untouched, and no ZIP field is consulted anywhere.
 * There is nothing left for a crafted archive to lie about.
 *
 * Fail-closed: any worker failure (including a module-resolution problem)
 * surfaces as an unsupported-file error and is logged at ERROR, rather than
 * silently falling back to an unbounded in-process parse.
 */
const DOCX_WORKER_HEAP_MB = 128

const DOCX_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads')
const mammoth = require('mammoth')
mammoth
  .extractRawText({ buffer: Buffer.from(workerData) })
  .then((r) => parentPort.postMessage({ ok: true, text: r.value }))
  .catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e) }))
`

export async function extractDocxBounded(
  buffer: Buffer,
  heapMb: number = DOCX_WORKER_HEAP_MB,
): Promise<string> {
  const result = await new Promise<{ ok: boolean; text?: string; error?: string }>(
    (resolve) => {
      let worker: Worker
      try {
        worker = new Worker(DOCX_WORKER_SOURCE, {
          eval: true,
          workerData: buffer,
          resourceLimits: {
            maxOldGenerationSizeMb: heapMb,
            maxYoungGenerationSizeMb: 16,
          },
        })
      } catch (err) {
        resolve({ ok: false, error: `worker start failed: ${String(err)}` })
        return
      }
      let settled = false
      const done = (r: { ok: boolean; text?: string; error?: string }) => {
        if (settled) return
        settled = true
        resolve(r)
        void worker.terminate()
      }
      worker.on('message', done)
      worker.on('error', (err: NodeJS.ErrnoException) => {
        done({ ok: false, error: err.code || err.message })
      })
      worker.on('exit', (code) => {
        done({ ok: false, error: `worker exited (${code})` })
      })
    },
  )

  if (!result.ok) {
    logger.error({ reason: result.error }, 'docx worker parse failed')
    throw new UnsupportedFileTypeError(
      'We could not process that DOCX file. Please export it as PDF or plain text.',
    )
  }
  return result.text ?? ''
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
      // Bounded worker — see extractDocxBounded. A decompression bomb dies
      // with the worker instead of the server.
      rawText = await extractDocxBounded(buffer)
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

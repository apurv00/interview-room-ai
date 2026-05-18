/**
 * Tiny client-side Server-Sent Events (SSE) parser.
 *
 * Async-iterates frames off a `ReadableStream<Uint8Array>` — the shape
 * returned by `Response.body` from a `fetch()` against an SSE endpoint
 * (e.g. `/api/learn/drill/evaluate` after Wave-5 streaming work). Per
 * the W3C EventSource spec a "frame" is a sequence of `field: value`
 * lines terminated by a blank line; we surface each as a
 * `ParsedSSEEvent` carrying the `event` name (default `'message'`)
 * and the joined `data` field.
 *
 * Co-located in `modules/learn/lib/` because the drill page is the
 * only current consumer. Promote to `shared/services/` once a second
 * consumer appears.
 *
 * Limitations (intentionally minimal):
 *   - No reconnect / Last-Event-ID handling (those belong to
 *     EventSource itself; this parser is for `fetch`-driven streams
 *     that close on completion)
 *   - `data:` lines are joined with `\n` per spec, but most callers
 *     send a single line so this is a no-op
 *   - `id:` and `retry:` fields are surfaced but most callers ignore them
 */

export interface ParsedSSEEvent {
  event: string
  data: string
  id?: string
  retry?: number
}

/**
 * Parse an SSE stream into events. The reader is read exhaustively
 * until `done`. Consumer typically iterates with `for await`.
 *
 * Caller is responsible for handling `AbortSignal` on the underlying
 * `fetch` — when the request is aborted the reader will reject, which
 * surfaces as the iterator throwing. Wrap the for-await in try/catch
 * if you need to distinguish abort from network error.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ParsedSSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // Decoder may hold a trailing byte from an incomplete code
        // point that was split across chunks; flush it. If a complete
        // final frame is sitting in the buffer without a trailing
        // blank line, emit it (lenient closure).
        buffer += decoder.decode()
        const trailing = buffer.trim()
        if (trailing.length > 0) {
          const ev = parseFrame(trailing)
          if (ev) yield ev
        }
        return
      }
      // `stream: true` keeps the decoder ready for multi-byte chunks
      // that span chunk boundaries (e.g. an emoji split across two
      // reads). Without it, those bytes turn into replacement chars.
      buffer += decoder.decode(value, { stream: true })
      // Process all complete frames currently in the buffer. Frames
      // are separated by a blank line — `\n\n` or `\r\n\r\n`.
      let frameEnd: number
      while (
        (frameEnd = nextFrameBoundary(buffer)) !== -1
      ) {
        const frame = buffer.slice(0, frameEnd.valueOf())
        // Advance past the boundary AND any trailing newlines that
        // make up the blank-line separator.
        buffer = buffer.slice(frameEnd + (buffer[frameEnd] === '\r' ? 4 : 2))
        const ev = parseFrame(frame)
        if (ev) yield ev
      }
    }
  } finally {
    // Releasing the reader lock allows callers to e.g. cancel the body
    // without throwing on subsequent iteration attempts.
    reader.releaseLock()
  }
}

/**
 * Return the index of the next blank-line frame boundary in `buffer`,
 * or -1 if none. Handles both LF (`\n\n`) and CRLF (`\r\n\r\n`)
 * endings since real-world SSE producers use either.
 */
function nextFrameBoundary(buffer: string): number {
  // Prefer the earliest of either separator so we don't miss a CRLF
  // frame followed later by an LF frame (or vice versa).
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

/**
 * Parse a single SSE frame (one or more `field: value` lines, no
 * trailing blank line). Returns null when the frame is empty or
 * comprises only comment lines (lines starting with `:`).
 */
function parseFrame(frame: string): ParsedSSEEvent | null {
  let event = 'message'
  let id: string | undefined
  let retry: number | undefined
  const dataParts: string[] = []

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine
    if (line.length === 0) continue
    // Comment line per spec — discard silently.
    if (line.startsWith(':')) continue
    // Split on the FIRST `:` only; the value (with leading space
    // trimmed) is everything after.
    const colon = line.indexOf(':')
    let field: string
    let value: string
    if (colon === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
    }
    switch (field) {
      case 'event':
        event = value
        break
      case 'data':
        dataParts.push(value)
        break
      case 'id':
        id = value
        break
      case 'retry': {
        const n = Number(value)
        if (Number.isFinite(n) && n >= 0) retry = n
        break
      }
      // Unknown fields ignored per spec.
    }
  }

  if (dataParts.length === 0 && event === 'message') return null
  return {
    event,
    data: dataParts.join('\n'),
    ...(id !== undefined && { id }),
    ...(retry !== undefined && { retry }),
  }
}

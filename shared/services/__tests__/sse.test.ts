/**
 * Tests for the client-side SSE parser shared/services/sse.ts.
 *
 * Covers the edge cases the drill streaming evaluator (Phase 1) and
 * any future SSE consumer will hit:
 *   - Frame boundary detection (\n\n vs \r\n\r\n)
 *   - `event:` / `data:` / `id:` / `retry:` field parsing
 *   - Comment lines (`:` prefix) ignored
 *   - Multi-byte UTF-8 split across chunk boundaries decodes correctly
 *   - Incomplete final frame at stream-end is emitted (lenient)
 *   - Each chunk may contain partial or multiple frames
 */

import { describe, it, expect } from 'vitest'
import { parseSSEStream } from '../sse'

function stringStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe('parseSSEStream', () => {
  it('parses a single complete frame in one chunk', async () => {
    const events = await collect(
      parseSSEStream(stringStream(['event: score\ndata: {"dimension":"relevance","score":80}\n\n'])),
    )
    expect(events).toEqual([
      { event: 'score', data: '{"dimension":"relevance","score":80}' },
    ])
  })

  it('parses multiple frames in a single chunk', async () => {
    const stream = stringStream([
      'event: score\ndata: {"dimension":"relevance","score":80}\n\nevent: score\ndata: {"dimension":"structure","score":65}\n\n',
    ])
    const events = await collect(parseSSEStream(stream))
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('score')
    expect(events[1].event).toBe('score')
  })

  it('handles a frame split across multiple chunks', async () => {
    const stream = stringStream([
      'event: sco',
      're\ndata: {"dimension":"',
      'relevance","score":80}\n\n',
    ])
    const events = await collect(parseSSEStream(stream))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      event: 'score',
      data: '{"dimension":"relevance","score":80}',
    })
  })

  it('handles CRLF line endings (some producers emit them)', async () => {
    const events = await collect(
      parseSSEStream(stringStream(['event: complete\r\ndata: {"ok":true}\r\n\r\n'])),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'complete', data: '{"ok":true}' })
  })

  it('defaults event name to "message" when `event:` field is absent', async () => {
    const events = await collect(parseSSEStream(stringStream(['data: hello\n\n'])))
    expect(events).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('joins multiple `data:` lines with a newline', async () => {
    const events = await collect(
      parseSSEStream(stringStream(['data: line1\ndata: line2\ndata: line3\n\n'])),
    )
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2\nline3' }])
  })

  it('skips comment lines (starting with `:`)', async () => {
    const events = await collect(
      parseSSEStream(stringStream([': this is a comment\nevent: score\ndata: 1\n\n'])),
    )
    expect(events).toEqual([{ event: 'score', data: '1' }])
  })

  it('does not emit a frame that is only comments + no data field', async () => {
    const events = await collect(
      parseSSEStream(stringStream([': heartbeat 1\n\n: heartbeat 2\n\nevent: score\ndata: 1\n\n'])),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'score', data: '1' })
  })

  it('handles a multi-byte UTF-8 character split across chunk boundaries', async () => {
    // The emoji 🎉 is 4 bytes in UTF-8 (F0 9F 8E 89). Split across
    // two chunks so the decoder has to buffer the trailing bytes.
    const encoder = new TextEncoder()
    const fullBytes = encoder.encode('data: 🎉 done\n\n')
    const splitIndex = 8 // mid-emoji
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fullBytes.slice(0, splitIndex))
        controller.enqueue(fullBytes.slice(splitIndex))
        controller.close()
      },
    })
    const events = await collect(parseSSEStream(stream))
    expect(events).toEqual([{ event: 'message', data: '🎉 done' }])
  })

  it('emits a trailing frame even when the stream ends without a final blank line', async () => {
    // Some servers close immediately after the last frame without the
    // trailing \n\n. We're lenient — emit what we have.
    const events = await collect(
      parseSSEStream(stringStream(['event: complete\ndata: {"ok":true}'])),
    )
    expect(events).toEqual([{ event: 'complete', data: '{"ok":true}' }])
  })

  it('parses id + retry fields when present', async () => {
    const events = await collect(
      parseSSEStream(stringStream(['id: 42\nretry: 3000\nevent: score\ndata: 1\n\n'])),
    )
    expect(events).toEqual([
      { event: 'score', data: '1', id: '42', retry: 3000 },
    ])
  })

  it('ignores fields with an unrecognised name', async () => {
    const events = await collect(
      parseSSEStream(stringStream(['custom: ignored\nevent: score\ndata: 1\n\n'])),
    )
    expect(events).toEqual([{ event: 'score', data: '1' }])
  })

  it('correctly handles a value with no space after the colon', async () => {
    // Per spec, a single leading space after the colon is stripped;
    // a value with no space at all is fine too.
    const events = await collect(
      parseSSEStream(stringStream(['event:score\ndata:hello\n\n'])),
    )
    expect(events).toEqual([{ event: 'score', data: 'hello' }])
  })
})

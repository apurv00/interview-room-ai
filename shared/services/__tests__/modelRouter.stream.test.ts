/**
 * Tests for the new `streamCompletion()` primitive in modelRouter
 * (added for the drill streaming evaluator, Phase 1).
 *
 * Covers the contract drill evaluate + future SSE endpoints depend on:
 *
 *   - **Polyfill path**: a provider without a `.stream` method gets
 *     synthesized into a single delta + done from its `complete()`
 *     output. Callers never have to branch on capability.
 *   - **firstTextByteSeen fallback guard**: errors BEFORE the first
 *     non-empty delta retry the next provider in the chain; errors
 *     AFTER re-throw because we've already streamed bytes to the
 *     client and can't restart without corrupting the consumer.
 *   - **Boundary correctness**: empty deltas (e.g. OpenAI's
 *     `{role:'assistant'}` first chunk) do NOT flip the flag — we
 *     stay in "can still fall back" mode until real text arrives.
 *   - **AbortSignal passthrough**: signal is forwarded to both the
 *     adapter's `.stream` and `.complete` paths.
 *   - **Exhausted attempts**: all attempts fail → the final lastErr
 *     surfaces with provenance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ─────────────────────────────────────────────────

const { mockGetProvider } = vi.hoisted(() => ({
  mockGetProvider: vi.fn(),
}))

// Drop in our fake getProvider. Tests fully control which adapter
// shape is returned per attempt.
vi.mock('../providers/index', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  return {
    ...actual,
    getProvider: (...args: unknown[]) => mockGetProvider(...args),
  }
})

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// Avoid pulling Mongoose into the test runtime: the modelRouter
// imports ModelConfig for CMS lookups. We stub it so `resolveModel`
// falls back to the hardcoded TASK_SLOT_DEFAULTS path, which is what
// the test wants (predictable primary/fallback/default chain).
vi.mock('@shared/db/models/ModelConfig', () => ({
  ModelConfig: {
    find: () => ({ lean: async () => [] }),
    findOne: () => ({ lean: async () => null }),
  },
}))
vi.mock('@shared/db/connection', () => ({
  connectDB: async () => undefined,
}))

import { streamCompletion, replaceModelConfigCache } from '../modelRouter'
import type { StreamEvent } from '../providers/index'

/**
 * Inject a CMS-style config into the modelRouter cache so resolveModel
 * returns the desired primary+fallback for the test. Lets us drive a
 * multi-attempt chain without needing real Mongo.
 */
async function injectSlotConfig(opts: {
  primaryProvider: string
  primaryModel: string
  fallbackProvider?: string
  fallbackModel?: string
}) {
  await replaceModelConfigCache({
    routingEnabled: true,
    slots: [
      {
        taskSlot: 'learn.drill-evaluate',
        model: opts.primaryModel,
        provider: opts.primaryProvider,
        fallbackModel: opts.fallbackModel,
        fallbackProvider: opts.fallbackProvider,
        maxTokens: 1500,
        isActive: true,
      },
    ],
  })
}

// ─── Synthetic providers ───────────────────────────────────────────

/** Yield a sequence of StreamEvents as a real async iterable. */
function asyncIter(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

/** Yield N events then throw — useful for "fails AFTER first byte". */
function asyncIterThrowing(events: StreamEvent[], err: Error): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
      throw err
    },
  }
}

/** Async iterable that throws immediately — "fails BEFORE first byte". */
function asyncIterImmediateThrow(err: Error): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      throw err
      yield { kind: 'done', inputTokens: 0, outputTokens: 0, truncated: false }
    },
  }
}

beforeEach(() => {
  mockGetProvider.mockReset()
})

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

describe('streamCompletion — polyfill path', () => {
  it('synthesizes delta + done from complete() when provider has no .stream', async () => {
    mockGetProvider.mockReturnValue({
      name: 'polyfill-only',
      isConfigured: () => true,
      complete: vi.fn().mockResolvedValue({
        text: '{"relevance":80}',
        inputTokens: 50,
        outputTokens: 10,
        truncated: false,
      }),
      // no `stream` method
    })

    const events = await collect(
      streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    // Polyfill yields one delta then done.
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ kind: 'delta', text: '{"relevance":80}' })
    expect(events[1]).toEqual({
      kind: 'done',
      inputTokens: 50,
      outputTokens: 10,
      truncated: false,
    })
  })

  it('forwards AbortSignal to complete() on the polyfill path', async () => {
    const completeMock = vi.fn().mockResolvedValue({
      text: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      truncated: false,
    })
    mockGetProvider.mockReturnValue({
      name: 'polyfill-only',
      isConfigured: () => true,
      complete: completeMock,
    })

    const controller = new AbortController()
    await collect(
      streamCompletion(
        {
          taskSlot: 'learn.drill-evaluate',
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
        },
        controller.signal,
      ),
    )
    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(completeMock.mock.calls[0][1]).toBe(controller.signal)
  })
})

describe('streamCompletion — native streaming path', () => {
  it('pipes provider stream events through unchanged', async () => {
    const events: StreamEvent[] = [
      { kind: 'delta', text: 'hello' },
      { kind: 'delta', text: ' world' },
      { kind: 'done', inputTokens: 5, outputTokens: 2, truncated: false },
    ]
    mockGetProvider.mockReturnValue({
      name: 'streaming-provider',
      isConfigured: () => true,
      complete: vi.fn(),
      stream: vi.fn().mockReturnValue(asyncIter(events)),
    })

    const out = await collect(
      streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(out).toEqual(events)
  })

  it('forwards AbortSignal to provider.stream()', async () => {
    const streamMock = vi.fn().mockReturnValue(asyncIter([
      { kind: 'done', inputTokens: 0, outputTokens: 0, truncated: false },
    ]))
    mockGetProvider.mockReturnValue({
      name: 'streaming-provider',
      isConfigured: () => true,
      complete: vi.fn(),
      stream: streamMock,
    })

    const controller = new AbortController()
    await collect(
      streamCompletion(
        {
          taskSlot: 'learn.drill-evaluate',
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
        },
        controller.signal,
      ),
    )
    expect(streamMock.mock.calls[0][1]).toBe(controller.signal)
  })
})

describe('streamCompletion — firstTextByteSeen fallback guard', () => {
  it('retries next provider when primary fails BEFORE first byte', async () => {
    // Inject a primary that differs from the hardcoded default
    // (anthropic/claude-sonnet-4-6) so the chain has 2 attempts.
    await injectSlotConfig({ primaryProvider: 'fake-primary', primaryModel: 'm-1' })

    const completeOk = vi.fn().mockResolvedValue({
      text: '{"fallback":"ok"}',
      inputTokens: 1,
      outputTokens: 1,
      truncated: false,
    })
    mockGetProvider
      .mockReturnValueOnce({
        name: 'fake-primary',
        isConfigured: () => true,
        complete: vi.fn(),
        stream: vi.fn().mockReturnValue(asyncIterImmediateThrow(new Error('primary down'))),
      })
      .mockReturnValueOnce({
        name: 'anthropic', // hardcoded default for learn.drill-evaluate
        isConfigured: () => true,
        complete: completeOk,
      })

    const events = await collect(
      streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(events[0]).toEqual({ kind: 'delta', text: '{"fallback":"ok"}' })
    expect(events[1].kind).toBe('done')
  })

  it('re-throws when primary fails AFTER first byte (no fallback)', async () => {
    mockGetProvider.mockReturnValueOnce({
      name: 'primary',
      isConfigured: () => true,
      complete: vi.fn(),
      stream: vi.fn().mockReturnValue(
        asyncIterThrowing(
          [{ kind: 'delta', text: 'partial response' }],
          new Error('upstream dropped mid-stream'),
        ),
      ),
    })

    let caught: unknown
    const events: StreamEvent[] = []
    try {
      for await (const ev of streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        events.push(ev)
      }
    } catch (err) {
      caught = err
    }
    // Got the first delta…
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ kind: 'delta', text: 'partial response' })
    // …then the error propagated (no fallback attempted).
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('upstream dropped mid-stream')
    // CRITICAL: only ONE provider was consulted; the fallback was
    // NOT engaged because bytes already left the iterator.
    expect(mockGetProvider).toHaveBeenCalledTimes(1)
  })

  it('empty deltas do NOT flip firstTextByteSeen (boundary lives at first non-empty text)', async () => {
    // Two-attempt chain to expose the fallback engagement.
    await injectSlotConfig({ primaryProvider: 'fake-primary', primaryModel: 'm-1' })

    const completeOk = vi.fn().mockResolvedValue({
      text: 'fallback worked',
      inputTokens: 1,
      outputTokens: 1,
      truncated: false,
    })
    // Primary yields an EMPTY delta then throws — must still fall back.
    mockGetProvider
      .mockReturnValueOnce({
        name: 'fake-primary',
        isConfigured: () => true,
        complete: vi.fn(),
        stream: vi.fn().mockReturnValue(
          asyncIterThrowing(
            [{ kind: 'delta', text: '' }],
            new Error('primary down after empty delta'),
          ),
        ),
      })
      .mockReturnValueOnce({
        name: 'anthropic',
        isConfigured: () => true,
        complete: completeOk,
      })

    const events = await collect(
      streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    // Fallback engaged successfully — empty delta did not commit
    // us to the primary.
    expect(events.find((e) => e.kind === 'delta' && e.text === 'fallback worked')).toBeTruthy()
  })

  it('throws lastErr when all attempts fail', async () => {
    const err1 = new Error('primary down')
    mockGetProvider.mockReturnValue({
      name: 'any-provider',
      isConfigured: () => true,
      complete: vi.fn(),
      stream: vi.fn().mockReturnValue(asyncIterImmediateThrow(err1)),
    })

    let caught: unknown
    try {
      for await (const _ of streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // never reached
      }
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
  })

  it('skips a provider that is not registered + falls back to next', async () => {
    await injectSlotConfig({ primaryProvider: 'fake-primary', primaryModel: 'm-1' })

    const completeOk = vi.fn().mockResolvedValue({
      text: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      truncated: false,
    })
    mockGetProvider
      .mockReturnValueOnce(undefined) // primary not registered
      .mockReturnValueOnce({
        name: 'anthropic',
        isConfigured: () => true,
        complete: completeOk,
      })

    const events = await collect(
      streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(events[0]).toEqual({ kind: 'delta', text: 'ok' })
  })

  it('skips a provider that is not configured (missing API key) + falls back to next', async () => {
    await injectSlotConfig({ primaryProvider: 'fake-primary', primaryModel: 'm-1' })

    const completeOk = vi.fn().mockResolvedValue({
      text: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      truncated: false,
    })
    mockGetProvider
      .mockReturnValueOnce({
        name: 'fake-primary',
        isConfigured: () => false,
        complete: vi.fn(),
        stream: vi.fn(),
      })
      .mockReturnValueOnce({
        name: 'anthropic',
        isConfigured: () => true,
        complete: completeOk,
      })

    const events = await collect(
      streamCompletion({
        taskSlot: 'learn.drill-evaluate',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(events[0]).toEqual({ kind: 'delta', text: 'ok' })
  })
})

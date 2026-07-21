/**
 * Tests for the OpenAI adapter's streaming variant (Phase 1 of the
 * drill streaming evaluator).
 *
 * Locks the contract the modelRouter + drill route depend on:
 *   1. Each non-empty `delta.content` chunk yields a `kind:'delta'` event
 *   2. The first chunk (which carries only `{role:'assistant'}` with no
 *      content) does NOT yield a delta — keeps the modelRouter's
 *      "first non-empty text" fallback boundary clean
 *   3. The terminal usage-only chunk produces a `kind:'done'` event
 *      with input/output token counts AND truncated flag from the
 *      last seen finish_reason
 *   4. `stream_options.include_usage` is in the request (without it
 *      OpenAI returns null usage and our token counts are wrong)
 *   5. The model-family `__usesMaxCompletionTokens` dispatch is
 *      respected (reasoning models like gpt-5/o1 need
 *      `max_completion_tokens`, not `max_tokens`)
 *   6. AbortSignal is forwarded to the SDK request options
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

// Real `getProvider` will register adapters lazily. We mock the SDK
// before importing so the registration doesn't try to talk to OpenAI.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

// Use a real class (not vi.fn) so `new OpenAI()` in the adapter
// works — vi.fn() instances are not constructable in Vitest.
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } }
    },
  }
})

import { getProvider } from '../index'

// Two-step provider registration for vitest ESM mode:
//   1. Dynamic import of '../openai' runs its top-level
//      registerProvider() under the vitest transform (so `vi.mock`
//      for the 'openai' package is honored when the adapter does
//      `new OpenAI()`). A top-level static import here would fire
//      before vitest's runner is ready ("failed to find the runner").
//   2. The very first call to `getProvider(...)` invokes
//      `ensureInitialized()` which tries `require('./anthropic')`
//      and similar — those `require` calls don't resolve under
//      vitest ESM and throw. We swallow once because `_initialized`
//      is set to true BEFORE the failing requires, so subsequent
//      `getProvider` calls in tests skip the failing chain and find
//      our openai adapter in the registry.
beforeAll(async () => {
  process.env.OPENAI_API_KEY = 'sk-test'
  await import('../openai')
  try {
    getProvider('openai')
  } catch {
    /* expected — `_initialized` flag is flipped; tests can use getProvider freely */
  }
})

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test'
  mockCreate.mockReset()
})

/**
 * Build an async iterable that yields a sequence of synthetic
 * OpenAI ChatCompletionChunks. Mirrors the shape the SDK returns
 * when `stream: true`.
 */
function asyncIterableFrom<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

interface MockChunk {
  choices: Array<{
    index: number
    delta?: { role?: string; content?: string }
    finish_reason?: 'stop' | 'length' | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

describe('OpenAI adapter streaming', () => {
  it('disables SDK-internal retries for authority-gated completion and stream calls', async () => {
    const completionResponse = {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
    mockCreate.mockResolvedValueOnce(completionResponse)
    const provider = getProvider('openai')!

    await provider.complete({
      model: 'gpt-4o',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      disableSdkRetries: true,
    })
    expect(mockCreate.mock.calls[0][1]).toEqual({ maxRetries: 0 })

    mockCreate.mockResolvedValueOnce(asyncIterableFrom<MockChunk>([
      { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    ]))
    for await (const _ of provider.stream!({
      model: 'gpt-4o',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      disableSdkRetries: true,
    })) {
      // drain
    }
    expect(mockCreate.mock.calls[1][1]).toEqual({ maxRetries: 0 })
  })

  it('yields a delta per non-empty content chunk + a terminal done event', async () => {
    const chunks: MockChunk[] = [
      // First chunk — role-only, no content. MUST be skipped.
      { choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { choices: [{ index: 0, delta: { content: '{"rel' } }] },
      { choices: [{ index: 0, delta: { content: 'evance' } }] },
      { choices: [{ index: 0, delta: { content: '":80}' } }] },
      // Finish-reason chunk
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      // Terminal usage-only chunk
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 14, total_tokens: 134 } },
    ]
    mockCreate.mockResolvedValue(asyncIterableFrom(chunks))

    const provider = getProvider('openai')!
    const events: Array<{ kind: string; text?: string; inputTokens?: number; outputTokens?: number; truncated?: boolean }> = []
    for await (const ev of provider.stream!({
      model: 'gpt-5.6-luna',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }

    // 3 deltas (role-only chunk skipped) + 1 done
    expect(events).toHaveLength(4)
    expect(events[0]).toEqual({ kind: 'delta', text: '{"rel' })
    expect(events[1]).toEqual({ kind: 'delta', text: 'evance' })
    expect(events[2]).toEqual({ kind: 'delta', text: '":80}' })
    expect(events[3]).toEqual({
      kind: 'done',
      inputTokens: 120,
      outputTokens: 14,
      truncated: false,
    })
  })

  it('marks truncated=true when the last finish_reason is "length"', async () => {
    const chunks: MockChunk[] = [
      { choices: [{ index: 0, delta: { content: 'partial' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 1000, total_tokens: 1050 } },
    ]
    mockCreate.mockResolvedValue(asyncIterableFrom(chunks))

    const provider = getProvider('openai')!
    const events = []
    for await (const ev of provider.stream!({
      model: 'gpt-5.6-luna',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }
    const done = events[events.length - 1] as { kind: 'done'; truncated: boolean }
    expect(done.truncated).toBe(true)
  })

  it('includes stream_options.include_usage in the request body', async () => {
    mockCreate.mockResolvedValue(
      asyncIterableFrom<MockChunk>([
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      ]),
    )

    const provider = getProvider('openai')!
    const events = []
    for await (const ev of provider.stream!({
      model: 'gpt-5.6-luna',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const body = mockCreate.mock.calls[0][0]
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('uses max_completion_tokens (not max_tokens) for reasoning models', async () => {
    mockCreate.mockResolvedValue(
      asyncIterableFrom<MockChunk>([
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      ]),
    )

    const provider = getProvider('openai')!
    for await (const _ of provider.stream!({
      model: 'gpt-5.6-luna', // matches /^(gpt-5|o[1-4])/
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 250,
    })) {
      // drain
    }

    const body = mockCreate.mock.calls[0][0]
    expect(body.max_completion_tokens).toBe(250)
    expect(body.max_tokens).toBeUndefined()
  })

  it('uses max_tokens for legacy models (gpt-4 etc.)', async () => {
    mockCreate.mockResolvedValue(
      asyncIterableFrom<MockChunk>([
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      ]),
    )

    const provider = getProvider('openai')!
    for await (const _ of provider.stream!({
      model: 'gpt-4o',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 250,
    })) {
      // drain
    }

    const body = mockCreate.mock.calls[0][0]
    expect(body.max_tokens).toBe(250)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('forwards an AbortSignal to the SDK request options', async () => {
    mockCreate.mockResolvedValue(
      asyncIterableFrom<MockChunk>([
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      ]),
    )

    const controller = new AbortController()
    const provider = getProvider('openai')!
    for await (const _ of provider.stream!(
      {
        model: 'gpt-5.6-luna',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      },
      controller.signal,
    )) {
      // drain
    }

    // SDK options object is the second arg.
    const options = mockCreate.mock.calls[0][1]
    expect(options?.signal).toBe(controller.signal)
  })

  it('does NOT forward `signal` when none was provided (omits the second arg)', async () => {
    mockCreate.mockResolvedValue(
      asyncIterableFrom<MockChunk>([
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      ]),
    )

    const provider = getProvider('openai')!
    for await (const _ of provider.stream!({
      model: 'gpt-5.6-luna',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      // drain
    }

    expect(mockCreate.mock.calls[0][1]).toBeUndefined()
  })
})

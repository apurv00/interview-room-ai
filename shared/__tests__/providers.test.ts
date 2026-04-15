/**
 * Provider adapter truncation-detection tests.
 *
 * Validates that OpenAI and Anthropic adapters surface `truncated: true`
 * in CompletionResponse when the model hit max_tokens mid-generation.
 *
 * Historical bug: adapters dropped `finish_reason` / `stop_reason` on the
 * floor, so callers saw a mid-sentence answer and treated it as normal.
 * See .claude/audit/current/impact-openai.ts.md and
 * .claude/audit/current/impact-anthropic.ts.md.
 *
 * Strategy: we spy on `registerProvider` so the adapter object flows into
 * a test-local map on module import. This avoids going through the real
 * registry + `ensureInitialized`, which triggers cross-module requires
 * that are fragile under vite-node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderAdapter } from '../services/providers/index'

// ─── Hoisted SDK mocks + captured registrations ──────────────────────────
const { mockOpenAICreate, mockAnthropicCreate, captured } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
  mockAnthropicCreate: vi.fn(),
  captured: new Map<string, unknown>(),
}))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } }
  },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate }
  },
}))

// Replace registerProvider so the adapter lands in `captured` instead of
// the real registry — sidesteps the require('./anthropic') chain that
// ensureInitialized runs.
vi.mock('../services/providers/index', async () => {
  const actual = await vi.importActual<typeof import('../services/providers/index')>(
    '../services/providers/index',
  )
  return {
    ...actual,
    registerProvider: (adapter: unknown) => {
      const a = adapter as { name: string }
      captured.set(a.name, adapter)
    },
  }
})

process.env.OPENAI_API_KEY = 'test-openai-key'
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

describe('OpenAI provider adapter', () => {
  beforeEach(() => {
    mockOpenAICreate.mockReset()
  })

  async function getAdapter(): Promise<ProviderAdapter> {
    await import('../services/providers/openai')
    const adapter = captured.get('openai') as ProviderAdapter | undefined
    expect(adapter).toBeDefined()
    return adapter!
  }

  const baseParams = {
    model: 'gpt-test',
    system: 'sys',
    messages: [{ role: 'user' as const, content: 'hi' }],
    maxTokens: 100,
  }

  it('sets truncated: true when finish_reason is "length"', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'partial answer cut o' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    })
    const adapter = await getAdapter()
    const result = await adapter.complete(baseParams)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('partial answer cut o')
    expect(result.outputTokens).toBe(100)
  })

  it('sets truncated: false when finish_reason is "stop"', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'complete answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    })
    const adapter = await getAdapter()
    const result = await adapter.complete(baseParams)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('complete answer.')
  })

  // ── Token-parameter dispatch by model family ──
  // Reasoning / GPT-5+ / o1+ / o3+ / o4+ models reject `max_tokens` and
  // require `max_completion_tokens`. Legacy chat models (gpt-4, gpt-4o,
  // gpt-3.5) still use `max_tokens`. Historical bug: the adapter hardcoded
  // `max_tokens` for all models, producing 400 `unsupported_parameter` on
  // every call to gpt-5.4-mini in production.

  it.each([
    ['gpt-5.4-mini'],
    ['gpt-5-nano'],
    ['gpt-5'],
    ['o1-preview'],
    ['o1-mini'],
    ['o3'],
    ['o3-mini'],
    ['o4'],
  ])('uses max_completion_tokens for reasoning model %s', async (model) => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({ ...baseParams, model, maxTokens: 777 })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.model).toBe(model)
    expect(sentArgs.max_completion_tokens).toBe(777)
    expect(sentArgs.max_tokens).toBeUndefined()
  })

  it.each([
    ['gpt-4o-mini'],
    ['gpt-4o'],
    ['gpt-4.1'],
    ['gpt-4-turbo'],
    ['gpt-4'],
    ['gpt-3.5-turbo'],
  ])('uses max_tokens for legacy model %s', async (model) => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({ ...baseParams, model, maxTokens: 500 })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.model).toBe(model)
    expect(sentArgs.max_tokens).toBe(500)
    expect(sentArgs.max_completion_tokens).toBeUndefined()
  })
})

describe('Anthropic provider adapter', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset()
  })

  async function getAdapter(): Promise<ProviderAdapter> {
    await import('../services/providers/anthropic')
    const adapter = captured.get('anthropic') as ProviderAdapter | undefined
    expect(adapter).toBeDefined()
    return adapter!
  }

  const baseParams = {
    model: 'claude-test',
    system: 'sys',
    messages: [{ role: 'user' as const, content: 'hi' }],
    maxTokens: 100,
  }

  it('sets truncated: true when stop_reason is "max_tokens"', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'partial response clipped mid-' }],
      usage: { input_tokens: 2600, output_tokens: 300 },
      stop_reason: 'max_tokens',
    })
    const adapter = await getAdapter()
    const result = await adapter.complete(baseParams)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('partial response clipped mid-')
    expect(result.inputTokens).toBe(2600)
  })

  it('sets truncated: false when stop_reason is "end_turn"', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'complete response.' }],
      usage: { input_tokens: 2600, output_tokens: 50 },
      stop_reason: 'end_turn',
    })
    const adapter = await getAdapter()
    const result = await adapter.complete(baseParams)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('complete response.')
  })
})

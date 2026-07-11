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
process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

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
    ['gpt-5.6-luna'],
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

  // ── Temperature dispatch by model family ──
  // GPT-5.6 (sol/terra/luna) and o-series models lock `temperature` to the
  // default (1) — any other value returns 400 `unsupported_value` (verified
  // live against all three 5.6 tiers, 2026-07-11). Earlier GPT-5.x models
  // (gpt-5.4-mini) accept custom temperature. The adapter must omit the
  // param for locked models or every conversational route (turn-router,
  // clarify-case-context, answer-candidate-question — all pass temperature)
  // 400s on every call.

  it.each([
    ['gpt-5.6-luna'],
    ['gpt-5.6-terra'],
    ['gpt-5.6-sol'],
    ['o3-mini'],
    ['o1-preview'],
  ])('omits temperature for locked model %s', async (model) => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({ ...baseParams, model, temperature: 0.2 })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.temperature).toBeUndefined()
  })

  it.each([
    ['gpt-5.4-mini'],
    ['gpt-5-nano'],
    ['gpt-4o'],
    ['gpt-3.5-turbo'],
  ])('passes temperature through for %s', async (model) => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({ ...baseParams, model, temperature: 0.2 })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.temperature).toBe(0.2)
  })

  // ── reasoning_effort dispatch by model family ──
  // Sent ONLY to the GPT-5.6 family, whose vocabulary
  // (none/low/medium/high/xhigh) was verified live 2026-07-11 ('max' and
  // GPT-5.0's 'minimal' are 400s). Other models — including gpt-5.4-mini
  // and the o-series with their different vocabularies — get the param
  // dropped so an unsupported value can never 400 a CMS-re-routed slot.

  it.each([
    ['none'],
    ['low'],
    ['medium'],
    ['high'],
    ['xhigh'],
  ])('sends reasoning_effort=%s for gpt-5.6-luna', async (effort) => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({
      ...baseParams,
      model: 'gpt-5.6-luna',
      reasoningEffort: effort as 'none' | 'low' | 'medium' | 'high' | 'xhigh',
    })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.reasoning_effort).toBe(effort)
  })

  it.each([
    ['gpt-5.4-mini'],
    ['gpt-4o'],
    ['o3-mini'],
    ['gpt-3.5-turbo'],
  ])('omits reasoning_effort for non-5.6 model %s', async (model) => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({ ...baseParams, model, reasoningEffort: 'high' })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.reasoning_effort).toBeUndefined()
  })

  it('omits reasoning_effort entirely when not set (default model behavior applies)', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    await adapter.complete({ ...baseParams, model: 'gpt-5.6-luna' })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.reasoning_effort).toBeUndefined()
  })

  it('sends strict json_schema response_format when requested', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    })
    const adapter = await getAdapter()
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    }
    await adapter.complete({
      ...baseParams,
      responseFormat: { type: 'json_schema', name: 'test_schema', strict: true, schema },
    })
    const sentArgs = mockOpenAICreate.mock.calls[0][0]
    expect(sentArgs.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_schema', strict: true, schema },
    })
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

  it('uses forced tool use for json_schema response format', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'feedback_core', input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 15 },
      stop_reason: 'tool_use',
    })
    const adapter = await getAdapter()
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    }
    const result = await adapter.complete({
      ...baseParams,
      responseFormat: { type: 'json_schema', name: 'feedback_core', strict: true, schema },
    })
    expect(result.text).toBe('{"ok":true}')
    expect(mockAnthropicCreate.mock.calls[0][0]).toMatchObject({
      tools: [{ name: 'feedback_core', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'feedback_core' },
    })
  })
})

describe('OpenRouter provider adapter', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset()
  })

  async function getAdapter(): Promise<ProviderAdapter> {
    await import('../services/providers/openrouter')
    const adapter = captured.get('openrouter') as ProviderAdapter | undefined
    expect(adapter).toBeDefined()
    return adapter!
  }

  it('uses forced tool use for json_schema response format', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'feedback_core', input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 15 },
      stop_reason: 'tool_use',
    })
    const adapter = await getAdapter()
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    }
    const result = await adapter.complete({
      model: 'openrouter-model',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      responseFormat: { type: 'json_schema', name: 'feedback_core', strict: true, schema },
    })
    expect(result.text).toBe('{"ok":true}')
    expect(result.truncated).toBe(false)
    expect(mockAnthropicCreate.mock.calls[0][0]).toMatchObject({
      tools: [{ name: 'feedback_core', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'feedback_core' },
    })
  })
})

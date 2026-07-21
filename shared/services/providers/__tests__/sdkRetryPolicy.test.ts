import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAnthropicCreate, mockOpenAICreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate }
  },
}))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } }
  },
}))

import { getProvider } from '../index'

const params = {
  model: 'test-model',
  system: 'system',
  messages: [{ role: 'user' as const, content: 'sensitive input' }],
  maxTokens: 100,
}

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test'
  process.env.OPENROUTER_API_KEY = 'test'
  process.env.GROQ_API_KEY = 'test'
  await Promise.all([
    import('../anthropic'),
    import('../openrouter'),
    import('../groq'),
  ])
  try {
    getProvider('anthropic')
  } catch {
    // Built-in CommonJS auto-registration is unavailable under Vitest ESM;
    // the explicit imports above already registered the adapters under test.
  }
})

beforeEach(() => {
  mockAnthropicCreate.mockReset().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  })
  mockOpenAICreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })
})

describe('provider SDK retry policy', () => {
  it.each(['anthropic', 'openrouter'] as const)(
    '%s disables SDK retries only for authority-gated calls',
    async (name) => {
      const provider = getProvider(name)!
      await provider.complete({ ...params, disableSdkRetries: true })
      expect(mockAnthropicCreate.mock.calls[0][1]).toEqual({ maxRetries: 0 })

      await provider.complete(params)
      expect(mockAnthropicCreate.mock.calls[1][1]).toBeUndefined()
    },
  )

  it('groq disables OpenAI-SDK retries only for authority-gated calls', async () => {
    const provider = getProvider('groq')!
    await provider.complete({ ...params, disableSdkRetries: true })
    expect(mockOpenAICreate.mock.calls[0][1]).toEqual({ maxRetries: 0 })

    await provider.complete(params)
    expect(mockOpenAICreate.mock.calls[1][1]).toBeUndefined()
  })
})

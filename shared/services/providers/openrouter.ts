import Anthropic from '@anthropic-ai/sdk'
import { registerProvider, type CompletionParams, type CompletionResponse } from './index'

let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  }
  return _client
}

registerProvider({
  name: 'openrouter',
  label: 'OpenRouter (any model)',

  isConfigured: () => !!process.env.OPENROUTER_API_KEY,

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const client = getClient()
    const message = await client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    })
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    return {
      text,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    }
  },
})

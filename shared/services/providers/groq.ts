import OpenAI from 'openai'
import { registerProvider, type CompletionParams, type CompletionResponse } from './index'

// Groq provides an OpenAI-compatible API — we use the OpenAI SDK
// pointed at Groq's endpoint.

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    })
  }
  return _client
}

registerProvider({
  name: 'groq',
  label: 'Groq (fast inference)',

  isConfigured: () => !!process.env.GROQ_API_KEY,

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const client = getClient()
    const response = await client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: [
        { role: 'system', content: params.system },
        ...params.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ],
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    })
    const text = response.choices[0]?.message?.content?.trim() ?? ''
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    }
  },
})

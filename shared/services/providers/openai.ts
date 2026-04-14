import OpenAI from 'openai'
import { registerProvider, type CompletionParams, type CompletionResponse } from './index'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI()
  }
  return _client
}

registerProvider({
  name: 'openai',
  label: 'OpenAI (direct)',

  isConfigured: () => !!process.env.OPENAI_API_KEY,

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
    const finishReason = response.choices[0]?.finish_reason
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      truncated: finishReason === 'length',
    }
  },
})

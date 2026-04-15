import OpenAI from 'openai'
import { registerProvider, type CompletionParams, type CompletionResponse } from './index'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI()
  }
  return _client
}

// Reasoning / next-gen chat models (GPT-5.x, o1-*, o3-*, o4-*) reject the
// legacy `max_tokens` parameter and require `max_completion_tokens` instead.
// Older chat models (gpt-4, gpt-4o, gpt-3.5) still use `max_tokens`. We
// dispatch on the model name prefix because the two parameter names are
// mutually exclusive in the API contract — sending the wrong one returns
// 400 `unsupported_parameter`.
const MAX_COMPLETION_TOKENS_MODEL_RE = /^(gpt-5|o[1-4])/

export function __usesMaxCompletionTokens(model: string): boolean {
  return MAX_COMPLETION_TOKENS_MODEL_RE.test(model)
}

registerProvider({
  name: 'openai',
  label: 'OpenAI (direct)',

  isConfigured: () => !!process.env.OPENAI_API_KEY,

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const client = getClient()
    const tokenParam = __usesMaxCompletionTokens(params.model)
      ? { max_completion_tokens: params.maxTokens }
      : { max_tokens: params.maxTokens }
    const response = await client.chat.completions.create({
      model: params.model,
      ...tokenParam,
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

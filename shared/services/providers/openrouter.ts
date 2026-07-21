import Anthropic from '@anthropic-ai/sdk'
import {
  registerProvider,
  type CompletionParams,
  type CompletionResponse,
  type CompletionResponseFormat,
} from './index'

let _client: Anthropic | null = null

interface AnthropicMessageResponse {
  content: Array<Record<string, unknown>>
  usage: {
    input_tokens: number
    output_tokens: number
  }
  stop_reason?: string | null
}

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  }
  return _client
}

function forcedToolFor(format: CompletionResponseFormat | undefined) {
  if (!format) return {}
  const name = format.type === 'json_schema' ? format.name : 'json_response'
  const inputSchema = format.type === 'json_schema'
    ? format.schema
    : { type: 'object', additionalProperties: true }
  return {
    tools: [{
      name,
      description: 'Return the requested structured JSON object.',
      input_schema: inputSchema,
    }],
    tool_choice: { type: 'tool', name },
  }
}

function extractText(message: AnthropicMessageResponse, format: CompletionResponseFormat | undefined): string {
  const content = message.content
  if (format) {
    const toolUse = content.find((block) => block.type === 'tool_use')
    if (!toolUse) return ''
    return JSON.stringify(toolUse.input ?? {})
  }
  const textBlock = content.find((block) => block.type === 'text')
  return typeof textBlock?.text === 'string' ? textBlock.text.trim() : ''
}

registerProvider({
  name: 'openrouter',
  label: 'OpenRouter (any model)',

  isConfigured: () => !!process.env.OPENROUTER_API_KEY,

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const client = getClient()
    const message = await client.messages.create(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: params.messages,
        ...(params.temperature !== undefined && { temperature: params.temperature }),
        ...forcedToolFor(params.responseFormat),
      } as Parameters<Anthropic['messages']['create']>[0],
      params.disableSdkRetries ? { maxRetries: 0 } : undefined,
    ) as unknown as AnthropicMessageResponse
    const text = extractText(message, params.responseFormat)
    return {
      text,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      truncated: message.stop_reason === 'max_tokens',
    }
  },
})

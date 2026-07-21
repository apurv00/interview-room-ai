import OpenAI from 'openai'
import {
  registerProvider,
  type CompletionParams,
  type CompletionResponse,
  type StreamEvent,
} from './index'

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

// The GPT-5.6 family (sol/terra/luna) and o-series reasoning models lock
// `temperature` to the default (1) — any other value returns 400
// `unsupported_value` (verified live against all three 5.6 tiers,
// 2026-07-11). Earlier GPT-5.x models (gpt-5.4-mini) still accept custom
// temperature. Omit the param entirely for locked models: the server-side
// default (1) applies, and callers' intent is preserved for any model that
// does support it.
const TEMPERATURE_LOCKED_MODEL_RE = /^(gpt-5\.6|o[1-4])/

export function __supportsCustomTemperature(model: string): boolean {
  return !TEMPERATURE_LOCKED_MODEL_RE.test(model)
}

// `reasoning_effort` is sent ONLY to the GPT-5.6 family, whose accepted
// vocabulary (none/low/medium/high/xhigh) we verified live 2026-07-11.
// Other reasoning models use different vocabularies (GPT-5.0 uses
// 'minimal', o-series has no 'none') — sending an unsupported value is a
// 400, so for any other model the param is dropped and the model's own
// default applies. Widen deliberately (with a live check) per family.
const REASONING_EFFORT_MODEL_RE = /^gpt-5\.6/

export function __supportsReasoningEffort(model: string): boolean {
  return REASONING_EFFORT_MODEL_RE.test(model)
}

/**
 * Build the request body shared between `complete()` and `stream()`.
 * Factored out so the two paths can't drift on parameter defaults
 * (token-name dispatch, response_format, message ordering, etc.).
 */
function buildRequestBody(params: CompletionParams) {
  const tokenParam = __usesMaxCompletionTokens(params.model)
    ? { max_completion_tokens: params.maxTokens }
    : { max_tokens: params.maxTokens }
  const responseFormat = params.responseFormat?.type === 'json_schema'
    ? {
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: params.responseFormat.name,
            strict: params.responseFormat.strict ?? true,
            schema: params.responseFormat.schema,
          },
        },
      }
    : params.responseFormat?.type === 'json_object'
    ? { response_format: { type: 'json_object' as const } }
    : {}
  return {
    model: params.model,
    ...tokenParam,
    ...responseFormat,
    messages: [
      { role: 'system' as const, content: params.system },
      ...params.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ],
    ...(params.temperature !== undefined &&
      __supportsCustomTemperature(params.model) && { temperature: params.temperature }),
    ...(params.reasoningEffort !== undefined &&
      __supportsReasoningEffort(params.model) && { reasoning_effort: params.reasoningEffort }),
  }
}

function sdkRequestOptions(params: CompletionParams, signal?: AbortSignal) {
  if (!signal && !params.disableSdkRetries) return undefined
  return {
    ...(signal ? { signal } : {}),
    ...(params.disableSdkRetries ? { maxRetries: 0 } : {}),
  }
}

registerProvider({
  name: 'openai',
  label: 'OpenAI (direct)',

  isConfigured: () => !!process.env.OPENAI_API_KEY,

  async complete(params: CompletionParams, signal?: AbortSignal): Promise<CompletionResponse> {
    const client = getClient()
    const response = await client.chat.completions.create(
      buildRequestBody(params),
      sdkRequestOptions(params, signal),
    )
    const text = response.choices[0]?.message?.content?.trim() ?? ''
    const finishReason = response.choices[0]?.finish_reason
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      truncated: finishReason === 'length',
    }
  },

  /**
   * Streaming variant. Yields `kind:'delta'` events for each non-empty
   * `delta.content` chunk and one terminal `kind:'done'` event with
   * usage + truncation flag.
   *
   * - `stream: true` opt-in
   * - `stream_options: { include_usage: true }` is REQUIRED to get
   *   `chunk.usage` on the final empty-choices chunk (without this,
   *   usage is null and our done-event has zero token counts)
   * - First-chunk skip: OpenAI's first chunk is usually
   *   `delta: {role:'assistant'}` with no `content`. Skipping it
   *   here keeps the modelRouter's "first non-empty text" fallback
   *   boundary clean (Plan-agent review on streaming PR plan).
   * - `signal` propagated to the SDK so client disconnects abort
   *   the upstream call.
   */
  async *stream(
    params: CompletionParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const client = getClient()
    const requestBody = {
      ...buildRequestBody(params),
      stream: true as const,
      stream_options: { include_usage: true },
    }
    const stream = await client.chat.completions.create(
      requestBody,
      sdkRequestOptions(params, signal),
    )

    let usagePromptTokens = 0
    let usageCompletionTokens = 0
    let finishReason: string | null = null

    for await (const chunk of stream) {
      // The terminal usage-only chunk has `choices: []` (no delta).
      if (chunk.usage) {
        usagePromptTokens = chunk.usage.prompt_tokens ?? 0
        usageCompletionTokens = chunk.usage.completion_tokens ?? 0
      }
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta?.content
      // Skip empty deltas — the first chunk's `{role:'assistant'}` has
      // no content and must NOT count as "first byte" for the
      // modelRouter's fallback-chain boundary.
      if (typeof delta === 'string' && delta.length > 0) {
        yield { kind: 'delta', text: delta }
      }
    }

    yield {
      kind: 'done',
      inputTokens: usagePromptTokens,
      outputTokens: usageCompletionTokens,
      truncated: finishReason === 'length',
    }
  },
})

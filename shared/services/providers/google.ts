import { registerProvider, type CompletionParams, type CompletionResponse } from './index'

let _model: unknown = null
let _genAI: unknown = null

async function getGenAI() {
  if (!_genAI) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    _genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY!)
  }
  return _genAI as import('@google/generative-ai').GoogleGenerativeAI
}

registerProvider({
  name: 'google',
  label: 'Google Gemini',

  isConfigured: () => !!process.env.GOOGLE_AI_API_KEY,

  async complete(params: CompletionParams): Promise<CompletionResponse> {
    const genAI = await getGenAI()
    const model = genAI.getGenerativeModel({
      model: params.model,
      systemInstruction: params.system,
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        ...(params.temperature !== undefined && { temperature: params.temperature }),
      },
    })

    // Convert messages to Gemini format (alternating user/model parts)
    const contents = params.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: m.content }],
    }))

    const result = await model.generateContent({ contents })
    const response = result.response
    const text = response.text().trim()

    // Gemini provides token counts via usageMetadata
    const usage = response.usageMetadata
    return {
      text,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    }
  },
})

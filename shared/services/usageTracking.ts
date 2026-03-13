import { connectDB } from '@shared/db/connection'
import { UsageRecord } from '@shared/db/models/UsageRecord'
import { aiLogger } from '@shared/logger'
import type { AuthUser } from '@shared/middleware/withAuth'
import mongoose from 'mongoose'

interface TrackUsageInput {
  user: AuthUser
  type: 'api_call_question' | 'api_call_evaluate' | 'api_call_feedback'
  sessionId?: string
  inputTokens: number
  outputTokens: number
  modelUsed: string
  durationMs: number
  success: boolean
  errorMessage?: string
}

// Pricing per 1K tokens (approximate)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
}

export async function trackUsage(input: TrackUsageInput): Promise<void> {
  // Skip for anonymous users — no valid ObjectId
  if (input.user.id === 'anonymous') return

  try {
    await connectDB()

    const pricing = PRICING[input.modelUsed] || { input: 0.015, output: 0.075 }
    const costUsd =
      (input.inputTokens / 1000) * pricing.input +
      (input.outputTokens / 1000) * pricing.output

    await UsageRecord.create({
      userId: new mongoose.Types.ObjectId(input.user.id),
      organizationId: input.user.organizationId
        ? new mongoose.Types.ObjectId(input.user.organizationId)
        : undefined,
      type: input.type,
      sessionId: input.sessionId
        ? new mongoose.Types.ObjectId(input.sessionId)
        : undefined,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      modelUsed: input.modelUsed,
      costUsd,
      durationMs: input.durationMs,
      success: input.success,
      errorMessage: input.errorMessage,
    })

    aiLogger.debug(
      { type: input.type, tokens: input.inputTokens + input.outputTokens, costUsd },
      'Usage tracked'
    )
  } catch (err) {
    aiLogger.error({ err, type: input.type }, 'Failed to track usage')
    // Fail silently — don't break the API response
  }
}

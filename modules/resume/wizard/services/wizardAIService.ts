import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { aiLogger } from '@shared/logger'
import { trackUsage } from '@shared/services/usageTracking'
import { connectDB } from '@shared/db/connection'
import { extractJSON } from '@shared/utils'
import { WizardSession } from '@shared/db/models/WizardSession'
import { WizardConfig } from '@shared/db/models/WizardConfig'
import { WIZARD_COST_CAP_USD, FALLBACK_FOLLOW_UPS, SEGMENT_PROMPT_CONTEXT } from '../config/wizardConfig'
import type { AuthUser } from '@shared/middleware/composeApiRoute'

// ─── Cost Cap Check ────────────────────────────────────────────────────────

export async function checkCostCap(sessionId: string): Promise<{ allowed: boolean; remaining: number }> {
  await connectDB()

  // Fetch dynamic config from DB (falls back to static defaults)
  const config = await WizardConfig.getConfig()
  if (!config.costCapEnabled) {
    return { allowed: true, remaining: Infinity }
  }

  const capUsd = config.costCapUsd ?? WIZARD_COST_CAP_USD
  const session = await WizardSession.findById(sessionId).select('aiCostUsd').lean()
  if (!session) return { allowed: false, remaining: 0 }
  const remaining = capUsd - (session.aiCostUsd || 0)
  return { allowed: remaining > 0, remaining }
}

async function updateSessionCost(sessionId: string, cost: number): Promise<void> {
  await WizardSession.updateOne(
    { _id: sessionId },
    { $inc: { aiCostUsd: cost, aiCallCount: 1 } }
  )
}

// ─── Generate Follow-Up Questions ──────────────────────────────────────────

export async function generateFollowUpQuestions(
  user: AuthUser,
  sessionId: string,
  data: {
    jobTitle: string
    company?: string
    rawDescription: string
    segment: string
  }
): Promise<{ questions: string[]; cost: number; model: string }> {
  const { allowed } = await checkCostCap(sessionId)
  if (!allowed) {
    aiLogger.info({ sessionId }, 'Cost cap reached, using fallback follow-ups')
    return {
      questions: FALLBACK_FOLLOW_UPS[data.segment] || FALLBACK_FOLLOW_UPS.default,
      cost: 0,
      model: 'fallback',
    }
  }

  const segmentContext = SEGMENT_PROMPT_CONTEXT[data.segment] || ''
  const startTime = Date.now()

  try {
    const followUpResult = await completion({
      taskSlot: 'resume.wizard-followup',
      system: `${DATA_BOUNDARY_RULE}

You are an expert resume consultant helping a candidate build a strong resume. ${segmentContext}

Generate 2-3 targeted follow-up questions about their role to extract quantifiable achievements, specific metrics, and impactful details that will strengthen their resume bullets.

Rules:
- Questions should probe for numbers, metrics, team sizes, dollar amounts, percentages
- Tailor questions to the industry and role level
- Keep questions conversational and easy to answer
- ${JSON_OUTPUT_RULE}`,
      messages: [{
        role: 'user',
        content: `<role_info>
Job Title: ${data.jobTitle}
${data.company ? `Company: ${data.company}` : ''}
Description: ${data.rawDescription}
</role_info>

Generate 2-3 follow-up questions to help this candidate add metrics and impact to their resume bullets.`,
      }],
    })

    const durationMs = Date.now() - startTime
    const raw = followUpResult.text || '[]'
    const inputTokens = followUpResult.inputTokens
    const outputTokens = followUpResult.outputTokens

    // Track usage
    trackUsage({
      user,
      type: 'api_call_wizard_followup',
      sessionId,
      inputTokens,
      outputTokens,
      modelUsed: followUpResult.model,
      durationMs,
      success: true,
    }).catch(() => {})

    const cost = (inputTokens / 1000) * 0.001 + (outputTokens / 1000) * 0.005
    await updateSessionCost(sessionId, cost)

    const cleaned = extractJSON(raw)
    try {
      const questions = JSON.parse(cleaned)
      if (Array.isArray(questions) && questions.length > 0) {
        return { questions: questions.slice(0, 3), cost, model: followUpResult.model }
      }
    } catch {
      aiLogger.error({ raw: raw.slice(0, 300) }, 'Follow-up questions JSON parse failed')
    }

    // Parse failed — use fallback
    return {
      questions: FALLBACK_FOLLOW_UPS[data.segment] || FALLBACK_FOLLOW_UPS.default,
      cost,
      model: 'fallback',
    }
  } catch (err) {
    aiLogger.error({ err, sessionId }, 'Follow-up generation failed')
    return {
      questions: FALLBACK_FOLLOW_UPS[data.segment] || FALLBACK_FOLLOW_UPS.default,
      cost: 0,
      model: 'fallback',
    }
  }
}

// ─── Enhance All Bullets ───────────────────────────────────────────────────

interface RoleForEnhancement {
  id: string
  title: string
  company: string
  rawBullets: string[]
  followUpQuestions: Array<{ question: string; answer: string }>
}

export interface EnhancedRoleResult {
  roleId: string
  original: string[]
  enhanced: string[]
}

export async function enhanceAllBullets(
  user: AuthUser,
  sessionId: string,
  roles: RoleForEnhancement[],
  segment: string
): Promise<{ enhancedRoles: EnhancedRoleResult[]; summary: string; cost: number; model: string }> {
  const { allowed } = await checkCostCap(sessionId)
  if (!allowed) {
    aiLogger.info({ sessionId }, 'Cost cap reached, returning raw bullets')
    return {
      enhancedRoles: roles.map(r => ({ roleId: r.id, original: r.rawBullets, enhanced: r.rawBullets })),
      summary: '',
      cost: 0,
      model: 'fallback',
    }
  }

  const segmentContext = SEGMENT_PROMPT_CONTEXT[segment] || ''
  const startTime = Date.now()

  // Build role descriptions with follow-up context
  const rolesPayload = roles.map(role => ({
    roleId: role.id,
    title: role.title,
    company: role.company,
    rawBullets: role.rawBullets,
    followUpContext: role.followUpQuestions
      .filter(q => q.answer?.trim())
      .map(q => `Q: ${q.question}\nA: ${q.answer}`)
      .join('\n'),
  }))

  try {
    const enrichResult = await completion({
      taskSlot: 'resume.wizard-enrich',
      system: `${DATA_BOUNDARY_RULE}

You are an expert resume writer who transforms basic job descriptions into powerful, ATS-optimized resume bullets. ${segmentContext}

Rules:
- Start each bullet with a strong action verb (Led, Managed, Developed, Resolved, etc.)
- Incorporate metrics and numbers from the follow-up context when available
- Keep bullets concise (1-2 lines each)
- Make bullets ATS-friendly with industry keywords
- Generate 3-5 enhanced bullets per role
- Also generate a 2-3 sentence professional summary based on ALL roles

${JSON_OUTPUT_RULE}
{
  "roles": [
    {
      "roleId": "string",
      "enhanced": ["bullet1", "bullet2", "bullet3"]
    }
  ],
  "summary": "2-3 sentence professional summary"
}`,
      messages: [{
        role: 'user',
        content: `Enhance the resume bullets for each role and generate a professional summary.`,
      }],
      contextData: { roles: rolesPayload },
    })

    const durationMs = Date.now() - startTime
    const raw = enrichResult.text || '{}'
    const inputTokens = enrichResult.inputTokens
    const outputTokens = enrichResult.outputTokens

    // Track usage
    trackUsage({
      user,
      type: 'api_call_wizard_enhance',
      sessionId,
      inputTokens,
      outputTokens,
      modelUsed: enrichResult.model,
      durationMs,
      success: true,
    }).catch(() => {})

    const cost = (inputTokens / 1000) * 0.015 + (outputTokens / 1000) * 0.075
    await updateSessionCost(sessionId, cost)

    const cleaned = extractJSON(raw)
    try {
      const result = JSON.parse(cleaned)
      const enhancedRoles: EnhancedRoleResult[] = roles.map(role => {
        const enhanced = result.roles?.find((r: { roleId: string }) => r.roleId === role.id)
        return {
          roleId: role.id,
          original: role.rawBullets,
          enhanced: Array.isArray(enhanced?.enhanced) ? enhanced.enhanced : role.rawBullets,
        }
      })

      return {
        enhancedRoles,
        summary: result.summary || '',
        cost,
        model: enrichResult.model,
      }
    } catch {
      aiLogger.error({ raw: raw.slice(0, 500) }, 'Enhancement JSON parse failed')
    }

    // Parse failed — return raw
    return {
      enhancedRoles: roles.map(r => ({ roleId: r.id, original: r.rawBullets, enhanced: r.rawBullets })),
      summary: '',
      cost,
      model: 'fallback',
    }
  } catch (err) {
    aiLogger.error({ err, sessionId }, 'Bullet enhancement failed')
    return {
      enhancedRoles: roles.map(r => ({ roleId: r.id, original: r.rawBullets, enhanced: r.rawBullets })),
      summary: '',
      cost: 0,
      model: 'fallback',
    }
  }
}

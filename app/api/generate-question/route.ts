import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { composeApiRoute } from '@/lib/middleware/composeApiRoute'
import { GenerateQuestionSchema } from '@/lib/validators/interview'
import { trackUsage } from '@/lib/services/usageTracking'
import { aiLogger } from '@/lib/logger'
import { PRESSURE_QUESTION_INDEX, QUESTION_COUNT } from '@/lib/interviewConfig'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const client = new Anthropic()

type GenerateQuestionBody = z.infer<typeof GenerateQuestionSchema>

export const POST = composeApiRoute<GenerateQuestionBody>({
  schema: GenerateQuestionSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:gen-q' },
  authOptional: true,

  async handler(req, { user, body }) {
    const { config, questionIndex, previousQA } = body
    const startTime = Date.now()

    const totalQuestions = QUESTION_COUNT[config.duration]
    const isPressureQuestion = questionIndex === PRESSURE_QUESTION_INDEX[config.duration]
    const isLastQuestion = questionIndex === totalQuestions - 1

    const qaContext =
      previousQA.length > 0
        ? previousQA
            .map((e) => `${e.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${e.text}`)
            .join('\n')
        : 'No prior exchange yet.'

    // Build context from JD and resume
    let contextBlock = ''
    if (config.jobDescription) {
      contextBlock += `\n\nJOB DESCRIPTION:\n${config.jobDescription.slice(0, 4000)}\nUse this JD to ask targeted questions that probe the candidate's fit for the specific requirements listed.`
    }
    if (config.resumeText) {
      contextBlock += `\n\nCANDIDATE'S RESUME:\n${config.resumeText.slice(0, 4000)}\nProbe specific experiences, projects, and claims from the resume. Ask for concrete details.`
    }
    if (config.jobDescription && config.resumeText) {
      contextBlock += `\n\nCross-reference the resume against the JD requirements. Identify gaps or areas where the candidate's experience may not fully match, and explore those.`
    }

    const systemPrompt = `You are Alex Chen, a senior HR interviewer at a top-tier tech company. You are conducting a ${config.duration}-minute behavioral screening for a ${config.role} role (${config.experience} years experience).

Your interview style is warm but professional. You ask ONE focused question at a time. Questions should feel conversational and natural — not robotic or overly formal.

Question types you rotate through:
- Behavioral (STAR): "Tell me about a time when..."
- Motivation: "What drives you / why this role?"
- Situational: "How would you handle..."
- Consistency check: follow up on something mentioned earlier${contextBlock}`

    const userPrompt = `Previous conversation:
${qaContext}

Generate question ${questionIndex + 1} of ${totalQuestions}.
${isPressureQuestion ? '⚠️ This is the PRESSURE moment — ask a mildly challenging follow-up or a "devil\'s advocate" question that tests resilience or self-awareness. Keep it professional.' : ''}
${isLastQuestion ? 'This is the FINAL substantive question before wrap-up — make it memorable and forward-looking.' : ''}

Return ONLY the question text. No preamble, no numbering, no quotation marks. Just the question.`

    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      const question =
        message.content[0].type === 'text' ? message.content[0].text.trim() : ''

      // Fire-and-forget usage tracking
      trackUsage({
        user,
        type: 'api_call_question',
        sessionId: body.sessionId,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        modelUsed: 'claude-sonnet-4-6',
        durationMs: Date.now() - startTime,
        success: true,
      }).catch(() => {})

      return NextResponse.json({ question })
    } catch (err) {
      aiLogger.error({ err }, 'Claude API error in generate-question')

      trackUsage({
        user,
        type: 'api_call_question',
        sessionId: body.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'claude-sonnet-4-6',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch(() => {})

      return NextResponse.json({
        question:
          'Tell me about a challenge you faced in your most recent role and how you overcame it.',
      })
    }
  },
})

import { connectDB } from '@/lib/db/connection'
import { QuestionBank, CompanyPattern } from '@/lib/db/models'
import type { IQuestionBank, ICompanyPattern } from '@/lib/db/models'
import { isFeatureEnabled } from '@/lib/featureFlags'
import { logger } from '@/lib/logger'

// ─── Question Bank Retrieval ────────────────────────────────────────────────

interface QuestionRetrievalInput {
  domain: string
  interviewType: string
  seniorityBand?: string
  targetCompetencies?: string[]
  difficulty?: string
  excludeTopics?: string[]
  limit?: number
}

export async function retrieveQuestions(
  input: QuestionRetrievalInput
): Promise<Array<{
  question: string
  category: string
  targetCompetencies: string[]
  difficulty: string
  idealAnswerPoints: string[]
}>> {
  if (!isFeatureEnabled('question_bank_rag')) return []

  try {
    await connectDB()

    const filter: Record<string, unknown> = {
      domain: input.domain,
      interviewType: input.interviewType,
      isActive: true,
    }

    if (input.seniorityBand && input.seniorityBand !== '*') {
      filter.seniorityBand = { $in: [input.seniorityBand, '*'] }
    }

    if (input.targetCompetencies?.length) {
      filter.targetCompetencies = { $in: input.targetCompetencies }
    }

    if (input.difficulty) {
      filter.difficulty = input.difficulty
    }

    let query = QuestionBank.find(filter)
      .sort({ usageCount: 1 })  // prefer less-used questions
      .limit(input.limit || 5)
      .lean()

    const questions = await query

    // Increment usage counts (fire and forget)
    if (questions.length > 0) {
      const ids = questions.map(q => q._id)
      QuestionBank.updateMany(
        { _id: { $in: ids } },
        { $inc: { usageCount: 1 } }
      ).catch(() => {})
    }

    return questions.map(q => ({
      question: q.question,
      category: q.category,
      targetCompetencies: q.targetCompetencies,
      difficulty: q.difficulty,
      idealAnswerPoints: q.idealAnswerPoints,
    }))
  } catch (err) {
    logger.error({ err }, 'Question retrieval failed')
    return []
  }
}

// ─── Text Search in Question Bank ───────────────────────────────────────────

export async function searchQuestions(
  query: string,
  domain?: string,
  limit = 5
): Promise<IQuestionBank[]> {
  if (!isFeatureEnabled('question_bank_rag')) return []

  try {
    await connectDB()

    const filter: Record<string, unknown> = {
      $text: { $search: query },
      isActive: true,
    }
    if (domain) filter.domain = domain

    return await QuestionBank.find(filter)
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean()
  } catch (err) {
    logger.error({ err }, 'Question search failed')
    return []
  }
}

// ─── Company Pattern Retrieval ──────────────────────────────────────────────

export async function getCompanyPatterns(
  companyNames: string[],
  domain?: string
): Promise<ICompanyPattern[]> {
  if (!isFeatureEnabled('company_patterns_rag') || companyNames.length === 0) return []

  try {
    await connectDB()

    const normalizedNames = companyNames.map(n => n.toLowerCase().trim())

    const filter: Record<string, unknown> = {
      companyName: { $in: normalizedNames },
      isActive: true,
    }

    if (domain) {
      filter.$or = [
        { applicableDomains: { $size: 0 } },
        { applicableDomains: domain },
      ]
    }

    return await CompanyPattern.find(filter).lean()
  } catch (err) {
    logger.error({ err }, 'Company pattern retrieval failed')
    return []
  }
}

// ─── Company Type Pattern Retrieval ─────────────────────────────────────────

export async function getCompanyTypePatterns(
  companyType: string,
  domain?: string,
  limit = 3
): Promise<ICompanyPattern[]> {
  if (!isFeatureEnabled('company_patterns_rag')) return []

  try {
    await connectDB()

    const filter: Record<string, unknown> = {
      companyType,
      isActive: true,
    }

    if (domain) {
      filter.$or = [
        { applicableDomains: { $size: 0 } },
        { applicableDomains: domain },
      ]
    }

    return await CompanyPattern.find(filter).limit(limit).lean()
  } catch (err) {
    logger.error({ err }, 'Company type pattern retrieval failed')
    return []
  }
}

// ─── Build Company Context for Prompt Injection ─────────────────────────────

export async function getCompanyContext(input: {
  userId: string
  domain: string
}): Promise<string> {
  if (!isFeatureEnabled('company_patterns_rag')) return ''

  try {
    await connectDB()

    // Import here to avoid circular dependency
    const { User } = await import('@/lib/db/models')
    const profile = await User.findById(input.userId)
      .select('targetCompanies targetCompanyType')
      .lean()

    if (!profile) return ''

    const parts: string[] = []

    // Get specific company patterns
    const targetCompanies = profile.targetCompanies as string[] | undefined
    if (targetCompanies?.length) {
      const patterns = await getCompanyPatterns(targetCompanies, input.domain)
      for (const p of patterns) {
        const lines = []
        if (p.interviewStyle) lines.push(`Interview style: ${p.interviewStyle}`)
        if (p.culturalValues?.length) lines.push(`Values: ${p.culturalValues.join(', ')}`)
        if (p.evaluationFocus?.length) lines.push(`Focus: ${p.evaluationFocus.join(', ')}`)
        if (p.interviewTips?.length) lines.push(`Tips: ${p.interviewTips.slice(0, 2).join('; ')}`)
        if (lines.length > 0) {
          parts.push(`[${p.companyName.toUpperCase()}]\n${lines.join('\n')}`)
        }
      }
    }

    // Get company type patterns if no specific companies found
    if (parts.length === 0 && profile.targetCompanyType) {
      const typePatterns = await getCompanyTypePatterns(
        profile.targetCompanyType as string,
        input.domain,
        2
      )
      for (const p of typePatterns) {
        if (p.interviewStyle) {
          parts.push(`${profile.targetCompanyType} company style: ${p.interviewStyle}`)
        }
      }
    }

    return parts.length > 0 ? `COMPANY CONTEXT:\n${parts.join('\n\n')}` : ''
  } catch (err) {
    logger.error({ err }, 'Failed to build company context')
    return ''
  }
}

// ─── Build Question Bank Context for Prompt ─────────────────────────────────

export async function getQuestionBankContext(input: {
  domain: string
  interviewType: string
  targetCompetencies?: string[]
  difficulty?: string
}): Promise<string> {
  if (!isFeatureEnabled('question_bank_rag')) return ''

  try {
    const questions = await retrieveQuestions({
      domain: input.domain,
      interviewType: input.interviewType,
      targetCompetencies: input.targetCompetencies,
      difficulty: input.difficulty,
      limit: 3,
    })

    if (questions.length === 0) return ''

    const lines = questions.map((q, i) =>
      `${i + 1}. "${q.question}" [${q.category}] targets: ${q.targetCompetencies.join(', ')}`
    )

    return `REFERENCE QUESTIONS (for inspiration, not verbatim):\n${lines.join('\n')}`
  } catch (err) {
    logger.error({ err }, 'Failed to build question bank context')
    return ''
  }
}

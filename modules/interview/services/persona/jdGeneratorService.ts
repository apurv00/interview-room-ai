import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { logger } from '@shared/logger'

export interface GenerateJDInput {
  company: string
  role: string
  resumeText?: string
}

export interface GeneratedJD {
  jobDescription: string
  company: string
  industry: string
}

export async function generateJobDescription(input: GenerateJDInput): Promise<GeneratedJD> {
  const { company, role, resumeText } = input

  const resumeContext = resumeText
    ? `\n\nThe candidate's resume is provided below for experience-level calibration. Match the JD seniority to the candidate's background — do not make it significantly more senior or junior.\n<candidate_resume>\n${resumeText.slice(0, 3000)}\n</candidate_resume>`
    : ''

  try {
    const result = await completion({
      taskSlot: 'interview.jd-extract',
      system: `${DATA_BOUNDARY_RULE}

You are a job description writer. Generate realistic, professional job descriptions based on a company name and role title.

${JSON_OUTPUT_RULE}
{
  "jobDescription": "Full job description text (300-500 words). Include: company overview (1 sentence), role summary, key responsibilities (5-7 bullets), required qualifications (5-7 bullets), nice-to-haves (3-4 bullets), and what we offer (3-4 bullets).",
  "company": "Company name",
  "industry": "Primary industry (e.g. tech, finance, healthcare, consulting, retail, media)"
}

Guidelines:
- Write requirements that are specific and testable, not vague.`,
      messages: [{
        role: 'user',
        content: `Generate a job description for the role "${role}" at "${company}".${resumeContext}`,
      }],
    })

    const text = result.text

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn('JD generator returned no JSON, using fallback')
      return createFallbackJD(company, role)
    }

    const parsed = JSON.parse(jsonMatch[0])

    return {
      jobDescription: String(parsed.jobDescription || ''),
      company: String(parsed.company || company),
      industry: String(parsed.industry || ''),
    }
  } catch (err) {
    logger.error({ err }, 'JD generation failed')
    return createFallbackJD(company, role)
  }
}

function createFallbackJD(company: string, role: string): GeneratedJD {
  return {
    jobDescription: `${role} at ${company}\n\nWe are looking for a ${role} to join our team at ${company}. The ideal candidate will bring relevant experience, strong communication skills, and a collaborative mindset.\n\nResponsibilities:\n- Drive key initiatives aligned with business goals\n- Collaborate with cross-functional teams\n- Deliver measurable results in your area of expertise\n\nRequirements:\n- Relevant professional experience\n- Strong analytical and problem-solving skills\n- Excellent communication and teamwork abilities`,
    company,
    industry: '',
  }
}

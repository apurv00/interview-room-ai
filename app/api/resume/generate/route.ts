import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const client = new Anthropic()

const GenerateSchema = z.object({
  action: z.enum(['enhance', 'generate_full']),
  sectionType: z.string().max(50).optional(),
  currentContent: z.string().max(10000).optional(),
  targetRole: z.string().max(200).optional(),
  targetCompany: z.string().max(200).optional(),
  currentSections: z.array(z.object({
    type: z.string(),
    content: z.string(),
  })).optional(),
})

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = GenerateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const { action, sectionType, currentContent, targetRole, targetCompany, currentSections } = parsed.data

  // Fetch user profile for personalization
  await connectDB()
  const profile = await User.findById(session.user.id).select(
    'currentTitle currentIndustry experienceLevel topSkills educationLevel'
  ).lean()

  let profileContext = ''
  if (profile?.currentTitle) profileContext += `Current title: ${profile.currentTitle}. `
  if (profile?.currentIndustry) profileContext += `Industry: ${profile.currentIndustry}. `
  if (profile?.experienceLevel) profileContext += `Experience: ${profile.experienceLevel} years. `
  if (profile?.topSkills?.length) profileContext += `Key skills: ${profile.topSkills.join(', ')}. `

  if (action === 'enhance' && sectionType && currentContent) {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are an expert resume writer. Enhance the given resume section to be more impactful, ATS-friendly, and quantified. ${profileContext}${targetRole ? `Target role: ${targetRole}. ` : ''}${targetCompany ? `Target company: ${targetCompany}. ` : ''}Keep the same factual content but improve language, add metrics where possible, and use strong action verbs. Return ONLY the enhanced text, no explanations.`,
      messages: [{ role: 'user', content: `Enhance this "${sectionType}" section:\n\n${currentContent}` }],
    })

    const enhanced = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    return NextResponse.json({ enhanced })
  }

  if (action === 'generate_full') {
    const existingContent = currentSections?.filter(s => s.content.trim())
      .map(s => `${s.type}: ${s.content.slice(0, 500)}`).join('\n\n') || 'No existing content.'

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an expert resume writer. Generate professional resume content based on the user's profile and any existing content. ${profileContext}${targetRole ? `Target role: ${targetRole}. ` : ''}${targetCompany ? `Target company: ${targetCompany}. ` : ''}Make content ATS-friendly with strong action verbs and quantified achievements.

Return ONLY valid JSON with this structure:
{"sections": [{"type": "summary", "content": "..."}, {"type": "experience", "content": "..."}, {"type": "education", "content": "..."}, {"type": "skills", "content": "..."}, {"type": "projects", "content": "..."}]}`,
      messages: [{ role: 'user', content: `Generate resume section suggestions. Existing content:\n\n${existingContent}` }],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    try {
      const parsed = JSON.parse(cleaned)
      return NextResponse.json(parsed)
    } catch {
      return NextResponse.json({ sections: [] })
    }
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}

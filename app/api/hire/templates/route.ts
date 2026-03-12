import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User, InterviewTemplate } from '@/lib/db/models'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.string().min(1).max(50),
  experienceLevel: z.enum(['0-2', '3-6', '7+', 'all']).default('all'),
  questions: z.array(z.object({
    text: z.string().min(1).max(1000),
    category: z.enum(['behavioral', 'situational', 'motivation', 'technical', 'custom']).default('behavioral'),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  })).max(20).optional(),
  settings: z.object({
    duration: z.number().optional(),
    questionCount: z.number().optional(),
  }).optional(),
})

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('organizationId role').lean()
  if (!user?.organizationId || !['recruiter', 'org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const templates = await InterviewTemplate.find({ organizationId: user.organizationId })
    .sort({ createdAt: -1 }).lean()

  return NextResponse.json({
    templates: templates.map(t => ({
      id: t._id.toString(),
      name: t.name,
      description: t.description || '',
      role: t.role,
      experienceLevel: t.experienceLevel,
      questionCount: t.questions?.length || 0,
      duration: t.settings?.duration || 10,
      isActive: t.isActive,
      createdAt: t.createdAt.toISOString(),
    })),
  })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('organizationId role').lean()
  if (!user?.organizationId || !['recruiter', 'org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = CreateTemplateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const template = await InterviewTemplate.create({
    organizationId: user.organizationId,
    name: parsed.data.name,
    description: parsed.data.description,
    role: parsed.data.role,
    experienceLevel: parsed.data.experienceLevel,
    questions: parsed.data.questions || [],
    settings: {
      duration: parsed.data.settings?.duration || 10,
      questionCount: parsed.data.questions?.length || 6,
      allowFollowUps: true,
    },
    createdBy: user._id,
  })

  return NextResponse.json({
    success: true,
    template: { id: template._id.toString(), name: template.name },
  })
}

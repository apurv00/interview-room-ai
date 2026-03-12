import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models'
import { OnboardingUpdateSchema } from '@/lib/validators/onboarding'

export const dynamic = 'force-dynamic'

const ONBOARDING_FIELDS = [
  'targetRole', 'experienceLevel', 'onboardingCompleted',
  'currentTitle', 'currentIndustry', 'isCareerSwitcher', 'switchingFrom',
  'targetCompanyType', 'interviewGoal', 'weakAreas',
  'resumeFileName', 'resumeR2Key',
] as const

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select(ONBOARDING_FIELDS.join(' ')).lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({
    targetRole: user.targetRole || null,
    experienceLevel: user.experienceLevel || null,
    onboardingCompleted: user.onboardingCompleted ?? false,
    currentTitle: user.currentTitle || null,
    currentIndustry: user.currentIndustry || null,
    isCareerSwitcher: user.isCareerSwitcher ?? false,
    switchingFrom: user.switchingFrom || null,
    targetCompanyType: user.targetCompanyType || null,
    interviewGoal: user.interviewGoal || null,
    weakAreas: user.weakAreas || [],
    hasResume: !!(user.resumeText || user.resumeFileName),
    resumeFileName: user.resumeFileName || null,
  })
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = OnboardingUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid data',
        ...(process.env.NODE_ENV !== 'production' && { details: parsed.error.flatten() }),
      },
      { status: 400 }
    )
  }

  const { complete, ...fields } = parsed.data
  const update: Record<string, unknown> = { ...fields }
  if (complete) {
    update.onboardingCompleted = true
  }

  await connectDB()
  const user = await User.findByIdAndUpdate(session.user.id, { $set: update }, { new: true })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}

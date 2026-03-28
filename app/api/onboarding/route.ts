import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { OnboardingUpdateSchema } from '@shared/validators/onboarding'

export const dynamic = 'force-dynamic'

const ONBOARDING_FIELDS = [
  'targetRole', 'experienceLevel', 'onboardingCompleted',
  'currentTitle', 'currentIndustry', 'isCareerSwitcher', 'switchingFrom',
  'targetCompanyType', 'interviewGoal', 'weakAreas',
  'resumeText', 'resumeFileName', 'resumeR2Key',
  'preferredDomains', 'preferredInterviewTypes', 'targetCompanies',
  'linkedinUrl', 'yearsInCurrentRole', 'educationLevel',
  'topSkills', 'communicationStyle', 'feedbackPreference',
  'practiceStats',
  'savedResumes',
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
    resumeText: user.resumeText || null,
    resumeFileName: user.resumeFileName || null,
    // Saved resumes (metadata only for selection UI)
    savedResumes: (user.savedResumes || []).map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      targetRole: r.targetRole || null,
      updatedAt: r.updatedAt || r.createdAt || null,
    })),
    // Extended profile
    preferredDomains: user.preferredDomains || [],
    preferredInterviewTypes: user.preferredInterviewTypes || [],
    targetCompanies: user.targetCompanies || [],
    linkedinUrl: user.linkedinUrl || null,
    yearsInCurrentRole: user.yearsInCurrentRole ?? null,
    educationLevel: user.educationLevel || null,
    topSkills: user.topSkills || [],
    communicationStyle: user.communicationStyle || null,
    feedbackPreference: user.feedbackPreference || null,
    practiceStats: user.practiceStats || {},
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

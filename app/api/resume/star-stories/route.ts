import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { generateSTARStories } from '@resume/services/resumeAIService'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'

// GET — List saved STAR stories
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('starStories').lean()
  return NextResponse.json({ stories: user?.starStories || [] })
}

// POST — Generate STAR stories from a resume
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { resumeId, jobDescription } = body as { resumeId?: string; jobDescription?: string }

  await connectDB()
  const user = await User.findById(session.user.id).select('savedResumes targetRole').lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Find the resume
  const resumes = (user.savedResumes || []) as Array<{
    id: string
    name: string
    targetRole?: string
    experience: Array<{ id: string; company: string; title: string; bullets: string[] }>
  }>

  const resume = resumeId
    ? resumes.find(r => r.id === resumeId)
    : resumes[0]

  if (!resume) {
    return NextResponse.json({ error: 'Resume not found' }, { status: 404 })
  }

  if (!resume.experience?.length) {
    return NextResponse.json({ error: 'Resume has no experience entries' }, { status: 400 })
  }

  // Generate stories
  const stories = await generateSTARStories(session.user.id, {
    experience: resume.experience,
    targetRole: resume.targetRole || (user.targetRole as string) || undefined,
    jobDescription,
  })

  if (stories.length === 0) {
    return NextResponse.json({ error: 'Failed to generate stories' }, { status: 500 })
  }

  // Save to user
  const savedStories = stories.map(s => ({
    id: crypto.randomBytes(8).toString('hex'),
    resumeId: resume.id,
    ...s,
    createdAt: new Date().toISOString(),
  }))

  await User.findByIdAndUpdate(session.user.id, {
    $push: { starStories: { $each: savedStories } },
  })

  return NextResponse.json({ stories: savedStories })
}

// DELETE — Remove a STAR story
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { storyId } = await req.json() as { storyId: string }
  if (!storyId) {
    return NextResponse.json({ error: 'storyId required' }, { status: 400 })
  }

  await connectDB()
  await User.findByIdAndUpdate(session.user.id, {
    $pull: { starStories: { id: storyId } },
  })

  return NextResponse.json({ success: true })
}

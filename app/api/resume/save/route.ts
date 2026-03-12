import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models/User'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const ResumeSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  targetRole: z.string().max(200).optional(),
  targetCompany: z.string().max(200).optional(),
  template: z.string().max(50).optional(),
  atsScore: z.number().min(0).max(100).nullable().optional(),
  sections: z.record(z.string(), z.string()).optional(),
  fullText: z.string().max(100000).optional(),
})

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await connectDB()
    const user = await User.findById(session.user.id).select('savedResumes onboardingProfile').lean()
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const resumes = (user.savedResumes || []).map((r: Record<string, unknown>) => ({
      id: r.id || r._id?.toString(),
      name: r.name || 'Untitled Resume',
      targetRole: r.targetRole || '',
      targetCompany: r.targetCompany || '',
      atsScore: r.atsScore ?? null,
      updatedAt: r.updatedAt || new Date().toISOString(),
    }))

    return NextResponse.json({
      resumes,
      hasProfile: !!(user.onboardingProfile?.targetRole || user.onboardingProfile?.currentTitle),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to load resumes' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = ResumeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const { id, name, targetRole, targetCompany, template, atsScore, sections, fullText } = parsed.data

  try {
    await connectDB()

    if (id) {
      // Update existing resume
      await User.updateOne(
        { _id: session.user.id, 'savedResumes.id': id },
        {
          $set: {
            'savedResumes.$.name': name,
            'savedResumes.$.targetRole': targetRole || '',
            'savedResumes.$.targetCompany': targetCompany || '',
            'savedResumes.$.template': template || 'professional',
            'savedResumes.$.atsScore': atsScore ?? null,
            'savedResumes.$.sections': sections || {},
            'savedResumes.$.fullText': fullText || '',
            'savedResumes.$.updatedAt': new Date().toISOString(),
          },
        }
      )
      return NextResponse.json({ id })
    } else {
      // Create new resume
      const newId = crypto.randomUUID()
      const resumeDoc = {
        id: newId,
        name,
        targetRole: targetRole || '',
        targetCompany: targetCompany || '',
        template: template || 'professional',
        atsScore: atsScore ?? null,
        sections: sections || {},
        fullText: fullText || '',
        updatedAt: new Date().toISOString(),
      }

      await User.updateOne(
        { _id: session.user.id },
        { $push: { savedResumes: resumeDoc } }
      )
      return NextResponse.json({ id: newId }, { status: 201 })
    }
  } catch {
    return NextResponse.json({ error: 'Failed to save resume' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Missing resume id' }, { status: 400 })
  }

  try {
    await connectDB()
    await User.updateOne(
      { _id: session.user.id },
      { $pull: { savedResumes: { id } } }
    )
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed to delete resume' }, { status: 500 })
  }
}

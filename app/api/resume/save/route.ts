import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { listResumes, getResume, saveResume, deleteResume } from '@resume/services/resumeService'
import { ResumeSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')

  // If id is provided, return single resume
  if (id) {
    try {
      const resume = await getResume(session.user.id, id)
      if (!resume) {
        return NextResponse.json({ error: 'Resume not found' }, { status: 404 })
      }
      return NextResponse.json(resume)
    } catch {
      return NextResponse.json({ error: 'Failed to load resume' }, { status: 500 })
    }
  }

  // Otherwise list all resumes
  try {
    const data = await listResumes(session.user.id)
    if (!data) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    return NextResponse.json(data)
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

  try {
    const result = await saveResume(session.user.id, parsed.data)
    if ('error' in result && result.code === 'RESUME_LIMIT') {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 403 })
    }
    return NextResponse.json({ id: result.id }, { status: 'created' in result && result.created ? 201 : 200 })
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
    const result = await deleteResume(session.user.id, id)
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Failed to delete resume' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { listResumes, getResume, saveResume, deleteResume } from '@resume/services/resumeService'
import { ResumeSchema, resumeClampedContent } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const originUserId = req.headers.get('x-origin-user-id')
  if (originUserId !== null && originUserId !== session.user.id) {
    return NextResponse.json(
      { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
      { status: 409 },
    )
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
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'originUserId')) {
    const originUserId = body?.originUserId
    if (typeof originUserId !== 'string' || originUserId !== session.user.id) {
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }
  }
  // preserveFullText is a control flag, not resume data — parse it off the
  // body BEFORE Zod validation (ResumeSchema would strip an unknown key). Set
  // by callers holding an authoritative complete fullText plus a partial
  // structured parse of it (builder parse-on-open upgrade); keeps the posted
  // fullText instead of regenerating a lossy one from the partial structure.
  const preserveFullText = body?.preserveFullText === true

  const parsed = ResumeSchema.safeParse(body)
  if (!parsed.success) {
    // Size caps clamp inside the schema now, so reaching here means a
    // STRUCTURAL problem — tell the user which field, not just "Invalid data"
    // (the bare message left resumes unsavable with no way to find out why).
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }))
    return NextResponse.json({ error: 'Some fields are invalid', issues }, { status: 400 })
  }

  try {
    const result = await saveResume(session.user.id, parsed.data, { preserveFullText })
    if ('error' in result && result.code === 'RESUME_LIMIT') {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 403 })
    }
    if ('error' in result && result.code === 'NOT_FOUND') {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 404 })
    }
    if ('error' in result && result.code === 'ACCOUNT_UNAVAILABLE') {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 401 })
    }
    // `clamped` tells the client a field was shortened to fit its cap so it can
    // warn the user instead of showing "Saved!" over a silent truncation (the
    // editor still holds the un-clamped text until reload).
    return NextResponse.json(
      { id: result.id, clamped: resumeClampedContent(body, parsed.data) },
      { status: 'created' in result && result.created ? 201 : 200 },
    )
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

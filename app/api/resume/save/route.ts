import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { listResumes, saveResume, deleteResume } from '@resume/services/resumeService'
import { ResumeSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
    return NextResponse.json({ id: result.id }, { status: result.created ? 201 : 200 })
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

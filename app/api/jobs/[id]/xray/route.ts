import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { getOrParseXray } from '@jobs'

export const dynamic = 'force-dynamic'

/**
 * GET /api/jobs/[id]/xray — the Interview X-ray (authed only; the anon
 * detail is a P-2 gate surface and the parse output derives from the JD it
 * must not see). Fetched progressively by the detail page AFTER the body
 * renders — the first view on a posting pays a lazy LLM parse (seconds);
 * every later view is a cache read from JobPosting.parsedJD.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  await connectDB()
  const xray = await getOrParseXray(params.id)
  if (!xray) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({
    cached: xray.cached,
    retryable: xray.retryable === true,
    role: xray.parsed.role,
    inferredDomain: xray.parsed.inferredDomain,
    keyThemes: xray.parsed.keyThemes ?? [],
    requirements: (xray.parsed.requirements ?? []).map((r) => ({
      id: r.id,
      category: r.category,
      requirement: r.requirement,
      importance: r.importance,
    })),
  })
}

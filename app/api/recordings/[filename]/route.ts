import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getDownloadPresignedUrl, isR2Configured } from '@shared/storage/r2'

export const dynamic = 'force-dynamic'

/**
 * GET /api/recordings/[filename]
 * Now treats `filename` as an R2 key (URL-encoded) and redirects to a presigned download URL.
 * For backwards compatibility, also supports legacy R2 keys passed as a query param.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { filename: string } }
) {
  // Auth required
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isR2Configured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
  }

  // The R2 key can be passed as a query param ?key= or as the filename path segment
  const r2Key = req.nextUrl.searchParams.get('key') || decodeURIComponent(params.filename)

  // Basic validation
  if (!r2Key || r2Key.includes('..')) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  // Ownership check: verify the R2 key belongs to the requesting user.
  // Keys follow the pattern: recordings/{userId}/... or documents/{userId}/...
  const keySegments = r2Key.split('/')
  const userRole = (session.user as { role?: string }).role
  if (
    keySegments.length < 3 ||
    !['recordings', 'documents'].includes(keySegments[0]) ||
    (keySegments[1] !== session.user.id && userRole !== 'platform_admin')
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const url = await getDownloadPresignedUrl(r2Key)
    return NextResponse.redirect(url)
  } catch {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }
}

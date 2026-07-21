import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import {
  getDownloadPresignedUrl,
  isCanonicalR2Key,
  isR2Configured,
} from '@shared/storage/r2'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { User } from '@shared/db/models/User'
import { parseRecordingArtifactKey } from '@interview/services/core/recordingArtifactService'

export const dynamic = 'force-dynamic'

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

const recordingNotFoundResponse = () => NextResponse.json(
  { error: 'Recording not found' },
  { status: 404 },
)

async function isLiveArtifactReference(key: string, ownerUserId: string): Promise<boolean> {
  const segments = key.split('/')
  if (segments[0] === 'recordings') {
    const identity = parseRecordingArtifactKey(key, ownerUserId)
    if (!identity) return false
    const field = identity.type === 'screen-recording'
      ? 'screenRecordingR2Key'
      : identity.type === 'audio-recording'
      ? 'audioRecordingR2Key'
      : 'recordingR2Key'
    return Boolean(await InterviewSession.exists({
      _id: identity.sessionId,
      userId: ownerUserId,
      [field]: key,
    }))
  }
  if (segments[0] !== 'documents') return false
  const references = await Promise.all([
    InterviewSession.exists({
      userId: ownerUserId,
      $or: [{ resumeR2Key: key }, { jdR2Key: key }],
    }),
    User.exists({ _id: ownerUserId, resumeR2Key: key }),
  ])
  return references.some(Boolean)
}

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

  const requesterId = session.user.id
  await connectDB()
  if (!(await isJobsAccountActive(requesterId))) {
    return accountUnavailableResponse()
  }

  if (!isR2Configured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
  }

  // The R2 key can be passed as a query param ?key= or as the filename path segment
  const r2Key = req.nextUrl.searchParams.get('key') || decodeURIComponent(params.filename)

  // Basic validation
  if (!r2Key || !isCanonicalR2Key(r2Key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  // Ownership check: verify the R2 key belongs to the requesting user.
  // Keys follow the pattern: recordings/{userId}/... or documents/{userId}/...
  const keySegments = r2Key.split('/')
  if (
    keySegments.length < 3 ||
    !['recordings', 'documents'].includes(keySegments[0])
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const ownerUserId = keySegments[1]
  const isForeignOwner = ownerUserId !== requesterId
  const userRole = (session.user as { role?: string }).role
  if (isForeignOwner && userRole !== 'platform_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (isForeignOwner) {
    // Platform admins can inspect another account's retained artifact only
    // while that owner remains active. Use the same not-found shape as a
    // missing object so account lifecycle state is not exposed.
    if (!(await isJobsAccountActive(ownerUserId))) {
      return recordingNotFoundResponse()
    }
    // Owner admission is an async read; do not continue from it if the
    // requester's own deletion crossed that wait.
    if (!(await isJobsAccountActive(requesterId))) {
      return accountUnavailableResponse()
    }
  }

  if (!(await isLiveArtifactReference(r2Key, ownerUserId))) {
    if (!(await isJobsAccountActive(requesterId))) {
      return accountUnavailableResponse()
    }
    return recordingNotFoundResponse()
  }

  try {
    const url = await getDownloadPresignedUrl(r2Key)
    if (!(await isJobsAccountActive(requesterId))) {
      return accountUnavailableResponse()
    }
    if (isForeignOwner && !(await isJobsAccountActive(ownerUserId))) {
      return recordingNotFoundResponse()
    }
    if (!(await isLiveArtifactReference(r2Key, ownerUserId))) {
      if (!(await isJobsAccountActive(requesterId))) {
        return accountUnavailableResponse()
      }
      return recordingNotFoundResponse()
    }
    const response = NextResponse.redirect(url)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch {
    // A signer failure must not mask deletion that crossed the request. Check
    // requester first because its terminal contract is always the exact 401;
    // a foreign owner's lifecycle remains privacy-preserving 404.
    try {
      if (!(await isJobsAccountActive(requesterId))) {
        return accountUnavailableResponse()
      }
      if (isForeignOwner && !(await isJobsAccountActive(ownerUserId))) {
        return recordingNotFoundResponse()
      }
    } catch {
      // Preserve the original not-found response below.
    }
    return recordingNotFoundResponse()
  }
}

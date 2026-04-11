import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { getSession } from '@interview/services/core/interviewService'
import { logger } from '@shared/logger'
import { AppError } from '@shared/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/interviews/[id]/retake
 *
 * Initiates a retake of the given session. This endpoint does NOT create a
 * new InterviewSession — that happens later when the user submits the
 * pre-filled setup form via `POST /api/interviews`. It simply returns the
 * parent's config + resolved root parent id so the client can pre-fill the
 * setup form and thread `parentSessionId` through to the normal creation
 * flow. Ownership is verified by `getSession()`.
 *
 * Returns:
 *   - `config`         — role / interviewType / experience / duration
 *   - `parentSessionId`— the ROOT of the retake chain (so every retake of
 *                        the same original shares the same parent id)
 *   - `hasJobDescription`, `hasResumeText` — booleans so the client can show
 *     a "JD/resume will be preserved" hint; actual text stays server-side to
 *     avoid leaking PII through localStorage. The setup form's existing
 *     `/api/interviews/last-config` fallback already hydrates these fields
 *     on the server when the user starts the session.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const authSession = await getServerSession(authOptions)
    if (!authSession?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Loads with ownership check baked in (throws ForbiddenError for non-owner).
    const parent = await getSession(
      params.id,
      authSession.user.id,
      authSession.user.role,
      authSession.user.organizationId,
      { excludeTranscript: true }
    )

    // Resolve root parent so chained retakes always link to the original,
    // keeping the comparison query trivial.
    const rootParentId = (parent.parentSessionId?.toString()) || params.id

    logger.info(
      { parentSessionId: params.id, rootParentId, userId: authSession.user.id },
      'Interview retake initiated'
    )

    return NextResponse.json({
      parentSessionId: rootParentId,
      config: {
        role: parent.config.role,
        interviewType: parent.config.interviewType,
        experience: parent.config.experience,
        duration: parent.config.duration,
      },
      hasJobDescription: !!parent.jobDescription,
      hasResumeText: !!parent.resumeText,
    })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to initiate retake')
    return NextResponse.json({ error: 'Failed to initiate retake' }, { status: 500 })
  }
}

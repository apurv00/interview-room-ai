import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { getSession } from '@interview/services/core/interviewService'
import { JobApplication, JobPosting } from '@shared/db/models'
import { jobPostingStateOf } from '@jobs/services/postingAccess'
import { preparePracticeHandoffPosting } from '@jobs/services/practiceHandoff'
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
 *   - `jobsPractice`   — verified Jobs source only; sends the client back
 *                        through the job page for a fresh signed handoff
 *   - `jobsOrigin`     — tells generic fallback clients to discard any
 *                        posting-derived browser config when reuse is denied
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
    // getSession intentionally permits organization-scoped viewers. Retaking
    // is a candidate mutation, so this endpoint is strictly owner-only.
    if (String(parent.userId) !== authSession.user.id) {
      return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 })
    }

    // Resolve root parent so chained retakes always link to the original,
    // keeping the comparison query trivial.
    const rootParentId = (parent.parentSessionId?.toString()) || params.id
    const attribution = parent.attribution as {
      source?: string
      jobId?: string
      handoffVersion?: number
      jdHash?: string
    } | undefined
    const jobsOrigin = attribution?.source === 'jobs'
    const claimedJobId = attribution?.jobId
    const attributedJobId =
      jobsOrigin &&
      attribution.handoffVersion === 1 &&
      typeof attribution.jdHash === 'string' &&
      attribution.jdHash.length === 64 &&
      typeof claimedJobId === 'string' &&
      mongoose.Types.ObjectId.isValid(claimedJobId)
        ? claimedJobId
        : undefined
    // Live Jobs context remains available to its original candidate. Normal
    // expiry/delisting also remains available, but only when a JobApplication
    // proves that this authenticated user tracked it before closure. In both
    // cases the CURRENT posting must still mint exact-JD Practice for the same
    // hash as the parent session. Safety/legal closures, changed/unreadable
    // JDs, inactive CMS roles, deleted postings, and foreign archives fall
    // back to a generic retake.
    let verifiedJobId: string | undefined
    if (attributedJobId) {
      const posting = await JobPosting.findById(attributedJobId)
        .select('domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed')
        .lean()
      if (posting) {
        const postingState = jobPostingStateOf(posting)
        const mayReuseArchivedContext = postingState === 'archived' && !!(
          await JobApplication.exists({
            userId: authSession.user.id,
            jobPostingId: attributedJobId,
          })
        )
        if (postingState === 'live' || mayReuseArchivedContext) {
          try {
            const prepared = await preparePracticeHandoffPosting(posting)
            if (prepared.role && prepared.jdHash === attribution?.jdHash) {
              verifiedJobId = attributedJobId
            }
          } catch {
            // CMS/JD preparation failure degrades to generic retake. The
            // candidate's retake remains usable without a false exact-JD CTA.
          }
        }
      }
    }

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
      ...(jobsOrigin ? { jobsOrigin: true } : {}),
      ...(verifiedJobId ? { jobsPractice: { jobId: verifiedJobId } } : {}),
    })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to initiate retake')
    return NextResponse.json({ error: 'Failed to initiate retake' }, { status: 500 })
  }
}

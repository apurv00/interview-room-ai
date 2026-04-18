/**
 * GET /api/interviews/[id]/bootstrap
 *
 * Returns the minimal payload needed for the /lobby page to hydrate an
 * `InterviewConfig` when the candidate lands via the B2B invite flow
 * (`/lobby?sessionId=X`) with empty localStorage.
 *
 * Why a dedicated endpoint instead of reusing /api/interviews/[id]?
 *   - That endpoint returns the full session document (transcript,
 *     evaluations, recordingR2Key, multimodalAnalysisId, …) — far more
 *     than the lobby needs.
 *   - Critically, the full document includes `recruiterNotes`, which is
 *     the recruiter's private evaluation notes on this candidate and
 *     MUST NOT be exposed to the candidate. After OTP adoption the
 *     candidate becomes the session's owner, so the general endpoint's
 *     owner-only PII strip wouldn't help.
 *   - A strict allowlist here is safer than a blacklist there.
 *
 * Response shape (200):
 *   {
 *     config: {
 *       role, interviewType, experience, duration,
 *       jobDescription?, resumeText?, jdFileName?, resumeFileName?, persona?
 *     },
 *     candidateName?: string,
 *     orgName?: string
 *   }
 *
 * Auth: candidate (or owner) session required. Ownership is strict —
 * recruiters with org-scope access can't bootstrap; they have their own
 * hire UI.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, Organization } from '@shared/db/models'
import { logger } from '@shared/logger'
import type { InterviewConfig } from '@shared/types'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await connectDB()

    const doc = await InterviewSession.findById(params.id)
      .select(
        'userId organizationId config jobDescription resumeText jdFileName resumeFileName persona candidateName status',
      )
      .lean()

    if (!doc) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Strict owner check. Recruiters with org-scope access are deliberately
    // excluded — this endpoint exists to seed the candidate's /lobby.
    if (doc.userId?.toString() !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const config: InterviewConfig = {
      role: doc.config.role,
      interviewType: doc.config.interviewType,
      experience: doc.config.experience,
      duration: doc.config.duration,
      ...(doc.jobDescription && { jobDescription: doc.jobDescription }),
      ...(doc.resumeText && { resumeText: doc.resumeText }),
      ...(doc.jdFileName && { jdFileName: doc.jdFileName }),
      ...(doc.resumeFileName && { resumeFileName: doc.resumeFileName }),
      ...(doc.persona && { persona: doc.persona }),
    }

    let orgName: string | undefined
    if (doc.organizationId) {
      const org = await Organization.findById(doc.organizationId)
        .select('name')
        .lean()
      if (org?.name) orgName = org.name
    }

    return NextResponse.json({
      config,
      ...(doc.candidateName && { candidateName: doc.candidateName }),
      ...(orgName && { orgName }),
    })
  } catch (err) {
    logger.error({ err, sessionId: params.id }, 'Failed to bootstrap interview')
    return NextResponse.json({ error: 'Failed to bootstrap session' }, { status: 500 })
  }
}

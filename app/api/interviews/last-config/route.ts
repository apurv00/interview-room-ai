import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { listSessions } from '@interview/services/core/interviewService'
import { logger } from '@shared/logger'
import type { InterviewConfig } from '@shared/types'

interface StoredSession {
  config?: InterviewConfig
  jobDescription?: string
  resumeText?: string
  jdFileName?: string
  resumeFileName?: string
}

export const dynamic = 'force-dynamic'

/**
 * GET /api/interviews/last-config
 *
 * Returns the user's most recent interview setup so a returning user on a
 * fresh device (empty localStorage) can be offered a one-click "enter the
 * interview room" flow. Responds with `{ config: null }` when the user has
 * never started an interview.
 *
 * This is the DB fallback for `InterviewSetupForm`'s repeat-user modal —
 * localStorage is the primary source.
 */
export async function GET(_req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await listSessions({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      role: session.user.role,
      page: 1,
      limit: 1,
    })

    const latest = result.sessions[0] as StoredSession | undefined
    if (!latest?.config) {
      return NextResponse.json({ config: null })
    }

    // Reconstruct the full client-side InterviewConfig. Sessions store the
    // config blob at `config` but also mirror the heavy fields (jobDescription,
    // resumeText, jdFileName, resumeFileName) at the top level — see
    // createSession in modules/interview/services/interviewService.ts.
    const config: InterviewConfig = {
      ...latest.config,
      ...(latest.jobDescription && { jobDescription: latest.jobDescription }),
      ...(latest.resumeText && { resumeText: latest.resumeText }),
      ...(latest.jdFileName && { jdFileName: latest.jdFileName }),
      ...(latest.resumeFileName && { resumeFileName: latest.resumeFileName }),
    }

    return NextResponse.json({ config })
  } catch (err) {
    logger.error({ err }, 'Failed to load last interview config')
    return NextResponse.json({ error: 'Failed to load last config' }, { status: 500 })
  }
}

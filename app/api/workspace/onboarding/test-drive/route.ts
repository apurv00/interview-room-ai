/**
 * Member-only cleanup/read endpoint for the retired Hire practice flow.
 *
 * New practice graphs must never be created again. Existing graphs retain
 * their bounded member-cleanup and lifecycle paths until production drain is
 * complete, so retiring the product surface cannot strand personal data.
 */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import {
  getHireOnboardingTestDrive,
  removeHireOnboardingTestDrive,
} from '@/modules/hire-onboarding/services/testDriveService'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const MEMBER_PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-test-drive-read' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const testDrive = await getHireOnboardingTestDrive(ctx)
    return NextResponse.json({ testDrive }, { headers: MEMBER_PRIVATE_HEADERS })
  },
})

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-test-drive-start' },
  async handler(_req, { user }) {
    await requireMembership({ userId: user.id, email: user.email })
    return NextResponse.json(
      { error: 'Hire practice interviews have been retired.' },
      { status: 410, headers: MEMBER_PRIVATE_HEADERS },
    )
  },
})

export const DELETE = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-test-drive-remove' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const testDrive = await removeHireOnboardingTestDrive(ctx)
    return NextResponse.json({ testDrive }, { headers: MEMBER_PRIVATE_HEADERS })
  },
})

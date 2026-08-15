/**
 * Member-only "Interview yourself" practice flow. The one raw invite URL is
 * returned only by the initial successful POST and is never accepted back as
 * input or included in the durable test-drive record.
 */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import {
  getHireOnboardingTestDrive,
  removeHireOnboardingTestDrive,
  startHireOnboardingTestDrive,
} from '@/modules/hire-onboarding/services/testDriveService'
import {
  StartHireOnboardingTestDriveSchema,
  type StartHireOnboardingTestDrivePayload,
} from '@/modules/hire-onboarding/validators/hireOnboarding'
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

export const POST = composeHireApiRoute<StartHireOnboardingTestDrivePayload>({
  schema: StartHireOnboardingTestDriveSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-test-drive-start' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await startHireOnboardingTestDrive(ctx, body)
    return NextResponse.json(
      {
        testDrive: result.testDrive,
        inviteUrl: result.inviteUrl,
        created: result.created,
        emailSent: result.emailSent,
      },
      {
        status: result.created ? 201 : 200,
        headers: MEMBER_PRIVATE_HEADERS,
      },
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

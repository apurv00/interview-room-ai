import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { ZodError } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'
import {
  captureHireRuntimeMultimodalObservation,
  HireMultimodalCaptureSchema,
} from '@modules/hire-runtime/services/multimodalObservationCaptureService'

export const dynamic = 'force-dynamic'

const FENCE_BYPASS_HEADER = 'x-ipg-hire-runtime-fence-bypass'
const ORIGIN_USER_HEADER = 'x-origin-user-id'

function trustedFenceRequest(req: NextRequest): boolean {
  const secret = process.env.HIRE_RUNTIME_FENCE_SECRET
  return Boolean(
    secret &&
      secret.length >= 32 &&
      req.headers.get(FENCE_BYPASS_HEADER) === secret,
  )
}

export async function POST(req: NextRequest) {
  if (!trustedFenceRequest(req)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (req.headers.get(ORIGIN_USER_HEADER) !== session.user.id) {
    return NextResponse.json({ error: 'Session changed' }, { status: 409 })
  }
  try {
    const outcome = await captureHireRuntimeMultimodalObservation({
      workspaceId: requireRuntimeWorkspaceId(session.user.organizationId),
      principalId: session.user.id,
      capture: HireMultimodalCaptureSchema.parse(await req.json()),
    })
    // Candidates never receive or render their own derived report. Recruiter
    // access happens only after the separate signed runtime → control bridge.
    return NextResponse.json(
      { accepted: outcome === 'accepted', outcome },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid capture' }, { status: 400 })
    }
    return NextResponse.json(
      { error: 'Capture unavailable' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
}

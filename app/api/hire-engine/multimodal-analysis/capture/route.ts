import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { ZodError } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES } from '@shared/contracts/hireMultimodalAnalysisBridge'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'
import {
  captureHireRuntimeMultimodalAnalysis,
  HireMultimodalAnalysisCaptureSchema,
} from '@modules/hire-runtime/services/multimodalAnalysisCaptureService'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

  const body = await req.text()
  if (Buffer.byteLength(body) > HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Capture is too large' }, { status: 413 })
  }
  try {
    const outcome = await captureHireRuntimeMultimodalAnalysis({
      workspaceId: requireRuntimeWorkspaceId(session.user.organizationId),
      principalId: session.user.id,
      capture: HireMultimodalAnalysisCaptureSchema.parse(JSON.parse(body)),
    })
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

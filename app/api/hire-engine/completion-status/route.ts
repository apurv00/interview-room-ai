import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { logger } from '@shared/logger'
import {
  completionBindingForPrincipal,
  HireRuntimeBindingError,
} from '@modules/hire-runtime/services/bindingService'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    )
  }

  try {
    const workspaceId = requireRuntimeWorkspaceId(session.user.organizationId)
    const binding = await completionBindingForPrincipal({
      workspaceId,
      principalId: session.user.id,
    })
    if (!binding.runtimeSessionId) {
      return NextResponse.json(
        { state: 'pending' },
        { headers: NO_STORE_HEADERS },
      )
    }

    const interview = await InterviewSession.findOne({
      _id: binding.runtimeSessionId,
      userId: binding.principalId,
      organizationId: workspaceId,
    })
      .select('status')
      .lean<{ status?: string }>()

    const completed = interview?.status === 'completed'
    return NextResponse.json(
      { state: completed ? 'completed' : 'pending' },
      { headers: NO_STORE_HEADERS },
    )
  } catch (error) {
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS },
      )
    }
    logger.error(
      { errorName: error instanceof Error ? error.constructor.name : 'UnknownError' },
      'hire runtime completion status failed',
    )
    return NextResponse.json(
      { error: 'Service unavailable' },
      { status: 503, headers: NO_STORE_HEADERS },
    )
  }
}

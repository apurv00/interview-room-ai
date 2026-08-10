import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { createSession } from '@interview/services/core/interviewService'
import {
  acquireSessionProvisioningLease,
  attachRuntimeSession,
  attachRuntimeSessionAfterRevocation,
  HireRuntimeBindingError,
  releaseSessionProvisioningLease,
} from '@modules/hire-runtime/services/bindingService'
import { ensureRuntimePrincipal } from '@modules/hire-runtime/services/runtimePrincipalService'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'
import { AppError } from '@shared/errors'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let workspaceId: string
  try {
    workspaceId = requireRuntimeWorkspaceId(session.user.organizationId)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let lease: Awaited<ReturnType<typeof acquireSessionProvisioningLease>> | undefined
  try {
    lease = await acquireSessionProvisioningLease({
      workspaceId,
      principalId: session.user.id,
    })
    if (lease.binding.runtimeSessionId) {
      return NextResponse.json({ sessionId: lease.binding.runtimeSessionId.toString() })
    }
    if (!lease.leaseToken) {
      return NextResponse.json({ error: 'Session provisioning unavailable' }, { status: 409 })
    }

    const principal = await ensureRuntimePrincipal(lease.binding)
    if (!principal) {
      throw new HireRuntimeBindingError(
        'Runtime binding unavailable',
        'revoked',
        410,
      )
    }
    // Recover an engine session created before a serverless interruption but
    // not yet attached to its binding. Exact canonical config prevents an
    // unrelated runtime session from being adopted.
    const orphan = await InterviewSession.findOne({
      userId: lease.binding.principalId,
      organizationId: workspaceId,
      createdAt: { $gte: lease.binding.createdAt },
      'config.role': lease.binding.config.role,
      'config.interviewType': lease.binding.config.interviewType,
      'config.experience': lease.binding.config.experience,
      'config.duration': lease.binding.config.duration,
      jobDescription: lease.binding.config.jobDescription,
    })
      .sort({ createdAt: 1 })
      .select('_id')
      .lean()

    const engineSession = orphan ?? (await createSession({
      userId: lease.binding.principalId.toString(),
      organizationId: workspaceId,
      config: lease.binding.config,
      jobDescription: lease.binding.config.jobDescription,
      userAgent: req.headers.get('user-agent') ?? undefined,
    }))
    let attached
    try {
      attached = await attachRuntimeSession({
        workspaceId,
        bindingId: lease.binding._id.toString(),
        leaseToken: lease.leaseToken,
        runtimeSessionId: engineSession._id.toString(),
      })
    } catch (error) {
      if (error instanceof HireRuntimeBindingError) {
        await attachRuntimeSessionAfterRevocation({
          workspaceId,
          bindingId: lease.binding._id.toString(),
          runtimeSessionId: engineSession._id.toString(),
        })
      }
      throw error
    }
    return NextResponse.json(
      { sessionId: attached.runtimeSessionId!.toString() },
      { status: orphan ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    if (lease?.leaseToken) {
      await releaseSessionProvisioningLease({
        workspaceId,
        bindingId: lease.binding._id.toString(),
        leaseToken: lease.leaseToken,
      }).catch(() => undefined)
    }
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode })
    }
    return NextResponse.json({ error: 'Could not create interview session' }, { status: 503 })
  }
}

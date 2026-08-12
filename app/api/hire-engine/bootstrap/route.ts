import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { HireRuntimeBootstrapResponseSchema } from '@shared/contracts/hireEngineBridge'
import { logger } from '@shared/logger'
import {
  activeBindingForPrincipal,
  HireRuntimeBindingError,
} from '@modules/hire-runtime/services/bindingService'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'
import { runtimeEngineConfig } from '@modules/hire-runtime/services/runtimeEngineConfig'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let stage: 'binding_lookup' | 'response_serialization' = 'binding_lookup'
  try {
    const binding = await activeBindingForPrincipal({
      workspaceId: requireRuntimeWorkspaceId(session.user.organizationId),
      principalId: session.user.id,
    })
    stage = 'response_serialization'
    return NextResponse.json(
      HireRuntimeBootstrapResponseSchema.parse({
        principalId: binding.principalId.toString(),
        roundId: binding.roundId.toString(),
        config: runtimeEngineConfig(binding.config),
      }),
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    )
  } catch (error) {
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    logger.error(
      {
        stage,
        errorName: error instanceof Error ? error.constructor.name : 'UnknownError',
      },
      'hire runtime bootstrap failed',
    )
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { HireRuntimeBootstrapResponseSchema } from '@shared/contracts/hireEngineBridge'
import {
  activeBindingForPrincipal,
  HireRuntimeBindingError,
} from '@modules/hire-runtime/services/bindingService'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const binding = await activeBindingForPrincipal({
      workspaceId: requireRuntimeWorkspaceId(session.user.organizationId),
      principalId: session.user.id,
    })
    return NextResponse.json(
      HireRuntimeBootstrapResponseSchema.parse({
        principalId: binding.principalId.toString(),
        roundId: binding.roundId.toString(),
        config: binding.config,
      }),
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    )
  } catch (error) {
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}

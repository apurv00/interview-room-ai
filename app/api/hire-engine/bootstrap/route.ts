import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { HireRuntimeBootstrapResponseSchema } from '@shared/contracts/hireEngineBridge'
import { logger } from '@shared/logger'
import {
  supportsHireDisplayCapture,
  supportsHireMultimodalObservations,
} from '@hire/policies/aiInterviewConsent'
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
    const response = NextResponse.json(
      HireRuntimeBootstrapResponseSchema.parse({
        principalId: binding.principalId.toString(),
        roundId: binding.roundId.toString(),
        config: runtimeEngineConfig(binding.config),
      }),
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    )
    // This is only a client-side collection hint. The capture route checks
    // the immutable binding again, so a stale or forged browser marker cannot
    // create a recruiter-visible analysis artifact.
    if (supportsHireMultimodalObservations(binding.consentVersion)) {
      response.headers.set('X-Hire-Multimodal-Observations', '1')
    }
    // The authenticated bootstrap response derives this marker from the
    // immutable signed runtime binding. It is a browser setup requirement;
    // runtime capture endpoints still re-check the binding and V6 consent.
    if (supportsHireDisplayCapture(binding.consentVersion)) {
      response.headers.set('X-Hire-Display-Capture-Required', '1')
    }
    return response
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

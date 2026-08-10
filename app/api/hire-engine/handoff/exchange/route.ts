import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { HireRuntimeHandoffRequestSchema } from '@shared/contracts/hireEngineBridge'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { issueAuthTicket } from '@b2b/services/inviteTicketService'
import { exchangeHandoffWithControl, HireControlBridgeError } from '@modules/hire-runtime/services/controlBridgeClient'
import {
  activateRuntimeBinding,
  HireRuntimeBindingError,
  provisionRuntimeBinding,
} from '@modules/hire-runtime/services/bindingService'
import { ensureRuntimePrincipal } from '@modules/hire-runtime/services/runtimePrincipalService'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const blocked = await checkRateLimit(ip, {
    windowMs: 15 * 60_000,
    maxRequests: 20,
    keyPrefix: 'rl:hire-runtime-exchange',
  })
  if (blocked) return blocked

  try {
    const input = HireRuntimeHandoffRequestSchema.parse(await req.json())
    const envelope = await exchangeHandoffWithControl(input.code)
    const binding = await provisionRuntimeBinding(envelope)
    const principal = await ensureRuntimePrincipal(binding)
    if (!principal) {
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
    }
    const ticket = await issueAuthTicket(
      binding.principalId.toString(),
      binding.roundId.toString(),
      binding.workspaceId.toString(),
    )
    if (!ticket) {
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
    }
    await activateRuntimeBinding({
      workspaceId: binding.workspaceId.toString(),
      bindingId: binding._id.toString(),
    })
    return NextResponse.json(
      { ok: true, ticket },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    )
  } catch (error) {
    if (error instanceof HireControlBridgeError) {
      const status = error.status === 410 ? 410 : error.retryable ? 503 : error.status
      return NextResponse.json({ error: 'This interview handoff is unavailable' }, { status })
    }
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}

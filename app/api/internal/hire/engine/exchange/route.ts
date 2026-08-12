import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { HireEngineExchangeResponseSchema } from '@shared/contracts/hireEngineBridge'
import { verifyInternalServiceRequest } from '@shared/services/internalServiceAuth'
import {
  exchangeHireEngineHandoff,
  HireEngineHandoffError,
} from '@hire/services/engineHandoffService'

export const dynamic = 'force-dynamic'
const ROUTE_PATH = '/api/internal/hire/engine/exchange'
const MAX_BODY_BYTES = 8 * 1024

export async function POST(req: NextRequest) {
  const body = await req.text()
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const auth = await verifyInternalServiceRequest({
    method: 'POST',
    path: ROUTE_PATH,
    body,
    headers: req.headers,
  })
  if (!auth.ok) {
    const status = auth.reason === 'replay-store-unavailable' ? 503 : 401
    return NextResponse.json({ error: 'Service authentication failed' }, { status })
  }

  try {
    const envelope = await exchangeHireEngineHandoff(JSON.parse(body))
    return NextResponse.json(HireEngineExchangeResponseSchema.parse({ envelope }), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof HireEngineHandoffError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}

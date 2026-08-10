import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { verifyInternalServiceRequest } from '@shared/services/internalServiceAuth'
import {
  HireEngineIngestionError,
  ingestHireEngineResult,
} from '@hire/services/resultIngestionService'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
const ROUTE_PATH = '/api/internal/hire/engine/results'
const MAX_BODY_BYTES = 2 * 1024 * 1024

export async function POST(req: NextRequest) {
  const body = await req.text()
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
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
    const result = await ingestHireEngineResult(JSON.parse(body))
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof HireEngineIngestionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}

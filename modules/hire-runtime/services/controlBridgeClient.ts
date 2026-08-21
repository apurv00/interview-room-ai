import { createHash } from 'node:crypto'
import {
  HireEngineExchangeResponseSchema,
  HireEngineResultIngestionSchema,
  type HireEngineHandoffEnvelope,
  type HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'
import {
  HireMultimodalObservationIngestionSchema,
  type HireMultimodalObservationIngestion,
} from '@shared/contracts/hireMultimodalObservationBridge'
import {
  HireMultimodalAnalysisIngestionSchema,
  type HireMultimodalAnalysisIngestion,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import { createInternalServiceHeaders } from '@shared/services/internalServiceAuth'
import { assertHireRuntimeSurface } from './runtimeBoundary'

export class HireControlBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'HireControlBridgeError'
  }
}

function controlBaseUrl(): string {
  assertHireRuntimeSurface()
  const raw = process.env.HIRE_CONTROL_INTERNAL_URL
  if (!raw) throw new HireControlBridgeError('Hire control URL is not configured', 503, true)
  const url = new URL(raw)
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new HireControlBridgeError('Hire control URL must use HTTPS', 503, false)
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const HANDOFF_TIMEOUT_MS = 15_000
const RESULT_INGESTION_TIMEOUT_MS = 4 * 60 * 1_000

function handoffRequestId(code: string, clientNonce: string): string {
  return createHash('sha256')
    .update('ipg-hire-handoff-request:v2\0')
    .update(code.toLowerCase())
    .update('\0')
    .update(clientNonce.toLowerCase())
    .digest('hex')
}

async function postControl(
  path: string,
  value: unknown,
  timeoutMs = HANDOFF_TIMEOUT_MS,
): Promise<unknown> {
  const body = JSON.stringify(value)
  const response = await fetch(new URL(path, controlBaseUrl()), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...createInternalServiceHeaders({ method: 'POST', path, body }),
    },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const responseBody = await response.text()
  if (!response.ok) {
    throw new HireControlBridgeError(
      `Hire control bridge returned ${response.status}`,
      response.status,
      response.status === 429 || response.status >= 500,
    )
  }
  try {
    return JSON.parse(responseBody)
  } catch {
    throw new HireControlBridgeError('Hire control returned invalid JSON', 502, true)
  }
}

export async function exchangeHandoffWithControl(
  code: string,
  clientNonce: string,
): Promise<HireEngineHandoffEnvelope> {
  const requestId = handoffRequestId(code, clientNonce)
  const response = await postControl('/api/internal/hire/engine/exchange', {
    code: code.toLowerCase(),
    requestId,
  })
  return HireEngineExchangeResponseSchema.parse(response).envelope
}

export async function publishResultToControl(
  rawPayload: HireEngineResultIngestion,
): Promise<'processed' | 'duplicate' | 'stale'> {
  const payload = HireEngineResultIngestionSchema.parse(rawPayload)
  const response = (await postControl(
    '/api/internal/hire/engine/results',
    payload,
    RESULT_INGESTION_TIMEOUT_MS,
  )) as { ok?: unknown; outcome?: unknown }
  if (
    response.ok !== true ||
    !['processed', 'duplicate', 'stale'].includes(String(response.outcome))
  ) {
    throw new HireControlBridgeError('Hire control returned an invalid result ack', 502, true)
  }
  return response.outcome as 'processed' | 'duplicate' | 'stale'
}

export async function publishMultimodalObservationToControl(
  rawPayload: HireMultimodalObservationIngestion,
): Promise<'processed' | 'duplicate' | 'stale'> {
  const payload = HireMultimodalObservationIngestionSchema.parse(rawPayload)
  const response = (await postControl(
    '/api/internal/hire/engine/multimodal-observations',
    payload,
  )) as { ok?: unknown; outcome?: unknown }
  if (
    response.ok !== true ||
    !['processed', 'duplicate', 'stale'].includes(String(response.outcome))
  ) {
    throw new HireControlBridgeError(
      'Hire control returned an invalid multimodal observation acknowledgement',
      502,
      true,
    )
  }
  return response.outcome as 'processed' | 'duplicate' | 'stale'
}

/** Publishes a checksum-addressed raw-landmark artifact for Hire-only review
 * analysis. It is intentionally not routed through B2C `/api/analysis/*`. */
export async function publishMultimodalAnalysisToControl(
  rawPayload: HireMultimodalAnalysisIngestion,
): Promise<'processed' | 'duplicate' | 'stale'> {
  const payload = HireMultimodalAnalysisIngestionSchema.parse(rawPayload)
  const response = (await postControl(
    '/api/internal/hire/engine/multimodal-analysis',
    payload,
    RESULT_INGESTION_TIMEOUT_MS,
  )) as { ok?: unknown; outcome?: unknown }
  if (
    response.ok !== true ||
    !['processed', 'duplicate', 'stale'].includes(String(response.outcome))
  ) {
    throw new HireControlBridgeError(
      'Hire control returned an invalid multimodal analysis acknowledgement',
      502,
      true,
    )
  }
  return response.outcome as 'processed' | 'duplicate' | 'stale'
}

export const __controlBridgeClient = {
  HANDOFF_TIMEOUT_MS,
  RESULT_INGESTION_TIMEOUT_MS,
  handoffRequestId,
}

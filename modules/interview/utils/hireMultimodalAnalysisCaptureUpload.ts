'use client'

import {
  fitHireMultimodalAnalysisCaptureToBodyLimit,
  type HireMultimodalAnalysisFacialFrame,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import type { ReplayUploadIntent } from './resumableUpload'
import { requestAccountBoundJson } from './accountBoundArtifactUpload'

const CAPTURE_PATH = '/api/hire-engine/multimodal-analysis/capture'
export const HIRE_MULTIMODAL_CAPTURE_MAX_DELIVERY_ATTEMPTS = 3
export const HIRE_MULTIMODAL_CAPTURE_RETRY_DELAYS_MS = [250, 750] as const
/** Each attempt is bounded so all retries finish before navigation. */
export const HIRE_MULTIMODAL_CAPTURE_REQUEST_TIMEOUT_MS = 2_000
/** The interview finish path waits at most this long before navigation. */
export const HIRE_MULTIMODAL_CAPTURE_DELIVERY_TIMEOUT_MS = 8_000

export type HireMultimodalCaptureDeliveryOutcome =
  | 'accepted'
  | 'already_captured'
  | 'disabled'
  | 'cancelled'

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function readOutcome(value: unknown): Exclude<HireMultimodalCaptureDeliveryOutcome, 'cancelled'> | null {
  if (!value || typeof value !== 'object') return null
  const outcome = (value as { outcome?: unknown }).outcome
  return outcome === 'accepted' || outcome === 'already_captured' || outcome === 'disabled'
    ? outcome
    : null
}

/**
 * Delivers a bounded Hire landmark payload and waits for the runtime's durable
 * outbox receipt. Transient offline/5xx failures retry within the interview
 * finish window; privacy/account cancellation intentionally does not retry.
 */
export async function deliverHireMultimodalAnalysisCapture(input: {
  sessionId: string
  frames: HireMultimodalAnalysisFacialFrame[]
  intent: ReplayUploadIntent
  originUserId: string
}): Promise<HireMultimodalCaptureDeliveryOutcome> {
  const capture = fitHireMultimodalAnalysisCaptureToBodyLimit({
    sessionId: input.sessionId,
    frames: input.frames,
  })
  let lastFailure: unknown = null
  for (let attempt = 0; attempt < HIRE_MULTIMODAL_CAPTURE_MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      const response = await requestAccountBoundJson(
        CAPTURE_PATH,
        capture,
        input.intent,
        input.originUserId,
        { timeoutMs: HIRE_MULTIMODAL_CAPTURE_REQUEST_TIMEOUT_MS },
      )
      if (!response) return 'cancelled'
      if (response.ok) {
        const outcome = readOutcome(await response.json().catch(() => null))
        if (outcome) return outcome
        throw new Error('Hire multimodal capture response was malformed')
      }
      lastFailure = new Error(`Hire multimodal capture failed: ${response.status}`)
      if (!retryableStatus(response.status)) throw lastFailure
    } catch (error) {
      lastFailure = error
      // A non-retryable HTTP response is encoded above as an Error. Preserve
      // its terminal nature rather than turning a bad request into retries.
      if (
        error instanceof Error &&
        /^Hire multimodal capture failed: (?!408$|429$|5\d\d$)\d+$/.test(error.message)
      ) {
        throw error
      }
    }
    const retryDelay = HIRE_MULTIMODAL_CAPTURE_RETRY_DELAYS_MS[attempt]
    if (retryDelay !== undefined) await delay(retryDelay)
  }
  throw lastFailure instanceof Error
    ? lastFailure
    : new Error('Hire multimodal capture delivery failed')
}

/** Bound a caller-owned promise before Hire feedback navigation. */
export async function awaitHireMultimodalCaptureDelivery(
  delivery: Promise<unknown> | void,
): Promise<'settled' | 'timed_out'> {
  if (!delivery) return 'settled'
  const result = await Promise.race([
    Promise.resolve(delivery).then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    delay(HIRE_MULTIMODAL_CAPTURE_DELIVERY_TIMEOUT_MS).then(() => 'timed_out' as const),
  ])
  return result
}

export const __hireMultimodalAnalysisCaptureUpload = {
  CAPTURE_PATH,
  retryableStatus,
  readOutcome,
}

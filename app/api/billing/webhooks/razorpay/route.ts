import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@shared/logger'
import {
  RAZORPAY_ENVIRONMENT_VARIABLES,
  RazorpayConfigurationError,
  loadRazorpayWebhookSigningSecrets,
  type RazorpayWebhookSigningSecret,
} from '@payments/providers/razorpayEnvironment'
import {
  loadWebhookPayloadEncryptionKey,
  WebhookPayloadCipherConfigurationError,
} from '@payments/providers/webhookPayloadCipher'
import {
  verifyRazorpayWebhookSignature,
} from '@payments/providers/razorpaySignature'
import {
  RazorpayWebhookDedupeConflictError,
  MAX_RAZORPAY_WEBHOOK_BYTES,
  RazorpayWebhookPayloadError,
  RazorpayWebhookSignatureError,
  receiveRazorpayWebhook,
} from '@payments/services/webhookInboxService'
import {
  processPaymentWebhookEvent,
} from '@payments/services/webhookProcessingService'
import type { ProviderMode } from '@payments/types/catalog'
import {
  paymentWebhookLaunchHandler,
} from '@/app/api/_lib/paymentWebhookLaunchComposition'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const webhookLogger = logger.child({ module: 'payments-webhook' })

function json(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      ...headers,
    },
  })
}

interface ModeSecrets {
  providerMode: ProviderMode
  signingSecrets: RazorpayWebhookSigningSecret[]
}

class WebhookBodyReadError extends Error {
  readonly reason: 'invalid_body' | 'too_large'

  constructor(reason: WebhookBodyReadError['reason']) {
    super(reason)
    this.name = 'WebhookBodyReadError'
    this.reason = reason
  }
}

async function readBoundedRawBody(request: NextRequest): Promise<Buffer> {
  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_RAZORPAY_WEBHOOK_BYTES
  ) {
    throw new WebhookBodyReadError('too_large')
  }
  if (!request.body) return Buffer.alloc(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > MAX_RAZORPAY_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new WebhookBodyReadError('too_large')
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (error instanceof WebhookBodyReadError) throw error
    throw new WebhookBodyReadError('invalid_body')
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    byteLength,
  )
}

function configuredWebhookSecrets(): ModeSecrets[] {
  const configured: ModeSecrets[] = []
  for (const providerMode of ['test', 'live'] as const) {
    const variableName =
      RAZORPAY_ENVIRONMENT_VARIABLES[providerMode].webhookSecret
    if (!process.env[variableName]?.trim()) continue
    configured.push({
      providerMode,
      signingSecrets: loadRazorpayWebhookSigningSecrets(providerMode),
    })
  }
  return configured
}

function resolveProviderMode(input: {
  rawBody: Uint8Array
  signature: string
  configured: readonly ModeSecrets[]
}): ModeSecrets {
  const matches = input.configured.filter(({ signingSecrets }) => (
    verifyRazorpayWebhookSignature({
      rawBody: input.rawBody,
      signature: input.signature,
      signingSecrets,
    }).verified
  ))
  if (matches.length === 0) throw new RazorpayWebhookSignatureError()
  if (matches.length !== 1) {
    throw new RazorpayConfigurationError(
      'Razorpay webhook signature matched more than one provider mode',
    )
  }
  return matches[0]
}

export async function POST(request: NextRequest) {
  const signature = request.headers.get('x-razorpay-signature')
  if (!signature) {
    return json({ error: 'Missing Razorpay signature' }, 400)
  }

  let rawBody: Buffer
  try {
    rawBody = await readBoundedRawBody(request)
  } catch (error) {
    if (
      error instanceof WebhookBodyReadError &&
      error.reason === 'too_large'
    ) {
      return json({ error: 'Razorpay webhook body is too large' }, 413)
    }
    return json({ error: 'Unable to read webhook body' }, 400)
  }

  let matchedMode: ModeSecrets | undefined
  try {
    const configured = configuredWebhookSecrets()
    if (configured.length === 0) {
      throw new RazorpayConfigurationError(
        'No Razorpay webhook mode is configured',
      )
    }
    matchedMode = resolveProviderMode({
      rawBody,
      signature,
      configured,
    })
    const payloadEncryptionKey = loadWebhookPayloadEncryptionKey()
    const result = await receiveRazorpayWebhook({
      providerMode: matchedMode.providerMode,
      rawBody,
      signature,
      razorpayEventId:
        request.headers.get('x-razorpay-event-id') ?? undefined,
      signingSecrets: matchedMode.signingSecrets,
      payloadEncryptionKey,
    })
    const processing = await processPaymentWebhookEvent({
      eventId: result.id,
      handler: paymentWebhookLaunchHandler,
    })
    if (
      processing.outcome === 'processed' ||
      processing.outcome === 'already_processed'
    ) {
      return json({
        received: true,
        duplicate: result.duplicate,
      }, 200)
    }

    webhookLogger.error(
      {
        providerMode: matchedMode.providerMode,
        processingOutcome: processing.outcome,
      },
      'Razorpay webhook was stored but not completed',
    )
    if (processing.outcome === 'dead_letter') {
      return json({ error: 'Webhook requires review' }, 409)
    }
    return json(
      { error: 'Webhook processing is temporarily unavailable' },
      503,
      { 'Retry-After': '10' },
    )
  } catch (error) {
    if (error instanceof RazorpayWebhookSignatureError) {
      return json({ error: 'Invalid Razorpay signature' }, 401)
    }
    if (error instanceof RazorpayWebhookPayloadError) {
      return json({ error: 'Invalid Razorpay webhook payload' }, 400)
    }
    if (error instanceof RazorpayWebhookDedupeConflictError) {
      webhookLogger.error(
        {
          providerMode: matchedMode?.providerMode,
          eventIdPresent: request.headers.has('x-razorpay-event-id'),
        },
        'Razorpay webhook dedupe conflict',
      )
      return json({ error: 'Webhook receipt conflict' }, 409)
    }
    if (
      error instanceof RazorpayConfigurationError ||
      error instanceof WebhookPayloadCipherConfigurationError
    ) {
      webhookLogger.error(
        {
          errorName: error.name,
          providerMode: matchedMode?.providerMode,
        },
        'Razorpay webhook ingress is not ready',
      )
      return json(
        { error: 'Webhook ingress is temporarily unavailable' },
        503,
        { 'Retry-After': '30' },
      )
    }

    webhookLogger.error(
      {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        providerMode: matchedMode?.providerMode,
      },
      'Razorpay webhook receipt failed',
    )
    return json(
      { error: 'Webhook receipt is temporarily unavailable' },
      503,
      { 'Retry-After': '30' },
    )
  }
}

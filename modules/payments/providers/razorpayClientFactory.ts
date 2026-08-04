import Razorpay from 'razorpay'
import type { ProviderMode } from '../types/catalog'
import {
  loadRazorpayApiCredentials,
} from './razorpayEnvironment'
import {
  createRazorpayRefundCommandAdapter,
  createRazorpayServerAdapter,
  type RazorpayRefundCommandAdapter,
  type RazorpayRefundCommandTransport,
  type RazorpayCustomerCreatePayload,
  type RazorpayInvoiceListPayload,
  type RazorpayOfferReader,
  type RazorpayOrderCreatePayload,
  type RazorpayOrderListPayload,
  type RazorpayPlanCreatePayload,
  type RazorpaySdkPort,
  type RazorpayServerAdapter,
  type RazorpaySubscriptionCreatePayload,
  type RazorpaySubscriptionListPayload,
} from './razorpayServerAdapter'
import {
  createRazorpaySubscriptionCancellationAdapter,
  type RazorpaySubscriptionCancellationAdapter,
} from './razorpaySubscriptionCancellationAdapter'

type EnvironmentSource = Readonly<Record<string, string | undefined>>

export interface RazorpaySdkAuthConfig {
  key_id: string
  key_secret: string
}

export type RazorpaySdkBuilder = (
  config: RazorpaySdkAuthConfig,
) => RazorpaySdkPort

export interface RazorpayClientFactory {
  forMode(mode: ProviderMode): RazorpayServerAdapter
}

export interface RazorpaySubscriptionCancellationClientFactory {
  forMode(mode: ProviderMode): RazorpaySubscriptionCancellationAdapter
}

export interface CreateRazorpayClientFactoryOptions {
  environment?: EnvironmentSource
  sdkBuilder?: RazorpaySdkBuilder
  offerReader?: RazorpayOfferReader
}

function buildOfficialRazorpaySdkPort(
  config: RazorpaySdkAuthConfig,
): RazorpaySdkPort {
  const client = new Razorpay(config)
  return {
    orders: {
      create(input: RazorpayOrderCreatePayload) {
        return client.orders.create(input)
      },
      all(input: RazorpayOrderListPayload) {
        return client.orders.all(input)
      },
      fetch(orderId: string) {
        return client.orders.fetch(orderId)
      },
      fetchPayments(orderId: string) {
        return client.orders.fetchPayments(orderId)
      },
    },
    payments: {
      fetch(paymentId: string) {
        return client.payments.fetch(paymentId)
      },
    },
    invoices: {
      fetch(invoiceId: string) {
        return client.invoices.fetch(invoiceId)
      },
      all(input: RazorpayInvoiceListPayload) {
        return client.invoices.all(input)
      },
    },
    refunds: {
      fetch(refundId: string) {
        return client.refunds.fetch(refundId)
      },
    },
    disputes: {
      fetch(disputeId: string) {
        return client.disputes.fetch(disputeId)
      },
    },
    plans: {
      create(input: RazorpayPlanCreatePayload) {
        return client.plans.create(input)
      },
      fetch(planId: string) {
        return client.plans.fetch(planId)
      },
    },
    subscriptions: {
      create(input: RazorpaySubscriptionCreatePayload) {
        return client.subscriptions.create(input)
      },
      all(input: RazorpaySubscriptionListPayload) {
        return client.subscriptions.all(input)
      },
      fetch(subscriptionId: string) {
        return client.subscriptions.fetch(subscriptionId)
      },
      cancel(
        subscriptionId: string,
        cancelAtCycleEnd: boolean,
      ) {
        return client.subscriptions.cancel(
          subscriptionId,
          cancelAtCycleEnd,
        )
      },
    },
    customers: {
      create(input: RazorpayCustomerCreatePayload) {
        return client.customers.create(input)
      },
      fetch(customerId: string) {
        return client.customers.fetch(customerId)
      },
    },
  }
}

/**
 * Builds mode-isolated clients lazily. Importing or constructing this factory
 * does not read credentials; the selected mode is loaded only on first use.
 */
export function createRazorpayClientFactory(
  options: CreateRazorpayClientFactoryOptions = {},
): RazorpayClientFactory {
  const environment = options.environment ?? process.env
  const sdkBuilder = options.sdkBuilder ?? buildOfficialRazorpaySdkPort
  const clients = new Map<ProviderMode, RazorpayServerAdapter>()

  return {
    forMode(mode) {
      const existing = clients.get(mode)
      if (existing) return existing

      const credentials = loadRazorpayApiCredentials(mode, environment)
      const sdk = sdkBuilder({
        key_id: credentials.keyId,
        key_secret: credentials.keySecret,
      })
      const adapter = createRazorpayServerAdapter({
        providerMode: mode,
        sdk,
        offerReader: options.offerReader,
      })
      clients.set(mode, adapter)
      return adapter
    },
  }
}

/**
 * Builds the destructive subscription-cancellation capability separately
 * from the general payment client. Construction stays inert; credentials are
 * loaded and the official SDK is built only when a provider mode is selected.
 */
export function createRazorpaySubscriptionCancellationClientFactory(
  options: CreateRazorpayClientFactoryOptions = {},
): RazorpaySubscriptionCancellationClientFactory {
  const environment = options.environment ?? process.env
  const sdkBuilder = options.sdkBuilder ?? buildOfficialRazorpaySdkPort
  const clients = new Map<
    ProviderMode,
    RazorpaySubscriptionCancellationAdapter
  >()

  return {
    forMode(mode) {
      const existing = clients.get(mode)
      if (existing) return existing

      const credentials = loadRazorpayApiCredentials(mode, environment)
      const sdk = sdkBuilder({
        key_id: credentials.keyId,
        key_secret: credentials.keySecret,
      })
      const adapter = createRazorpaySubscriptionCancellationAdapter({
        providerMode: mode,
        sdk: {
          subscriptions: {
            fetch(subscriptionId) {
              return sdk.subscriptions.fetch(subscriptionId)
            },
            ...(sdk.subscriptions.cancel
              ? {
                  cancel(subscriptionId, cancelAtCycleEnd) {
                    return sdk.subscriptions.cancel!(
                      subscriptionId,
                      cancelAtCycleEnd,
                    )
                  },
                }
              : {}),
          },
        },
      })
      clients.set(mode, adapter)
      return adapter
    },
  }
}

const RAZORPAY_REFUND_API_BASE = 'https://api.razorpay.com/v1'
const RAZORPAY_REFUND_HTTP_TIMEOUT_MS = 10_000
const RAZORPAY_REFUND_MAX_RESPONSE_BYTES = 512_000

export interface RazorpayRefundTransportAuthConfig {
  keyId: string
  keySecret: string
}

export type RazorpayRefundFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type RazorpayRefundTransportBuilder = (
  config: RazorpayRefundTransportAuthConfig,
) => RazorpayRefundCommandTransport

export interface RazorpayRefundCommandClientFactory {
  forMode(mode: ProviderMode): RazorpayRefundCommandAdapter
}

export interface CreateRazorpayRefundCommandClientFactoryOptions {
  environment?: EnvironmentSource
  transportBuilder?: RazorpayRefundTransportBuilder
}

export class RazorpayRefundTransportError extends Error {
  constructor(
    readonly reason:
      | 'network_error'
      | 'http_error'
      | 'response_too_large'
      | 'response_invalid',
    readonly status?: number,
  ) {
    super(`Razorpay refund transport failed: ${reason}`)
    this.name = 'RazorpayRefundTransportError'
  }
}

async function refundTransportRequest(input: {
  fetchImpl: RazorpayRefundFetch
  authorization: string
  method: 'GET' | 'POST'
  url: string
  idempotencyKey?: string
  body?: unknown
}): Promise<unknown> {
  let response: Response
  try {
    response = await input.fetchImpl(input.url, {
      method: input.method,
      headers: {
        authorization: input.authorization,
        accept: 'application/json',
        ...(input.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(input.idempotencyKey
          ? {
              'X-Refund-Idempotency': input.idempotencyKey,
            }
          : {}),
      },
      ...(input.body === undefined
        ? {}
        : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(RAZORPAY_REFUND_HTTP_TIMEOUT_MS),
    })
  } catch {
    throw new RazorpayRefundTransportError('network_error')
  }
  if (!response.ok) {
    throw new RazorpayRefundTransportError(
      'http_error',
      response.status,
    )
  }
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) > RAZORPAY_REFUND_MAX_RESPONSE_BYTES
    )
  ) {
    throw new RazorpayRefundTransportError('response_too_large')
  }
  const responseText = await response.text()
  if (
    Buffer.byteLength(responseText, 'utf8') >
    RAZORPAY_REFUND_MAX_RESPONSE_BYTES
  ) {
    throw new RazorpayRefundTransportError('response_too_large')
  }
  try {
    return JSON.parse(responseText) as unknown
  } catch {
    throw new RazorpayRefundTransportError('response_invalid')
  }
}

/**
 * Uses the documented refund endpoint directly because Razorpay SDK 2.9.8's
 * payments.refund helper cannot forward X-Refund-Idempotency.
 */
export function buildRazorpayRefundHttpTransport(
  config: RazorpayRefundTransportAuthConfig,
  fetchImpl: RazorpayRefundFetch = globalThis.fetch,
): RazorpayRefundCommandTransport {
  const authorization = `Basic ${Buffer.from(
    `${config.keyId}:${config.keySecret}`,
    'utf8',
  ).toString('base64')}`

  return {
    listPaymentRefunds(input) {
      const query = new URLSearchParams({
        count: String(input.count),
        skip: String(input.skip),
      })
      return refundTransportRequest({
        fetchImpl,
        authorization,
        method: 'GET',
        url:
          `${RAZORPAY_REFUND_API_BASE}/payments/` +
          `${encodeURIComponent(input.paymentId)}/refunds?${query}`,
      })
    },
    async createRefund(input) {
      const idempotencyKey =
        input.headers['X-Refund-Idempotency']
      if (idempotencyKey !== input.body.receipt) {
        throw new RazorpayRefundTransportError('response_invalid')
      }
      return refundTransportRequest({
        fetchImpl,
        authorization,
        method: 'POST',
        url:
          `${RAZORPAY_REFUND_API_BASE}/payments/` +
          `${encodeURIComponent(input.paymentId)}/refund`,
        idempotencyKey,
        body: input.body,
      })
    },
  }
}

/**
 * Lazily builds a destructive, mode-isolated refund command client. This is
 * intentionally separate from RazorpayClientFactory and RazorpaySdkPort.
 */
export function createRazorpayRefundCommandClientFactory(
  options: CreateRazorpayRefundCommandClientFactoryOptions = {},
): RazorpayRefundCommandClientFactory {
  const environment = options.environment ?? process.env
  const transportBuilder =
    options.transportBuilder ?? buildRazorpayRefundHttpTransport
  const clients = new Map<ProviderMode, RazorpayRefundCommandAdapter>()

  return {
    forMode(mode) {
      const existing = clients.get(mode)
      if (existing) return existing

      const credentials = loadRazorpayApiCredentials(mode, environment)
      const transport = transportBuilder({
        keyId: credentials.keyId,
        keySecret: credentials.keySecret,
      })
      const adapter = createRazorpayRefundCommandAdapter({
        providerMode: mode,
        transport,
      })
      clients.set(mode, adapter)
      return adapter
    },
  }
}

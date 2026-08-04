import { z } from 'zod'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'
import {
  RazorpayProviderEntityMismatchError,
  RazorpaySdkCapabilityError,
  RazorpaySubscriptionDtoSchema,
  type RazorpaySubscriptionDto,
} from './razorpayServerAdapter'

const CanonicalSubscriptionIdSchema = z.string()
  .regex(/^sub_[A-Za-z0-9]+$/)
  .max(128)
const CanonicalPlanIdSchema = z.string()
  .regex(/^plan_[A-Za-z0-9]+$/)
  .max(128)
const CanonicalCustomerIdSchema = z.string()
  .regex(/^cust_[A-Za-z0-9]+$/)
  .max(128)
const SafeIntegerLikeSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).transform(Number),
]).pipe(z.number().int().nonnegative().safe())
const EpochSecondsSchema = z.number().int().nonnegative().safe()

const RawSubscriptionSchema = z.object({
  id: CanonicalSubscriptionIdSchema,
  entity: z.literal('subscription'),
  plan_id: CanonicalPlanIdSchema,
  offer_id: z.string().regex(/^offer_[A-Za-z0-9]+$/).max(128).nullish(),
  customer_id: CanonicalCustomerIdSchema.nullish(),
  status: z.enum([
    'created',
    'authenticated',
    'active',
    'pending',
    'halted',
    'paused',
    'cancelled',
    'completed',
    'expired',
  ]),
  total_count: SafeIntegerLikeSchema,
  paid_count: SafeIntegerLikeSchema,
  remaining_count: SafeIntegerLikeSchema,
  current_start: EpochSecondsSchema.nullish(),
  current_end: EpochSecondsSchema.nullish(),
  start_at: EpochSecondsSchema.nullish(),
  end_at: EpochSecondsSchema.nullish(),
  charge_at: EpochSecondsSchema.nullish(),
  expire_by: EpochSecondsSchema.nullish(),
  ended_at: EpochSecondsSchema.nullish(),
  has_scheduled_changes: z.boolean().nullish(),
  change_scheduled_at: EpochSecondsSchema.nullish(),
  notes: z.record(
    z.string().trim().min(1).max(256),
    z.union([z.string().max(256), z.number().finite()]),
  ).optional(),
  created_at: EpochSecondsSchema,
  providerMode: z.enum(PROVIDER_MODES).optional(),
  provider_mode: z.enum(PROVIDER_MODES).optional(),
}).passthrough()

export interface RazorpaySubscriptionCancellationSdkPort {
  subscriptions: {
    fetch(subscriptionId: string): Promise<unknown>
    cancel?(
      subscriptionId: string,
      cancelAtCycleEnd: boolean,
    ): Promise<unknown>
  }
}

export interface RazorpayScheduledCancellationDto
  extends RazorpaySubscriptionDto {
  currentEndEpochSeconds: number
  hasScheduledChanges: true
  scheduledChangeAtEpochSeconds: number
}

export interface RazorpaySubscriptionCancellationAdapter {
  readonly providerMode: ProviderMode
  fetchSubscription(
    subscriptionId: string,
  ): Promise<RazorpaySubscriptionDto>
  cancelSubscriptionImmediately(
    subscriptionId: string,
  ): Promise<RazorpaySubscriptionDto>
  cancelSubscriptionAtCycleEnd(
    subscriptionId: string,
  ): Promise<RazorpayScheduledCancellationDto>
}

export class RazorpaySubscriptionCancellationEvidenceError
  extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RazorpaySubscriptionCancellationEvidenceError'
  }
}

function normalizeSubscription(
  providerMode: ProviderMode,
  expectedId: string,
  value: unknown,
): RazorpaySubscriptionDto {
  const subscription = RawSubscriptionSchema.parse(value)
  if (
    (
      subscription.providerMode !== undefined &&
      subscription.providerMode !== providerMode
    ) ||
    (
      subscription.provider_mode !== undefined &&
      subscription.provider_mode !== providerMode
    )
  ) {
    throw new RazorpayProviderEntityMismatchError(
      'Subscription operation returned data for a different provider mode',
    )
  }
  if (subscription.id !== expectedId) {
    throw new RazorpayProviderEntityMismatchError(
      'Subscription operation returned a different subscription identifier',
    )
  }
  return RazorpaySubscriptionDtoSchema.parse({
    providerMode,
    id: subscription.id,
    planId: subscription.plan_id,
    offerId: subscription.offer_id ?? undefined,
    customerId: subscription.customer_id ?? undefined,
    status: subscription.status,
    totalCount: subscription.total_count,
    paidCount: subscription.paid_count,
    remainingCount: subscription.remaining_count,
    currentStartEpochSeconds: subscription.current_start ?? undefined,
    currentEndEpochSeconds: subscription.current_end ?? undefined,
    startAtEpochSeconds: subscription.start_at ?? undefined,
    endAtEpochSeconds: subscription.end_at ?? undefined,
    chargeAtEpochSeconds: subscription.charge_at ?? undefined,
    authorizationExpiresAtEpochSeconds:
      subscription.expire_by ?? undefined,
    endedAtEpochSeconds: subscription.ended_at ?? undefined,
    hasScheduledChanges:
      subscription.has_scheduled_changes ?? undefined,
    scheduledChangeAtEpochSeconds:
      subscription.change_scheduled_at ?? undefined,
    notes: subscription.notes ?? {},
    createdAtEpochSeconds: subscription.created_at,
  })
}

function isScheduledCancellationEvidence(
  subscription: RazorpaySubscriptionDto,
): subscription is RazorpayScheduledCancellationDto {
  return (
    (
      subscription.status === 'active' ||
      subscription.status === 'pending' ||
      subscription.status === 'halted' ||
      subscription.status === 'paused'
    ) &&
    subscription.hasScheduledChanges === true &&
    subscription.currentEndEpochSeconds !== undefined &&
    subscription.scheduledChangeAtEpochSeconds ===
      subscription.currentEndEpochSeconds
  )
}

function isTerminalCancellationEvidence(
  subscription: RazorpaySubscriptionDto,
): boolean {
  return (
    subscription.status === 'cancelled' ||
    subscription.status === 'completed' ||
    subscription.status === 'expired'
  )
}

/**
 * The installed Razorpay SDK maps cancel(id, false) to immediate cancellation
 * and cancel(id, true) to `cancel_at_cycle_end: 1`.
 */
export function createRazorpaySubscriptionCancellationAdapter(input: {
  providerMode: ProviderMode
  sdk: RazorpaySubscriptionCancellationSdkPort
}): RazorpaySubscriptionCancellationAdapter {
  const providerMode = z.enum(PROVIDER_MODES).parse(input.providerMode)

  return {
    providerMode,
    async fetchSubscription(subscriptionId) {
      const exactId = CanonicalSubscriptionIdSchema.parse(subscriptionId)
      return normalizeSubscription(
        providerMode,
        exactId,
        await input.sdk.subscriptions.fetch(exactId),
      )
    },
    async cancelSubscriptionImmediately(subscriptionId) {
      const exactId = CanonicalSubscriptionIdSchema.parse(subscriptionId)
      const cancel = input.sdk.subscriptions.cancel
      if (!cancel) {
        throw new RazorpaySdkCapabilityError(
          'Razorpay SDK does not expose subscription cancellation',
        )
      }
      const acknowledged = normalizeSubscription(
        providerMode,
        exactId,
        await cancel(exactId, false),
      )
      if (isTerminalCancellationEvidence(acknowledged)) {
        return acknowledged
      }
      const fetched = normalizeSubscription(
        providerMode,
        exactId,
        await input.sdk.subscriptions.fetch(exactId),
      )
      if (isTerminalCancellationEvidence(fetched)) {
        return fetched
      }
      throw new RazorpaySubscriptionCancellationEvidenceError(
        'Razorpay did not prove immediate terminal cancellation',
      )
    },
    async cancelSubscriptionAtCycleEnd(subscriptionId) {
      const exactId = CanonicalSubscriptionIdSchema.parse(subscriptionId)
      const cancel = input.sdk.subscriptions.cancel
      if (!cancel) {
        throw new RazorpaySdkCapabilityError(
          'Razorpay SDK does not expose subscription cancellation',
        )
      }
      const acknowledged = normalizeSubscription(
        providerMode,
        exactId,
        await cancel(exactId, true),
      )
      if (isScheduledCancellationEvidence(acknowledged)) {
        return acknowledged
      }

      const fetched = normalizeSubscription(
        providerMode,
        exactId,
        await input.sdk.subscriptions.fetch(exactId),
      )
      if (isScheduledCancellationEvidence(fetched)) {
        return fetched
      }
      throw new RazorpaySubscriptionCancellationEvidenceError(
        'Razorpay did not prove cancellation at the current cycle boundary',
      )
    },
  }
}

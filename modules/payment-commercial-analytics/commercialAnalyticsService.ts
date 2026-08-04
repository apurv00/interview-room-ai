import type { ClientSession, PipelineStage } from 'mongoose'
import {
  CommercialAnalyticsEvent,
} from './models/CommercialAnalyticsEvent'
import {
  PAYMENT_COMMERCIAL_ANALYTICS_CMS_READ_READY,
  PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY,
  composeCommercialAnalyticsEventRecord,
  type CommercialAnalyticsEventInput,
  type CommercialAnalyticsEventName,
  type CommercialAnalyticsEventRecord,
} from './types'

const MAX_WINDOW_DAYS = 366
const testAuthorities = new WeakSet<object>()

export type CommercialAnalyticsErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'transaction_required'
  | 'evidence_conflict'
  | 'persistence_conflict'

export class CommercialAnalyticsError extends Error {
  constructor(
    readonly code: CommercialAnalyticsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CommercialAnalyticsError'
  }
}

export interface CommercialAnalyticsTestAuthority {
  readonly kind: 'payment_commercial_analytics_test_v1'
}

export interface CommercialAnalyticsAppendStore<
  TSession extends object,
> {
  append(
    event: CommercialAnalyticsEventRecord,
    session: TSession,
  ): Promise<'created' | 'replayed'>
}

interface CommercialAnalyticsAggregateEvidence {
  readonly eventCounts: Partial<
    Record<CommercialAnalyticsEventName, number>
  >
  readonly funnel: {
    readonly eligiblePaywalls: number
    readonly checkoutIntents: number
    readonly captured: number
    readonly activated: number
    readonly paidSubscriptionActivations: number
    readonly mandateStarted: number
    readonly mandateCaptured: number
    readonly firstPaidUseWithin24Hours: number
  }
  readonly money: {
    readonly grossCapturedPaise: number
    readonly refundsPaise: number
    readonly allocatedVariableCostPaise: number
    readonly capturedSubjects: number
  }
  readonly activePlans: {
    readonly plus: number
    readonly pro: number
  }
  readonly byDiscount: readonly {
    readonly discountPaise: number
    readonly eligiblePaywalls: number
    readonly captured: number
    readonly capturedPaise: number
    readonly refundsPaise: number
    readonly variableCostPaise: number
  }[]
}

export interface CommercialAnalyticsReadStore {
  aggregate(input: {
    readonly providerMode: 'test' | 'live'
    readonly from: Date
    readonly to: Date
  }): Promise<CommercialAnalyticsAggregateEvidence>
}

export interface CommercialAnalyticsSnapshot {
  readonly generatedAt: string
  readonly window: {
    readonly from: string
    readonly to: string
    readonly providerMode: 'test' | 'live'
  }
  readonly evidence: {
    readonly authority:
      'append_only_server_commercial_events'
    readonly revenue: 'payment_captured_events_only'
    readonly clientTelemetryAuthoritative: false
    readonly reconciliationBacklog:
      'not_integrated_use_payment_reconciliation_authority'
  }
  readonly financial: {
    readonly grossCapturedPaise: number
    readonly gstIncludedPaise: number
    readonly refundsPaise: number
    readonly netRevenuePaise: number
    readonly allocatedVariableCostPaise: number
    readonly grossProfitPaise: number
    readonly grossProfitPerEligiblePaywallPaise: number | null
    readonly couponAdjustedArpuPaise: number | null
  }
  readonly subscriptions: {
    readonly activePlus: number
    readonly activePro: number
    readonly newSubscriptions: number
    readonly cancellations: number
    readonly pending: number
    readonly halted: number
    readonly renewals: number
  }
  readonly funnel: {
    readonly eligiblePaywalls: number
    readonly checkoutIntents: number
    readonly captured: number
    readonly activated: number
    readonly paywallToCheckoutBps: number | null
    readonly checkoutToCapturedBps: number | null
    readonly capturedToActivatedBps: number | null
    readonly mandateStarted: number
    readonly mandateAbandonmentBps: number | null
  }
  readonly products: {
    readonly singleInterviewPurchased: number
    readonly singleInterviewConsumed: number
    readonly premiumResumePurchased: number
    readonly premiumResumeRendered: number
    readonly firstPaidInterviewStarted: number
    readonly firstPaidInterviewWithin24Hours: number
    readonly firstPaidInterviewWithin24HoursBps: number | null
  }
  readonly risk: {
    readonly paymentFailures: number
    readonly activationPending: number
    readonly refunds: number
    readonly disputes: number
    readonly reconciliationBacklog: null
  }
  readonly byDiscount: readonly {
    readonly discountPaise: number
    readonly eligiblePaywalls: number
    readonly captured: number
    readonly capturedPaise: number
    readonly refundsPaise: number
    readonly grossProfitPaise: number
    readonly conversionBps: number | null
  }[]
}

function fail(
  code: CommercialAnalyticsErrorCode,
  message: string,
): never {
  throw new CommercialAnalyticsError(code, message)
}

function exactSession(session: ClientSession): void {
  let active = false
  try {
    active =
      Boolean(session) &&
      typeof session.inTransaction === 'function' &&
      session.inTransaction()
  } catch {
    active = false
  }
  if (!active) {
    fail(
      'transaction_required',
      'Commercial analytics append requires the caller transaction',
    )
  }
}

function exactReplay(
  existing: unknown,
  expected: CommercialAnalyticsEventRecord,
): boolean {
  if (!existing || typeof existing !== 'object') return false
  const row = existing as {
    _id?: unknown
    eventDigest?: unknown
  }
  return (
    row._id === expected.eventId &&
    row.eventDigest === expected.eventDigest
  )
}

const mongoAppendStore: CommercialAnalyticsAppendStore<ClientSession> = {
  async append(event, session) {
    try {
      const {
        eventId,
        ...persistedEvent
      } = event
      const document = new CommercialAnalyticsEvent({
        ...persistedEvent,
        _id: eventId,
        occurredAt: new Date(event.occurredAt),
      })
      await document.save({ session })
      return 'created'
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 11000
      ) {
        throw error
      }
      const existing = await CommercialAnalyticsEvent
        .findById(event.eventId)
        .select({ _id: 1, eventDigest: 1 })
        .session(session)
        .lean()
      return exactReplay(existing, event)
        ? 'replayed'
        : fail(
            'persistence_conflict',
            'Commercial event identity is bound to different evidence',
          )
    }
  },
}

async function appendWithStore<TSession extends object>(
  input: {
    readonly event: CommercialAnalyticsEventInput
    readonly session: TSession
  },
  store: CommercialAnalyticsAppendStore<TSession>,
): Promise<{
  readonly outcome: 'created' | 'replayed'
  readonly eventId: string
  readonly eventDigest: string
}> {
  let event: CommercialAnalyticsEventRecord
  try {
    event = composeCommercialAnalyticsEventRecord(input.event)
  } catch {
    return fail(
      'invalid_input',
      'Commercial analytics event is invalid',
    )
  }
  const outcome = await store.append(event, input.session)
  return Object.freeze({
    outcome,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
  })
}

export async function appendCommercialAnalyticsEvent(
  input: {
    readonly event: CommercialAnalyticsEventInput
    readonly session: ClientSession
  },
): Promise<{
  readonly outcome: 'created' | 'replayed'
  readonly eventId: string
  readonly eventDigest: string
}> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) {
    fail('disabled', 'Commercial analytics event writes are disabled')
  }
  exactSession(input.session)
  return appendWithStore(input, mongoAppendStore)
}

export function composeCommercialAnalyticsTestAuthorityForTest():
CommercialAnalyticsTestAuthority {
  if (
    process.env.NODE_ENV !== 'test' ||
    PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY ||
    PAYMENT_COMMERCIAL_ANALYTICS_CMS_READ_READY
  ) {
    fail('disabled', 'Commercial analytics test authority is unavailable')
  }
  const authority: CommercialAnalyticsTestAuthority = Object.freeze({
    kind: 'payment_commercial_analytics_test_v1',
  })
  testAuthorities.add(authority)
  return authority
}

export async function appendCommercialAnalyticsEventForTest<
  TSession extends object,
>(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    readonly event: CommercialAnalyticsEventInput
    readonly session: TSession
  },
  store: CommercialAnalyticsAppendStore<TSession>,
) {
  if (!testAuthorities.has(authority)) {
    fail('disabled', 'Commercial analytics test authority is invalid')
  }
  return appendWithStore(input, store)
}

function number(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0
  ) {
    return fail(
      'evidence_conflict',
      `${label} is not a non-negative safe integer`,
    )
  }
  return Number(value)
}

function bps(
  numerator: number,
  denominator: number,
): number | null {
  return denominator === 0
    ? null
    : Math.round((numerator * 10_000) / denominator)
}

function count(
  evidence: CommercialAnalyticsAggregateEvidence,
  eventName: CommercialAnalyticsEventName,
): number {
  return number(
    evidence.eventCounts[eventName] ?? 0,
    `eventCounts.${eventName}`,
  )
}

function parseWindow(input: {
  readonly providerMode: 'test' | 'live'
  readonly from: string
  readonly to: string
}): {
  readonly providerMode: 'test' | 'live'
  readonly from: Date
  readonly to: Date
} {
  const from = new Date(input.from)
  const to = new Date(input.to)
  if (
    !['test', 'live'].includes(input.providerMode) ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.toISOString() !== input.from ||
    to.toISOString() !== input.to ||
    from >= to ||
    to.getTime() - from.getTime() >
      MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ) {
    fail(
      'invalid_input',
      'Commercial analytics window is invalid or exceeds 366 days',
    )
  }
  return { providerMode: input.providerMode, from, to }
}

function snapshot(
  evidence: CommercialAnalyticsAggregateEvidence,
  window: ReturnType<typeof parseWindow>,
  now: Date,
): CommercialAnalyticsSnapshot {
  const gross = number(
    evidence.money.grossCapturedPaise,
    'money.grossCapturedPaise',
  )
  const refunds = number(
    evidence.money.refundsPaise,
    'money.refundsPaise',
  )
  const cost = number(
    evidence.money.allocatedVariableCostPaise,
    'money.allocatedVariableCostPaise',
  )
  const subjects = number(
    evidence.money.capturedSubjects,
    'money.capturedSubjects',
  )
  const net = gross - refunds
  const paywalls = number(
    evidence.funnel.eligiblePaywalls,
    'funnel.eligiblePaywalls',
  )
  const checkouts = number(
    evidence.funnel.checkoutIntents,
    'funnel.checkoutIntents',
  )
  const captured = number(
    evidence.funnel.captured,
    'funnel.captured',
  )
  const activated = number(
    evidence.funnel.activated,
    'funnel.activated',
  )
  const firstPaidInterviewStarted = count(
    evidence,
    'first_paid_interview_started',
  )
  const mandateStarted = number(
    evidence.funnel.mandateStarted,
    'funnel.mandateStarted',
  )
  const mandateCaptured = number(
    evidence.funnel.mandateCaptured,
    'funnel.mandateCaptured',
  )
  const firstPaidWithin24Hours = number(
    evidence.funnel.firstPaidUseWithin24Hours,
    'funnel.firstPaidUseWithin24Hours',
  )
  const result: CommercialAnalyticsSnapshot = {
    generatedAt: now.toISOString(),
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      providerMode: window.providerMode,
    },
    evidence: {
      authority: 'append_only_server_commercial_events',
      revenue: 'payment_captured_events_only',
      clientTelemetryAuthoritative: false,
      reconciliationBacklog:
        'not_integrated_use_payment_reconciliation_authority',
    },
    financial: {
      grossCapturedPaise: gross,
      gstIncludedPaise: Math.round((gross * 18) / 118),
      refundsPaise: refunds,
      netRevenuePaise: net,
      allocatedVariableCostPaise: cost,
      grossProfitPaise: net - cost,
      grossProfitPerEligiblePaywallPaise:
        paywalls === 0
          ? null
          : Math.round((net - cost) / paywalls),
      couponAdjustedArpuPaise:
        subjects === 0 ? null : Math.round(net / subjects),
    },
    subscriptions: {
      activePlus: number(
        evidence.activePlans.plus,
        'activePlans.plus',
      ),
      activePro: number(
        evidence.activePlans.pro,
        'activePlans.pro',
      ),
      newSubscriptions: number(
        evidence.funnel.paidSubscriptionActivations,
        'funnel.paidSubscriptionActivations',
      ),
      cancellations: count(
        evidence,
        'subscription_cancelled',
      ),
      pending: count(evidence, 'subscription_pending'),
      halted: count(evidence, 'subscription_halted'),
      renewals: count(evidence, 'subscription_renewed'),
    },
    funnel: {
      eligiblePaywalls: paywalls,
      checkoutIntents: checkouts,
      captured,
      activated,
      paywallToCheckoutBps: bps(checkouts, paywalls),
      checkoutToCapturedBps: bps(captured, checkouts),
      capturedToActivatedBps: bps(activated, captured),
      mandateStarted,
      mandateAbandonmentBps: bps(
        Math.max(0, mandateStarted - mandateCaptured),
        mandateStarted,
      ),
    },
    products: {
      singleInterviewPurchased: count(
        evidence,
        'single_interview_purchased',
      ),
      singleInterviewConsumed: count(
        evidence,
        'single_interview_consumed',
      ),
      premiumResumePurchased: count(
        evidence,
        'premium_resume_purchased',
      ),
      premiumResumeRendered: count(
        evidence,
        'premium_resume_rendered',
      ),
      firstPaidInterviewStarted,
      firstPaidInterviewWithin24Hours:
        firstPaidWithin24Hours,
      firstPaidInterviewWithin24HoursBps:
        bps(firstPaidWithin24Hours, firstPaidInterviewStarted),
    },
    risk: {
      paymentFailures: count(evidence, 'payment_failed'),
      activationPending: count(
        evidence,
        'activation_pending',
      ),
      refunds: count(evidence, 'refund_created'),
      disputes: count(evidence, 'dispute_created'),
      reconciliationBacklog: null,
    },
    byDiscount: evidence.byDiscount.map((row) => {
      const rowPaywalls = number(
        row.eligiblePaywalls,
        'byDiscount.eligiblePaywalls',
      )
      const rowCaptured = number(
        row.captured,
        'byDiscount.captured',
      )
      const rowRevenue = number(
        row.capturedPaise,
        'byDiscount.capturedPaise',
      )
      const rowCost = number(
        row.variableCostPaise,
        'byDiscount.variableCostPaise',
      )
      const rowRefunds = number(
        row.refundsPaise,
        'byDiscount.refundsPaise',
      )
      return Object.freeze({
        discountPaise: number(
          row.discountPaise,
          'byDiscount.discountPaise',
        ),
        eligiblePaywalls: rowPaywalls,
        captured: rowCaptured,
        capturedPaise: rowRevenue,
        refundsPaise: rowRefunds,
        grossProfitPaise:
          rowRevenue - rowRefunds - rowCost,
        conversionBps: bps(rowCaptured, rowPaywalls),
      })
    }),
  }
  return Object.freeze(result)
}

function eventCountFacet():
PipelineStage.FacetPipelineStage[] {
  return [
    { $group: { _id: '$eventName', count: { $sum: 1 } } },
  ]
}

function funnelFacet():
PipelineStage.FacetPipelineStage[] {
  return [
    {
      $group: {
        _id: '$correlationDigest',
        names: { $addToSet: '$eventName' },
        initialActivatedPlans: {
          $addToSet: {
            $cond: [
              {
                $and: [
                  { $eq: ['$eventName', 'entitlement_activated'] },
                  {
                    $eq: [
                      '$dimensions.activationKind',
                      'initial_subscription',
                    ],
                  },
                ],
              },
              '$dimensions.productKey',
              null,
            ],
          },
        },
        firstPaidUseWithin24Hours: {
          $max: {
            $cond: [
              {
                $and: [
                  {
                    $eq: [
                      '$eventName',
                      'first_paid_interview_started',
                    ],
                  },
                  {
                    $eq: [
                      '$dimensions.firstPaidUseWithin24Hours',
                      true,
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        eligiblePaywalls: {
          $sum: {
            $cond: [
              { $in: ['paywall_viewed', '$names'] },
              1,
              0,
            ],
          },
        },
        checkoutIntents: {
          $sum: {
            $cond: [
              { $in: ['checkout_intent_created', '$names'] },
              1,
              0,
            ],
          },
        },
        captured: {
          $sum: {
            $cond: [
              { $in: ['payment_captured', '$names'] },
              1,
              0,
            ],
          },
        },
        activated: {
          $sum: {
            $cond: [
              { $in: ['entitlement_activated', '$names'] },
              1,
              0,
            ],
          },
        },
        paidSubscriptionActivations: {
          $sum: {
            $cond: [
              {
                $and: [
                  {
                    $in: [
                      'entitlement_activated',
                      '$names',
                    ],
                  },
                  {
                    $gt: [
                      {
                        $size: {
                          $setIntersection: [
                            '$initialActivatedPlans',
                            ['plus', 'pro'],
                          ],
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        mandateStarted: {
          $sum: {
            $cond: [
              { $in: ['mandate_started', '$names'] },
              1,
              0,
            ],
          },
        },
        mandateCaptured: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $in: ['mandate_started', '$names'] },
                  { $in: ['payment_captured', '$names'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        firstPaidUseWithin24Hours: {
          $sum: '$firstPaidUseWithin24Hours',
        },
      },
    },
  ]
}

function moneyFacet():
PipelineStage.FacetPipelineStage[] {
  return [
    {
      $group: {
        _id: null,
        grossCapturedPaise: {
          $sum: {
            $cond: [
              { $eq: ['$eventName', 'payment_captured'] },
              '$amounts.eventAmountPaise',
              0,
            ],
          },
        },
        refundsPaise: {
          $sum: {
            $cond: [
              { $eq: ['$eventName', 'refund_created'] },
              '$amounts.eventAmountPaise',
              0,
            ],
          },
        },
        allocatedVariableCostPaise: {
          $sum: '$amounts.allocatedVariableCostPaise',
        },
        subjects: {
          $addToSet: {
            $cond: [
              { $eq: ['$eventName', 'payment_captured'] },
              '$subjectDigest',
              null,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        grossCapturedPaise: 1,
        refundsPaise: 1,
        allocatedVariableCostPaise: 1,
        capturedSubjects: {
          $size: {
            $setDifference: ['$subjects', [null]],
          },
        },
      },
    },
  ]
}

function discountFacet():
PipelineStage.FacetPipelineStage[] {
  return [
    {
      $group: {
        _id: '$amounts.discountPaise',
        eligiblePaywalls: {
          $sum: {
            $cond: [
              { $eq: ['$eventName', 'paywall_viewed'] },
              1,
              0,
            ],
          },
        },
        captured: {
          $sum: {
            $cond: [
              { $eq: ['$eventName', 'payment_captured'] },
              1,
              0,
            ],
          },
        },
        capturedPaise: {
          $sum: {
            $cond: [
              { $eq: ['$eventName', 'payment_captured'] },
              '$amounts.eventAmountPaise',
              0,
            ],
          },
        },
        refundsPaise: {
          $sum: {
            $cond: [
              { $eq: ['$eventName', 'refund_created'] },
              '$amounts.eventAmountPaise',
              0,
            ],
          },
        },
        variableCostPaise: {
          $sum: '$amounts.allocatedVariableCostPaise',
        },
      },
    },
    {
      $project: {
        _id: 0,
        discountPaise: '$_id',
        eligiblePaywalls: 1,
        captured: 1,
        capturedPaise: 1,
        refundsPaise: 1,
        variableCostPaise: 1,
      },
    },
    { $sort: { discountPaise: 1 } },
  ]
}

async function activePlans(
  providerMode: 'test' | 'live',
  asOf: Date,
): Promise<{ plus: number; pro: number }> {
  const rows = await CommercialAnalyticsEvent.aggregate<{
    _id: 'plus' | 'pro'
    count: number
  }>([
    {
      $match: {
        providerMode,
        occurredAt: { $lt: asOf },
        subjectDigest: { $type: 'string' },
        eventName: {
          $in: [
            'entitlement_activated',
            'subscription_cancelled',
            'subscription_halted',
          ],
        },
        'dimensions.productKey': { $in: ['plus', 'pro'] },
      },
    },
    { $sort: { occurredAt: 1, _id: 1 } },
    {
      $group: {
        _id: '$subjectDigest',
        eventName: { $last: '$eventName' },
        plan: { $last: '$dimensions.productKey' },
        accessEndsAt: { $last: '$dimensions.accessEndsAt' },
      },
    },
    {
      $match: {
        eventName: 'entitlement_activated',
        accessEndsAt: { $gt: asOf },
      },
    },
    { $group: { _id: '$plan', count: { $sum: 1 } } },
  ])
  return {
    plus: rows.find((row) => row._id === 'plus')?.count ?? 0,
    pro: rows.find((row) => row._id === 'pro')?.count ?? 0,
  }
}

const mongoReadStore: CommercialAnalyticsReadStore = {
  async aggregate(input) {
    const [window] = await CommercialAnalyticsEvent.aggregate<{
      eventCounts: { _id: CommercialAnalyticsEventName; count: number }[]
      funnel: CommercialAnalyticsAggregateEvidence['funnel'][]
      money: CommercialAnalyticsAggregateEvidence['money'][]
      byDiscount: CommercialAnalyticsAggregateEvidence['byDiscount']
    }>([
      {
        $match: {
          providerMode: input.providerMode,
          occurredAt: { $gte: input.from, $lt: input.to },
        },
      },
      {
        $facet: {
          eventCounts: eventCountFacet(),
          funnel: funnelFacet(),
          money: moneyFacet(),
          byDiscount: discountFacet(),
        },
      },
    ])
    const eventCounts = Object.fromEntries(
      (window?.eventCounts ?? []).map((row) => [
        row._id,
        row.count,
      ]),
    )
    return {
      eventCounts,
      funnel: window?.funnel[0] ?? {
        eligiblePaywalls: 0,
        checkoutIntents: 0,
        captured: 0,
        activated: 0,
        paidSubscriptionActivations: 0,
        mandateStarted: 0,
        mandateCaptured: 0,
        firstPaidUseWithin24Hours: 0,
      },
      money: window?.money[0] ?? {
        grossCapturedPaise: 0,
        refundsPaise: 0,
        allocatedVariableCostPaise: 0,
        capturedSubjects: 0,
      },
      activePlans: await activePlans(
        input.providerMode,
        input.to,
      ),
      byDiscount: window?.byDiscount ?? [],
    }
  },
}

async function readWithStore(
  input: {
    readonly providerMode: 'test' | 'live'
    readonly from: string
    readonly to: string
  },
  store: CommercialAnalyticsReadStore,
  now: () => Date,
): Promise<CommercialAnalyticsSnapshot> {
  const window = parseWindow(input)
  const generatedAt = now()
  if (!Number.isFinite(generatedAt.getTime())) {
    fail('invalid_input', 'Commercial analytics clock is invalid')
  }
  return snapshot(
    await store.aggregate(window),
    window,
    generatedAt,
  )
}

export async function readCommercialAnalytics(
  input: {
    readonly providerMode: 'test' | 'live'
    readonly from: string
    readonly to: string
  },
): Promise<CommercialAnalyticsSnapshot> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_CMS_READ_READY) {
    fail('disabled', 'Commercial analytics CMS reads are disabled')
  }
  return readWithStore(input, mongoReadStore, () => new Date())
}

export async function readCommercialAnalyticsForTest(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    readonly providerMode: 'test' | 'live'
    readonly from: string
    readonly to: string
  },
  dependencies: {
    readonly store: CommercialAnalyticsReadStore
    readonly now: () => Date
  },
): Promise<CommercialAnalyticsSnapshot> {
  if (!testAuthorities.has(authority)) {
    fail('disabled', 'Commercial analytics test authority is invalid')
  }
  return readWithStore(
    input,
    dependencies.store,
    dependencies.now,
  )
}

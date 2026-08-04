import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  CHARGE_FULFILLMENT_KINDS,
  CHARGE_FULFILLMENT_STATUSES,
  ChargeFulfillment,
  FULFILLMENT_STEP_STATUSES,
  type ChargeFulfillmentKind,
  type ChargeFulfillmentStatus,
  type FulfillmentStepStatus,
  type IChargeFulfillmentSteps,
} from '../models/ChargeFulfillment'
import type { ProviderMode } from '../types/catalog'
import {
  fulfillOneTimeEntitlement,
  type OneTimeEntitlementFulfillmentResult,
} from './oneTimeEntitlementFulfillmentService'

const DEFAULT_SCAN_LIMIT = 25
const MAX_SCAN_LIMIT = 100
const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const PROVIDER_ID_PATTERNS = {
  payment: /^pay_[A-Za-z0-9]+$/,
  order: /^order_[A-Za-z0-9]+$/,
  subscription: /^sub_[A-Za-z0-9]+$/,
  invoice: /^inv_[A-Za-z0-9]+$/,
} as const

export const CHARGE_FULFILLMENT_RECOVERY_ERROR_CODES = [
  'invalid_request',
  'not_found',
  'context_conflict',
  'financial_policy_handler_invalid',
] as const
export type ChargeFulfillmentRecoveryErrorCode =
  (typeof CHARGE_FULFILLMENT_RECOVERY_ERROR_CODES)[number]

export class ChargeFulfillmentRecoveryError extends Error {
  readonly code: ChargeFulfillmentRecoveryErrorCode

  constructor(
    code: ChargeFulfillmentRecoveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ChargeFulfillmentRecoveryError'
    this.code = code
  }
}

export interface RecoverableChargeFulfillment {
  id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  userId: mongoose.Types.ObjectId
  kind: ChargeFulfillmentKind
  periodKey?: string
  status: ChargeFulfillmentStatus
  verifiedAmountPaise: number
  verifiedCurrency: string
  steps: IChargeFulfillmentSteps
  attempts: number
  lastError?: string
  nextAttemptAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface ChargeFulfillmentRecoveryStore {
  loadExact(input: {
    fulfillmentId: mongoose.Types.ObjectId
    providerMode: ProviderMode
  }): Promise<RecoverableChargeFulfillment | null>
}

export interface DueChargeFulfillmentScanStore {
  listDue(input: {
    providerMode: ProviderMode
    cursor?: mongoose.Types.ObjectId
    dueBefore: Date
    limit: number
    statuses: readonly ChargeFulfillmentStatus[]
    chargedWithoutEntitlementReviewOnly: boolean
  }): Promise<RecoverableChargeFulfillment[]>
}

export interface ApprovedFinancialPolicyInput {
  fulfillmentId: string
  providerMode: ProviderMode
  userId: string
  kind: ChargeFulfillmentKind
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  verifiedAmountPaise: number
  verifiedCurrency: 'INR'
  expectedStatus: 'entitlement_skipped' | 'entitlement_applied'
  invoiceOperationKey: string
  invoiceStepStatus: 'pending' | 'running' | 'failed'
  /**
   * ISO timestamp used as the durable invoice-step fence. It is absent only
   * for a never-attempted pending step.
   */
  invoiceAttemptFence?: string
}

export type ApprovedFinancialPolicyResult =
  | {
      disposition: 'invoiced' | 'already_invoiced'
      invoiceReferenceId: string
    }
  | {
      disposition: 'deferred'
      reason: string
    }

/**
 * Implementations must use expectedStatus, invoiceOperationKey, step status,
 * and invoiceAttemptFence as their compare-and-set boundary. Merely injecting
 * this handler is the explicit approval boundary for financial-document
 * generation.
 */
export type ApprovedFinancialPolicyHandler = (
  input: ApprovedFinancialPolicyInput,
) => Promise<ApprovedFinancialPolicyResult>

type OneTimeFulfillmentDelegate = (
  input: { fulfillmentId: string },
) => Promise<OneTimeEntitlementFulfillmentResult>

export interface RecoverChargeFulfillmentDependencies {
  store?: ChargeFulfillmentRecoveryStore
  oneTimeFulfillment?: OneTimeFulfillmentDelegate
  approvedFinancialPolicyHandler?: ApprovedFinancialPolicyHandler
}

interface RecoveryResultBase {
  fulfillmentId: string
  providerMode: ProviderMode
  kind: ChargeFulfillmentKind
  currentStatus: ChargeFulfillmentStatus
  terminal: boolean
}

export type ChargeFulfillmentRecoveryResult =
  | (RecoveryResultBase & {
      outcome: 'payment_verification_required'
      currentStatus: 'received'
      nextStep: 'verification'
      terminal: false
    })
  | (RecoveryResultBase & {
      outcome: 'one_time_entitlement_processed'
      currentStatus: 'verified'
      nextStep: 'invoice' | 'notification' | 'completion' | 'none'
      terminal: boolean
      entitlement: OneTimeEntitlementFulfillmentResult
    })
  | (RecoveryResultBase & {
      outcome: 'subscription_reconciliation_required'
      currentStatus: 'verified'
      nextStep: 'subscription_reconciliation'
      terminal: false
    })
  | (RecoveryResultBase & {
      outcome: 'manual_review'
      currentStatus: 'review'
      nextStep: 'manual_review'
      terminal: true
      chargedWithoutEntitlement: boolean
    })
  | (RecoveryResultBase & {
      outcome: 'financial_policy_required'
      currentStatus: 'entitlement_skipped' | 'entitlement_applied'
      nextStep: 'invoice'
      terminal: false
    })
  | (RecoveryResultBase & {
      outcome: 'invoice_in_progress'
      currentStatus: 'entitlement_skipped' | 'entitlement_applied'
      nextStep: 'invoice'
      terminal: false
    })
  | (RecoveryResultBase & {
      outcome: 'financial_policy_handler_completed'
      currentStatus: 'entitlement_skipped' | 'entitlement_applied'
      nextStep: 'invoice' | 'notification'
      terminal: false
      financialPolicy: ApprovedFinancialPolicyResult
    })
  | (RecoveryResultBase & {
      outcome: 'customer_notification_disabled'
      currentStatus: 'invoiced'
      nextStep: 'notification'
      terminal: false
    })
  | (RecoveryResultBase & {
      outcome: 'completion_required'
      currentStatus: 'notified'
      nextStep: 'completion'
      terminal: false
    })
  | (RecoveryResultBase & {
      outcome: 'done'
      currentStatus: 'done'
      nextStep: 'none'
      terminal: true
    })

export interface ScanDueChargeFulfillmentsInput {
  providerMode: ProviderMode
  cursor?: string
  dueBefore?: Date
  limit?: number
  includeReview?: boolean
  includeChargedWithoutEntitlementReview?: boolean
  includeDone?: boolean
}

export interface DueChargeFulfillmentListItem {
  fulfillmentId: string
  providerMode: ProviderMode
  kind: ChargeFulfillmentKind
  status: ChargeFulfillmentStatus
  attempts: number
  nextAttemptAt?: string
  updatedAt: string
}

export interface DueChargeFulfillmentPage {
  items: DueChargeFulfillmentListItem[]
  dueBefore: string
  nextCursor?: string
}

interface LeanChargeFulfillment
  extends Omit<RecoverableChargeFulfillment, 'id'> {
  _id: mongoose.Types.ObjectId
}

function failure(
  code: ChargeFulfillmentRecoveryErrorCode,
  message: string,
  cause?: unknown,
): ChargeFulfillmentRecoveryError {
  return new ChargeFulfillmentRecoveryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function validProviderId(
  value: string | undefined,
  kind: keyof typeof PROVIDER_ID_PATTERNS,
): value is string {
  return Boolean(
    value &&
    value.length <= 128 &&
    PROVIDER_ID_PATTERNS[kind].test(value),
  )
}

function parseObjectId(
  value: string | undefined,
  field: string,
): mongoose.Types.ObjectId | undefined {
  if (value === undefined) return undefined
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw failure('invalid_request', `${field} must be a MongoDB ObjectId`)
  }
  return new mongoose.Types.ObjectId(value)
}

function assertProviderMode(
  value: ProviderMode,
): asserts value is ProviderMode {
  if (value !== 'test' && value !== 'live') {
    throw failure('invalid_request', 'providerMode must be test or live')
  }
}

function assertStep(
  fulfillment: RecoverableChargeFulfillment,
  name: keyof IChargeFulfillmentSteps,
): void {
  const step = fulfillment.steps[name]
  const expectedOperationKey =
    `${fulfillment.providerMode}:` +
    `${fulfillment.razorpayPaymentId}:${name}`
  if (
    !step ||
    !FULFILLMENT_STEP_STATUSES.includes(step.status) ||
    step.operationKey !== expectedOperationKey
  ) {
    throw failure(
      'context_conflict',
      `Fulfillment ${name} operation key is not exact`,
    )
  }
  if (
    step.completedAt !== undefined &&
    !validDate(step.completedAt)
  ) {
    throw failure(
      'context_conflict',
      `Fulfillment ${name} completion timestamp is invalid`,
    )
  }
  if (
    step.lastAttemptAt !== undefined &&
    !validDate(step.lastAttemptAt)
  ) {
    throw failure(
      'context_conflict',
      `Fulfillment ${name} attempt timestamp is invalid`,
    )
  }
  if (
    (
      step.status === 'complete' &&
      (
        !validDate(step.completedAt) ||
        !step.referenceId?.trim()
      )
    ) ||
    (
      step.status === 'skipped' &&
      (
        !validDate(step.completedAt) ||
        !step.referenceId?.trim() ||
        !validDate(step.lastAttemptAt)
      )
    )
  ) {
    throw failure(
      'context_conflict',
      `Resolved fulfillment ${name} lacks durable evidence`,
    )
  }
}

function isStatus(
  value: FulfillmentStepStatus,
  allowed: readonly FulfillmentStepStatus[],
): boolean {
  return allowed.includes(value)
}

function assertProgressiveSteps(
  fulfillment: RecoverableChargeFulfillment,
): void {
  const { kind, status, steps } = fulfillment
  const pendingWork: readonly FulfillmentStepStatus[] = [
    'pending',
    'running',
    'failed',
  ]
  const entitlementResolved =
    steps.entitlement.status === 'complete' ||
    (
      kind === 'subscription_cycle' &&
      steps.entitlement.status === 'skipped'
    )
  const downstreamPending = (
    names: Array<keyof IChargeFulfillmentSteps>,
  ) => names.every((name) => steps[name].status === 'pending')

  let coherent = false
  switch (status) {
    case 'received':
      coherent =
        isStatus(steps.verification.status, pendingWork) &&
        downstreamPending(['entitlement', 'invoice', 'notification'])
      break
    case 'verified':
      coherent =
        steps.verification.status === 'complete' &&
        isStatus(steps.entitlement.status, pendingWork) &&
        downstreamPending(['invoice', 'notification'])
      break
    case 'entitlement_skipped':
      coherent =
        steps.verification.status === 'complete' &&
        steps.entitlement.status === 'skipped' &&
        isStatus(steps.invoice.status, pendingWork) &&
        steps.notification.status === 'pending'
      break
    case 'entitlement_applied':
      coherent =
        steps.verification.status === 'complete' &&
        steps.entitlement.status === 'complete' &&
        isStatus(steps.invoice.status, pendingWork) &&
        steps.notification.status === 'pending'
      break
    case 'invoiced':
      coherent =
        steps.verification.status === 'complete' &&
        entitlementResolved &&
        steps.invoice.status === 'complete' &&
        isStatus(steps.notification.status, pendingWork)
      break
    case 'notified':
    case 'done':
      coherent =
        steps.verification.status === 'complete' &&
        entitlementResolved &&
        steps.invoice.status === 'complete' &&
        steps.notification.status === 'complete'
      break
    case 'review': {
      const entitlementComplete =
        entitlementResolved
      const invoiceComplete = steps.invoice.status === 'complete'
      const reversibleStep: readonly FulfillmentStepStatus[] = [
        'pending',
        'running',
        'complete',
        'failed',
        'skipped',
      ]
      coherent =
        steps.verification.status === 'complete' &&
        isStatus(
          steps.entitlement.status,
          kind === 'subscription_cycle'
            ? ['pending', 'complete', 'skipped']
            : ['pending', 'complete'],
        ) &&
        (!invoiceComplete || entitlementComplete) &&
        isStatus(steps.invoice.status, reversibleStep) &&
        (
          isStatus(
            steps.notification.status,
            reversibleStep.filter((candidate) => (
              candidate !== 'complete'
            )),
          ) ||
          (
            steps.notification.status === 'complete' &&
            invoiceComplete
          )
        )
      break
    }
  }
  if (!coherent) {
    throw failure(
      'context_conflict',
      'Fulfillment status conflicts with its durable steps',
    )
  }
}

function assertFulfillmentCoherent(
  fulfillment: RecoverableChargeFulfillment,
): void {
  if (
    !(fulfillment.id instanceof mongoose.Types.ObjectId) ||
    !(fulfillment.userId instanceof mongoose.Types.ObjectId) ||
    !CHARGE_FULFILLMENT_KINDS.includes(fulfillment.kind) ||
    !CHARGE_FULFILLMENT_STATUSES.includes(fulfillment.status) ||
    !fulfillment.steps ||
    !validProviderId(fulfillment.razorpayPaymentId, 'payment') ||
    fulfillment.verifiedCurrency !== 'INR' ||
    !Number.isSafeInteger(fulfillment.verifiedAmountPaise) ||
    fulfillment.verifiedAmountPaise <= 0 ||
    !Number.isSafeInteger(fulfillment.attempts) ||
    fulfillment.attempts < 0 ||
    !validDate(fulfillment.createdAt) ||
    !validDate(fulfillment.updatedAt) ||
    (
      fulfillment.nextAttemptAt !== undefined &&
      !validDate(fulfillment.nextAttemptAt)
    )
  ) {
    throw failure(
      'context_conflict',
      'Charge fulfillment identity or value fields are invalid',
    )
  }
  if (
    fulfillment.razorpayOrderId !== undefined &&
    !validProviderId(fulfillment.razorpayOrderId, 'order')
  ) {
    throw failure('context_conflict', 'Fulfillment order id is invalid')
  }
  if (
    fulfillment.razorpaySubscriptionId !== undefined &&
    !validProviderId(
      fulfillment.razorpaySubscriptionId,
      'subscription',
    )
  ) {
    throw failure(
      'context_conflict',
      'Fulfillment subscription id is invalid',
    )
  }
  if (
    fulfillment.razorpayInvoiceId !== undefined &&
    !validProviderId(fulfillment.razorpayInvoiceId, 'invoice')
  ) {
    throw failure('context_conflict', 'Fulfillment invoice id is invalid')
  }

  if (fulfillment.kind === 'subscription_cycle') {
    if (
      !fulfillment.razorpaySubscriptionId ||
      !fulfillment.razorpayInvoiceId ||
      !fulfillment.razorpayOrderId ||
      !fulfillment.periodKey?.trim()
    ) {
      throw failure(
        'context_conflict',
        'Subscription-cycle fulfillment lacks exact provider references',
      )
    }
  } else if (
    !fulfillment.razorpayOrderId ||
    fulfillment.razorpaySubscriptionId !== undefined ||
    fulfillment.razorpayInvoiceId !== undefined ||
    fulfillment.periodKey !== undefined
  ) {
    throw failure(
      'context_conflict',
      'One-time fulfillment has contaminated provider references',
    )
  }

  for (const name of [
    'verification',
    'entitlement',
    'invoice',
    'notification',
  ] as const) {
    assertStep(fulfillment, name)
  }
  if (
    fulfillment.steps.verification.status === 'complete' &&
    fulfillment.steps.verification.referenceId !==
      fulfillment.razorpayPaymentId
  ) {
    throw failure(
      'context_conflict',
      'Fulfillment verification does not reference the payment',
    )
  }
  assertProgressiveSteps(fulfillment)
}

function mapLeanFulfillment(
  fulfillment: LeanChargeFulfillment,
): RecoverableChargeFulfillment {
  return {
    ...fulfillment,
    id: fulfillment._id,
  }
}

export const mongoChargeFulfillmentRecoveryStore:
ChargeFulfillmentRecoveryStore & DueChargeFulfillmentScanStore = {
  async loadExact({ fulfillmentId, providerMode }) {
    await connectDB()
    const fulfillment = await ChargeFulfillment.findOne({
      _id: fulfillmentId,
      providerMode,
    })
      .select([
        '_id',
        'providerMode',
        'razorpayPaymentId',
        'razorpayInvoiceId',
        'razorpaySubscriptionId',
        'razorpayOrderId',
        'userId',
        'kind',
        'periodKey',
        'status',
        'verifiedAmountPaise',
        'verifiedCurrency',
        'steps',
        'attempts',
        'lastError',
        'nextAttemptAt',
        'createdAt',
        'updatedAt',
      ].join(' '))
      .lean<LeanChargeFulfillment>()
    return fulfillment ? mapLeanFulfillment(fulfillment) : null
  },

  async listDue(input) {
    await connectDB()
    const fulfillment = await ChargeFulfillment.find({
      providerMode: input.providerMode,
      ...(input.cursor
        ? { _id: { $gt: input.cursor } }
        : {}),
      $and: [
        input.chargedWithoutEntitlementReviewOnly
          ? { $or: [
              { status: { $in: input.statuses.filter(
                (status) => status !== 'review',
              ) } },
              {
                status: 'review',
                'steps.verification.status': 'complete',
                'steps.entitlement.status': 'pending',
              },
            ] }
          : { status: { $in: input.statuses } },
        { $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: input.dueBefore } },
        ] },
      ],
    })
      .sort({ _id: 1 })
      .limit(input.limit)
      .select([
        '_id',
        'providerMode',
        'razorpayPaymentId',
        'razorpayInvoiceId',
        'razorpaySubscriptionId',
        'razorpayOrderId',
        'userId',
        'kind',
        'periodKey',
        'status',
        'verifiedAmountPaise',
        'verifiedCurrency',
        'steps',
        'attempts',
        'lastError',
        'nextAttemptAt',
        'createdAt',
        'updatedAt',
      ].join(' '))
      .lean<LeanChargeFulfillment[]>()
    return fulfillment.map(mapLeanFulfillment)
  },
}

function resultBase(
  fulfillment: RecoverableChargeFulfillment,
): RecoveryResultBase {
  return {
    fulfillmentId: fulfillment.id.toString(),
    providerMode: fulfillment.providerMode,
    kind: fulfillment.kind,
    currentStatus: fulfillment.status,
    terminal: false,
  }
}

function assertFinancialPolicyResult(
  result: unknown,
): asserts result is ApprovedFinancialPolicyResult {
  if (!result || typeof result !== 'object') {
    throw failure(
      'financial_policy_handler_invalid',
      'Approved financial-policy handler returned an invalid result',
    )
  }
  const candidate = result as Partial<ApprovedFinancialPolicyResult>
  if (
    candidate.disposition !== 'invoiced' &&
    candidate.disposition !== 'already_invoiced' &&
    candidate.disposition !== 'deferred'
  ) {
    throw failure(
      'financial_policy_handler_invalid',
      'Approved financial-policy handler returned an invalid disposition',
    )
  }
  if (
    (
      candidate.disposition === 'invoiced' ||
      candidate.disposition === 'already_invoiced'
    ) &&
    (
      typeof candidate.invoiceReferenceId !== 'string' ||
      !candidate.invoiceReferenceId.trim() ||
      candidate.invoiceReferenceId.length > 255
    )
  ) {
    throw failure(
      'financial_policy_handler_invalid',
      'Approved financial-policy handler returned invalid invoice evidence',
    )
  }
  if (
    candidate.disposition === 'deferred' &&
    (
      typeof candidate.reason !== 'string' ||
      !candidate.reason.trim() ||
      candidate.reason.length > 2000
    )
  ) {
    throw failure(
      'financial_policy_handler_invalid',
      'Approved financial-policy handler returned an invalid reason',
    )
  }
}

/**
 * Recovers exactly one durable fulfillment state. This service deliberately
 * has no customer-notification dependency, so recovery cannot send messages.
 */
export async function recoverChargeFulfillment(
  input: {
    fulfillmentId: string
    providerMode: ProviderMode
  },
  dependencies: RecoverChargeFulfillmentDependencies = {},
): Promise<ChargeFulfillmentRecoveryResult> {
  assertProviderMode(input.providerMode)
  const fulfillmentId = parseObjectId(
    input.fulfillmentId,
    'fulfillmentId',
  )
  if (!fulfillmentId) {
    throw failure('invalid_request', 'fulfillmentId is required')
  }
  const store =
    dependencies.store ?? mongoChargeFulfillmentRecoveryStore
  const fulfillment = await store.loadExact({
    fulfillmentId,
    providerMode: input.providerMode,
  })
  if (!fulfillment) {
    throw failure('not_found', 'Charge fulfillment was not found')
  }
  if (
    !(fulfillment.id instanceof mongoose.Types.ObjectId) ||
    !fulfillment.id.equals(fulfillmentId) ||
    fulfillment.providerMode !== input.providerMode
  ) {
    throw failure(
      'context_conflict',
      'Charge fulfillment identity does not match the request',
    )
  }
  assertFulfillmentCoherent(fulfillment)
  const base = resultBase(fulfillment)

  switch (fulfillment.status) {
    case 'received':
      return {
        ...base,
        outcome: 'payment_verification_required',
        currentStatus: 'received',
        nextStep: 'verification',
        terminal: false,
      }
    case 'verified': {
      if (fulfillment.kind === 'subscription_cycle') {
        return {
          ...base,
          outcome: 'subscription_reconciliation_required',
          currentStatus: 'verified',
          nextStep: 'subscription_reconciliation',
          terminal: false,
        }
      }
      const entitlement = await (
        dependencies.oneTimeFulfillment ??
        fulfillOneTimeEntitlement
      )({ fulfillmentId: fulfillment.id.toString() })
      const nextStep = (() => {
        switch (entitlement.fulfillmentStatus) {
          case 'entitlement_applied':
            return 'invoice' as const
          case 'invoiced':
            return 'notification' as const
          case 'notified':
            return 'completion' as const
          case 'done':
            return 'none' as const
          default:
            throw failure(
              'context_conflict',
              'One-time entitlement delegate returned an invalid status',
            )
        }
      })()
      return {
        ...base,
        outcome: 'one_time_entitlement_processed',
        currentStatus: 'verified',
        nextStep,
        terminal: nextStep === 'none',
        entitlement,
      }
    }
    case 'review':
      return {
        ...base,
        outcome: 'manual_review',
        currentStatus: 'review',
        nextStep: 'manual_review',
        terminal: true,
        chargedWithoutEntitlement:
          fulfillment.steps.verification.status === 'complete' &&
          fulfillment.steps.entitlement.status === 'pending',
      }
    case 'entitlement_skipped':
    case 'entitlement_applied': {
      const financiallyReadyStatus = fulfillment.status
      const invoiceStepStatus =
        fulfillment.steps.invoice.status
      const handler = dependencies.approvedFinancialPolicyHandler
      if (invoiceStepStatus === 'running' && !handler) {
        return {
          ...base,
          outcome: 'invoice_in_progress',
          currentStatus: financiallyReadyStatus,
          nextStep: 'invoice',
          terminal: false,
        }
      }
      if (
        invoiceStepStatus !== 'pending' &&
        invoiceStepStatus !== 'running' &&
        invoiceStepStatus !== 'failed'
      ) {
        throw failure(
          'context_conflict',
          'Entitlement-applied fulfillment has an invalid invoice step',
        )
      }
      if (!handler) {
        return {
          ...base,
          outcome: 'financial_policy_required',
          currentStatus: financiallyReadyStatus,
          nextStep: 'invoice',
          terminal: false,
        }
      }
      const financialPolicy = await handler({
        fulfillmentId: fulfillment.id.toString(),
        providerMode: fulfillment.providerMode,
        userId: fulfillment.userId.toString(),
        kind: fulfillment.kind,
        razorpayPaymentId: fulfillment.razorpayPaymentId,
        razorpayInvoiceId: fulfillment.razorpayInvoiceId,
        razorpaySubscriptionId:
          fulfillment.razorpaySubscriptionId,
        razorpayOrderId: fulfillment.razorpayOrderId,
        verifiedAmountPaise: fulfillment.verifiedAmountPaise,
        verifiedCurrency: 'INR',
        expectedStatus: financiallyReadyStatus,
        invoiceOperationKey:
          fulfillment.steps.invoice.operationKey,
        invoiceStepStatus,
        invoiceAttemptFence:
          fulfillment.steps.invoice.lastAttemptAt?.toISOString(),
      })
      assertFinancialPolicyResult(financialPolicy)
      return {
        ...base,
        outcome: 'financial_policy_handler_completed',
        currentStatus: financiallyReadyStatus,
        nextStep: financialPolicy.disposition === 'deferred'
          ? 'invoice'
          : 'notification',
        terminal: false,
        financialPolicy,
      }
    }
    case 'invoiced':
      return {
        ...base,
        outcome: 'customer_notification_disabled',
        currentStatus: 'invoiced',
        nextStep: 'notification',
        terminal: false,
      }
    case 'notified':
      return {
        ...base,
        outcome: 'completion_required',
        currentStatus: 'notified',
        nextStep: 'completion',
        terminal: false,
      }
    case 'done':
      return {
        ...base,
        outcome: 'done',
        currentStatus: 'done',
        nextStep: 'none',
        terminal: true,
      }
  }
}

export async function scanDueChargeFulfillments(
  input: ScanDueChargeFulfillmentsInput,
  dependencies: {
    store?: DueChargeFulfillmentScanStore
    now?: () => Date
  } = {},
): Promise<DueChargeFulfillmentPage> {
  assertProviderMode(input.providerMode)
  const cursor = parseObjectId(input.cursor, 'cursor')
  const limit = input.limit ?? DEFAULT_SCAN_LIMIT
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SCAN_LIMIT
  ) {
    throw failure(
      'invalid_request',
      `limit must be an integer between 1 and ${MAX_SCAN_LIMIT}`,
    )
  }
  const dueBefore = input.dueBefore ?? dependencies.now?.() ?? new Date()
  if (!validDate(dueBefore)) {
    throw failure('invalid_request', 'dueBefore is invalid')
  }
  const statuses = CHARGE_FULFILLMENT_STATUSES.filter(
    (status) => (
      (
        input.includeReview ||
        input.includeChargedWithoutEntitlementReview ||
        status !== 'review'
      ) &&
      (input.includeDone || status !== 'done')
    ),
  )
  const chargedWithoutEntitlementReviewOnly =
    input.includeChargedWithoutEntitlementReview === true &&
    input.includeReview !== true
  const store =
    dependencies.store ?? mongoChargeFulfillmentRecoveryStore
  const records = await store.listDue({
    providerMode: input.providerMode,
    cursor,
    dueBefore,
    limit: limit + 1,
    statuses,
    chargedWithoutEntitlementReviewOnly,
  })
  const hasMore = records.length > limit
  const page = records.slice(0, limit)
  let previousId = cursor?.toHexString()
  for (const fulfillment of page) {
    if (
      !(fulfillment.id instanceof mongoose.Types.ObjectId) ||
      fulfillment.providerMode !== input.providerMode ||
      !statuses.includes(fulfillment.status) ||
      (
        fulfillment.status === 'review' &&
        chargedWithoutEntitlementReviewOnly &&
        (
          fulfillment.steps.verification.status !== 'complete' ||
          fulfillment.steps.entitlement.status !== 'pending'
        )
      ) ||
      !validDate(fulfillment.updatedAt) ||
      (
        fulfillment.nextAttemptAt !== undefined &&
        (
          !validDate(fulfillment.nextAttemptAt) ||
          fulfillment.nextAttemptAt.getTime() >
            dueBefore.getTime()
        )
      )
    ) {
      throw failure(
        'context_conflict',
        'Due fulfillment scan returned an invalid or cross-mode row',
      )
    }
    const currentId = fulfillment.id.toHexString()
    if (previousId !== undefined && currentId <= previousId) {
      throw failure(
        'context_conflict',
        'Due fulfillment scan is not in stable ObjectId order',
      )
    }
    previousId = currentId
  }
  return {
    items: page.map((fulfillment) => ({
      fulfillmentId: fulfillment.id.toString(),
      providerMode: fulfillment.providerMode,
      kind: fulfillment.kind,
      status: fulfillment.status,
      attempts: fulfillment.attempts,
      nextAttemptAt: fulfillment.nextAttemptAt?.toISOString(),
      updatedAt: fulfillment.updatedAt.toISOString(),
    })),
    dueBefore: dueBefore.toISOString(),
    nextCursor: hasMore
      ? page.at(-1)?.id.toString()
      : undefined,
  }
}

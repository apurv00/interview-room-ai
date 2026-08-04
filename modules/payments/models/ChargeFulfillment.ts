import mongoose, { Document, Model, Schema } from 'mongoose'
import { InrPaiseSchema } from '../lib/money'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const CHARGE_FULFILLMENT_KINDS = [
  'subscription_cycle',
  'single_interview',
  'premium_resume',
] as const
export type ChargeFulfillmentKind =
  (typeof CHARGE_FULFILLMENT_KINDS)[number]

export const CHARGE_FULFILLMENT_STATUSES = [
  'received',
  'verified',
  'entitlement_skipped',
  'entitlement_applied',
  'invoiced',
  'notified',
  'done',
  'review',
] as const
export type ChargeFulfillmentStatus =
  (typeof CHARGE_FULFILLMENT_STATUSES)[number]

export const CHARGE_FULFILLMENT_POST_INVOICE_SCAN_INDEX_CONTRACT =
  Object.freeze({
    keys: Object.freeze({
      providerMode: 1,
      status: 1,
      updatedAt: 1,
      _id: 1,
      'steps.notification.status': 1,
    }),
    name: 'charge_fulfillment_post_invoice_scan_v1',
  } as const)

export const FULFILLMENT_STEP_STATUSES = [
  'pending',
  'running',
  'complete',
  'failed',
  'skipped',
] as const
export type FulfillmentStepStatus =
  (typeof FULFILLMENT_STEP_STATUSES)[number]

export interface IFulfillmentStep {
  status: FulfillmentStepStatus
  operationKey: string
  completedAt?: Date
  referenceId?: string
  lastAttemptAt?: Date
}

export interface IChargeFulfillmentSteps {
  verification: IFulfillmentStep
  entitlement: IFulfillmentStep
  invoice: IFulfillmentStep
  notification: IFulfillmentStep
}

export interface IChargeFulfillment extends Document {
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
  verifiedCurrency: 'INR'
  steps: IChargeFulfillmentSteps
  attempts: number
  lastError?: string
  nextAttemptAt?: Date
  createdAt: Date
  updatedAt: Date
}

const FulfillmentStepSchema = new Schema<IFulfillmentStep>(
  {
    status: {
      type: String,
      enum: FULFILLMENT_STEP_STATUSES,
      required: true,
      default: 'pending',
    },
    operationKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    completedAt: { type: Date },
    referenceId: { type: String, trim: true, maxlength: 255 },
    lastAttemptAt: { type: Date },
  },
  { _id: false },
)

const ChargeFulfillmentStepsSchema =
  new Schema<IChargeFulfillmentSteps>(
    {
      verification: {
        type: FulfillmentStepSchema,
        required: true,
      },
      entitlement: {
        type: FulfillmentStepSchema,
        required: true,
      },
      invoice: {
        type: FulfillmentStepSchema,
        required: true,
      },
      notification: {
        type: FulfillmentStepSchema,
        required: true,
      },
    },
    { _id: false },
  )

const ChargeFulfillmentSchema = new Schema<IChargeFulfillment>(
  {
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    razorpayPaymentId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayInvoiceId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpaySubscriptionId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayOrderId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    kind: {
      type: String,
      enum: CHARGE_FULFILLMENT_KINDS,
      required: true,
      immutable: true,
    },
    periodKey: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    status: {
      type: String,
      enum: CHARGE_FULFILLMENT_STATUSES,
      required: true,
      default: 'received',
    },
    verifiedAmountPaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: {
        validator: (value: number) => (
          InrPaiseSchema.safeParse(value).success
        ),
        message: 'Verified amount must be non-negative safe-integer INR paise',
      },
    },
    verifiedCurrency: {
      type: String,
      enum: ['INR'],
      required: true,
      default: 'INR',
      immutable: true,
    },
    steps: {
      type: ChargeFulfillmentStepsSchema,
      required: true,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (value: number) => (
          Number.isSafeInteger(value) && value >= 0
        ),
        message: 'Attempts must be a non-negative safe integer',
      },
    },
    lastError: {
      type: String,
      maxlength: 2000,
    },
    nextAttemptAt: { type: Date },
  },
  { timestamps: true },
)

ChargeFulfillmentSchema.index(
  { providerMode: 1, razorpayPaymentId: 1 },
  { unique: true },
)
ChargeFulfillmentSchema.index({ status: 1, nextAttemptAt: 1 })
ChargeFulfillmentSchema.index({ userId: 1, createdAt: -1 })

ChargeFulfillmentSchema.pre('validate', function validateFulfillmentShape() {
  if (this.kind === 'subscription_cycle' && !this.razorpaySubscriptionId) {
    this.invalidate(
      'razorpaySubscriptionId',
      'Subscription-cycle fulfillment requires a subscription id',
    )
  }
  if (
    this.kind !== 'subscription_cycle' &&
    !this.razorpayOrderId
  ) {
    this.invalidate(
      'razorpayOrderId',
      'One-time fulfillment requires an order id',
    )
  }

  const steps = this.steps as IChargeFulfillmentSteps & {
    toObject?: () => Record<string, IFulfillmentStep>
  }
  const stepEntries = steps
    ? Object.entries(steps.toObject?.() ?? steps)
    : []
  for (const [name, rawStep] of stepEntries) {
    const step = rawStep as IFulfillmentStep
    if (step.status === 'complete' && !step.completedAt) {
      this.invalidate(
        `steps.${name}.completedAt`,
        'Completed steps require a completion timestamp',
      )
    }
  }
})

export const ChargeFulfillment: Model<IChargeFulfillment> =
  mongoose.models.ChargeFulfillment ||
  mongoose.model<IChargeFulfillment>(
    'ChargeFulfillment',
    ChargeFulfillmentSchema,
  )

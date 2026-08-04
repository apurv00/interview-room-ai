import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  FINANCIAL_LEDGER_PROVIDER_MODES,
  isNormalizedPaise,
  type FinancialLedgerProviderMode,
  type NormalizedPaise,
} from '../types'
import {
  FinancialDocumentNumberSnapshotSchema,
  FinancialTaxSnapshotSchema,
  inrPaiseValidator,
  type IFinancialDocumentNumberSnapshot,
  type IFinancialTaxSnapshot,
} from './financialDocumentSnapshots'

export const INVOICE_CHARGE_KINDS = [
  'subscription_cycle',
  'single_interview',
  'premium_resume',
] as const
export type InvoiceChargeKind = (typeof INVOICE_CHARGE_KINDS)[number]

export interface IInvoice extends Document {
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  chargeKind: InvoiceChargeKind
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  capturedPaise: NormalizedPaise
  currency: 'INR'
  numberSnapshot: IFinancialDocumentNumberSnapshot
  sellerSnapshot: Record<string, unknown>
  buyerSnapshot: Record<string, unknown>
  taxSnapshot: IFinancialTaxSnapshot
  descriptionSnapshot: string
  issuedAt: Date
  createdAt: Date
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    providerMode: {
      type: String,
      enum: FINANCIAL_LEDGER_PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    chargeKind: {
      type: String,
      enum: INVOICE_CHARGE_KINDS,
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
    razorpayOrderId: {
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
    capturedPaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: inrPaiseValidator,
    },
    currency: {
      type: String,
      enum: ['INR'],
      required: true,
      default: 'INR',
      immutable: true,
    },
    numberSnapshot: {
      type: FinancialDocumentNumberSnapshotSchema,
      required: true,
      immutable: true,
    },
    // Seller/buyer contents come from a separately approved tax policy.
    // Keeping them opaque prevents this persistence layer from inventing SAC,
    // seller-state, place-of-supply, or retention rules.
    sellerSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    buyerSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    taxSnapshot: {
      type: FinancialTaxSnapshotSchema,
      required: true,
      immutable: true,
    },
    descriptionSnapshot: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      immutable: true,
    },
    issuedAt: {
      type: Date,
      required: true,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

InvoiceSchema.pre('validate', function validateInvoiceConsideration() {
  if (this.numberSnapshot?.documentType !== 'invoice') {
    this.invalidate(
      'numberSnapshot.documentType',
      'Invoice number snapshot must use documentType invoice',
    )
  }
  if (
    isNormalizedPaise(this.capturedPaise) &&
    isNormalizedPaise(this.taxSnapshot?.grossPaise) &&
    this.capturedPaise !== this.taxSnapshot.grossPaise
  ) {
    this.invalidate(
      'capturedPaise',
      'capturedPaise must equal the tax snapshot gross consideration',
    )
  }
  if (
    this.chargeKind === 'subscription_cycle' &&
    !this.razorpaySubscriptionId
  ) {
    this.invalidate(
      'razorpaySubscriptionId',
      'Subscription-cycle invoices require a subscription id',
    )
  }
  if (
    this.chargeKind !== 'subscription_cycle' &&
    !this.razorpayOrderId
  ) {
    this.invalidate(
      'razorpayOrderId',
      'One-time invoices require an order id',
    )
  }
})

InvoiceSchema.index(
  { providerMode: 1, razorpayPaymentId: 1 },
  { unique: true },
)
InvoiceSchema.index(
  { providerMode: 1, razorpayInvoiceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayInvoiceId: { $type: 'string' },
    },
  },
)
InvoiceSchema.index(
  { providerMode: 1, razorpayOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayOrderId: { $type: 'string' },
    },
  },
)
InvoiceSchema.index({
  providerMode: 1,
  razorpaySubscriptionId: 1,
  issuedAt: -1,
})
InvoiceSchema.index(
  { providerMode: 1, 'numberSnapshot.formattedNumber': 1 },
  { unique: true },
)
InvoiceSchema.index({ userId: 1, issuedAt: -1, _id: -1 })

const rejectInvoiceMutation = function rejectInvoiceMutation(): never {
  throw new Error('Invoice is append-only')
}

InvoiceSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  { query: true, document: false },
  rejectInvoiceMutation,
)
InvoiceSchema.pre(
  ['replaceOne', 'findOneAndReplace'],
  { query: true, document: false },
  rejectInvoiceMutation,
)
InvoiceSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  rejectInvoiceMutation,
)
InvoiceSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectInvoiceMutation,
)
InvoiceSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectInvoiceMutation,
)
InvoiceSchema.pre('save', function rejectExistingInvoiceSave() {
  if (!this.isNew) rejectInvoiceMutation()
})

export const Invoice: Model<IInvoice> =
  mongoose.models.PaymentInvoice ||
  mongoose.model<IInvoice>('PaymentInvoice', InvoiceSchema)

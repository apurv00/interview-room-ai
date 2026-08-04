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

export interface ICreditNote extends Document {
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  invoiceId: mongoose.Types.ObjectId
  refundRecordId: mongoose.Types.ObjectId
  originalInvoiceNumberSnapshot: string
  razorpayRefundId: string
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  refundedPaise: NormalizedPaise
  currency: 'INR'
  numberSnapshot: IFinancialDocumentNumberSnapshot
  sellerSnapshot: Record<string, unknown>
  buyerSnapshot: Record<string, unknown>
  taxSnapshot: IFinancialTaxSnapshot
  reasonSnapshot: string
  issuedAt: Date
  createdAt: Date
}

const CreditNoteSchema = new Schema<ICreditNote>(
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
    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentInvoice',
      required: true,
      immutable: true,
    },
    refundRecordId: {
      type: Schema.Types.ObjectId,
      ref: 'RefundRecord',
      required: true,
      immutable: true,
    },
    originalInvoiceNumberSnapshot: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 16,
      immutable: true,
    },
    razorpayRefundId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayPaymentId: {
      type: String,
      required: true,
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
    refundedPaise: {
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
    reasonSnapshot: {
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

CreditNoteSchema.pre('validate', function validateRefundConsideration() {
  if (this.numberSnapshot?.documentType !== 'credit_note') {
    this.invalidate(
      'numberSnapshot.documentType',
      'Credit-note number snapshot must use documentType credit_note',
    )
  }
  if (
    isNormalizedPaise(this.refundedPaise) &&
    isNormalizedPaise(this.taxSnapshot?.grossPaise) &&
    this.refundedPaise !== this.taxSnapshot.grossPaise
  ) {
    this.invalidate(
      'refundedPaise',
      'refundedPaise must equal the tax snapshot gross consideration',
    )
  }
})

CreditNoteSchema.index(
  { providerMode: 1, razorpayRefundId: 1 },
  { unique: true },
)
CreditNoteSchema.index({
  providerMode: 1,
  razorpayPaymentId: 1,
  issuedAt: -1,
})
CreditNoteSchema.index({
  providerMode: 1,
  razorpayOrderId: 1,
})
CreditNoteSchema.index({
  providerMode: 1,
  razorpaySubscriptionId: 1,
})
CreditNoteSchema.index(
  { providerMode: 1, refundRecordId: 1 },
  { unique: true },
)
CreditNoteSchema.index(
  { providerMode: 1, 'numberSnapshot.formattedNumber': 1 },
  { unique: true },
)
CreditNoteSchema.index({ invoiceId: 1, issuedAt: -1, _id: -1 })
CreditNoteSchema.index({ userId: 1, issuedAt: -1, _id: -1 })

const rejectCreditNoteMutation =
  function rejectCreditNoteMutation(): never {
    throw new Error('CreditNote is append-only')
  }

CreditNoteSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  { query: true, document: false },
  rejectCreditNoteMutation,
)
CreditNoteSchema.pre(
  ['replaceOne', 'findOneAndReplace'],
  { query: true, document: false },
  rejectCreditNoteMutation,
)
CreditNoteSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  rejectCreditNoteMutation,
)
CreditNoteSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectCreditNoteMutation,
)
CreditNoteSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectCreditNoteMutation,
)
CreditNoteSchema.pre('save', function rejectExistingCreditNoteSave() {
  if (!this.isNew) rejectCreditNoteMutation()
})

export const CreditNote: Model<ICreditNote> =
  mongoose.models.CreditNote ||
  mongoose.model<ICreditNote>('CreditNote', CreditNoteSchema)

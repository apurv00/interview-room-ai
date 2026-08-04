import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  FINANCIAL_LEDGER_PROVIDER_MODES,
  type FinancialLedgerProviderMode,
} from '../types'
import {
  FINANCIAL_DOCUMENT_TYPES,
  type FinancialDocumentType,
} from './financialDocumentSnapshots'

export interface IBillingCounter extends Document {
  providerMode: FinancialLedgerProviderMode
  documentType: FinancialDocumentType
  financialYear: string
  lastAllocatedSequence: number
  createdAt: Date
  updatedAt: Date
}

const BillingCounterSchema = new Schema<IBillingCounter>(
  {
    providerMode: {
      type: String,
      enum: FINANCIAL_LEDGER_PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    documentType: {
      type: String,
      enum: FINANCIAL_DOCUMENT_TYPES,
      required: true,
      immutable: true,
    },
    financialYear: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
      immutable: true,
    },
    // A future allocator can atomically `$inc` this field and use the returned
    // value. No read-then-write allocation or number-formatting policy lives
    // in this persistence-only slice.
    lastAllocatedSequence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'lastAllocatedSequence must be a non-negative safe integer',
      },
    },
  },
  { timestamps: true },
)

BillingCounterSchema.pre('validate', function validateIndianFinancialYear() {
  const match = /^(\d{4})-(\d{2})$/.exec(this.financialYear)
  if (!match) return
  const startYear = Number(match[1])
  const expectedEnd = String((startYear + 1) % 100).padStart(2, '0')
  if (match[2] !== expectedEnd) {
    this.invalidate(
      'financialYear',
      'financialYear must span consecutive Indian financial years',
    )
  }
})

BillingCounterSchema.index(
  { providerMode: 1, documentType: 1, financialYear: 1 },
  { unique: true },
)

export const BillingCounter: Model<IBillingCounter> =
  mongoose.models.BillingCounter ||
  mongoose.model<IBillingCounter>('BillingCounter', BillingCounterSchema)

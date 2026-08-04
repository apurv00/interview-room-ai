import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  BillingCounter,
} from '../models/BillingCounter'
import {
  CreditNote,
  type ICreditNote,
} from '../models/CreditNote'
import {
  Invoice,
  type IInvoice,
  type InvoiceChargeKind,
} from '../models/Invoice'
import {
  RefundRecord,
  type IRefundRecord,
} from '../models/RefundRecord'
import type {
  FinancialDocumentType,
  IFinancialDocumentNumberSnapshot,
  IFinancialTaxSnapshot,
} from '../models/financialDocumentSnapshots'
import type {
  FinancialLedgerProviderMode,
  NormalizedPaise,
} from '../types'

export interface FinancialInvoicePersistenceFields {
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
  sellerSnapshot: unknown
  buyerSnapshot: unknown
  taxSnapshot: IFinancialTaxSnapshot
  descriptionSnapshot: string
  issuedAt: Date
}

export interface FinancialCreditNotePersistenceFields {
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
  sellerSnapshot: unknown
  buyerSnapshot: unknown
  taxSnapshot: IFinancialTaxSnapshot
  reasonSnapshot: string
  issuedAt: Date
}

export interface FinancialDocumentPersistenceStore {
  reserveSequence(
    providerMode: FinancialLedgerProviderMode,
    documentType: FinancialDocumentType,
    financialYear: string,
  ): Promise<number>
  findInvoiceByPaymentKey(
    providerMode: FinancialLedgerProviderMode,
    razorpayPaymentId: string,
  ): Promise<IInvoice | null>
  findCreditNoteByRefundKey(
    providerMode: FinancialLedgerProviderMode,
    razorpayRefundId: string,
  ): Promise<ICreditNote | null>
  findInvoiceById(
    invoiceId: mongoose.Types.ObjectId,
  ): Promise<IInvoice | null>
  findRefundRecordById(
    refundRecordId: mongoose.Types.ObjectId,
  ): Promise<IRefundRecord | null>
  createInvoice(
    input: FinancialInvoicePersistenceFields,
  ): Promise<IInvoice>
  createCreditNote(
    input: FinancialCreditNotePersistenceFields,
  ): Promise<ICreditNote>
}

export interface MongooseFinancialDocumentStoreDependencies {
  connect?: () => Promise<unknown>
  startSession?: () => Promise<ClientSession>
}

const MAX_COUNTER_RESERVATION_ATTEMPTS = 5

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 11000) return true
  return 'cause' in error && isDuplicateKeyError(error.cause)
}

export class MongooseFinancialDocumentStore
implements FinancialDocumentPersistenceStore {
  private readonly connect: () => Promise<unknown>
  private readonly startSession: () => Promise<ClientSession>

  constructor(
    dependencies: MongooseFinancialDocumentStoreDependencies = {},
  ) {
    this.connect = dependencies.connect ?? connectDB
    this.startSession =
      dependencies.startSession ?? (() => mongoose.startSession())
  }

  private async runCommittedTransaction<T>(
    operationName: string,
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await this.connect()
    const session = await this.startSession()
    let result: T | undefined
    let callbackCompleted = false
    try {
      await session.withTransaction(async () => {
        // The driver may retry this callback after a transient abort.
        result = undefined
        callbackCompleted = false
        result = await operation(session)
        callbackCompleted = true
      })
    } finally {
      await session.endSession()
    }
    if (!callbackCompleted || result === undefined) {
      throw new Error(`${operationName} transaction did not commit`)
    }
    return result
  }

  async reserveSequence(
    providerMode: FinancialLedgerProviderMode,
    documentType: FinancialDocumentType,
    financialYear: string,
  ): Promise<number> {
    for (
      let attempt = 1;
      attempt <= MAX_COUNTER_RESERVATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.runCommittedTransaction(
          'Financial document number reservation',
          async (session) => {
            const counter = await BillingCounter.findOneAndUpdate(
              {
                providerMode,
                documentType,
                financialYear,
              },
              {
                $setOnInsert: {
                  providerMode,
                  documentType,
                  financialYear,
                },
                $inc: { lastAllocatedSequence: 1 },
              },
              {
                session,
                upsert: true,
                new: true,
                setDefaultsOnInsert: false,
                runValidators: true,
              },
            ).exec()
            const sequence = counter?.lastAllocatedSequence
            if (
              !Number.isSafeInteger(sequence) ||
              sequence === undefined ||
              sequence < 1
            ) {
              throw new Error(
                'Billing counter returned an invalid sequence',
              )
            }
            return sequence
          },
        )
      } catch (error) {
        if (
          isDuplicateKeyError(error) &&
          attempt < MAX_COUNTER_RESERVATION_ATTEMPTS
        ) {
          continue
        }
        throw error
      }
    }
    throw new Error('Financial document number reservation exhausted retries')
  }

  async findInvoiceByPaymentKey(
    providerMode: FinancialLedgerProviderMode,
    razorpayPaymentId: string,
  ): Promise<IInvoice | null> {
    await this.connect()
    return Invoice.findOne({ providerMode, razorpayPaymentId }).exec()
  }

  async findCreditNoteByRefundKey(
    providerMode: FinancialLedgerProviderMode,
    razorpayRefundId: string,
  ): Promise<ICreditNote | null> {
    await this.connect()
    return CreditNote.findOne({ providerMode, razorpayRefundId }).exec()
  }

  async findInvoiceById(
    invoiceId: mongoose.Types.ObjectId,
  ): Promise<IInvoice | null> {
    await this.connect()
    return Invoice.findById(invoiceId).exec()
  }

  async findRefundRecordById(
    refundRecordId: mongoose.Types.ObjectId,
  ): Promise<IRefundRecord | null> {
    await this.connect()
    return RefundRecord.findById(refundRecordId).exec()
  }

  async createInvoice(
    input: FinancialInvoicePersistenceFields,
  ): Promise<IInvoice> {
    return this.runCommittedTransaction(
      'Invoice creation',
      async (session) => {
        const created = await Invoice.create([{
          ...input,
          sellerSnapshot: input.sellerSnapshot as Record<string, unknown>,
          buyerSnapshot: input.buyerSnapshot as Record<string, unknown>,
        }], { session })
        const invoice = created[0]
        if (!invoice) throw new Error('Invoice creation returned no document')
        return invoice
      },
    )
  }

  async createCreditNote(
    input: FinancialCreditNotePersistenceFields,
  ): Promise<ICreditNote> {
    return this.runCommittedTransaction(
      'Credit-note creation',
      async (session) => {
        const created = await CreditNote.create([{
          ...input,
          sellerSnapshot: input.sellerSnapshot as Record<string, unknown>,
          buyerSnapshot: input.buyerSnapshot as Record<string, unknown>,
        }], { session })
        const creditNote = created[0]
        if (!creditNote) {
          throw new Error('Credit-note creation returned no document')
        }
        return creditNote
      },
    )
  }
}

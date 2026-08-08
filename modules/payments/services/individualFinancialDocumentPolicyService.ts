import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { ChargeFulfillment } from '../models/ChargeFulfillment'
import type {
  ApprovedFinancialPolicyHandler,
  ApprovedFinancialPolicyInput,
  ApprovedFinancialPolicyResult,
} from './chargeFulfillmentRecoveryService'

export const INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE =
  'not-required:individual:v1' as const

type IndividualFinancialDocumentCompletion =
  | 'completed'
  | 'already_completed'
  | 'contended'

export interface IndividualFinancialDocumentPolicyPersistence {
  completeNotRequired(
    input: Readonly<ApprovedFinancialPolicyInput>,
    completedAt: Date,
  ): Promise<IndividualFinancialDocumentCompletion>
}

export interface IndividualFinancialDocumentPolicyDependencies {
  persistence?: IndividualFinancialDocumentPolicyPersistence
  now?: () => Date
}

function optionalReference(value: string | undefined) {
  return value ?? { $exists: false }
}

function attemptFence(value: string | undefined) {
  return value === undefined ? { $exists: false } : new Date(value)
}

function exactIdentityFilter(
  input: Readonly<ApprovedFinancialPolicyInput>,
): Record<string, unknown> {
  return {
    _id: new mongoose.Types.ObjectId(input.fulfillmentId),
    providerMode: input.providerMode,
    userId: new mongoose.Types.ObjectId(input.userId),
    kind: input.kind,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpayInvoiceId: optionalReference(input.razorpayInvoiceId),
    razorpaySubscriptionId: optionalReference(
      input.razorpaySubscriptionId,
    ),
    razorpayOrderId: optionalReference(input.razorpayOrderId),
    verifiedAmountPaise: input.verifiedAmountPaise,
    verifiedCurrency: input.verifiedCurrency,
    'steps.invoice.operationKey': input.invoiceOperationKey,
  }
}

export const mongoIndividualFinancialDocumentPolicyPersistence:
IndividualFinancialDocumentPolicyPersistence = {
  async completeNotRequired(input, completedAt) {
    await connectDB()
    const nextStatus = input.expectedStatus === 'review'
      ? 'review'
      : 'invoiced'
    const completed = await ChargeFulfillment.findOneAndUpdate(
      {
        ...exactIdentityFilter(input),
        status: input.expectedStatus,
        'steps.invoice.status': input.invoiceStepStatus,
        'steps.invoice.lastAttemptAt': attemptFence(
          input.invoiceAttemptFence,
        ),
      },
      {
        $set: {
          status: nextStatus,
          'steps.invoice.status': 'complete',
          'steps.invoice.completedAt': completedAt,
          'steps.invoice.lastAttemptAt': completedAt,
          'steps.invoice.referenceId':
            INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE,
        },
        $unset: { lastError: 1, nextAttemptAt: 1 },
      },
      { new: true, runValidators: true },
    )
      .select('_id')
      .lean()
      .exec()
    if (completed) return 'completed'

    const existing = await ChargeFulfillment.findOne({
      ...exactIdentityFilter(input),
      status: nextStatus,
      'steps.invoice.status': 'complete',
      'steps.invoice.referenceId':
        INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE,
    })
      .select('_id')
      .lean()
      .exec()
    return existing ? 'already_completed' : 'contended'
  },
}

/**
 * Current customer checkout is individual-only. The legacy fulfillment state
 * still calls this stage "invoice", so we complete it with durable
 * not-required evidence instead of creating a GST financial document.
 */
export async function completeIndividualFinancialDocumentPolicy(
  input: ApprovedFinancialPolicyInput,
  dependencies: IndividualFinancialDocumentPolicyDependencies = {},
): Promise<ApprovedFinancialPolicyResult> {
  const result = await (
    dependencies.persistence ??
    mongoIndividualFinancialDocumentPolicyPersistence
  ).completeNotRequired(input, dependencies.now?.() ?? new Date())
  if (result === 'contended') {
    return {
      disposition: 'deferred',
      reason: 'individual_financial_document_completion_contended',
    }
  }
  return {
    disposition: result === 'completed' ? 'invoiced' : 'already_invoiced',
    invoiceReferenceId:
      INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE,
  }
}

export const individualFinancialDocumentPolicyHandler:
ApprovedFinancialPolicyHandler = (input) => (
  completeIndividualFinancialDocumentPolicy(input)
)

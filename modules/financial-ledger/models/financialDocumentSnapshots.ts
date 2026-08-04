import { Schema } from 'mongoose'
import {
  isNormalizedPaise,
  type NormalizedPaise,
} from '../types'

export const FINANCIAL_DOCUMENT_TYPES = [
  'invoice',
  'credit_note',
] as const
export type FinancialDocumentType =
  (typeof FINANCIAL_DOCUMENT_TYPES)[number]

export const GST_COMPONENT_ALLOCATIONS = [
  'intra_state',
  'inter_state',
] as const
export type GstComponentAllocation =
  (typeof GST_COMPONENT_ALLOCATIONS)[number]

export interface IFinancialPolicyApprovalSnapshot {
  policyId: string
  policyVersion: string
  approvalId: string
  approvedBy: string
  approvedAt: Date
  contentHash: string
}

export interface IFinancialDocumentNumberSnapshot {
  documentType: FinancialDocumentType
  financialYear: string
  sequenceNumber: number
  formattedNumber: string
}

export interface IFinancialTaxSnapshot {
  gstRateBps: number
  taxablePaise: NormalizedPaise
  gstPaise: NormalizedPaise
  grossPaise: NormalizedPaise
  componentAllocation: GstComponentAllocation
  cgstPaise?: NormalizedPaise
  sgstPaise?: NormalizedPaise
  igstPaise?: NormalizedPaise
  approvalSnapshot: IFinancialPolicyApprovalSnapshot
}

export const inrPaiseValidator = {
  validator: isNormalizedPaise,
  message: '{PATH} must be non-negative safe-integer INR paise',
}

const optionalInrPaiseValidator = {
  validator: (value: unknown) =>
    value === undefined || isNormalizedPaise(value),
  message: '{PATH} must be non-negative safe-integer INR paise',
}

export const FinancialDocumentNumberSnapshotSchema =
  new Schema<IFinancialDocumentNumberSnapshot>(
    {
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
      sequenceNumber: {
        type: Number,
        required: true,
        min: 1,
        immutable: true,
        validate: {
          validator: Number.isSafeInteger,
          message: 'sequenceNumber must be a positive safe integer',
        },
      },
      formattedNumber: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 16,
        immutable: true,
      },
    },
    { _id: false },
  )

export const FinancialPolicyApprovalSnapshotSchema =
  new Schema<IFinancialPolicyApprovalSnapshot>(
    {
      policyId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        immutable: true,
      },
      policyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        immutable: true,
      },
      approvalId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        immutable: true,
      },
      approvedBy: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        immutable: true,
      },
      approvedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      contentHash: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
    },
    { _id: false },
  )

export const FinancialTaxSnapshotSchema =
  new Schema<IFinancialTaxSnapshot>(
    {
      gstRateBps: {
        type: Number,
        required: true,
        min: 0,
        immutable: true,
        validate: {
          validator: Number.isSafeInteger,
          message: 'gstRateBps must be a non-negative safe integer',
        },
      },
      taxablePaise: {
        type: Number,
        required: true,
        immutable: true,
        validate: inrPaiseValidator,
      },
      gstPaise: {
        type: Number,
        required: true,
        immutable: true,
        validate: inrPaiseValidator,
      },
      grossPaise: {
        type: Number,
        required: true,
        immutable: true,
        validate: inrPaiseValidator,
      },
      componentAllocation: {
        type: String,
        enum: GST_COMPONENT_ALLOCATIONS,
        required: true,
        immutable: true,
      },
      cgstPaise: {
        type: Number,
        immutable: true,
        validate: optionalInrPaiseValidator,
      },
      sgstPaise: {
        type: Number,
        immutable: true,
        validate: optionalInrPaiseValidator,
      },
      igstPaise: {
        type: Number,
        immutable: true,
        validate: optionalInrPaiseValidator,
      },
      approvalSnapshot: {
        type: FinancialPolicyApprovalSnapshotSchema,
        required: true,
        immutable: true,
      },
    },
    { _id: false },
  )

FinancialTaxSnapshotSchema.pre('validate', function validateTaxArithmetic() {
  if (
    isNormalizedPaise(this.taxablePaise) &&
    isNormalizedPaise(this.gstPaise) &&
    isNormalizedPaise(this.grossPaise)
  ) {
    if (
      this.taxablePaise > Number.MAX_SAFE_INTEGER - this.gstPaise ||
      this.taxablePaise + this.gstPaise !== this.grossPaise
    ) {
      this.invalidate(
        'grossPaise',
        'taxablePaise plus gstPaise must equal grossPaise exactly',
      )
    }
  }

  const hasCgst = this.cgstPaise !== undefined
  const hasSgst = this.sgstPaise !== undefined
  const hasIgst = this.igstPaise !== undefined

  if (this.componentAllocation === 'intra_state') {
    if (!hasCgst || !hasSgst || hasIgst) {
      this.invalidate(
        'componentAllocation',
        'Intra-state tax requires CGST and SGST only',
      )
      return
    }
    if (
      isNormalizedPaise(this.cgstPaise) &&
      isNormalizedPaise(this.sgstPaise) &&
      isNormalizedPaise(this.gstPaise) &&
      (
        this.cgstPaise > Number.MAX_SAFE_INTEGER - this.sgstPaise ||
        this.cgstPaise + this.sgstPaise !== this.gstPaise
      )
    ) {
      this.invalidate(
        'gstPaise',
        'CGST plus SGST must equal gstPaise exactly',
      )
    }
    return
  }

  if (this.componentAllocation === 'inter_state') {
    if (hasCgst || hasSgst || !hasIgst) {
      this.invalidate(
        'componentAllocation',
        'Inter-state tax requires IGST only',
      )
      return
    }
    if (
      isNormalizedPaise(this.igstPaise) &&
      isNormalizedPaise(this.gstPaise) &&
      this.igstPaise !== this.gstPaise
    ) {
      this.invalidate('gstPaise', 'IGST must equal gstPaise exactly')
    }
  }
})

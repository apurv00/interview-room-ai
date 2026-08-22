import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import {
  MongooseFinancialDocumentStore,
} from './financialDocumentPersistenceService'
import {
  type ICreditNote,
} from '../models/CreditNote'
import {
  INVOICE_CHARGE_KINDS,
  type IInvoice,
  type InvoiceChargeKind,
} from '../models/Invoice'
import {
  type IRefundRecord,
} from '../models/RefundRecord'
import type {
  FinancialDocumentType,
  GstComponentAllocation,
  IFinancialDocumentNumberSnapshot,
  IFinancialTaxSnapshot,
} from '../models/financialDocumentSnapshots'
import {
  FINANCIAL_LEDGER_PROVIDER_MODES,
  isNormalizedPaise,
  type FinancialLedgerProviderMode,
  type NormalizedPaise,
} from '../types'

type ProviderMode = FinancialLedgerProviderMode
type InrPaise = NormalizedPaise
const PROVIDER_MODES = FINANCIAL_LEDGER_PROVIDER_MODES
const isInrPaise = isNormalizedPaise

function normalizeCanonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeCanonicalValue(nested)]),
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value))
}

function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

const MAX_PROVIDER_ID_LENGTH = 255
const MAX_DESCRIPTION_LENGTH = 500
const FINANCIAL_NUMBER_MAX_LENGTH = 16
const APPROVAL_FIELDS = new Set([
  'policyId',
  'policyVersion',
  'approvalId',
  'approvedBy',
  'approvedAt',
  'contentHash',
])
const APPROVED_SNAPSHOT_FIELDS = new Set(['approval', 'value'])
const TAX_FIELDS = new Set([
  'gstRateBps',
  'taxablePaise',
  'gstPaise',
  'grossPaise',
  'componentAllocation',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
])

export class FinancialDocumentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinancialDocumentValidationError'
  }
}

export class FinancialDocumentIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinancialDocumentIdempotencyConflictError'
  }
}

export class FinancialDocumentPolicyError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'FinancialDocumentPolicyError'
  }
}

export interface FinancialSnapshotApproval {
  policyId: string
  policyVersion: string
  approvalId: string
  approvedBy: string
  approvedAt: Date
  contentHash: string
}

export interface ApprovedFinancialSnapshot<T> {
  approval: FinancialSnapshotApproval
  value: T
}

export interface FinancialTaxCalculationSnapshot {
  gstRateBps: number
  taxablePaise: number
  gstPaise: number
  grossPaise: number
  componentAllocation: GstComponentAllocation
  cgstPaise?: number
  sgstPaise?: number
  igstPaise?: number
}

export interface CreateFinancialInvoiceInput {
  providerMode: ProviderMode
  userId: string | mongoose.Types.ObjectId
  chargeKind: InvoiceChargeKind
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  capturedPaise: number
  sellerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  buyerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  taxSnapshot: ApprovedFinancialSnapshot<FinancialTaxCalculationSnapshot>
  descriptionSnapshot: string
  issuedAt: Date
}

export interface CreateFinancialCreditNoteInput {
  providerMode: ProviderMode
  userId: string | mongoose.Types.ObjectId
  invoiceId: string | mongoose.Types.ObjectId
  refundRecordId: string | mongoose.Types.ObjectId
  razorpayRefundId: string
  razorpayPaymentId: string
  refundedPaise: number
  sellerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  buyerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  taxSnapshot: ApprovedFinancialSnapshot<FinancialTaxCalculationSnapshot>
  reasonSnapshot: string
  issuedAt: Date
}

export interface FinancialSnapshotVerificationInput {
  documentType: FinancialDocumentType
  providerMode: ProviderMode
  considerationPaise: InrPaise
  issuedAt: Date
  sellerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  buyerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  taxSnapshot: ApprovedFinancialSnapshot<FinancialTaxCalculationSnapshot>
}

export interface FinancialDocumentNumberFormatInput {
  providerMode: ProviderMode
  documentType: FinancialDocumentType
  financialYear: string
  sequenceNumber: number
}

export interface FinancialInvoiceCreateFields {
  providerMode: ProviderMode
  userId: mongoose.Types.ObjectId
  chargeKind: InvoiceChargeKind
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  capturedPaise: InrPaise
  currency: 'INR'
  numberSnapshot: IFinancialDocumentNumberSnapshot
  sellerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  buyerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  taxSnapshot: IFinancialTaxSnapshot
  descriptionSnapshot: string
  issuedAt: Date
}

export interface FinancialCreditNoteCreateFields {
  providerMode: ProviderMode
  userId: mongoose.Types.ObjectId
  invoiceId: mongoose.Types.ObjectId
  refundRecordId: mongoose.Types.ObjectId
  originalInvoiceNumberSnapshot: string
  razorpayRefundId: string
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  refundedPaise: InrPaise
  currency: 'INR'
  numberSnapshot: IFinancialDocumentNumberSnapshot
  sellerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  buyerSnapshot: ApprovedFinancialSnapshot<Record<string, unknown>>
  taxSnapshot: IFinancialTaxSnapshot
  reasonSnapshot: string
  issuedAt: Date
}

export interface FinancialDocumentStore {
  reserveSequence(
    providerMode: ProviderMode,
    documentType: FinancialDocumentType,
    financialYear: string,
  ): Promise<number>
  findInvoiceByPaymentKey(
    providerMode: ProviderMode,
    razorpayPaymentId: string,
  ): Promise<IInvoice | null>
  findCreditNoteByRefundKey(
    providerMode: ProviderMode,
    razorpayRefundId: string,
  ): Promise<ICreditNote | null>
  findInvoiceById(
    invoiceId: mongoose.Types.ObjectId,
  ): Promise<IInvoice | null>
  findRefundRecordById(
    refundRecordId: mongoose.Types.ObjectId,
  ): Promise<IRefundRecord | null>
  createInvoice(input: FinancialInvoiceCreateFields): Promise<IInvoice>
  createCreditNote(
    input: FinancialCreditNoteCreateFields,
  ): Promise<ICreditNote>
}

export interface FinancialDocumentServiceDependencies {
  store: FinancialDocumentStore
  verifyApprovedSnapshots: (
    input: Readonly<FinancialSnapshotVerificationInput>,
  ) => true | Promise<true>
  formatDocumentNumber: (
    input: Readonly<FinancialDocumentNumberFormatInput>,
  ) => string | Promise<string>
}

interface NormalizedInvoiceInput
  extends Omit<
    CreateFinancialInvoiceInput,
    'userId' | 'capturedPaise'
  > {
  userId: mongoose.Types.ObjectId
  capturedPaise: InrPaise
}

interface NormalizedCreditNoteInput
  extends Omit<
    CreateFinancialCreditNoteInput,
    'userId' | 'invoiceId' | 'refundRecordId' | 'refundedPaise'
  > {
  userId: mongoose.Types.ObjectId
  invoiceId: mongoose.Types.ObjectId
  refundRecordId: mongoose.Types.ObjectId
  refundedPaise: InrPaise
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new FinancialDocumentValidationError(
      `${label} contains unsupported field ${unexpected[0]}`,
    )
  }
}

function normalizeRequiredString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    throw new FinancialDocumentValidationError(`${label} is required`)
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new FinancialDocumentValidationError(`${label} is required`)
  }
  if (normalized.length > maximumLength) {
    throw new FinancialDocumentValidationError(
      `${label} must not exceed ${maximumLength} characters`,
    )
  }
  return normalized
}

function normalizeOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined
  return normalizeRequiredString(value, label, maximumLength)
}

function normalizeDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new FinancialDocumentValidationError(
      `${label} must be a valid Date`,
    )
  }
  return new Date(value.getTime())
}

function normalizeObjectId(
  value: unknown,
  label: string,
): mongoose.Types.ObjectId {
  if (value instanceof mongoose.Types.ObjectId) {
    return new mongoose.Types.ObjectId(value.toHexString())
  }
  if (
    typeof value !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(value)
  ) {
    throw new FinancialDocumentValidationError(
      `${label} must be a Mongo ObjectId`,
    )
  }
  return new mongoose.Types.ObjectId(value)
}

function normalizeProviderMode(value: unknown): ProviderMode {
  if (!PROVIDER_MODES.includes(value as ProviderMode)) {
    throw new FinancialDocumentValidationError(
      'providerMode must be test or live',
    )
  }
  return value as ProviderMode
}

function normalizeMoney(value: unknown, label: string): InrPaise {
  if (!isInrPaise(value)) {
    throw new FinancialDocumentValidationError(
      `${label} must be non-negative safe-integer INR paise`,
    )
  }
  return value
}

function assertSerializableSnapshotValue(
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FinancialDocumentValidationError(
        `${label} must not contain non-finite numbers`,
      )
    }
    return
  }
  if (value instanceof Date) {
    normalizeDate(value, label)
    return
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new FinancialDocumentValidationError(
        `${label} must not contain cycles`,
      )
    }
    ancestors.add(value)
    value.forEach((nested, index) => {
      assertSerializableSnapshotValue(
        nested,
        `${label}[${index}]`,
        ancestors,
      )
    })
    ancestors.delete(value)
    return
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw new FinancialDocumentValidationError(
        `${label} must not contain cycles`,
      )
    }
    ancestors.add(value)
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) {
        throw new FinancialDocumentValidationError(
          `${label}.${key} must not be undefined`,
        )
      }
      assertSerializableSnapshotValue(nested, `${label}.${key}`, ancestors)
    }
    ancestors.delete(value)
    return
  }
  throw new FinancialDocumentValidationError(
    `${label} must contain only persistable snapshot values`,
  )
}

function cloneSnapshotValue<T>(value: T, label: string): T {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new FinancialDocumentValidationError(
      `${label} could not be copied safely: ${
        error instanceof Error ? error.message : 'unknown cloning failure'
      }`,
    )
  }
}

function normalizeApproval(
  value: unknown,
  label: string,
): FinancialSnapshotApproval {
  if (!isRecord(value)) {
    throw new FinancialDocumentValidationError(`${label} is required`)
  }
  assertExactKeys(value, APPROVAL_FIELDS, label)
  const contentHash = normalizeRequiredString(
    value.contentHash,
    `${label}.contentHash`,
    64,
  )
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new FinancialDocumentValidationError(
      `${label}.contentHash must be a lowercase SHA-256 digest`,
    )
  }
  return {
    policyId: normalizeRequiredString(
      value.policyId,
      `${label}.policyId`,
      200,
    ),
    policyVersion: normalizeRequiredString(
      value.policyVersion,
      `${label}.policyVersion`,
      100,
    ),
    approvalId: normalizeRequiredString(
      value.approvalId,
      `${label}.approvalId`,
      200,
    ),
    approvedBy: normalizeRequiredString(
      value.approvedBy,
      `${label}.approvedBy`,
      200,
    ),
    approvedAt: normalizeDate(
      value.approvedAt,
      `${label}.approvedAt`,
    ),
    contentHash,
  }
}

function normalizeApprovedSnapshot<T>(
  value: unknown,
  label: string,
  normalizeValue: (candidate: unknown, valueLabel: string) => T,
): ApprovedFinancialSnapshot<T> {
  if (!isRecord(value)) {
    throw new FinancialDocumentValidationError(`${label} is required`)
  }
  assertExactKeys(value, APPROVED_SNAPSHOT_FIELDS, label)
  const normalizedValue = normalizeValue(value.value, `${label}.value`)
  const approval = normalizeApproval(
    value.approval,
    `${label}.approval`,
  )
  const expectedHash = sha256CanonicalJson(normalizedValue)
  if (approval.contentHash !== expectedHash) {
    throw new FinancialDocumentValidationError(
      `${label}.approval.contentHash does not match the supplied snapshot`,
    )
  }
  return {
    approval,
    value: normalizedValue,
  }
}

function normalizeOpaqueSnapshot(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new FinancialDocumentValidationError(
      `${label} must be a non-empty object`,
    )
  }
  assertSerializableSnapshotValue(value, label)
  return cloneSnapshotValue(value, label)
}

function normalizeTaxSnapshot(
  value: unknown,
  label: string,
): FinancialTaxCalculationSnapshot {
  if (!isRecord(value)) {
    throw new FinancialDocumentValidationError(
      `${label} must be an object`,
    )
  }
  assertExactKeys(value, TAX_FIELDS, label)
  if (
    typeof value.gstRateBps !== 'number' ||
    !Number.isSafeInteger(value.gstRateBps) ||
    value.gstRateBps < 0
  ) {
    throw new FinancialDocumentValidationError(
      `${label}.gstRateBps must be a non-negative safe integer`,
    )
  }
  const gstRateBps = value.gstRateBps
  const taxablePaise = normalizeMoney(
    value.taxablePaise,
    `${label}.taxablePaise`,
  )
  const gstPaise = normalizeMoney(value.gstPaise, `${label}.gstPaise`)
  const grossPaise = normalizeMoney(
    value.grossPaise,
    `${label}.grossPaise`,
  )
  if (
    taxablePaise > Number.MAX_SAFE_INTEGER - gstPaise ||
    taxablePaise + gstPaise !== grossPaise
  ) {
    throw new FinancialDocumentValidationError(
      `${label} taxablePaise plus gstPaise must equal grossPaise exactly`,
    )
  }

  if (value.componentAllocation === 'intra_state') {
    const cgstPaise = normalizeMoney(
      value.cgstPaise,
      `${label}.cgstPaise`,
    )
    const sgstPaise = normalizeMoney(
      value.sgstPaise,
      `${label}.sgstPaise`,
    )
    if (value.igstPaise !== undefined) {
      throw new FinancialDocumentValidationError(
        `${label} intra-state allocation must not include IGST`,
      )
    }
    if (
      cgstPaise > Number.MAX_SAFE_INTEGER - sgstPaise ||
      cgstPaise + sgstPaise !== gstPaise
    ) {
      throw new FinancialDocumentValidationError(
        `${label} CGST plus SGST must equal gstPaise exactly`,
      )
    }
    return {
      gstRateBps,
      taxablePaise,
      gstPaise,
      grossPaise,
      componentAllocation: 'intra_state',
      cgstPaise,
      sgstPaise,
    }
  }

  if (value.componentAllocation === 'inter_state') {
    const igstPaise = normalizeMoney(
      value.igstPaise,
      `${label}.igstPaise`,
    )
    if (
      value.cgstPaise !== undefined ||
      value.sgstPaise !== undefined
    ) {
      throw new FinancialDocumentValidationError(
        `${label} inter-state allocation must not include CGST or SGST`,
      )
    }
    if (igstPaise !== gstPaise) {
      throw new FinancialDocumentValidationError(
        `${label} IGST must equal gstPaise exactly`,
      )
    }
    return {
      gstRateBps,
      taxablePaise,
      gstPaise,
      grossPaise,
      componentAllocation: 'inter_state',
      igstPaise,
    }
  }

  throw new FinancialDocumentValidationError(
    `${label}.componentAllocation must be intra_state or inter_state`,
  )
}

function normalizeInvoiceInput(
  input: CreateFinancialInvoiceInput,
): NormalizedInvoiceInput {
  const providerMode = normalizeProviderMode(input.providerMode)
  if (!INVOICE_CHARGE_KINDS.includes(input.chargeKind)) {
    throw new FinancialDocumentValidationError(
      'chargeKind is not supported',
    )
  }
  const razorpayOrderId = normalizeOptionalString(
    input.razorpayOrderId,
    'razorpayOrderId',
    MAX_PROVIDER_ID_LENGTH,
  )
  const razorpaySubscriptionId = normalizeOptionalString(
    input.razorpaySubscriptionId,
    'razorpaySubscriptionId',
    MAX_PROVIDER_ID_LENGTH,
  )
  if (
    input.chargeKind === 'subscription_cycle' &&
    !razorpaySubscriptionId
  ) {
    throw new FinancialDocumentValidationError(
      'Subscription-cycle invoices require razorpaySubscriptionId',
    )
  }
  if (
    input.chargeKind !== 'subscription_cycle' &&
    !razorpayOrderId
  ) {
    throw new FinancialDocumentValidationError(
      'One-time invoices require razorpayOrderId',
    )
  }

  const capturedPaise = normalizeMoney(
    input.capturedPaise,
    'capturedPaise',
  )
  const taxSnapshot = normalizeApprovedSnapshot(
    input.taxSnapshot,
    'taxSnapshot',
    normalizeTaxSnapshot,
  )
  if (taxSnapshot.value.grossPaise !== capturedPaise) {
    throw new FinancialDocumentValidationError(
      'capturedPaise must equal the approved tax gross exactly',
    )
  }

  return {
    providerMode,
    userId: normalizeObjectId(input.userId, 'userId'),
    chargeKind: input.chargeKind,
    razorpayPaymentId: normalizeRequiredString(
      input.razorpayPaymentId,
      'razorpayPaymentId',
      MAX_PROVIDER_ID_LENGTH,
    ),
    razorpayInvoiceId: normalizeOptionalString(
      input.razorpayInvoiceId,
      'razorpayInvoiceId',
      MAX_PROVIDER_ID_LENGTH,
    ),
    razorpayOrderId,
    razorpaySubscriptionId,
    capturedPaise,
    sellerSnapshot: normalizeApprovedSnapshot(
      input.sellerSnapshot,
      'sellerSnapshot',
      normalizeOpaqueSnapshot,
    ),
    buyerSnapshot: normalizeApprovedSnapshot(
      input.buyerSnapshot,
      'buyerSnapshot',
      normalizeOpaqueSnapshot,
    ),
    taxSnapshot,
    descriptionSnapshot: normalizeRequiredString(
      input.descriptionSnapshot,
      'descriptionSnapshot',
      MAX_DESCRIPTION_LENGTH,
    ),
    issuedAt: normalizeDate(input.issuedAt, 'issuedAt'),
  }
}

function normalizeCreditNoteInput(
  input: CreateFinancialCreditNoteInput,
): NormalizedCreditNoteInput {
  const refundedPaise = normalizeMoney(
    input.refundedPaise,
    'refundedPaise',
  )
  const taxSnapshot = normalizeApprovedSnapshot(
    input.taxSnapshot,
    'taxSnapshot',
    normalizeTaxSnapshot,
  )
  if (taxSnapshot.value.grossPaise !== refundedPaise) {
    throw new FinancialDocumentValidationError(
      'refundedPaise must equal the approved tax gross exactly',
    )
  }
  return {
    providerMode: normalizeProviderMode(input.providerMode),
    userId: normalizeObjectId(input.userId, 'userId'),
    invoiceId: normalizeObjectId(input.invoiceId, 'invoiceId'),
    refundRecordId: normalizeObjectId(
      input.refundRecordId,
      'refundRecordId',
    ),
    razorpayRefundId: normalizeRequiredString(
      input.razorpayRefundId,
      'razorpayRefundId',
      MAX_PROVIDER_ID_LENGTH,
    ),
    razorpayPaymentId: normalizeRequiredString(
      input.razorpayPaymentId,
      'razorpayPaymentId',
      MAX_PROVIDER_ID_LENGTH,
    ),
    refundedPaise,
    sellerSnapshot: normalizeApprovedSnapshot(
      input.sellerSnapshot,
      'sellerSnapshot',
      normalizeOpaqueSnapshot,
    ),
    buyerSnapshot: normalizeApprovedSnapshot(
      input.buyerSnapshot,
      'buyerSnapshot',
      normalizeOpaqueSnapshot,
    ),
    taxSnapshot,
    reasonSnapshot: normalizeRequiredString(
      input.reasonSnapshot,
      'reasonSnapshot',
      MAX_DESCRIPTION_LENGTH,
    ),
    issuedAt: normalizeDate(input.issuedAt, 'issuedAt'),
  }
}

function toPersistedTaxSnapshot(
  snapshot: ApprovedFinancialSnapshot<FinancialTaxCalculationSnapshot>,
): IFinancialTaxSnapshot {
  return {
    ...snapshot.value,
    taxablePaise: snapshot.value.taxablePaise as InrPaise,
    gstPaise: snapshot.value.gstPaise as InrPaise,
    grossPaise: snapshot.value.grossPaise as InrPaise,
    cgstPaise: snapshot.value.cgstPaise as InrPaise | undefined,
    sgstPaise: snapshot.value.sgstPaise as InrPaise | undefined,
    igstPaise: snapshot.value.igstPaise as InrPaise | undefined,
    approvalSnapshot: snapshot.approval,
  }
}

function materializeSnapshot(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    'toObject' in value &&
    typeof value.toObject === 'function'
  ) {
    return value.toObject()
  }
  return value
}

function persistedTaxComparable(
  snapshot: IFinancialTaxSnapshot,
): ApprovedFinancialSnapshot<FinancialTaxCalculationSnapshot> {
  const value: FinancialTaxCalculationSnapshot = {
    gstRateBps: snapshot.gstRateBps,
    taxablePaise: snapshot.taxablePaise,
    gstPaise: snapshot.gstPaise,
    grossPaise: snapshot.grossPaise,
    componentAllocation: snapshot.componentAllocation,
  }
  if (snapshot.cgstPaise !== undefined) value.cgstPaise = snapshot.cgstPaise
  if (snapshot.sgstPaise !== undefined) value.sgstPaise = snapshot.sgstPaise
  if (snapshot.igstPaise !== undefined) value.igstPaise = snapshot.igstPaise
  const approval = snapshot.approvalSnapshot
  return {
    approval: {
      policyId: approval.policyId,
      policyVersion: approval.policyVersion,
      approvalId: approval.approvalId,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      contentHash: approval.contentHash,
    },
    value,
  }
}

function objectIdString(value: unknown): string {
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString()
  if (typeof value === 'string') return value
  if (
    value &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    return value.toString()
  }
  return ''
}

function invoiceComparableFromRequest(
  input: NormalizedInvoiceInput,
): unknown {
  return {
    providerMode: input.providerMode,
    userId: input.userId.toHexString(),
    chargeKind: input.chargeKind,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpayInvoiceId: input.razorpayInvoiceId,
    razorpayOrderId: input.razorpayOrderId,
    razorpaySubscriptionId: input.razorpaySubscriptionId,
    capturedPaise: input.capturedPaise,
    sellerSnapshot: input.sellerSnapshot,
    buyerSnapshot: input.buyerSnapshot,
    taxSnapshot: input.taxSnapshot,
    descriptionSnapshot: input.descriptionSnapshot,
    issuedAt: input.issuedAt,
  }
}

function invoiceComparableFromDocument(invoice: IInvoice): unknown {
  return {
    providerMode: invoice.providerMode,
    userId: objectIdString(invoice.userId),
    chargeKind: invoice.chargeKind,
    razorpayPaymentId: invoice.razorpayPaymentId,
    razorpayInvoiceId: invoice.razorpayInvoiceId,
    razorpayOrderId: invoice.razorpayOrderId,
    razorpaySubscriptionId: invoice.razorpaySubscriptionId,
    capturedPaise: invoice.capturedPaise,
    sellerSnapshot: materializeSnapshot(invoice.sellerSnapshot),
    buyerSnapshot: materializeSnapshot(invoice.buyerSnapshot),
    taxSnapshot: persistedTaxComparable(invoice.taxSnapshot),
    descriptionSnapshot: invoice.descriptionSnapshot,
    issuedAt: invoice.issuedAt,
  }
}

function assertMatchingInvoiceRetry(
  invoice: IInvoice,
  input: NormalizedInvoiceInput,
): void {
  if (
    canonicalJson(invoiceComparableFromDocument(invoice)) !==
    canonicalJson(invoiceComparableFromRequest(input))
  ) {
    throw new FinancialDocumentIdempotencyConflictError(
      'providerMode and razorpayPaymentId already identify a different invoice request',
    )
  }
}

function creditNoteComparableFromRequest(
  input: NormalizedCreditNoteInput,
): unknown {
  return {
    providerMode: input.providerMode,
    userId: input.userId.toHexString(),
    invoiceId: input.invoiceId.toHexString(),
    refundRecordId: input.refundRecordId.toHexString(),
    razorpayRefundId: input.razorpayRefundId,
    razorpayPaymentId: input.razorpayPaymentId,
    refundedPaise: input.refundedPaise,
    sellerSnapshot: input.sellerSnapshot,
    buyerSnapshot: input.buyerSnapshot,
    taxSnapshot: input.taxSnapshot,
    reasonSnapshot: input.reasonSnapshot,
    issuedAt: input.issuedAt,
  }
}

function creditNoteComparableFromDocument(
  creditNote: ICreditNote,
): unknown {
  return {
    providerMode: creditNote.providerMode,
    userId: objectIdString(creditNote.userId),
    invoiceId: objectIdString(creditNote.invoiceId),
    refundRecordId: objectIdString(creditNote.refundRecordId),
    razorpayRefundId: creditNote.razorpayRefundId,
    razorpayPaymentId: creditNote.razorpayPaymentId,
    refundedPaise: creditNote.refundedPaise,
    sellerSnapshot: materializeSnapshot(creditNote.sellerSnapshot),
    buyerSnapshot: materializeSnapshot(creditNote.buyerSnapshot),
    taxSnapshot: persistedTaxComparable(creditNote.taxSnapshot),
    reasonSnapshot: creditNote.reasonSnapshot,
    issuedAt: creditNote.issuedAt,
  }
}

function assertMatchingCreditNoteRetry(
  creditNote: ICreditNote,
  input: NormalizedCreditNoteInput,
): void {
  if (
    canonicalJson(creditNoteComparableFromDocument(creditNote)) !==
    canonicalJson(creditNoteComparableFromRequest(input))
  ) {
    throw new FinancialDocumentIdempotencyConflictError(
      'providerMode and razorpayRefundId already identify a different credit-note request',
    )
  }
}

/**
 * Derive the Indian financial year containing `issuedAt`. The boundary is
 * midnight on April 1 in Asia/Kolkata, not midnight UTC.
 */
export function deriveIndianFinancialYear(issuedAt: Date): string {
  const normalized = normalizeDate(issuedAt, 'issuedAt')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(normalized)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  if (
    !Number.isSafeInteger(year) ||
    year < 1_000 ||
    year > 9_998 ||
    !Number.isSafeInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    throw new FinancialDocumentValidationError(
      'issuedAt cannot be represented as an Indian financial year',
    )
  }
  const startYear = month >= 4 ? year : year - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

export { MongooseFinancialDocumentStore }

export class FinancialDocumentService {
  private readonly store: FinancialDocumentStore
  private readonly verifyApprovedSnapshots:
    FinancialDocumentServiceDependencies['verifyApprovedSnapshots']
  private readonly formatDocumentNumber:
    FinancialDocumentServiceDependencies['formatDocumentNumber']

  constructor(dependencies: FinancialDocumentServiceDependencies) {
    if (
      !dependencies ||
      typeof dependencies.verifyApprovedSnapshots !== 'function' ||
      typeof dependencies.formatDocumentNumber !== 'function'
    ) {
      throw new FinancialDocumentPolicyError(
        'Approved snapshot verification and number formatting policies are required',
      )
    }
    this.store = dependencies.store
    this.verifyApprovedSnapshots = dependencies.verifyApprovedSnapshots
    this.formatDocumentNumber = dependencies.formatDocumentNumber
  }

  private async verifySnapshots(
    input: FinancialSnapshotVerificationInput,
  ): Promise<void> {
    let verified: true
    try {
      verified = await this.verifyApprovedSnapshots(
        cloneSnapshotValue(input, 'approved financial snapshot bundle'),
      )
    } catch (error) {
      throw new FinancialDocumentPolicyError(
        'Approved financial snapshot policy verification failed',
        error,
      )
    }
    if (verified !== true) {
      throw new FinancialDocumentPolicyError(
        'Approved financial snapshot policy did not explicitly verify the bundle',
      )
    }
  }

  private async reserveDocumentNumber(
    providerMode: ProviderMode,
    documentType: FinancialDocumentType,
    issuedAt: Date,
  ): Promise<IFinancialDocumentNumberSnapshot> {
    const financialYear = deriveIndianFinancialYear(issuedAt)
    // This reservation commits before formatting and document insertion.
    // Any later failure intentionally leaves a gap and cannot reuse the number.
    const sequenceNumber = await this.store.reserveSequence(
      providerMode,
      documentType,
      financialYear,
    )
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
      throw new Error('Financial document store returned an invalid sequence')
    }

    let formattedNumber: string
    try {
      formattedNumber = await this.formatDocumentNumber({
        providerMode,
        documentType,
        financialYear,
        sequenceNumber,
      })
    } catch (error) {
      throw new FinancialDocumentPolicyError(
        'Approved financial document number formatting failed',
        error,
      )
    }
    if (
      typeof formattedNumber !== 'string' ||
      !formattedNumber ||
      formattedNumber !== formattedNumber.trim() ||
      formattedNumber.length > FINANCIAL_NUMBER_MAX_LENGTH
    ) {
      throw new FinancialDocumentPolicyError(
        `Approved formatter must return 1-${FINANCIAL_NUMBER_MAX_LENGTH} unpadded characters`,
      )
    }
    return {
      documentType,
      financialYear,
      sequenceNumber,
      formattedNumber,
    }
  }

  private async recoverInvoiceAfterCreateError(
    input: NormalizedInvoiceInput,
    creationError: unknown,
  ): Promise<IInvoice> {
    const concurrent = await this.store.findInvoiceByPaymentKey(
      input.providerMode,
      input.razorpayPaymentId,
    )
    if (concurrent) {
      assertMatchingInvoiceRetry(concurrent, input)
      return concurrent
    }
    throw creationError
  }

  async createInvoice(
    input: CreateFinancialInvoiceInput,
  ): Promise<IInvoice> {
    const normalized = normalizeInvoiceInput(input)
    const existing = await this.store.findInvoiceByPaymentKey(
      normalized.providerMode,
      normalized.razorpayPaymentId,
    )
    if (existing) {
      assertMatchingInvoiceRetry(existing, normalized)
      return existing
    }

    await this.verifySnapshots({
      documentType: 'invoice',
      providerMode: normalized.providerMode,
      considerationPaise: normalized.capturedPaise,
      issuedAt: normalized.issuedAt,
      sellerSnapshot: normalized.sellerSnapshot,
      buyerSnapshot: normalized.buyerSnapshot,
      taxSnapshot: normalized.taxSnapshot,
    })

    // Reduce avoidable gaps when another request completed during policy
    // verification. A remaining race is resolved by the unique payment key.
    const verifiedExisting = await this.store.findInvoiceByPaymentKey(
      normalized.providerMode,
      normalized.razorpayPaymentId,
    )
    if (verifiedExisting) {
      assertMatchingInvoiceRetry(verifiedExisting, normalized)
      return verifiedExisting
    }

    const numberSnapshot = await this.reserveDocumentNumber(
      normalized.providerMode,
      'invoice',
      normalized.issuedAt,
    )
    try {
      return await this.store.createInvoice({
        providerMode: normalized.providerMode,
        userId: normalized.userId,
        chargeKind: normalized.chargeKind,
        razorpayPaymentId: normalized.razorpayPaymentId,
        razorpayInvoiceId: normalized.razorpayInvoiceId,
        razorpayOrderId: normalized.razorpayOrderId,
        razorpaySubscriptionId: normalized.razorpaySubscriptionId,
        capturedPaise: normalized.capturedPaise,
        currency: 'INR',
        numberSnapshot,
        sellerSnapshot: normalized.sellerSnapshot,
        buyerSnapshot: normalized.buyerSnapshot,
        taxSnapshot: toPersistedTaxSnapshot(normalized.taxSnapshot),
        descriptionSnapshot: normalized.descriptionSnapshot,
        issuedAt: normalized.issuedAt,
      })
    } catch (error) {
      return this.recoverInvoiceAfterCreateError(normalized, error)
    }
  }

  private assertCreditNoteLinkage(
    input: NormalizedCreditNoteInput,
    invoice: IInvoice,
    refund: IRefundRecord,
  ): void {
    const expectedUserId = input.userId.toHexString()
    const mismatch = (
      objectIdString(invoice._id) !== input.invoiceId.toHexString() ||
      objectIdString(refund._id) !== input.refundRecordId.toHexString() ||
      invoice.providerMode !== input.providerMode ||
      refund.providerMode !== input.providerMode ||
      objectIdString(invoice.userId) !== expectedUserId ||
      objectIdString(refund.userId) !== expectedUserId ||
      invoice.razorpayPaymentId !== input.razorpayPaymentId ||
      refund.razorpayPaymentId !== input.razorpayPaymentId ||
      refund.razorpayRefundId !== input.razorpayRefundId ||
      refund.originalCapturedPaise !== invoice.capturedPaise ||
      refund.refundedPaise !== input.refundedPaise ||
      input.refundedPaise > invoice.capturedPaise ||
      invoice.taxSnapshot.grossPaise !== invoice.capturedPaise ||
      refund.creditNoteDecision.status !== 'required'
    )
    const invoiceReferenceMismatch = (
      refund.razorpayInvoiceId !== undefined &&
      refund.razorpayInvoiceId !== invoice.razorpayInvoiceId
    )
    const orderMismatch = (
      refund.razorpayOrderId !== undefined &&
      refund.razorpayOrderId !== invoice.razorpayOrderId
    )
    const subscriptionMismatch = (
      refund.razorpaySubscriptionId !== undefined &&
      refund.razorpaySubscriptionId !== invoice.razorpaySubscriptionId
    )
    if (
      mismatch ||
      invoiceReferenceMismatch ||
      orderMismatch ||
      subscriptionMismatch
    ) {
      throw new FinancialDocumentValidationError(
        'Credit-note request does not exactly match its invoice and refund evidence',
      )
    }
  }

  private async recoverCreditNoteAfterCreateError(
    input: NormalizedCreditNoteInput,
    creationError: unknown,
  ): Promise<ICreditNote> {
    const concurrent = await this.store.findCreditNoteByRefundKey(
      input.providerMode,
      input.razorpayRefundId,
    )
    if (concurrent) {
      assertMatchingCreditNoteRetry(concurrent, input)
      return concurrent
    }
    throw creationError
  }

  async createCreditNote(
    input: CreateFinancialCreditNoteInput,
  ): Promise<ICreditNote> {
    const normalized = normalizeCreditNoteInput(input)
    const existing = await this.store.findCreditNoteByRefundKey(
      normalized.providerMode,
      normalized.razorpayRefundId,
    )
    if (existing) {
      assertMatchingCreditNoteRetry(existing, normalized)
      return existing
    }

    const [invoice, refund] = await Promise.all([
      this.store.findInvoiceById(normalized.invoiceId),
      this.store.findRefundRecordById(normalized.refundRecordId),
    ])
    if (!invoice || !refund) {
      throw new FinancialDocumentValidationError(
        'Credit-note request requires an existing invoice and refund record',
      )
    }
    this.assertCreditNoteLinkage(normalized, invoice, refund)

    await this.verifySnapshots({
      documentType: 'credit_note',
      providerMode: normalized.providerMode,
      considerationPaise: normalized.refundedPaise,
      issuedAt: normalized.issuedAt,
      sellerSnapshot: normalized.sellerSnapshot,
      buyerSnapshot: normalized.buyerSnapshot,
      taxSnapshot: normalized.taxSnapshot,
    })

    const verifiedExisting = await this.store.findCreditNoteByRefundKey(
      normalized.providerMode,
      normalized.razorpayRefundId,
    )
    if (verifiedExisting) {
      assertMatchingCreditNoteRetry(verifiedExisting, normalized)
      return verifiedExisting
    }

    const numberSnapshot = await this.reserveDocumentNumber(
      normalized.providerMode,
      'credit_note',
      normalized.issuedAt,
    )
    try {
      return await this.store.createCreditNote({
        providerMode: normalized.providerMode,
        userId: normalized.userId,
        invoiceId: normalized.invoiceId,
        refundRecordId: normalized.refundRecordId,
        originalInvoiceNumberSnapshot:
          invoice.numberSnapshot.formattedNumber,
        razorpayRefundId: normalized.razorpayRefundId,
        razorpayPaymentId: normalized.razorpayPaymentId,
        razorpayOrderId: invoice.razorpayOrderId,
        razorpaySubscriptionId: invoice.razorpaySubscriptionId,
        refundedPaise: normalized.refundedPaise,
        currency: 'INR',
        numberSnapshot,
        sellerSnapshot: normalized.sellerSnapshot,
        buyerSnapshot: normalized.buyerSnapshot,
        taxSnapshot: toPersistedTaxSnapshot(normalized.taxSnapshot),
        reasonSnapshot: normalized.reasonSnapshot,
        issuedAt: normalized.issuedAt,
      })
    } catch (error) {
      return this.recoverCreditNoteAfterCreateError(normalized, error)
    }
  }
}

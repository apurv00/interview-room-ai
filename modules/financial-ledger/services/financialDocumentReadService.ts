import mongoose from 'mongoose'
import { CreditNote } from '../models/CreditNote'
import {
  Invoice,
  type InvoiceChargeKind,
} from '../models/Invoice'
import type { FinancialLedgerProviderMode } from '../types'

export type FinancialDocumentKind = 'invoice' | 'credit_note'

export const MAX_FINANCIAL_DOCUMENT_PAGE_SIZE = 50

export interface FinancialDocumentCursor {
  issuedAt: string
  kind: FinancialDocumentKind
  id: string
  providerMode: FinancialLedgerProviderMode
}

interface InvoiceRow {
  _id: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  chargeKind: InvoiceChargeKind
  capturedPaise: number
  currency: 'INR'
  numberSnapshot: {
    formattedNumber: string
  }
  taxSnapshot: {
    gstRateBps: number
    taxablePaise: number
    gstPaise: number
    grossPaise: number
    componentAllocation: 'intra_state' | 'inter_state'
    cgstPaise?: number
    sgstPaise?: number
    igstPaise?: number
  }
  descriptionSnapshot: string
  issuedAt: Date
}

interface CreditNoteRow {
  _id: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  invoiceId: mongoose.Types.ObjectId
  originalInvoiceNumberSnapshot: string
  refundedPaise: number
  currency: 'INR'
  numberSnapshot: {
    formattedNumber: string
  }
  taxSnapshot: InvoiceRow['taxSnapshot']
  reasonSnapshot: string
  issuedAt: Date
}

export interface FinancialDocumentSummary {
  id: string
  kind: FinancialDocumentKind
  number: string
  issuedAt: string
  currency: 'INR'
  grossPaise: number
  taxablePaise: number
  gstPaise: number
  componentAllocation: 'intra_state' | 'inter_state'
  cgstPaise?: number
  sgstPaise?: number
  igstPaise?: number
  invoiceId?: string
  originalInvoiceNumber?: string
  chargeKind?: InvoiceChargeKind
  description: string
  pdfAvailable: false
  testMode: boolean
}

export interface FinancialDocumentPage {
  environment: FinancialLedgerProviderMode
  documents: FinancialDocumentSummary[]
  nextCursor?: string
}

export interface FinancialInvoiceRecord {
  environment: FinancialLedgerProviderMode
  invoice: FinancialDocumentSummary
  creditNotes: FinancialDocumentSummary[]
  capturedPaise: number
  refundedPaise: number[]
}

export class FinancialLedgerReadError extends Error {
  readonly code: 'invalid_cursor' | 'not_found'

  constructor(code: FinancialLedgerReadError['code']) {
    super(
      code === 'invalid_cursor'
        ? 'Financial document cursor is invalid'
        : 'Financial document was not found',
    )
    this.name = 'FinancialLedgerReadError'
    this.code = code
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function documentSummary(
  row: InvoiceRow | CreditNoteRow,
  kind: FinancialDocumentKind,
): FinancialDocumentSummary {
  const creditNote = kind === 'credit_note' ? (row as CreditNoteRow) : undefined
  const invoice = kind === 'invoice' ? (row as InvoiceRow) : undefined
  return {
    id: row._id.toString(),
    kind,
    number: row.numberSnapshot.formattedNumber,
    issuedAt: row.issuedAt.toISOString(),
    currency: row.currency,
    grossPaise:
      kind === 'invoice'
        ? (row as InvoiceRow).capturedPaise
        : (row as CreditNoteRow).refundedPaise,
    taxablePaise: row.taxSnapshot.taxablePaise,
    gstPaise: row.taxSnapshot.gstPaise,
    componentAllocation: row.taxSnapshot.componentAllocation,
    ...(row.taxSnapshot.cgstPaise !== undefined
      ? { cgstPaise: row.taxSnapshot.cgstPaise }
      : {}),
    ...(row.taxSnapshot.sgstPaise !== undefined
      ? { sgstPaise: row.taxSnapshot.sgstPaise }
      : {}),
    ...(row.taxSnapshot.igstPaise !== undefined
      ? { igstPaise: row.taxSnapshot.igstPaise }
      : {}),
    ...(creditNote
      ? {
          invoiceId: creditNote.invoiceId.toString(),
          originalInvoiceNumber: creditNote.originalInvoiceNumberSnapshot,
        }
      : {}),
    ...(invoice ? { chargeKind: invoice.chargeKind } : {}),
    description: invoice
      ? invoice.descriptionSnapshot
      : creditNote!.reasonSnapshot,
    pdfAvailable: false,
    testMode: row.providerMode === 'test',
  }
}

function encodeCursor(cursor: FinancialDocumentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function parseFinancialDocumentCursor(
  value: string | undefined,
): FinancialDocumentCursor | null {
  if (value === undefined) return null
  try {
    if (!value || value.length > 300) {
      throw new FinancialLedgerReadError('invalid_cursor')
    }
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new FinancialLedgerReadError('invalid_cursor')
    }
    const record = decoded as Record<string, unknown>
    if (
      Object.keys(record).sort().join(',') !==
        'id,issuedAt,kind,providerMode' ||
      typeof record.issuedAt !== 'string' ||
      !validDate(new Date(record.issuedAt)) ||
      (record.kind !== 'invoice' && record.kind !== 'credit_note') ||
      (record.providerMode !== 'test' && record.providerMode !== 'live') ||
      typeof record.id !== 'string' ||
      !mongoose.isValidObjectId(record.id)
    ) {
      throw new FinancialLedgerReadError('invalid_cursor')
    }
    return {
      issuedAt: record.issuedAt,
      kind: record.kind,
      id: record.id,
      providerMode: record.providerMode,
    }
  } catch (error) {
    if (error instanceof FinancialLedgerReadError) throw error
    throw new FinancialLedgerReadError('invalid_cursor')
  }
}

function cursorFilter(
  cursor: FinancialDocumentCursor | null,
  kind: FinancialDocumentKind,
) {
  if (!cursor) return {}
  const issuedAt = new Date(cursor.issuedAt)
  const rank = kind === 'invoice' ? 1 : 0
  const cursorRank = cursor.kind === 'invoice' ? 1 : 0
  const sameTimestamp =
    rank < cursorRank
      ? { issuedAt }
      : rank === cursorRank
        ? {
            issuedAt,
            _id: { $lt: new mongoose.Types.ObjectId(cursor.id) },
          }
        : null
  return {
    $or: [
      { issuedAt: { $lt: issuedAt } },
      ...(sameTimestamp ? [sameTimestamp] : []),
    ],
  }
}

function compareDocuments(
  left: FinancialDocumentSummary,
  right: FinancialDocumentSummary,
): number {
  const time = Date.parse(right.issuedAt) - Date.parse(left.issuedAt)
  if (time !== 0) return time
  const rank = (kind: FinancialDocumentKind) =>
    kind === 'invoice' ? 1 : 0
  const kind = rank(right.kind) - rank(left.kind)
  return kind !== 0 ? kind : right.id.localeCompare(left.id)
}

export async function listFinancialDocuments(input: {
  userId: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
  limit: number
  cursor: FinancialDocumentCursor | null
}): Promise<FinancialDocumentPage> {
  if (
    input.cursor &&
    input.cursor.providerMode !== input.providerMode
  ) {
    throw new FinancialLedgerReadError('invalid_cursor')
  }
  const [invoices, creditNotes] = await Promise.all([
    Invoice.find({
      userId: input.userId,
      providerMode: input.providerMode,
      ...cursorFilter(input.cursor, 'invoice'),
    })
      .sort({ issuedAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .select(
        'providerMode userId chargeKind capturedPaise currency numberSnapshot ' +
          'taxSnapshot descriptionSnapshot issuedAt',
      )
      .lean<InvoiceRow[]>(),
    CreditNote.find({
      userId: input.userId,
      providerMode: input.providerMode,
      ...cursorFilter(input.cursor, 'credit_note'),
    })
      .sort({ issuedAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .select(
        'providerMode userId invoiceId originalInvoiceNumberSnapshot refundedPaise ' +
          'currency numberSnapshot taxSnapshot reasonSnapshot issuedAt',
      )
      .lean<CreditNoteRow[]>(),
  ])
  const merged = [
    ...invoices.map((row) => documentSummary(row, 'invoice')),
    ...creditNotes.map((row) => documentSummary(row, 'credit_note')),
  ].sort(compareDocuments)
  const documents = merged.slice(0, input.limit)
  const hasMore = merged.length > input.limit
  const last = documents.at(-1)
  return {
    environment: input.providerMode,
    documents,
    ...(hasMore && last
      ? {
          nextCursor: encodeCursor({
            issuedAt: last.issuedAt,
            kind: last.kind,
            id: last.id,
            providerMode: input.providerMode,
          }),
        }
      : {}),
  }
}

export async function readFinancialInvoiceRecord(input: {
  userId: mongoose.Types.ObjectId
  invoiceId: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
}): Promise<FinancialInvoiceRecord> {
  const invoice = await Invoice.findOne({
    _id: input.invoiceId,
    userId: input.userId,
    providerMode: input.providerMode,
  })
    .select(
      'providerMode userId chargeKind capturedPaise currency numberSnapshot ' +
        'taxSnapshot descriptionSnapshot issuedAt',
    )
    .lean<InvoiceRow>()
  if (!invoice) throw new FinancialLedgerReadError('not_found')
  const creditNotes = await CreditNote.find({
    invoiceId: input.invoiceId,
    userId: input.userId,
    providerMode: input.providerMode,
  })
    .sort({ issuedAt: 1, _id: 1 })
    .select(
      'providerMode userId invoiceId originalInvoiceNumberSnapshot refundedPaise ' +
        'currency numberSnapshot taxSnapshot reasonSnapshot issuedAt',
    )
    .lean<CreditNoteRow[]>()
  return {
    environment: input.providerMode,
    invoice: documentSummary(invoice, 'invoice'),
    creditNotes: creditNotes.map((row) =>
      documentSummary(row, 'credit_note'),
    ),
    capturedPaise: invoice.capturedPaise,
    refundedPaise: creditNotes.map((row) => row.refundedPaise),
  }
}

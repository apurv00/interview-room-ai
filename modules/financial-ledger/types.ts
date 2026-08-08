export const FINANCIAL_LEDGER_PROVIDER_MODES = ['test', 'live'] as const

export type FinancialLedgerProviderMode =
  (typeof FINANCIAL_LEDGER_PROVIDER_MODES)[number]

/**
 * Provider adapters normalize and validate money before it crosses this
 * boundary. The ledger repeats only the storage invariant needed by Mongoose;
 * pricing arithmetic and currency conversion remain payment-owned.
 */
export type NormalizedPaise = number

export function isNormalizedPaise(
  value: unknown,
): value is NormalizedPaise {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

export const FINANCIAL_LEDGER_OPERATION_MUTATIONS_READY = false as const
export const FINANCIAL_LEDGER_CREDIT_NOTE_RECOVERY_READY = true as const

export const FINANCIAL_OPERATION_KINDS = [
  'generate_invoice',
  'issue_credit_note',
  'record_refund',
  'record_dispute',
  'reconcile_financial_document',
] as const

export type FinancialOperationKind =
  (typeof FINANCIAL_OPERATION_KINDS)[number]

export interface FinancialOperationRequest {
  requestId: string
  operation: FinancialOperationKind
  providerMode: FinancialLedgerProviderMode
  userId: string
  targetReference: string
  correlationId: string
  requestedBy: string
  reason: string
  requestedAt: Date
}

export interface FinancialEvidenceComparisonPort {
  equivalent(left: unknown, right: unknown): boolean
}

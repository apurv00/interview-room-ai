declare const financialOperationAuthorityBrand: unique symbol

export interface FinancialOperationServerAuthority {
  readonly [financialOperationAuthorityBrand]:
    'financial_operation_server_authority_v1'
}

export const FINANCIAL_LEDGER_OPERATION_SERVER_AUTHORITY_READY =
  false as const

export const FINANCIAL_OPERATION_SERVER_ADAPTER_HOOK =
  'modules/payments/services/financialOperationIntentAdapterService.ts' as const

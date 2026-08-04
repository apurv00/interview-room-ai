import mongoose, { type ClientSession } from 'mongoose'
import { FinancialOperationIntent } from '../models/FinancialOperationIntent'

/**
 * Design-time privacy inventory for financial-ledger persistence.
 *
 * This metadata is deliberately inert. Runtime export, erasure, retention, and
 * provider-reconciliation workflows remain disabled until their policy
 * approvals and recovery tests are complete.
 */
export const FINANCIAL_LEDGER_PRIVACY_RUNTIME_READY = false as const

export const FINANCIAL_LEDGER_MODEL_NAMES = [
  'BillingCounter',
  'CreditNote',
  'DisputeRecord',
  'FinancialOperationIntent',
  'Invoice',
  'RefundRecord',
] as const

export type FinancialLedgerModelName =
  (typeof FINANCIAL_LEDGER_MODEL_NAMES)[number]

type FinancialLedgerSubjectLocator =
  | {
      kind: 'direct' | 'embedded_snapshot'
      paths: readonly string[]
    }
  | {
      kind: 'provider_payload'
      paths: readonly string[]
      provider: 'razorpay'
    }

interface FinancialLedgerPrivacyEntry<
  Name extends FinancialLedgerModelName = FinancialLedgerModelName,
> {
  disposition:
    | 'pseudonymize_and_retain'
    | 'retain_and_block_erasure'
    | 'retain_non_personal'
  subjectLookup: {
    customer: readonly FinancialLedgerSubjectLocator[]
    operator: readonly FinancialLedgerSubjectLocator[]
    opaquePersonalDataPaths: readonly string[]
  }
  exportPolicy: {
    policyId:
      | 'pay-exp-customer-portability-minimized-v1'
      | 'pay-exp-financial-document-v1'
      | 'pay-exp-mixed-subject-access-minimized-v1'
      | 'pay-exp-none-non-subject-v1'
    subjectRoles: readonly ('customer' | 'operator')[]
    projection:
      | 'customer_portability_minimized'
      | 'financial_document_customer_copy'
      | 'mixed_subject_access_minimized'
      | 'none'
    redactionRequired: boolean
  }
  deletionPolicyIds: readonly (
    | 'pay-del-no-subject-action-v1'
    | 'pay-del-block-while-financial-evidence-retained-v1'
    | 'pay-del-pseudonymize-retained-customer-v1'
    | 'pay-del-redact-retained-operator-v1'
  )[]
  retentionPolicyIds: readonly (
    | 'pay-ret-non-personal-v1'
    | 'pay-ret-payment-evidence-pending-approval-v1'
    | 'pay-ret-statutory-financial-pending-approval-v1'
  )[]
  externalProviderDependency: {
    provider: 'none' | 'razorpay'
    dependency: 'none' | 'reconciliation_evidence'
    referencePaths: readonly string[]
    blocksDestructiveDisposition: boolean
  }
  verification: {
    modelSource: `modules/financial-ledger/models/${Name}.ts`
    coverageTest:
      'modules/financial-ledger/__tests__/financialPrivacyService.test.ts'
    runtimeEnforcement: 'registry_only'
    requiredApprovals: readonly (
      | 'privacy'
      | 'legal_finance'
      | 'security'
      | 'provider_operations'
    )[]
  }
}

type FinancialLedgerPrivacyRegistry = {
  readonly [Name in FinancialLedgerModelName]:
    FinancialLedgerPrivacyEntry<Name>
}

export const FINANCIAL_LEDGER_PRIVACY_DISPOSITION_REGISTRY = {
  BillingCounter: {
    disposition: 'retain_non_personal',
    subjectLookup: {
      customer: [],
      operator: [],
      opaquePersonalDataPaths: [],
    },
    exportPolicy: {
      policyId: 'pay-exp-none-non-subject-v1',
      subjectRoles: [],
      projection: 'none',
      redactionRequired: false,
    },
    deletionPolicyIds: ['pay-del-no-subject-action-v1'],
    retentionPolicyIds: ['pay-ret-non-personal-v1'],
    externalProviderDependency: {
      provider: 'none',
      dependency: 'none',
      referencePaths: [],
      blocksDestructiveDisposition: false,
    },
    verification: {
      modelSource: 'modules/financial-ledger/models/BillingCounter.ts',
      coverageTest:
        'modules/financial-ledger/__tests__/financialPrivacyService.test.ts',
      runtimeEnforcement: 'registry_only',
      requiredApprovals: [],
    },
  },
  CreditNote: {
    disposition: 'pseudonymize_and_retain',
    subjectLookup: {
      customer: [{ kind: 'direct', paths: ['userId'] }],
      operator: [
        {
          kind: 'embedded_snapshot',
          paths: ['taxSnapshot.approvalSnapshot.approvedBy'],
        },
      ],
      opaquePersonalDataPaths: [
        'buyerSnapshot',
        'sellerSnapshot',
        'taxSnapshot.approvalSnapshot',
      ],
    },
    exportPolicy: {
      policyId: 'pay-exp-financial-document-v1',
      subjectRoles: ['customer'],
      projection: 'financial_document_customer_copy',
      redactionRequired: true,
    },
    deletionPolicyIds: [
      'pay-del-pseudonymize-retained-customer-v1',
      'pay-del-redact-retained-operator-v1',
    ],
    retentionPolicyIds: [
      'pay-ret-statutory-financial-pending-approval-v1',
    ],
    externalProviderDependency: {
      provider: 'razorpay',
      dependency: 'reconciliation_evidence',
      referencePaths: [
        'razorpayRefundId',
        'razorpayPaymentId',
        'razorpayOrderId',
        'razorpaySubscriptionId',
      ],
      blocksDestructiveDisposition: false,
    },
    verification: {
      modelSource: 'modules/financial-ledger/models/CreditNote.ts',
      coverageTest:
        'modules/financial-ledger/__tests__/financialPrivacyService.test.ts',
      runtimeEnforcement: 'registry_only',
      requiredApprovals: [
        'privacy',
        'legal_finance',
        'provider_operations',
      ],
    },
  },
  DisputeRecord: {
    disposition: 'pseudonymize_and_retain',
    subjectLookup: {
      customer: [{ kind: 'direct', paths: ['userId'] }],
      operator: [],
      opaquePersonalDataPaths: [
        'originalProviderSnapshot',
        'lastProviderSnapshot',
        'history.providerSnapshot',
      ],
    },
    exportPolicy: {
      policyId: 'pay-exp-customer-portability-minimized-v1',
      subjectRoles: ['customer'],
      projection: 'customer_portability_minimized',
      redactionRequired: true,
    },
    deletionPolicyIds: ['pay-del-pseudonymize-retained-customer-v1'],
    retentionPolicyIds: [
      'pay-ret-payment-evidence-pending-approval-v1',
      'pay-ret-statutory-financial-pending-approval-v1',
    ],
    externalProviderDependency: {
      provider: 'razorpay',
      dependency: 'reconciliation_evidence',
      referencePaths: [
        'razorpayDisputeId',
        'razorpayPaymentId',
        'razorpayInvoiceId',
        'razorpayOrderId',
        'razorpaySubscriptionId',
      ],
      blocksDestructiveDisposition: false,
    },
    verification: {
      modelSource: 'modules/financial-ledger/models/DisputeRecord.ts',
      coverageTest:
        'modules/financial-ledger/__tests__/financialPrivacyService.test.ts',
      runtimeEnforcement: 'registry_only',
      requiredApprovals: [
        'privacy',
        'legal_finance',
        'security',
        'provider_operations',
      ],
    },
  },
  FinancialOperationIntent: {
    disposition: 'retain_and_block_erasure',
    subjectLookup: {
      customer: [{ kind: 'direct', paths: ['userId'] }],
      operator: [{
        kind: 'direct',
        paths: [
          'requestedBy',
          'approval.approvedBy',
          'finalization.finalizedBy',
        ],
      }],
      opaquePersonalDataPaths: [
        'reason',
        'correlationId',
        'claim.workerId',
        'observations.observedBy',
      ],
    },
    exportPolicy: {
      policyId: 'pay-exp-mixed-subject-access-minimized-v1',
      subjectRoles: ['customer', 'operator'],
      projection: 'mixed_subject_access_minimized',
      redactionRequired: true,
    },
    deletionPolicyIds: [
      'pay-del-block-while-financial-evidence-retained-v1',
    ],
    retentionPolicyIds: [
      'pay-ret-payment-evidence-pending-approval-v1',
      'pay-ret-statutory-financial-pending-approval-v1',
    ],
    externalProviderDependency: {
      provider: 'razorpay',
      dependency: 'reconciliation_evidence',
      referencePaths: [
        'target.referenceId',
        'target.providerReference.referenceId',
        'observations.providerReference',
        'finalization.resultReference',
        'reconciliationEvidencePointer.manifestDigest',
        'reconciliationEvidencePointer.observationRecordDigest',
        'reconciliationEvidencePointer.originalClaimIdentityDigest',
        'reconciliationEvidencePointer.originalFencingToken',
        'reconciliationEvidencePointer.firstCommittedCheckpointVersion',
      ],
      blocksDestructiveDisposition: true,
    },
    verification: {
      modelSource:
        'modules/financial-ledger/models/FinancialOperationIntent.ts',
      coverageTest:
        'modules/financial-ledger/__tests__/financialPrivacyService.test.ts',
      runtimeEnforcement: 'registry_only',
      requiredApprovals: [
        'privacy',
        'legal_finance',
        'security',
        'provider_operations',
      ],
    },
  },
  Invoice: {
    disposition: 'pseudonymize_and_retain',
    subjectLookup: {
      customer: [{ kind: 'direct', paths: ['userId'] }],
      operator: [
        {
          kind: 'embedded_snapshot',
          paths: ['taxSnapshot.approvalSnapshot.approvedBy'],
        },
      ],
      opaquePersonalDataPaths: [
        'buyerSnapshot',
        'sellerSnapshot',
        'taxSnapshot.approvalSnapshot',
      ],
    },
    exportPolicy: {
      policyId: 'pay-exp-financial-document-v1',
      subjectRoles: ['customer'],
      projection: 'financial_document_customer_copy',
      redactionRequired: true,
    },
    deletionPolicyIds: [
      'pay-del-pseudonymize-retained-customer-v1',
      'pay-del-redact-retained-operator-v1',
    ],
    retentionPolicyIds: [
      'pay-ret-statutory-financial-pending-approval-v1',
    ],
    externalProviderDependency: {
      provider: 'razorpay',
      dependency: 'reconciliation_evidence',
      referencePaths: [
        'razorpayPaymentId',
        'razorpayInvoiceId',
        'razorpayOrderId',
        'razorpaySubscriptionId',
      ],
      blocksDestructiveDisposition: false,
    },
    verification: {
      modelSource: 'modules/financial-ledger/models/Invoice.ts',
      coverageTest:
        'modules/financial-ledger/__tests__/financialPrivacyService.test.ts',
      runtimeEnforcement: 'registry_only',
      requiredApprovals: [
        'privacy',
        'legal_finance',
        'provider_operations',
      ],
    },
  },
  RefundRecord: {
    disposition: 'pseudonymize_and_retain',
    subjectLookup: {
      customer: [{ kind: 'direct', paths: ['userId'] }],
      operator: [],
      opaquePersonalDataPaths: [
        'originalProviderSnapshot',
        'lastProviderSnapshot',
        'creditNoteDecision.reason',
        'accessReversalDecision.reason',
      ],
    },
    exportPolicy: {
      policyId: 'pay-exp-customer-portability-minimized-v1',
      subjectRoles: ['customer'],
      projection: 'customer_portability_minimized',
      redactionRequired: true,
    },
    deletionPolicyIds: ['pay-del-pseudonymize-retained-customer-v1'],
    retentionPolicyIds: [
      'pay-ret-payment-evidence-pending-approval-v1',
      'pay-ret-statutory-financial-pending-approval-v1',
    ],
    externalProviderDependency: {
      provider: 'razorpay',
      dependency: 'reconciliation_evidence',
      referencePaths: [
        'razorpayRefundId',
        'razorpayPaymentId',
        'razorpayInvoiceId',
        'razorpayOrderId',
        'razorpaySubscriptionId',
      ],
      blocksDestructiveDisposition: false,
    },
    verification: {
      modelSource: 'modules/financial-ledger/models/RefundRecord.ts',
      coverageTest:
        'modules/financial-ledger/__tests__/financialPrivacyService.test.ts',
      runtimeEnforcement: 'registry_only',
      requiredApprovals: [
        'privacy',
        'legal_finance',
        'security',
        'provider_operations',
      ],
    },
  },
} as const satisfies FinancialLedgerPrivacyRegistry

export function financialLedgerPrivacyDispositionFor<
  Name extends FinancialLedgerModelName,
>(
  modelName: Name,
): (typeof FINANCIAL_LEDGER_PRIVACY_DISPOSITION_REGISTRY)[Name] {
  return FINANCIAL_LEDGER_PRIVACY_DISPOSITION_REGISTRY[modelName]
}

export async function hasRetainedFinancialOperationIntentEvidence(
  userId: mongoose.Types.ObjectId,
  session: ClientSession,
): Promise<boolean> {
  return Boolean(
    await FinancialOperationIntent.exists({
      $or: [
        { userId: userId.toHexString() },
        { requestedBy: userId.toHexString() },
        { 'approval.approvedBy': userId.toHexString() },
        { 'finalization.finalizedBy': userId.toHexString() },
      ],
    }).session(session),
  )
}

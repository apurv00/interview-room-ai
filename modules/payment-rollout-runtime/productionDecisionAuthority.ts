import type { ClientSession } from 'mongoose'
import {
  createBillingRolloutControlService,
  createMongoBillingRolloutControlRepository,
  type BillingRolloutAuthorityDecision,
  type BillingRolloutControlService,
  type BillingRolloutDecisionInput,
} from '@/modules/payment-rollout-control'
import { createMongoBillingRolloutRuntimeAuthority } from './mongoRuntimeAuthority'

let productionService: BillingRolloutControlService | undefined

function unavailable(): never {
  throw new Error('Billing rollout mutation authority is unavailable')
}

function getProductionService(): BillingRolloutControlService {
  if (productionService) return productionService
  const repository =
    createMongoBillingRolloutControlRepository()
  const runtime = createMongoBillingRolloutRuntimeAuthority({
    authorizeCurrentActor: async () => unavailable(),
    observeArtifacts: async () => unavailable(),
    loadAuthoritySecretBase64: () =>
      process.env
        .BILLING_ROLLOUT_AUTHORITY_HMAC_V1_SECRET_BASE64 ?? '',
    rolloutSeedId:
      process.env.BILLING_ROLLOUT_SEED_ID ?? '',
  })
  productionService = createBillingRolloutControlService<
    ClientSession
  >(repository, runtime.ports)
  return productionService
}

export async function readProductionBillingRolloutDecision(
  input: BillingRolloutDecisionInput,
): Promise<BillingRolloutAuthorityDecision> {
  return getProductionService().decide(input)
}

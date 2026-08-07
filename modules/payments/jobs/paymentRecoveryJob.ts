import { inngest } from '@shared/services/inngest'
import {
  recoverChargeFulfillmentWithCommercialAnalytics,
  fulfillSubscriptionCycleProviderObservationWithCommercialAnalytics,
} from '@/app/api/_lib/entitlementCommercialAnalyticsComposition'
import { paymentWebhookLaunchHandler } from '@/app/api/_lib/paymentWebhookLaunchComposition'
import {
  parsePaymentRecoveryProviderModes,
  runPaymentRecoverySweep,
  type PaymentRecoverySweepDependencies,
  type PaymentRecoverySweepResult,
} from '../services/paymentRecoverySweepService'

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export type PaymentRecoveryJobResult =
  | { outcome: 'disabled'; providerModes: readonly [] }
  | ({ outcome: 'completed' } & PaymentRecoverySweepResult)

export async function runPaymentRecoveryJobHandler(
  step: StepRunner,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Omit<
    PaymentRecoverySweepDependencies,
    'webhookHandler'
  > = {},
): Promise<PaymentRecoveryJobResult> {
  const providerModes = parsePaymentRecoveryProviderModes(environment)
  if (providerModes.length === 0) {
    return { outcome: 'disabled', providerModes: [] }
  }
  const recovered = await step.run('recover-payment-obligations', () =>
    runPaymentRecoverySweep({ providerModes }, {
      ...dependencies,
      webhookHandler: paymentWebhookLaunchHandler,
      fulfillSubscriptionCycle:
        dependencies.fulfillSubscriptionCycle ??
        fulfillSubscriptionCycleProviderObservationWithCommercialAnalytics,
      recoverCharge:
        dependencies.recoverCharge ??
        recoverChargeFulfillmentWithCommercialAnalytics,
    }),
  )
  return { outcome: 'completed', ...recovered }
}

export const paymentRecoveryJob = inngest.createFunction(
  {
    id: 'payment-recovery-sweep',
    name: 'Payments: bounded recovery sweep',
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => runPaymentRecoveryJobHandler(step as StepRunner),
)

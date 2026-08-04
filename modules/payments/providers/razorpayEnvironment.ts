import { z } from 'zod'
import type { ProviderMode } from '../types/catalog'

type EnvironmentSource = Readonly<Record<string, string | undefined>>

export const RAZORPAY_ENVIRONMENT_VARIABLES = {
  test: {
    keyId: 'RAZORPAY_TEST_KEY_ID',
    keySecret: 'RAZORPAY_TEST_KEY_SECRET',
    webhookSecret: 'RAZORPAY_TEST_WEBHOOK_SECRET',
    previousWebhookSecret: 'RAZORPAY_TEST_WEBHOOK_PREVIOUS_SECRET',
  },
  live: {
    keyId: 'RAZORPAY_LIVE_KEY_ID',
    keySecret: 'RAZORPAY_LIVE_KEY_SECRET',
    webhookSecret: 'RAZORPAY_LIVE_WEBHOOK_SECRET',
    previousWebhookSecret: 'RAZORPAY_LIVE_WEBHOOK_PREVIOUS_SECRET',
  },
} as const

export interface RazorpayApiCredentials {
  providerMode: ProviderMode
  keyId: string
  keySecret: string
}

export interface RazorpayWebhookSigningSecret {
  version: 'current' | 'previous'
  value: string
}

export class RazorpayConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RazorpayConfigurationError'
  }
}

const RequiredSecretSchema = z.string().trim().min(1).max(4096)
const WebhookSecretSchema = z.string().trim().min(8).max(4096)

function requireEnvironmentValue(
  environment: EnvironmentSource,
  variableName: string,
): string {
  const parsed = RequiredSecretSchema.safeParse(environment[variableName])
  if (!parsed.success) {
    throw new RazorpayConfigurationError(
      `Missing or invalid Razorpay environment variable: ${variableName}`,
    )
  }
  return parsed.data
}

function validateModeKeyId(mode: ProviderMode, keyId: string): void {
  const expectedPrefix = mode === 'test' ? 'rzp_test_' : 'rzp_live_'
  if (!keyId.startsWith(expectedPrefix)) {
    throw new RazorpayConfigurationError(
      `Razorpay ${mode} key id must start with ${expectedPrefix}`,
    )
  }
}

/**
 * Lazy server-only credential lookup. Importing this module never requires
 * payment secrets, so builds and all-off deployments remain inert.
 */
export function loadRazorpayApiCredentials(
  mode: ProviderMode,
  environment: EnvironmentSource = process.env,
): RazorpayApiCredentials {
  const variableNames = RAZORPAY_ENVIRONMENT_VARIABLES[mode]
  const keyId = requireEnvironmentValue(environment, variableNames.keyId)
  validateModeKeyId(mode, keyId)
  const keySecret = requireEnvironmentValue(
    environment,
    variableNames.keySecret,
  )
  return {
    providerMode: mode,
    keyId,
    keySecret,
  }
}

/**
 * Returns current and optional previous webhook secrets. Keeping the prior
 * secret available permits verification of Razorpay retries sent after a
 * secret rotation.
 */
export function loadRazorpayWebhookSigningSecrets(
  mode: ProviderMode,
  environment: EnvironmentSource = process.env,
): RazorpayWebhookSigningSecret[] {
  const variableNames = RAZORPAY_ENVIRONMENT_VARIABLES[mode]
  const currentResult = WebhookSecretSchema.safeParse(
    environment[variableNames.webhookSecret],
  )
  if (!currentResult.success) {
    throw new RazorpayConfigurationError(
      `Missing or invalid Razorpay environment variable: ${variableNames.webhookSecret}`,
    )
  }

  const secrets: RazorpayWebhookSigningSecret[] = [{
    version: 'current',
    value: currentResult.data,
  }]
  const previousValue = environment[variableNames.previousWebhookSecret]
  if (previousValue !== undefined && previousValue.trim() !== '') {
    const previousResult = WebhookSecretSchema.safeParse(previousValue)
    if (!previousResult.success) {
      throw new RazorpayConfigurationError(
        `Invalid Razorpay environment variable: ${variableNames.previousWebhookSecret}`,
      )
    }
    if (previousResult.data === currentResult.data) {
      throw new RazorpayConfigurationError(
        'Current and previous Razorpay webhook secrets must differ',
      )
    }
    secrets.push({
      version: 'previous',
      value: previousResult.data,
    })
  }
  return secrets
}

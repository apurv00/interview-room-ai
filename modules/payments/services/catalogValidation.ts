import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import type { CatalogContent } from '../types/catalog'
import { CatalogContentSchema } from '../validators/catalog'

export interface CatalogValidationResult {
  valid: boolean
  content?: CatalogContent
  contentHash?: string
  errors: string[]
  warnings: string[]
}

export function buildInitialCatalogContent(): CatalogContent {
  const source = CONSUMER_CATALOG_V1
  return {
    schemaVersion: source.schemaVersion,
    entitlementPolicyVersion: source.entitlementPolicyVersion,
    currency: source.currency,
    gstInclusive: source.gstInclusive,
    gstRatePercent: source.gstRatePercent,
    plans: {
      free: {
        ...source.plans.free,
        interview: {
          ...source.plans.free.interview,
          supportedDurationsMinutes: [
            ...source.plans.free.interview.supportedDurationsMinutes,
          ],
        },
        resume: { ...source.plans.free.resume },
      },
      plus: {
        ...source.plans.plus,
        interview: {
          ...source.plans.plus.interview,
          supportedDurationsMinutes: [
            ...source.plans.plus.interview.supportedDurationsMinutes,
          ],
        },
        resume: { ...source.plans.plus.resume },
        razorpayPlanIdByMode: {},
      },
      pro: {
        ...source.plans.pro,
        interview: {
          ...source.plans.pro.interview,
          supportedDurationsMinutes: [
            ...source.plans.pro.interview.supportedDurationsMinutes,
          ],
        },
        resume: { ...source.plans.pro.resume },
        razorpayPlanIdByMode: {},
      },
    },
    oneTimeProducts: {
      single_interview: {
        ...source.oneTimeProducts.single_interview,
        entitlement: {
          ...source.oneTimeProducts.single_interview.entitlement,
          supportedDurationsMinutes: [
            ...source.oneTimeProducts.single_interview.entitlement
              .supportedDurationsMinutes,
          ],
        },
      },
      premium_resume: {
        ...source.oneTimeProducts.premium_resume,
        entitlement: {
          ...source.oneTimeProducts.premium_resume.entitlement,
        },
      },
    },
    existingSubscriptionTreatment: 'grandfather',
  }
}

export function validateCatalogContent(
  input: unknown,
): CatalogValidationResult {
  const parsed = CatalogContentSchema.safeParse(input)
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'catalog'}: ${issue.message}`,
      ),
      warnings: [],
    }
  }

  const content = parsed.data as CatalogContent
  const warnings: string[] = []
  for (const planKey of ['plus', 'pro'] as const) {
    const binding = content.plans[planKey].razorpayPlanIdByMode
    if (!binding?.test) {
      warnings.push(`${planKey}.razorpayPlanIdByMode.test is not configured`)
    }
    if (!binding?.live) {
      warnings.push(`${planKey}.razorpayPlanIdByMode.live is not configured`)
    }
  }

  return {
    valid: true,
    content,
    contentHash: sha256CanonicalJson(content),
    errors: [],
    warnings,
  }
}

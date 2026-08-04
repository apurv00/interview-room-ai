/**
 * Client-safe PR7 rollout switches.
 *
 * Server mutation and checkout services retain their own independent
 * readiness gates. These flags only allow customer surfaces and resume
 * enforcement wiring to invoke those dark primitives; changing mutable CMS
 * state alone can never activate them.
 */
export const PR7_INTERVIEW_PREFLIGHT_UI_READY = false as const
export const PR7A_SAVED_RESUME_COLLECTION_READY = false as const
export const PR7_RESUME_DELETION_GUARD_READY = false as const
export const PR7_RESUME_ENTITLEMENT_STATE_READY = false as const
export const PR7_RESUME_EXPORT_ENFORCEMENT_APPROVED = false as const

export interface ResumeCommercialRolloutPrerequisites {
  collectionReady: boolean
  deletionGuardReady: boolean
  entitlementStateReady: boolean
}

export function resumeCommercialRolloutPrerequisitesReady(
  prerequisites: ResumeCommercialRolloutPrerequisites,
): boolean {
  return (
    prerequisites.collectionReady === true &&
    prerequisites.deletionGuardReady === true &&
    prerequisites.entitlementStateReady === true
  )
}

export function resumeExportEnforcementPrerequisitesReady(
  prerequisites: ResumeCommercialRolloutPrerequisites & {
    enforcementApproved: boolean
  },
): boolean {
  return (
    prerequisites.enforcementApproved === true &&
    resumeCommercialRolloutPrerequisitesReady(prerequisites)
  )
}

// These aggregate switches also remain literal false. The prerequisite
// helpers above support explicit rollout review, but satisfying mutable or
// constituent state must never activate a customer-facing commercial path.
export const PR7_PREMIUM_RESUME_SALE_READY = false as const
export const PR7_RESUME_EXPORT_ENFORCEMENT_READY = false as const

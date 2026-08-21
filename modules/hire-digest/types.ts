/**
 * Phase 5 Hire-member operational digest contracts.
 *
 * These payloads are deliberately aggregate-only: no candidate identity,
 * contact data, score, evidence, capability, report link, or decision note
 * may cross the email boundary.
 */

export const HIRE_DIGEST_OUTBOX_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const

export type HireDigestOutboxStatus = (typeof HIRE_DIGEST_OUTBOX_STATUSES)[number]

export const HIRE_DIGEST_MAX_ATTEMPTS = 5
export const HIRE_DIGEST_CLAIM_LEASE_MS = 5 * 60_000
export const HIRE_DIGEST_RECOVERY_LIMIT_PER_WORKSPACE = 25

/** UTC date by policy; workspace-local time is not inferred without an IANA zone. */
export const HIRE_DIGEST_PERIOD_KEY = /^\d{4}-\d{2}-\d{2}$/

export interface HireDigestPayload {
  workspaceName: string
  generatedAt: Date
  openJobs: number
  awaitingDecision: number
  pendingScorecards: number
  terminalKitDeliveryFailures: number
  /** Latest per-session observation timelines with events or insufficient signal. */
  /** Absent only on legacy pending outboxes created before this aggregate existed. */
  validationAttentionInterviews?: number
}

export interface HireDigestMemberView {
  enabled: boolean
  updatedAt: Date | null
}

export interface HireDigestOutboxMemberView {
  id: string
  periodKey: string
  status: HireDigestOutboxStatus
  sentAt: Date | null
}

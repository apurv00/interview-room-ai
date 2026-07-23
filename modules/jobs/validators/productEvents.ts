import { z } from 'zod'

/**
 * Product-event vocabulary (PRODUCT_FLOW.md §2) — a CLOSED enum, same
 * auditability discipline as the LLM verdict reason codes: free-form event
 * names rot into unqueryable telemetry. Adding an event = adding it here.
 */
export const PRODUCT_EVENT_NAMES = [
  'identity_aliased',
  'jobs.feed_viewed',
  'jobs.resume_attach_started',
  'jobs.resume_attach_completed',
  'jobs.target_role_confirmed',
  'jobs.signup_completed',
  'jobs.job_viewed',
  'jobs.job_saved',
  'jobs.apply_click',
  'jobs.apply_confirmed',
  'jobs.broken_link',
  'jobs.status_changed',
  'jobs.ghost_suggested',
  'jobs.ghost_confirmed',
  'jobs.ghost_auto',
  'jobs.interview_scheduled',
  'jobs.prep_handoff_started',
  'jobs.prep_started',
  'jobs.prep_deferred_email',
  'jobs.outcome_reported',
  'jobs.tailor_run',
  'jobs.quickwins_viewed',
  'jobs.quickwins_clicked',
  'jobs.ats_score_landed',
  'jobs.wizard_started',
  'jobs.wizard_completed',
] as const

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number]

/**
 * Events accepted from browser keepalive capture. Everything else in the
 * closed vocabulary is server/worker-owned and must be written at its
 * authoritative mutation point.
 */
export const BROWSER_PRODUCT_EVENT_NAMES = [
  'jobs.feed_viewed',
  'jobs.resume_attach_started',
  'jobs.resume_attach_completed',
  'jobs.target_role_confirmed',
  'jobs.job_viewed',
  'jobs.prep_handoff_started',
] as const satisfies readonly ProductEventName[]

const objectIdString = z.string().regex(/^[0-9a-f]{24}$/i)

/**
 * Public browser-capture contract. Application/session identifiers and
 * server-semantic events are intentionally unavailable on this boundary.
 */
export const ProductEventInputSchema = z.object({
  name: z.enum(BROWSER_PRODUCT_EVENT_NAMES),
  jobPostingId: objectIdString.optional(),
  // Bounded free-form props — no PII by convention; server stamps identity.
  props: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
}).strict()

export type ProductEventInput = z.infer<typeof ProductEventInputSchema>

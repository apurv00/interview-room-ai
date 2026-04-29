/**
 * Typed event registry — the single source of truth for every event we
 * emit through `track()`.
 *
 * Every event the app fires MUST be listed here with its property shape.
 * The registered shape becomes the compile-time contract for `track()`:
 * unknown event names and wrong-shape properties fail typecheck.
 *
 * ──────────────────────────────────────────────────────────────────
 *  PII rule (enforced by review + the events.test.ts shape audit)
 * ──────────────────────────────────────────────────────────────────
 * NEVER add `email`, `name`, `firstName`, `lastName`, `phone`, `image`,
 * `ip`, `address`, `dob`, or any free-text user-supplied identifier as
 * a property key. Both PostHog and GA receive these payloads; we
 * cannot ingest PII into product analytics. If you need to associate
 * a user, use `identify(userId, traits)` — `userId` is the *only*
 * identifier that crosses the boundary, and `UserTraits` (below) is
 * the closed enum of safe properties.
 *
 * ──────────────────────────────────────────────────────────────────
 *  Migration — adding a new event
 * ──────────────────────────────────────────────────────────────────
 * 1. Add the snake_case name to `EVENT_NAMES`.
 * 2. Add the property shape to `EventPropsMap`.
 * 3. Call site: `track('your_event', { ...props })`. TS will flag
 *    typos and shape mismatches at the call site.
 */

export const EVENT_NAMES = {
  // ── Marketing / acquisition ────────────────────────────────────
  cta_clicked: 'cta_clicked',
  page_view: 'page_view',
  waitlist_joined: 'waitlist_joined',

  // ── Auth funnel ────────────────────────────────────────────────
  auth_gate_opened: 'auth_gate_opened',
  auth_completed: 'auth_completed',
  signin_succeeded: 'signin_succeeded',

  // ── Interview lobby ────────────────────────────────────────────
  lobby_ready: 'lobby_ready',
  lobby_check_failed: 'lobby_check_failed',
  interview_join_clicked: 'interview_join_clicked',

  // ── Post-interview / value capture ─────────────────────────────
  resume_downloaded: 'resume_downloaded',
  analysis_completed: 'analysis_completed',

  // ── Diagnostic (not a funnel — kept for debuggability) ─────────
  audio_worklet_loaded: 'audio_worklet_loaded',
} as const

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES]

/**
 * Per-event property shape. The shape registered here is exactly what
 * `track('eventName', props)` will accept at the call site.
 *
 * Keep keys lowercase_snake_case to match GA4's parameter conventions.
 */
export interface EventPropsMap {
  // Marketing / acquisition
  cta_clicked: { cta: string; location: string }
  page_view: { pathname: string }
  waitlist_joined: { source: string }

  // Auth funnel
  auth_gate_opened: { reason: string }
  auth_completed: { had_pending_action: boolean }
  /**
   * Fired exactly once when an unauthenticated session transitions to
   * authenticated. Distinct from `auth_completed` (which only fires
   * when the modal-opened-with-pending-action path resolves).
   */
  signin_succeeded: { had_prior_session: boolean }

  // Interview lobby
  lobby_ready: { degraded: boolean }
  lobby_check_failed: { failed: string[] }
  interview_join_clicked: { degraded: boolean }

  // Post-interview / value capture
  resume_downloaded: { template: string; file_type: 'pdf' }
  analysis_completed: { session_id: string; poll_duration_ms?: number }

  // Diagnostic
  audio_worklet_loaded: {
    success: boolean
    durationMs: number
    error?: string
    stale?: boolean
  }
}

/** Compile-time guard: every `EventName` must have a `EventPropsMap` entry. */
type _AssertEventMapCovers = {
  [K in EventName]: EventPropsMap[K]
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Assertion = _AssertEventMapCovers

export type EventProps<E extends EventName> = EventPropsMap[E]

/**
 * Closed enum of user properties safe to attach to `identify()`.
 *
 * These are the non-PII fields surfaced on `session.user` (see
 * `shared/auth/next-auth.d.ts`). PII fields (`id`, `email`, `name`,
 * `image`) are intentionally excluded — `userId` is passed as the
 * first arg to `identify()`, not as a trait.
 */
export interface UserTraits {
  plan?: 'free' | 'pro' | 'enterprise'
  role?: 'candidate' | 'recruiter' | 'org_admin' | 'platform_admin'
  organizationId?: string
  onboardingCompleted?: boolean
}

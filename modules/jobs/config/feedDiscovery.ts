/**
 * Public Jobs discovery contract. These values are intentionally client-safe:
 * users may keep, reload, and share them in `/jobs` URLs. Resume-derived role
 * and skill signals are a separate POST-only concern and never belong here.
 */

export const FEED_REMOTE_VALUES = ['remote'] as const
export const FEED_EXPERIENCE_VALUES = ['entry', 'mid', 'senior'] as const
export const FEED_FRESHNESS_VALUES = ['1d', '3d', '7d', '14d', '30d'] as const
export const FEED_SORT_VALUES = ['best', 'newest'] as const
export const FEED_CURSOR_DIRECTIONS = ['after', 'before'] as const
/** Founder P-2: anonymous cards remain browsable but not infinitely enumerable. */
export const FEED_RESULT_CAP = 400

export type FeedRemote = (typeof FEED_REMOTE_VALUES)[number]
export type FeedExperience = (typeof FEED_EXPERIENCE_VALUES)[number]
export type FeedFreshness = (typeof FEED_FRESHNESS_VALUES)[number]
export type FeedSort = (typeof FEED_SORT_VALUES)[number]
export type FeedCursorDirection = (typeof FEED_CURSOR_DIRECTIONS)[number]

export interface PublicFeedQuery {
  /** Legacy press-link taxonomy filter. Search is the primary user control. */
  domain?: string
  /** Public, shareable role/title/company query. */
  search?: string
  /** A normalized soft preference: it changes rank, never result inclusion. */
  location?: string
  /** Explicit hard work-mode filter over the stored deterministic field. */
  remote?: FeedRemote
  /** Deterministic title-based preference: it changes rank, never inclusion. */
  experience?: FeedExperience
  /** Public employer-name filter. */
  company?: string
  /** Explicit hard date-posted window. */
  freshness?: FeedFreshness
  sort?: FeedSort
  cursor?: string
  direction?: FeedCursorDirection
}

export const FEED_FRESHNESS_DAYS: Record<FeedFreshness, number> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '30d': 30,
}

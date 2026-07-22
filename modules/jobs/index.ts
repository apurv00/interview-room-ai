/**
 * @jobs barrel — the ONLY entry point other modules/app may import from.
 * Phase A1 surface: pure identity + quality-gate layers and the config
 * constants. Adapters, pipeline, and the LLM verdict layer land in later
 * phases (INGESTION.md §6 Phase 1 build order).
 */
export {
  companyKey, titleKey, titleTokens, locationKey, fingerprintOf, sourceKeyOf,
  isConfidentialCompany, titleJaccard, FUZZY_MERGE_JACCARD,
} from './services/identityResolver'
export {
  classifyJob, classifyApplyUrl, isBlockedApplyUrl, bestUsableTier,
  isStaffingOrg, normalizeJdBody, bodyHashOf, validThroughDate,
} from './services/qualityGate'
export type { ClassifyInput, ClassifyResult, DropRule, FlagRule } from './services/qualityGate'
export { METROS, METRO_ALIASES } from './config/metros'
export {
  JOB_DOMAINS, JOB_DOMAIN_IDS, FRESHER_DOMAINS, FRESHER_DOMAIN_PATTERNS, matchFresherDomain, interviewSlugForDomain, roleToJobsDomain,
} from './config/domains'
export type { JobDomainId } from './config/domains'
export {
  FEED_CURSOR_DIRECTIONS,
  FEED_RESULT_CAP,
  FEED_EXPERIENCE_VALUES,
  FEED_FRESHNESS_DAYS,
  FEED_FRESHNESS_VALUES,
  FEED_REMOTE_VALUES,
  FEED_SORT_VALUES,
} from './config/feedDiscovery'
export type {
  FeedCursorDirection,
  FeedExperience,
  FeedFreshness,
  FeedRemote,
  FeedSort,
  PublicFeedQuery,
} from './config/feedDiscovery'
export { APPLY_TIERS, TIER_RANK } from './config/spamRules'
export type { ApplyTier } from './config/spamRules'
export { PRODUCT_EVENT_NAMES, ProductEventInputSchema } from './validators/productEvents'
export type { ProductEventName, ProductEventInput } from './validators/productEvents'
export { ANON_COOKIE, ANON_COOKIE_MAX_AGE, mintAnonCookie, verifyAnonCookie, anonIdFromCookieHeader } from './services/anonCookie'
export { stitchAnonEventsToUser } from './services/identityStitch'
export { jsearchAdapter } from './adapters/jsearchAdapter'
export type { FetchTarget, FetchResult, NormalizedJob, JobSourceAdapter } from './adapters/types'
export { buildHarvestBuckets } from './config/bucketMatrix'
export { ingestBatch, mergeIntoDoc, evictProvenance, makeRedisRepostCounter } from './services/ingestPipeline'
export type { IngestCounters, RepostCounterDeps } from './services/ingestPipeline'
export { atsBoardAdapter } from './adapters/atsBoardAdapter'
export { BOARD_REGISTRY } from './config/boardRegistry'
export type { BoardSeed } from './config/boardRegistry'
export { getFeed, getJobDetail, bestApplyTierOf, isSafeHttpUrl } from './services/feedService'
export { InvalidFeedCursorError } from './services/feedDiscovery'
export {
  applyOptionIdOf,
  canonicalApplyOptionsOf,
  isApplyOptionId,
  parseApplyOptionMutation,
  resolveApplyOption,
} from './services/applyOptionIdentity'
export type { CanonicalApplyOption } from './services/applyOptionIdentity'
export { recordApplyClick, recordApplyOpenAttempt, claimAtsRun, releaseAtsClaim, transitionStatus, reportBrokenLink, recordPracticeEvidence, saveTailoredVersion, getTailoredVersion, USER_SETTABLE_STATUSES } from './services/applicationService'
export type { ApplyClickResult, BrokenLinkResult, UserSettableStatus } from './services/applicationService'
export { getOrParseXray } from './services/xrayService'
export { preparePracticeHandoffPosting } from './services/practiceHandoff'
export { jobPostingStateOf } from './services/postingAccess'
export type { JobPostingState } from './services/postingAccess'
export { saveBaseResume, getBaseResume } from './services/baseResumeService'
export { getTracker, dismissConfirmCard, saveNotes, GHOST_AFTER_DAYS } from './services/trackerService'
export { buildPrepPlan, dateForChoice, setInterviewDate } from './services/prepPlanService'
export type { InterviewDateCapture, InterviewDatePreference, PrepPlan, PrepPlanSession } from './services/prepPlanService'
export type { FeedQuery, FeedCard, FeedPayload, JobDetailShell, JobDetailFull } from './services/feedService'
export { isSuppressed, buildFooterUrls, sendTransactional } from './services/emailSendService'
export type { TailoredVersionView, TransitionTelemetry } from './services/applicationService'

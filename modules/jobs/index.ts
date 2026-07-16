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
  isStaffingOrg, normalizeJdBody, bodyHashOf,
} from './services/qualityGate'
export type { ClassifyInput, ClassifyResult, DropRule, FlagRule } from './services/qualityGate'
export { METROS, METRO_ALIASES } from './config/metros'
export {
  JOB_DOMAINS, JOB_DOMAIN_IDS, FRESHER_DOMAINS, FRESHER_DOMAIN_PATTERNS, matchFresherDomain, interviewSlugForDomain, roleToJobsDomain,
} from './config/domains'
export type { JobDomainId } from './config/domains'
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
export { getFeed, getJobDetail, tierAScore, bestApplyTierOf, isSafeHttpUrl } from './services/feedService'
export { recordApplyClick, claimAtsRun, releaseAtsClaim, transitionStatus, reportBrokenLink, recordPracticeEvidence, saveTailoredVersion, USER_SETTABLE_STATUSES } from './services/applicationService'
export type { UserSettableStatus } from './services/applicationService'
export { getOrParseXray } from './services/xrayService'
export { saveBaseResume, getBaseResume } from './services/baseResumeService'
export { getTracker, dismissConfirmCard, saveNotes, GHOST_AFTER_DAYS } from './services/trackerService'
export { buildPrepPlan, dateForChoice, setInterviewDate } from './services/prepPlanService'
export type { PrepPlan, PrepPlanSession } from './services/prepPlanService'
export type { FeedQuery, FeedCard, JobDetailShell, JobDetailFull } from './services/feedService'
export { isSuppressed, buildFooterUrls, sendTransactional } from './services/emailSendService'
export type { TransitionTelemetry } from './services/applicationService'

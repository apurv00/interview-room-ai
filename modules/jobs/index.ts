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
  JOB_DOMAINS, JOB_DOMAIN_IDS, FRESHER_DOMAINS, FRESHER_DOMAIN_PATTERNS, matchFresherDomain,
} from './config/domains'
export type { JobDomainId } from './config/domains'
export { APPLY_TIERS, TIER_RANK } from './config/spamRules'
export type { ApplyTier } from './config/spamRules'

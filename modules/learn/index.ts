// ── Services ──
export { getCompetenciesForDomain, updateCompetencyState, getUserCompetencySummary, updateWeaknessClusters, getUserWeaknesses, UNIVERSAL_COMPETENCIES, DOMAIN_COMPETENCIES } from './services/competencyService'
export type { CompetencySummary } from './services/competencyService'
export { generatePathwayPlan, getCurrentPathway, markTaskComplete } from './services/pathwayPlanner'
export { generateSessionSummary, getRecentSummaries, buildHistorySummary } from './services/sessionSummaryService'
export { calculateNextReview, scoreToQuality, updateAfterSession, getDueCompetencies } from './services/spacedRepetitionService'
export type { DueCompetency, ReviewUrgency } from './services/spacedRepetitionService'

// ── Lib ──
export { computePercentile } from './lib/peerComparison'
export { RESOURCES, getResourceBySlug, getResourcesByCategory, getAllSlugs, calculateRelevance, getPersonalizedResources } from './lib/resources'
export type { Resource, UserProfile } from './lib/resources'

// ── Components ──
export { default as ResourceLinks } from './components/ResourceLinks'

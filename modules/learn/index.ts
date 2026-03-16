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

// ── Drill ──
export { getWeakQuestions, saveDrillAttempt, getDrillHistory } from './services/drillService'
export type { WeakQuestion, DrillResult, DrillHistoryEntry } from './services/drillService'

// ── Analytics ──
export { getAnalyticsData } from './services/analyticsService'
export type { AnalyticsData } from './services/analyticsService'

// ── Benchmarking ──
export { getPeerBenchmark } from './services/benchmarkService'
export type { BenchmarkResult } from './services/benchmarkService'

// ── Email ──
export { processEmailBatch, buildDigestContent, sendInactivityNudge } from './services/emailTriggerService'

// ── Comparison ──
export { computeComparison } from './services/comparisonService'
export type { ComparisonResult, DimensionDelta } from './services/comparisonService'

// ── Components ──
export { default as ResourceLinks } from './components/ResourceLinks'
export { default as ComparisonCard } from './components/feedback/ComparisonCard'
export { default as ShareButton } from './components/feedback/ShareButton'

// ── XP ──
export { awardXp, getXpSummary, getXpHistory } from './services/xpService'
export type { XpAwardResult, XpSummary } from './services/xpService'
export { calculateLevel, XP_AMOUNTS, LEVEL_TITLES } from './config/xpTable'

// ── Badges ──
export { checkAndAwardBadges, getUserBadges, getUnnotifiedBadges, markBadgeNotified } from './services/badgeService'
export type { AwardedBadge, BadgeTrigger } from './services/badgeService'
export { BADGE_DEFINITIONS, getBadgesByTrigger, getBadgeById } from './config/badges'

// ── Streak v2 ──
export { recordActivity, updateStreak, getStreakCalendar, getStreakLeaderboard, refreshWeeklyFreeze } from './services/streakService'

// ── Daily Challenge ──
export { getTodaysChallenge, submitChallengeAnswer, getUserChallengeHistory, getChallengeLeaderboard, hasUserCompletedToday } from './services/dailyChallengeService'

// ── Share ──
export { generateShareToken, getPublicScorecard, revokeShareToken } from './services/shareService'
export type { PublicScorecard } from './services/shareService'

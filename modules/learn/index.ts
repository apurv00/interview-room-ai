// ── Services ──
export { getCompetenciesForDomain, updateCompetencyState, getUserCompetencySummary, updateWeaknessClusters, getUserWeaknesses, UNIVERSAL_COMPETENCIES, DOMAIN_COMPETENCIES } from './services/competencyService'
export type { CompetencySummary } from './services/competencyService'
export { updatePracticeStats, deriveStrongWeakDimensions } from './services/practiceStatsService'
export type { UpdatePracticeStatsInput, UpdatePracticeStatsResult } from './services/practiceStatsService'
export { generatePathwayPlan, getCurrentPathway, markTaskComplete, advanceUniversalPlan } from './services/pathwayPlanner'
export { updateMasteryTracking, updateMasteryBatch } from './services/masteryTracker'
export type { MasteryUpdateResult } from './services/masteryTracker'
export { registerPathwayBadgeWiring } from './services/pathwayBadgeWiring'
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
export { default as XpBadge } from './components/XpBadge'
export { default as BadgeUnlockChecker } from './components/BadgeUnlockChecker'
export { default as PathwayStatusBanner } from './components/PathwayStatusBanner'
export { default as NextStepHero } from './components/pathway/NextStepHero'
export { default as RecentSessionsStrip } from './components/pathway/RecentSessionsStrip'
export { default as PhaseProgressCard } from './components/pathway/PhaseProgressCard'
export { default as LessonCard } from './components/pathway/LessonCard'
export { default as UniversalPathwayView } from './components/pathway/UniversalPathwayView'

// ── XP ──
export { awardXp, getXpSummary, getXpHistory } from './services/xpService'
export type { XpAwardResult, XpSummary } from './services/xpService'
export { calculateLevel, XP_AMOUNTS, LEVEL_TITLES } from './config/xpTable'

// ── Badges ──
export { checkAndAwardBadges, getUserBadges, getUnnotifiedBadges, markBadgeNotified } from './services/badgeService'
export type { AwardedBadge, BadgeTrigger } from './services/badgeService'
export { BADGE_DEFINITIONS, getBadgesByTrigger, getBadgeById } from './config/badges'

// ── Streak v2 ──
export { recordActivity, updateStreak, getStreakCalendar, refreshWeeklyFreeze } from './services/streakService'

// ── Daily Challenge ──
export { getTodaysChallenge, submitChallengeAnswer, getUserChallengeHistory, hasUserCompletedToday } from './services/dailyChallengeService'

// ── Share ──
export { generateShareToken, getPublicScorecard, revokeShareToken } from './services/shareService'
export type { PublicScorecard } from './services/shareService'

// ── Daily plan regen (used by monthly scheduled job) ──
export { autoRegeneratePlan } from './services/dailyPlanService'

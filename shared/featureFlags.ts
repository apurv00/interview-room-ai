// ─── Feature Flags (env-based) ───────────────────────────────────────────────
// Simple feature flag system using environment variables.
// Set flags in .env.local: FEATURE_FLAG_PERSONALIZATION_ENGINE=true

export type FeatureFlag =
  | 'personalization_engine'
  | 'evaluation_engine_v2'
  | 'pathway_planner'
  | 'competency_tracking'
  | 'weakness_clusters'
  | 'session_summaries'
  | 'question_bank_rag'
  | 'company_patterns_rag'
  | 'benchmark_harness'
  | 'adaptive_difficulty'
  | 'rubric_registry'
  | 'resume_to_interview'
  | 'jd_structured_parsing'
  | 'interviewer_personas'
  | 'spaced_repetition'
  | 'engagement_xp'
  | 'engagement_badges'
  | 'engagement_streaks_v2'
  | 'engagement_daily_challenge'
  | 'multimodal_analysis'
  | 'company_guides'
  | 'coach_mode'
  | 'live_coding'
  | 'embedding_search'
  | 'monthly_plan'

const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  personalization_engine: true,
  evaluation_engine_v2: true,
  pathway_planner: true,
  competency_tracking: true,
  weakness_clusters: true,
  session_summaries: true,
  question_bank_rag: true,
  company_patterns_rag: true,
  benchmark_harness: false,
  adaptive_difficulty: true,
  rubric_registry: true,
  resume_to_interview: true,
  jd_structured_parsing: true,
  interviewer_personas: true,
  spaced_repetition: true,
  engagement_xp: true,
  engagement_badges: true,
  engagement_streaks_v2: true,
  engagement_daily_challenge: true,
  multimodal_analysis: false,
  company_guides: true,
  coach_mode: false,
  live_coding: false,
  embedding_search: false,
  monthly_plan: true,
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const envKey = `FEATURE_FLAG_${flag.toUpperCase()}`
  const envValue = process.env[envKey]

  if (envValue === 'true' || envValue === '1') return true
  if (envValue === 'false' || envValue === '0') return false

  return FLAG_DEFAULTS[flag]
}

export function getEnabledFlags(): Record<FeatureFlag, boolean> {
  const flags = {} as Record<FeatureFlag, boolean>
  for (const flag of Object.keys(FLAG_DEFAULTS) as FeatureFlag[]) {
    flags[flag] = isFeatureEnabled(flag)
  }
  return flags
}

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
  | 'resume_structured_parsing'
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
  | 'research_comparison'
  | 'session_config_cache'
  | 'interview_flow_templates'
  | 'jd_flow_overlay'
  | 'score_telemetry'
  | 'scoring_v2_overall'
  | 'scoring_v2_aq'

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
  resume_structured_parsing: true,
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
  // Dual-pipeline comparison experiment (#4). When true AND the session
  // owner has opted in via researchDonationConsent, the analysis pipeline
  // runs fusion twice (baseline categorical vs blendshape-enriched) and
  // persists both outputs for offline evaluation.
  research_comparison: false,
  session_config_cache: true,
  // Research-backed interview flow templates. When enabled, generate-question
  // injects structured topic guidance from pre-authored templates keyed by
  // domain × depth × experience. Falls back to current behavior when no
  // template matches (e.g. CMS custom domains).
  interview_flow_templates: true,
  // JD flow overlay — when true, the resolver receives a JDOverlay derived
  // from the parsed job description (promotions + annotations + must-have
  // insertions). Kill-switch scaffolding only; Phase 4 wires this into
  // generate-question. Default off until the wiring lands + rollout staged.
  jd_flow_overlay: false,
  // Score telemetry (Work Item G.1). When true, recordScoreDelta() persists
  // a row per feedback/eval scoring call so we can compare Claude's raw
  // overall_score against the deterministic formula. Read-only side effect,
  // safe to leave on by default. Gates every subsequent scoring-rebalance
  // work item (G.8/G.9/G.10/G.11) — they need this baseline to ship.
  score_telemetry: true,
  // Scoring V2 — Claude-vs-formula overall_score blend (Work Item G.8).
  // When enabled, generate-feedback blends Claude's holistic overall_score
  // with the deterministic aq*0.4 + comm*0.3 + eng*0.3 formula instead of
  // discarding the Claude value. Default OFF — flip on per the rollout
  // plan only after G.1 telemetry confirms the delta distribution looks
  // sane (≥100-session baseline). Tunable weights via
  // SCORING_V2_CLAUDE_WEIGHT / SCORING_V2_FORMULA_WEIGHT /
  // SCORING_V2_DISAGREEMENT_THRESHOLD env vars.
  scoring_v2_overall: false,
  // Scoring V2 — dimension-aware answer_quality aggregate (Work Item G.9).
  // When enabled, generate-feedback computes answer_quality.score as
  //   0.4*mean + 0.3*top3Mean + 0.2*median + 0.1*bottom3Mean
  // over per-question scores, preserving outlier signal. Default OFF —
  // flip on after G.1 telemetry shows the answer_quality distribution
  // has tightened around 65-75 on flat-mean (i.e. confirms the spread
  // problem G.9 solves is present in prod). Independent of G.8; either
  // can be enabled without the other.
  scoring_v2_aq: false,
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

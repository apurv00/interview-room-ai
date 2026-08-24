// ─── Task Slots & Defaults ──────────────────────────────────────────────────
// Pure constants — no mongoose dependency. Safe to import from client code.
// (The ReasoningEffort import below is type-only — erased at compile time,
// so no provider SDK code reaches client bundles.)

import type { ReasoningEffort } from './providers/index'

export const TASK_SLOTS = [
  // Interview
  'interview.generate-question',
  'interview.evaluate-answer',
  'interview.generate-feedback',
  'interview.evaluate-code',
  'interview.evaluate-design',
  'interview.clarify-coding',
  'interview.coding-problem-gen',
  'interview.code-run',
  'interview.coach-notes',
  'interview.jd-extract',
  'interview.fusion-analysis',
  // Resume
  'resume.enhance-section',
  'resume.enhance-bullets',
  'resume.generate-full',
  'resume.ats-check',
  'resume.tailor',
  'resume.parse',
  'resume.gap-analysis',
  'resume.wizard-followup',
  'resume.wizard-enrich',
  // Learn
  'learn.pathway-plan',
  'learn.pathway-lesson',
  'learn.daily-challenge-gen',
  'learn.daily-challenge-score',
  'learn.drill-evaluate',
  // Onboarding
  'onboarding.extract-profile',
  // Evaluation Engine V2
  'interview.evaluation-engine-v2',
  // Conversational — answering candidate's proactive questions
  'interview.answer-candidate-question',
  // Conversational — case-study/system-design scoping assumptions
  'interview.clarify-case-context',
  // Fast turn router — probe-vs-advance decision in the critical conversation path
  'interview.turn-router',
  // Jobs — async posting verdict (INGESTION §4.5 layer 2)
  'jobs.evaluate-posting',
  'jobs.evidence-attribution',
  // Hire — resume intake: identity extraction + JD-match in one call per CV
  'hire.resume-intake',
  // Hire — post-interview recorded video/audio/facial review. This is a
  // recruiter report only; it is deliberately separate from consumer coaching
  // and never writes a hiring decision or score.
  'hire.multimodal-analysis',
] as const

export type TaskSlot = (typeof TASK_SLOTS)[number]

export const TASK_SLOT_DEFAULTS: Record<
  TaskSlot,
  {
    model: string
    maxTokens: number
    provider: string
    fallbackModel?: string
    fallbackProvider?: string
    reasoningEffort?: ReasoningEffort
  }
> = {
  // ── reasoningEffort tiers (GPT-5.6 slots; decision 2026-07-11) ──
  // Judgment tasks that are async or latency-tolerant run HIGH now; if
  // score telemetry (/cms/score-telemetry) shows drift or truncation,
  // dial individual slots back to medium via a CMS ModelConfig row —
  // no deploy needed. In-interview generation runs medium/low to stay
  // inside client timeouts (evaluate-answer has a 5s client abort).
  // Real-time conversational slots + the streaming drill run NONE:
  // reasoning happens BEFORE the first output/stream token, so there it
  // is pure dead air. Reasoning tokens bill against max_completion_tokens,
  // so every slot with effort also got budget headroom sized ~3× the
  // live-measured spend (evaluate shape: 64 tokens @high; question
  // shape: 158 @high) — an undersized budget truncates the JSON, which
  // is the G.2/G.6 failure class.
  'interview.generate-question':    { model: 'gpt-5.6-luna', maxTokens: 800, provider: 'openai', reasoningEffort: 'medium' },
  'interview.evaluate-answer':      { model: 'gpt-5.6-luna', maxTokens: 500, provider: 'openai', reasoningEffort: 'low' },
  'interview.generate-feedback':    { model: 'gpt-5.6-luna', maxTokens: 7000, provider: 'openai', reasoningEffort: 'high' },
  // maxTokens headroom sized for the grounded_followups fields: truncated JSON
  // here 502s the route and converts the MAIN submission eval into a 'failed'
  // row excluded from aggregation — the added output must never cause that.
  'interview.evaluate-code':        { model: 'gpt-5.6-luna', maxTokens: 2400, provider: 'openai', reasoningEffort: 'high' },
  'interview.evaluate-design':      { model: 'gpt-5.6-luna', maxTokens: 2800, provider: 'openai', reasoningEffort: 'high' },
  'interview.clarify-coding':       { model: 'gpt-5.6-luna', maxTokens: 500, provider: 'openai', reasoningEffort: 'low' },
  'interview.coding-problem-gen':   { model: 'gpt-5.6-luna', maxTokens: 2600, provider: 'openai', reasoningEffort: 'medium' },
  'interview.code-run':             { model: 'gpt-5.6-luna', maxTokens: 3000, provider: 'openai', reasoningEffort: 'low' },
  'interview.coach-notes':          { model: 'gpt-5.6-luna', maxTokens: 500, provider: 'openai', reasoningEffort: 'none' },
  'interview.jd-extract':           { model: 'gpt-5.6-luna', maxTokens: 2500, provider: 'openai', reasoningEffort: 'low' },
  // Fusion is structured signal-merging, not judgment, and never used
  // reasoning pre-cutover (gpt-5.4-mini, no effort field): 'high' blew the 30s
  // fusion timeout on most runs (prod incident 2026-07-11→17) and its
  // reasoning preamble broke the strict JSON parse. 'none' + the pre-cutover
  // 3000 cap restore the proven latency envelope (3600 existed only as
  // reasoning-token headroom — OpenAI counts them against max output).
  'interview.fusion-analysis':      { model: 'gpt-5.6-luna', maxTokens: 3000, provider: 'openai', reasoningEffort: 'none' },
  'resume.enhance-section':         { model: 'claude-sonnet-4-6', maxTokens: 1000, provider: 'anthropic' },
  'resume.enhance-bullets':         { model: 'claude-sonnet-4-6', maxTokens: 1000, provider: 'anthropic' },
  'resume.generate-full':           { model: 'claude-sonnet-4-6', maxTokens: 3000, provider: 'anthropic' },
  'resume.ats-check':               { model: 'claude-sonnet-4-6', maxTokens: 2000, provider: 'anthropic' },
  // 8000: the tailor output contains the FULL rewritten resume plus the
  // change list — 3000 truncated the JSON for normal 2-page resumes.
  // DEPLOY PRECONDITION: these are DEFAULTS. An active CMS ModelConfig row for
  // resume.tailor / resume.parse overrides them (modelRouter prefers the CMS
  // slot). A stale row at the OLD 3000/3000 silently defeats the bump — every
  // tailor/parse then truncates on attempt 1 and reruns at the retry budget
  // (double spend, ~2x latency, no error). Before/after deploy, verify the CMS
  // rows for resume.tailor (>=8000), resume.parse (>=6000), resume.ats-check
  // (>=2000, retry raises to 6000) match or exceed these, or delete the rows.
  'resume.tailor':                   { model: 'claude-sonnet-4-6', maxTokens: 8000, provider: 'anthropic' },
  // 6000: a dense multi-page resume's structured JSON exceeded the old 3000
  // and the truncated output failed JSON.parse — losing the whole import.
  'resume.parse':                    { model: 'claude-sonnet-4-6', maxTokens: 6000, provider: 'anthropic' },
  'resume.gap-analysis':            { model: 'claude-sonnet-4-6', maxTokens: 2000, provider: 'anthropic' },
  'resume.wizard-followup':         { model: 'claude-haiku-4-5', maxTokens: 500, provider: 'anthropic' },
  'resume.wizard-enrich':           { model: 'claude-opus-4-6', maxTokens: 4000, provider: 'anthropic' },
  'learn.pathway-plan':             { model: 'claude-sonnet-4-6', maxTokens: 3000, provider: 'anthropic' },
  'learn.pathway-lesson':           { model: 'claude-haiku-4-5', maxTokens: 900, provider: 'anthropic' },
  'learn.daily-challenge-gen':      { model: 'claude-haiku-4-5', maxTokens: 500, provider: 'anthropic' },
  'learn.daily-challenge-score':    { model: 'claude-sonnet-4-6', maxTokens: 1000, provider: 'anthropic' },
  // Default to OpenAI so the streaming path (provider.stream on openai
  // adapter) engages on merge with no operator action. Anthropic
  // fallback covers OpenAI outages; CMS can override either side.
  // drill-evaluate streams to the UI — reasoning would delay the first
  // visible token (silent head on the stream), so it stays at none.
  'learn.drill-evaluate':           { model: 'gpt-5.6-luna', maxTokens: 1500, provider: 'openai', fallbackModel: 'claude-sonnet-4-6', fallbackProvider: 'anthropic', reasoningEffort: 'none' },
  'onboarding.extract-profile':     { model: 'claude-sonnet-4-6', maxTokens: 2000, provider: 'anthropic' },
  'interview.evaluation-engine-v2': { model: 'gpt-5.6-luna', maxTokens: 2600, provider: 'openai', reasoningEffort: 'high' },
  'interview.answer-candidate-question': { model: 'gpt-5.6-luna', maxTokens: 200, provider: 'openai', reasoningEffort: 'none' },
  'interview.clarify-case-context':       { model: 'gpt-5.6-luna', maxTokens: 400, provider: 'openai', reasoningEffort: 'low' },
  'interview.turn-router':               { model: 'gpt-5.6-luna', maxTokens: 150, provider: 'openai', reasoningEffort: 'none' },
  // Corpus-scaled, not user-scaled — effort 'low' is deliberate (below the
  // judgment=high tier policy); NO fallbackModel: verdict epochs must stay
  // homogeneous, degradation = verdict stays pending (INGESTION §4.5).
  'jobs.evaluate-posting':               { model: 'gpt-5.6-luna', maxTokens: 800, provider: 'openai', reasoningEffort: 'low' },
  // Readiness wave (READINESS.md §1): classification, sized for the
  // 30-answer worst case (the G.3 truncation lesson). Deploy gate: verify
  // no CMS ModelConfig row overrides this (#487 lesson).
  'jobs.evidence-attribution':           { model: 'gpt-5.6-luna', maxTokens: 1400, provider: 'openai', reasoningEffort: 'low' },
  // Hire intake (Phase 2): ONE call per uploaded CV does identity extraction
  // (name/email/phone) + resume-vs-JD match scoring. Volume path — bulk
  // upload fans out per file — so 'medium', not the async-judgment 'high':
  // a 50-CV batch must not burn deep-reasoning tokens per file. Anthropic
  // fallback so a provider outage degrades to slower intake, not lost CVs.
  'hire.resume-intake':                  { model: 'gpt-5.6-luna', maxTokens: 1200, provider: 'openai', fallbackModel: 'claude-sonnet-4-6', fallbackProvider: 'anthropic', reasoningEffort: 'medium' },
  // Structured post-interview signal synthesis. It is asynchronous and
  // bounded JSON, so preserve the proven no-reasoning fusion envelope rather
  // than borrowing the B2C task slot or emitting recruiter-visible prose from
  // an interactive coaching path.
  'hire.multimodal-analysis':             { model: 'gpt-5.6-luna', maxTokens: 3000, provider: 'openai', reasoningEffort: 'none' },
}

// ─── Task Slots & Defaults ──────────────────────────────────────────────────
// Pure constants — no mongoose dependency. Safe to import from client code.

export const TASK_SLOTS = [
  // Interview
  'interview.generate-question',
  'interview.evaluate-answer',
  'interview.generate-feedback',
  'interview.evaluate-code',
  'interview.evaluate-design',
  'interview.clarify-coding',
  'interview.coding-problem-gen',
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
  'learn.daily-challenge-gen',
  'learn.daily-challenge-score',
  'learn.drill-evaluate',
  // B2B
  'b2b.scorecard',
  // Onboarding
  'onboarding.extract-profile',
  // Evaluation Engine V2
  'interview.evaluation-engine-v2',
  // Conversational — answering candidate's proactive questions
  'interview.answer-candidate-question',
] as const

export type TaskSlot = (typeof TASK_SLOTS)[number]

export const TASK_SLOT_DEFAULTS: Record<TaskSlot, { model: string; maxTokens: number; provider: string }> = {
  'interview.generate-question':    { model: 'claude-haiku-4-5-20251001', maxTokens: 300, provider: 'anthropic' },
  'interview.evaluate-answer':      { model: 'claude-haiku-4-5-20251001', maxTokens: 600, provider: 'anthropic' },
  'interview.generate-feedback':    { model: 'claude-sonnet-4-6-20250514', maxTokens: 4000, provider: 'anthropic' },
  'interview.evaluate-code':        { model: 'claude-haiku-4-5-20251001', maxTokens: 1000, provider: 'anthropic' },
  'interview.evaluate-design':      { model: 'claude-haiku-4-5-20251001', maxTokens: 1500, provider: 'anthropic' },
  'interview.clarify-coding':       { model: 'claude-haiku-4-5-20251001', maxTokens: 500, provider: 'anthropic' },
  'interview.coding-problem-gen':   { model: 'claude-haiku-4-5-20251001', maxTokens: 1000, provider: 'anthropic' },
  'interview.coach-notes':          { model: 'claude-haiku-4-5-20251001', maxTokens: 500, provider: 'anthropic' },
  'interview.jd-extract':           { model: 'claude-haiku-4-5-20251001', maxTokens: 800, provider: 'anthropic' },
  'interview.fusion-analysis':      { model: 'claude-haiku-4-5-20251001', maxTokens: 1500, provider: 'anthropic' },
  'resume.enhance-section':         { model: 'claude-sonnet-4-6-20250514', maxTokens: 1000, provider: 'anthropic' },
  'resume.enhance-bullets':         { model: 'claude-sonnet-4-6-20250514', maxTokens: 1000, provider: 'anthropic' },
  'resume.generate-full':           { model: 'claude-sonnet-4-6-20250514', maxTokens: 3000, provider: 'anthropic' },
  'resume.ats-check':               { model: 'claude-sonnet-4-6-20250514', maxTokens: 2000, provider: 'anthropic' },
  'resume.tailor':                   { model: 'claude-sonnet-4-6-20250514', maxTokens: 3000, provider: 'anthropic' },
  'resume.parse':                    { model: 'claude-sonnet-4-6-20250514', maxTokens: 3000, provider: 'anthropic' },
  'resume.gap-analysis':            { model: 'claude-sonnet-4-6-20250514', maxTokens: 2000, provider: 'anthropic' },
  'resume.wizard-followup':         { model: 'claude-haiku-4-5-20251001', maxTokens: 500, provider: 'anthropic' },
  'resume.wizard-enrich':           { model: 'claude-opus-4-6-20250414', maxTokens: 4000, provider: 'anthropic' },
  'learn.pathway-plan':             { model: 'claude-sonnet-4-6-20250514', maxTokens: 3000, provider: 'anthropic' },
  'learn.daily-challenge-gen':      { model: 'claude-haiku-4-5-20251001', maxTokens: 500, provider: 'anthropic' },
  'learn.daily-challenge-score':    { model: 'claude-sonnet-4-6-20250514', maxTokens: 1000, provider: 'anthropic' },
  'learn.drill-evaluate':           { model: 'claude-sonnet-4-6-20250514', maxTokens: 1500, provider: 'anthropic' },
  'b2b.scorecard':                  { model: 'claude-haiku-4-5-20251001', maxTokens: 1000, provider: 'anthropic' },
  'onboarding.extract-profile':     { model: 'claude-sonnet-4-6-20250514', maxTokens: 2000, provider: 'anthropic' },
  'interview.evaluation-engine-v2': { model: 'claude-sonnet-4-6-20250514', maxTokens: 2000, provider: 'anthropic' },
  'interview.answer-candidate-question': { model: 'claude-haiku-4-5-20251001', maxTokens: 200, provider: 'anthropic' },
}

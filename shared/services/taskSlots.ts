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
  'learn.pathway-lesson',
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
  // Fast turn router — probe-vs-advance decision in the critical conversation path
  'interview.turn-router',
] as const

export type TaskSlot = (typeof TASK_SLOTS)[number]

export const TASK_SLOT_DEFAULTS: Record<TaskSlot, { model: string; maxTokens: number; provider: string }> = {
  'interview.generate-question':    { model: 'gpt-5.4-mini', maxTokens: 300, provider: 'openai' },
  'interview.evaluate-answer':      { model: 'gpt-5.4-mini', maxTokens: 250, provider: 'openai' },
  'interview.generate-feedback':    { model: 'gpt-5.4-mini', maxTokens: 6000, provider: 'openai' },
  'interview.evaluate-code':        { model: 'gpt-5.4-mini', maxTokens: 1000, provider: 'openai' },
  'interview.evaluate-design':      { model: 'gpt-5.4-mini', maxTokens: 1500, provider: 'openai' },
  'interview.clarify-coding':       { model: 'gpt-5.4-mini', maxTokens: 500, provider: 'openai' },
  'interview.coding-problem-gen':   { model: 'gpt-5.4-mini', maxTokens: 1000, provider: 'openai' },
  'interview.coach-notes':          { model: 'gpt-5.4-mini', maxTokens: 500, provider: 'openai' },
  'interview.jd-extract':           { model: 'gpt-5.4-mini', maxTokens: 2500, provider: 'openai' },
  'interview.fusion-analysis':      { model: 'gpt-5.4-mini', maxTokens: 3000, provider: 'openai' },
  'resume.enhance-section':         { model: 'claude-sonnet-4-6', maxTokens: 1000, provider: 'anthropic' },
  'resume.enhance-bullets':         { model: 'claude-sonnet-4-6', maxTokens: 1000, provider: 'anthropic' },
  'resume.generate-full':           { model: 'claude-sonnet-4-6', maxTokens: 3000, provider: 'anthropic' },
  'resume.ats-check':               { model: 'claude-sonnet-4-6', maxTokens: 2000, provider: 'anthropic' },
  'resume.tailor':                   { model: 'claude-sonnet-4-6', maxTokens: 3000, provider: 'anthropic' },
  'resume.parse':                    { model: 'claude-sonnet-4-6', maxTokens: 3000, provider: 'anthropic' },
  'resume.gap-analysis':            { model: 'claude-sonnet-4-6', maxTokens: 2000, provider: 'anthropic' },
  'resume.wizard-followup':         { model: 'claude-haiku-4-5', maxTokens: 500, provider: 'anthropic' },
  'resume.wizard-enrich':           { model: 'claude-opus-4-6', maxTokens: 4000, provider: 'anthropic' },
  'learn.pathway-plan':             { model: 'claude-sonnet-4-6', maxTokens: 3000, provider: 'anthropic' },
  'learn.pathway-lesson':           { model: 'claude-haiku-4-5', maxTokens: 900, provider: 'anthropic' },
  'learn.daily-challenge-gen':      { model: 'claude-haiku-4-5', maxTokens: 500, provider: 'anthropic' },
  'learn.daily-challenge-score':    { model: 'claude-sonnet-4-6', maxTokens: 1000, provider: 'anthropic' },
  'learn.drill-evaluate':           { model: 'claude-sonnet-4-6', maxTokens: 1500, provider: 'anthropic' },
  'b2b.scorecard':                  { model: 'claude-haiku-4-5', maxTokens: 1000, provider: 'anthropic' },
  'onboarding.extract-profile':     { model: 'claude-sonnet-4-6', maxTokens: 2000, provider: 'anthropic' },
  'interview.evaluation-engine-v2': { model: 'gpt-5.4-mini', maxTokens: 2000, provider: 'openai' },
  'interview.answer-candidate-question': { model: 'gpt-5.4-mini', maxTokens: 200, provider: 'openai' },
  'interview.turn-router':               { model: 'gpt-5.4-mini', maxTokens: 150, provider: 'openai' },
}

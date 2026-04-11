// ── Services: Core ──
export { createSession, updateSession, getSession, listSessions } from './services/core/interviewService'

// ── Services: Eval ──
export { getScoringDimensions, buildRubricPromptSection, evaluateStructured, evaluateSession } from './services/eval/evaluationEngine'
export type { SessionEvaluationSummary } from './services/eval/evaluationEngine'

// ── Services: Persona ──
export { generateSessionBrief, briefToPromptContext } from './services/persona/personalizationEngine'
export { retrieveQuestions, getQuestionBankContext, getCompanyContext } from './services/persona/retrievalService'
export { parseJobDescription, buildParsedJDContext } from './services/persona/jdParserService'
export {
  parseAndCacheResume,
  buildParsedResumeContext,
  filterResumeByDomain,
} from './services/persona/resumeContextService'
export type { ParsedResume } from './services/persona/resumeContextService'
export {
  getOrLoadJDContext,
  getOrLoadResumeContext,
  getCachedJDContext,
  setCachedJDContext,
  getCachedResumeContext,
  setCachedResumeContext,
} from './services/persona/documentContextCache'

// ── Config ──
export { QUESTION_COUNT, PRESSURE_QUESTION_INDEX, getDomainLabel, AVATAR_NAME, AVATAR_TITLE, getInterviewIntro, getAvatarTitle, WRAP_UP_LINE, EXPERIENCE_LABELS, DURATION_LABELS, ROLE_LABELS } from './config/interviewConfig'
export { deriveCoachingTip } from './config/coachingTips'
export { deriveNudge } from './config/coachingNudges'
export type { CoachingNudge } from './config/coachingNudges'
export { analyzeSpeech, aggregateMetrics, communicationScore } from './config/speechMetrics'
export { PROBABILITY_COLORS, CONFIDENCE_TREND_LABELS } from './config/feedbackConfig'

// ── Utils ──
export { readLocalInterviewData, mergeWithLocalData, cleanupLocalInterviewData } from './utils/mergeSessionData'
export { computeOffsetSeconds } from './utils/offsetHelpers'

// ── Validators ──
export { GenerateQuestionSchema, EvaluateAnswerSchema, GenerateFeedbackSchema, CreateSessionSchema, UpdateSessionSchema } from './validators/interview'

// ── Services (server-side, used by API routes) ──
export { createSession, updateSession, getSession, listSessions } from './services/interviewService'
export { getScoringDimensions, buildRubricPromptSection, evaluateStructured, evaluateSession } from './services/evaluationEngine'
export type { SessionEvaluationSummary } from './services/evaluationEngine'
export { generateSessionBrief, briefToPromptContext } from './services/personalizationEngine'
export { retrieveQuestions, getQuestionBankContext, getCompanyContext } from './services/retrievalService'
export { parseJobDescription, buildParsedJDContext } from './services/jdParserService'

// ── Config ──
export { QUESTION_COUNT, PRESSURE_QUESTION_INDEX, getDomainLabel, AVATAR_NAME, AVATAR_TITLE, getInterviewIntro, WRAP_UP_LINE, EXPERIENCE_LABELS, DURATION_LABELS, ROLE_LABELS } from './config/interviewConfig'
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

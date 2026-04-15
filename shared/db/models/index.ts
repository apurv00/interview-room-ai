// ═══════════════════════════════════════════════════════════════════════════
// Model Ownership Map
//
// Models live in shared/db/models/ to prevent cross-module import chains,
// but each model is conceptually OWNED by a specific domain module. This
// barrel is grouped by owner so developers know which module's service
// layer is the authoritative consumer of each model.
//
//   core       — cross-cutting: User, Organization, UsageRecord, WaitlistEntry
//   interview  — InterviewSession, Template, Domain, Depth, Rubric, Persona,
//                SavedJD, QuestionBank, CompanyPattern, Skill, MultimodalAnalysis
//   learn      — Competency, Weakness, Summary, Pathway, Drill, XP, Badge,
//                Streak, DailyChallenge, Benchmark
//   resume     — WizardConfig, WizardSession
//   b2b        — (uses Organization + InterviewSession + InterviewTemplate)
//   cms        — BenchmarkCase, InterviewDomain, InterviewDepth (shared with interview)
// ═══════════════════════════════════════════════════════════════════════════

// ── Core (cross-cutting) ──

export { User } from './User'
export type { IUser } from './User'

export { Organization } from './Organization'
export type { IOrganization } from './Organization'

export { UsageRecord } from './UsageRecord'
export type { IUsageRecord } from './UsageRecord'

export { ScoreTelemetry } from './ScoreTelemetry'
export type { IScoreTelemetry } from './ScoreTelemetry'

export { WaitlistEntry } from './WaitlistEntry'
export type { IWaitlistEntry } from './WaitlistEntry'

// ── Interview ──

export { InterviewSession } from './InterviewSession'
export type { IInterviewSession, SessionStatus } from './InterviewSession'

export { InterviewTemplate } from './InterviewTemplate'
export type { IInterviewTemplate } from './InterviewTemplate'

export { InterviewDomain } from './InterviewDomain'
export type { IInterviewDomain } from './InterviewDomain'

export { InterviewDepth } from './InterviewDepth'
export type { IInterviewDepth } from './InterviewDepth'

export { EvaluationRubric } from './EvaluationRubric'
export type { IEvaluationRubric, RubricDimension } from './EvaluationRubric'

export { InterviewerPersona } from './InterviewerPersona'
export type { IInterviewerPersona } from './InterviewerPersona'

export { SavedJobDescription } from './SavedJobDescription'
export type { ISavedJobDescription, IParsedJobDescription, ParsedRequirement } from './SavedJobDescription'

export { QuestionBank } from './QuestionBank'
export type { IQuestionBank } from './QuestionBank'

export { CompanyPattern } from './CompanyPattern'
export type { ICompanyPattern } from './CompanyPattern'

export { InterviewSkill } from './InterviewSkill'
export type { IInterviewSkill } from './InterviewSkill'

export { MultimodalAnalysis } from './MultimodalAnalysis'
export type { IMultimodalAnalysis } from './MultimodalAnalysis'

// ── Learn ──

export { UserCompetencyState } from './UserCompetencyState'
export type { IUserCompetencyState } from './UserCompetencyState'

export { WeaknessCluster } from './WeaknessCluster'
export type { IWeaknessCluster } from './WeaknessCluster'

export { SessionSummary } from './SessionSummary'
export type { ISessionSummary } from './SessionSummary'

export { PathwayPlan } from './PathwayPlan'
export type { IPathwayPlan, PracticeTask, Milestone } from './PathwayPlan'

export { DrillAttempt } from './DrillAttempt'
export type { IDrillAttempt } from './DrillAttempt'

export { XpEvent } from './XpEvent'
export type { IXpEvent, XpEventType } from './XpEvent'

export { UserBadge } from './UserBadge'
export type { IUserBadge } from './UserBadge'

export { StreakDay } from './StreakDay'
export type { IStreakDay } from './StreakDay'

export { DailyChallenge } from './DailyChallenge'
export type { IDailyChallenge } from './DailyChallenge'

export { DailyChallengeAttempt } from './DailyChallengeAttempt'
export type { IDailyChallengeAttempt } from './DailyChallengeAttempt'

export { BenchmarkCase } from './BenchmarkCase'
export type { IBenchmarkCase } from './BenchmarkCase'

// ── Resume ──

export { WizardConfig } from './WizardConfig'
export type { IWizardConfig } from './WizardConfig'

export { WizardSession } from './WizardSession'
export type {
  IWizardSession, IWizardRole, IWizardEducation, IWizardSkills,
  IWizardProject, IWizardCertification, IWizardContactInfo,
  IStrengthBreakdown, IFollowUpQA, IBulletDecisionEntry,
  WizardSegment, WizardStatus, BulletDecision,
} from './WizardSession'

// ── CMS / Config ──

export { ModelConfig, TASK_SLOTS, TASK_SLOT_DEFAULTS } from './ModelConfig'
export type { IModelConfig, IModelSlotConfig, TaskSlot } from './ModelConfig'

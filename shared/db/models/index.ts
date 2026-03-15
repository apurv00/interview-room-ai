export { User } from './User'
export type { IUser } from './User'

export { Organization } from './Organization'
export type { IOrganization } from './Organization'

export { InterviewSession } from './InterviewSession'
export type { IInterviewSession, SessionStatus } from './InterviewSession'

export { InterviewTemplate } from './InterviewTemplate'
export type { IInterviewTemplate } from './InterviewTemplate'

export { UsageRecord } from './UsageRecord'
export type { IUsageRecord } from './UsageRecord'

export { InterviewDomain } from './InterviewDomain'
export type { IInterviewDomain } from './InterviewDomain'

export { InterviewDepth } from './InterviewDepth'
export type { IInterviewDepth } from './InterviewDepth'

// Phase 1: Evaluation rubrics
export { EvaluationRubric } from './EvaluationRubric'
export type { IEvaluationRubric, RubricDimension } from './EvaluationRubric'

// Phase 2: User competency & memory
export { UserCompetencyState } from './UserCompetencyState'
export type { IUserCompetencyState } from './UserCompetencyState'

export { WeaknessCluster } from './WeaknessCluster'
export type { IWeaknessCluster } from './WeaknessCluster'

export { SessionSummary } from './SessionSummary'
export type { ISessionSummary } from './SessionSummary'

// Phase 5: Pathway planner
export { PathwayPlan } from './PathwayPlan'
export type { IPathwayPlan, PracticeTask, Milestone } from './PathwayPlan'

// Phase 6: RAG
export { QuestionBank } from './QuestionBank'
export type { IQuestionBank } from './QuestionBank'

export { CompanyPattern } from './CompanyPattern'
export type { ICompanyPattern } from './CompanyPattern'

// Phase 7: Benchmarking
export { BenchmarkCase } from './BenchmarkCase'
export type { IBenchmarkCase } from './BenchmarkCase'

// Phase 2: Drill Mode
export { DrillAttempt } from './DrillAttempt'
export type { IDrillAttempt } from './DrillAttempt'

// Phase 8: Theme A — Deeper Practice
export { InterviewerPersona } from './InterviewerPersona'
export type { IInterviewerPersona } from './InterviewerPersona'

export { SavedJobDescription } from './SavedJobDescription'
export type { ISavedJobDescription, IParsedJobDescription, ParsedRequirement } from './SavedJobDescription'

// Smart Wizard
export { WizardConfig } from './WizardConfig'
export type { IWizardConfig } from './WizardConfig'
export { WizardSession } from './WizardSession'
export type {
  IWizardSession, IWizardRole, IWizardEducation, IWizardSkills,
  IWizardProject, IWizardCertification, IWizardContactInfo,
  IStrengthBreakdown, IFollowUpQA, IBulletDecisionEntry,
  WizardSegment, WizardStatus, BulletDecision,
} from './WizardSession'

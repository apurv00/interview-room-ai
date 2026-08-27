export const CANDIDATE_STAGES = [
  'new',
  'screened',
  'interviewing',
  'shortlist',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
] as const

export type CandidateStage = (typeof CANDIDATE_STAGES)[number]

export const CANDIDATE_STAGE_LABEL: Record<CandidateStage, string> = {
  new: 'New',
  screened: 'Screened',
  interviewing: 'Interviewing',
  shortlist: 'Shortlist',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}

export const RECRUITER_DECISION_LABEL = 'Recruiter decision'

export const SAVED_VIEWS = [
  { id: 'all', label: 'All candidates' },
  { id: 'scoring_attention', label: 'Scoring attention' },
  { id: 'screening_attention', label: 'Screening attention' },
  { id: 'interview_attention', label: 'Interview attention' },
  { id: 'decision_ready', label: 'Decision ready' },
  { id: 'offers', label: 'Offers' },
] as const

export type CandidateSavedView = (typeof SAVED_VIEWS)[number]['id']

export const CANDIDATE_SORTS = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'newest', label: 'Newest applied' },
  { id: 'oldest', label: 'Oldest applied' },
  { id: 'name', label: 'Candidate name' },
  { id: 'stage', label: 'Stage' },
  { id: 'jd_match', label: 'JD match' },
  { id: 'rank', label: 'Global job rank' },
  { id: 'human_review', label: 'Human review' },
  { id: 'last_activity', label: 'Last activity' },
] as const

export type CandidateSort = (typeof CANDIDATE_SORTS)[number]['id']

export interface CandidateListRow {
  applicationId: string
  candidateId: string
  name: string
  email: string | null
  /** Canonical recruiter-owned workflow decision, separate from JD, human-review, and AI signals. */
  stage: CandidateStage
  appliedAt: string
  source: string | null
  sourceHistory: string[]
  lastActivityAt: string
  attention: string[]
  jdMatch: {
    state: 'fresh' | 'stale' | 'pending' | 'unscored'
    score: number | null
    rank: number | null
    denominator: number
  }
  humanReview: {
    state: 'none' | 'pending' | 'complete' | 'mixed'
    recommendations: Record<string, number>
    submitted: number
    pending: number
    total: number
    disagreement: boolean
  }
  aiInterview: {
    state: 'not_invited' | 'invited' | 'in_progress' | 'completed' | 'revoked'
    score: number | null
  }
  workspaceHistory: {
    previousApplications: number
  }
}

export interface CandidateListResponse {
  asOf: string
  job: {
    id: string
    title: string
    status: 'open' | 'on_hold' | 'closed'
  }
  rows: CandidateListRow[]
  pageInfo: {
    limit: number
    nextCursor: string | null
    hasNextPage: boolean
    snapshotAt: string
    refreshAvailable: boolean
  }
}

export interface CandidateSummaryResponse {
  asOf: string
  job: CandidateListResponse['job']
  counts: {
    total: number
    matching: number
    savedViews: Record<CandidateSavedView, number>
    stages: Record<CandidateStage, number>
    jdMatch: Record<string, number>
  }
  rankContext: {
    freshScoredTotal: number
    stale: number
    pending: number
    unscored: number
  }
}

export interface CandidateSelectionSnapshot {
  selectionId: string
  count: number
  expiresAt: string
  description: string
  homogeneousStage: CandidateStage | null
}

export type CandidateColumn =
  | 'candidate'
  | 'stage'
  | 'attention'
  | 'jdMatch'
  | 'humanReview'
  | 'aiInterview'
  | 'source'
  | 'appliedAt'
  | 'lastActivity'
  | 'history'
  | 'actions'

export const OPTIONAL_COLUMNS: Array<{ id: CandidateColumn; label: string }> = [
  { id: 'attention', label: 'Attention' },
  { id: 'jdMatch', label: 'JD match & rank' },
  { id: 'humanReview', label: 'Human review' },
  { id: 'aiInterview', label: 'AI interview' },
  { id: 'source', label: 'Candidate sources' },
  { id: 'appliedAt', label: 'Applied' },
  { id: 'lastActivity', label: 'Last activity' },
  { id: 'history', label: 'Workspace history' },
]

export const DEFAULT_COLUMNS: CandidateColumn[] = [
  'candidate',
  'stage',
  'attention',
  'jdMatch',
  'humanReview',
  'aiInterview',
  'appliedAt',
  'actions',
]

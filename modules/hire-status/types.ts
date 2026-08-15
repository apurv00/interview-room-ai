/**
 * Candidate-status links are a deliberately tiny public capability. They are
 * not a guest session, an apply credential, or an interview-room credential.
 */
export const CANDIDATE_STATUS_LINK_DEFAULT_EXPIRY_DAYS = 30
export const CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS = 90
export const CANDIDATE_STATUS_LINK_PROGRESS_TOTAL = 3

export const CANDIDATE_STATUS_PHASES = [
  'received',
  'under_review',
  'interviewing',
  'decision',
  'concluded',
] as const
export type CandidateStatusPhase = (typeof CANDIDATE_STATUS_PHASES)[number]

/**
 * Every persistent Hire coordinate is carried in the fragment capability.
 * The fragment never reaches HTTP logs; the raw secret is never persisted.
 */
export interface CandidateStatusCapability {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  linkId: string
  secret: string
}

/** The entire public DTO; internal stage names and candidate data never cross this boundary. */
export interface CandidateStatusPublicView {
  phase: CandidateStatusPhase
  progress: {
    current: number
    total: typeof CANDIDATE_STATUS_LINK_PROGRESS_TOTAL
  }
}

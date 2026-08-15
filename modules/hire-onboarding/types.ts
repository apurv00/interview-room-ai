import type { HireOnboardingTestDriveState } from './models/HireOnboardingTestDrive'

/** Member-facing data only: opaque coordinates and lifecycle state. */
export interface HireOnboardingTestDriveView {
  id: string
  label: 'Interview yourself'
  state: HireOnboardingTestDriveState
  jobId: string
  candidateId: string
  applicationId: string
  roundId: string | null
  issuedAt: Date
  cleanupAfter: Date
  removedAt: Date | null
}

/** Safe source-projection shape for the later read-only audit projection. */
export interface HireOnboardingTestDriveAuditView extends HireOnboardingTestDriveView {
  workspaceId: string
  issuedByMemberId: string
  issuedByName: string
  removedByMemberId: string | null
  removedByName: string | null
}

export type HireOnboardingTestDriveCoordinate =
  | 'applicationId'
  | 'jobId'
  | 'candidateId'
  | 'roundId'

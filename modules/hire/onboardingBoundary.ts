/**
 * Narrow Phase-5 onboarding facade.
 *
 * The separate onboarding module may create a deliberately synthetic Hire
 * graph, but it must not import Hire's broad route-facing barrel, B2C code,
 * or engine/runtime implementation. This facade exposes only the control
 * models and established member AI-round commands that preserve the normal
 * consent and recording-disclosure path.
 */
import mongoose, { type ClientSession } from 'mongoose'
import { AppError } from '@shared/errors'
import { HireOnboardingTestDrive } from '../hire-onboarding/models/HireOnboardingTestDrive'

export { HireApplication } from './models/HireApplication'
export { HireCandidate } from './models/HireCandidate'
export { HireJob } from './models/HireJob'
export { HireJobRequirementVersion } from './models/HireJobRequirementVersion'
export { HireRound } from './models/HireRound'

export { sendAiRound, revokeRound } from './services/aiRoundService'
export { connectHireControlDB } from './services/hireControlBoundary'
export { withActiveHireWorkspaceWriteTransaction } from './services/hireWorkspaceWriteFence'
export type { MembershipContext } from './services/workspaceService'

/**
 * The practice-interview graph is deliberately a normal-looking Hire graph
 * so the member can experience the real interview flow. It must never become
 * an input to ordinary recruiting writes: doing so would hide real candidate
 * data behind the aggregate-exclusion marker and make cleanup unsafe.
 *
 * This is a direct-model fence rather than a root-barrel import. All callers
 * invoke it inside the transaction that would otherwise persist an ordinary
 * application or intake task.
 */
type HireOnboardingCoordinateId = mongoose.Types.ObjectId | string

interface HireOnboardingTestDriveCoordinate {
  workspaceId: HireOnboardingCoordinateId
  jobId?: HireOnboardingCoordinateId
  candidateId?: HireOnboardingCoordinateId
  applicationId?: HireOnboardingCoordinateId
}

function testDriveCoordinateClauses(input: HireOnboardingTestDriveCoordinate) {
  const coordinates: Array<
    | { jobId: HireOnboardingCoordinateId }
    | { candidateId: HireOnboardingCoordinateId }
    | { applicationId: HireOnboardingCoordinateId }
  > = []
  if (input.jobId) coordinates.push({ jobId: input.jobId })
  if (input.candidateId) coordinates.push({ candidateId: input.candidateId })
  if (input.applicationId) coordinates.push({ applicationId: input.applicationId })
  return coordinates
}

/**
 * Read-only counterpart for public/non-transactional capability resolution.
 * It deliberately matches every retained marker state: a removed test drive
 * remains isolated until its graph is safely purged.
 */
export async function isHireOnboardingTestDriveCoordinate(
  input: HireOnboardingTestDriveCoordinate,
): Promise<boolean> {
  const coordinates = testDriveCoordinateClauses(input)
  if (coordinates.length === 0) return false
  const marker = await HireOnboardingTestDrive.exists({
    workspaceId: input.workspaceId,
    excludeFromAggregates: true,
    $or: coordinates,
  })
  return Boolean(marker)
}

export async function assertHireOnboardingTestDriveWriteIsolation(
  input: HireOnboardingTestDriveCoordinate & { session: ClientSession },
): Promise<void> {
  const coordinates = testDriveCoordinateClauses(input)
  if (coordinates.length === 0) return

  const marker = await HireOnboardingTestDrive.exists({
    workspaceId: input.workspaceId,
    excludeFromAggregates: true,
    $or: coordinates,
  }).session(input.session)
  if (marker) {
    throw new AppError(
      'Practice interviews are isolated from recruiting workflows',
      409,
      'ONBOARDING_TEST_DRIVE_ISOLATED',
    )
  }
}

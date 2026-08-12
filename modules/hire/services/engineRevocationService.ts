import {
  HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
  HireEngineRevocationSchema,
} from '@shared/contracts/hireEngineBridge'
import { createInternalServiceHeaders } from '@shared/services/internalServiceAuth'
import { HireEngineHandoff } from '../models/HireEngineHandoff'
import { HireGuestSession } from '../models/HireGuestSession'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireRound } from '../models/HireRound'
import { connectHireControlDB } from './hireControlBoundary'
import { listHireWorkspaceIdsForSweep } from './workspaceSweepService'

function runtimeBaseUrl(): string {
  const raw = process.env.HIRE_ENGINE_RUNTIME_URL
  if (!raw) throw new Error('HIRE_ENGINE_RUNTIME_URL is not configured')
  const url = new URL(raw)
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Hire runtime URL must use HTTPS')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export async function revokeControlPlaneGuestAccess(input: {
  workspaceId: string
  applicationId: string
  roundId: string
  revokedAt: Date
}): Promise<void> {
  await connectHireControlDB()
  const scope = {
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    roundId: input.roundId,
  }
  await Promise.all([
    HireGuestSession.updateMany(
      { ...scope, active: true },
      { $set: { revokedAt: input.revokedAt }, $unset: { active: 1 } },
    ),
    HireEngineHandoff.updateMany(
      { ...scope, revokedAt: { $exists: false } },
      { $set: { revokedAt: input.revokedAt } },
    ),
    HireInterviewAttempt.updateMany(
      { ...scope, live: true, status: { $in: ['photo_pending', 'ready'] } },
      {
        $set: { status: 'revoked' },
        $unset: { live: 1 },
      },
    ),
  ])
}

export async function deliverRuntimeRevocation(
  workspaceId: string,
  roundId: string,
): Promise<boolean> {
  await connectHireControlDB()
  const round = await HireRound.findOne({
    _id: roundId,
    workspaceId,
    revokedAt: { $exists: true },
    revocationState: { $in: ['pending', 'failed'] },
  })
    .select(
      'workspaceId applicationId revokedAt revocationReason runtimePurgeRequested',
    )
    .lean()
  if (!round?.revokedAt) return true

  const path = '/api/internal/hire-engine/revoke'
  const payload = HireEngineRevocationSchema.parse({
    schemaVersion: HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
    workspaceId: round.workspaceId.toString(),
    applicationId: round.applicationId.toString(),
    roundId: round._id.toString(),
    revokedAt: round.revokedAt.toISOString(),
    reason: round.revocationReason || 'Recruiter revoked the interview invitation',
    purgePersonalData: round.runtimePurgeRequested === true,
  })
  const body = JSON.stringify(payload)
  try {
    const response = await fetch(new URL(path, runtimeBaseUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...createInternalServiceHeaders({ method: 'POST', path, body }),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Runtime revoke returned ${response.status}`)
    await HireRound.updateOne(
      {
        _id: round._id,
        workspaceId: round.workspaceId,
        applicationId: round.applicationId,
        revokedAt: round.revokedAt,
      },
      {
        $set: {
          revocationState: 'confirmed',
          revocationConfirmedAt: new Date(),
          ...(round.runtimePurgeRequested ? { runtimePurgedAt: new Date() } : {}),
        },
        $unset: { revocationFailureCode: 1 },
      },
    )
    return true
  } catch (error) {
    await HireRound.updateOne(
      {
        _id: round._id,
        workspaceId: round.workspaceId,
        applicationId: round.applicationId,
        revokedAt: round.revokedAt,
      },
      {
        $set: {
          revocationState: 'failed',
          revocationFailureCode:
            error instanceof Error ? error.name.slice(0, 120) : 'RUNTIME_REVOKE_FAILED',
        },
      },
    )
    return false
  }
}

export async function retryPendingRuntimeRevocations(
  workspaceId: string,
  limit = 50,
): Promise<{
  scanned: number
  confirmed: number
}> {
  await connectHireControlDB()
  const rounds = await HireRound.find({
    workspaceId,
    revokedAt: { $exists: true },
    revocationState: { $in: ['pending', 'failed'] },
  })
    .sort({ updatedAt: 1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .select('_id')
    .lean()
  let confirmed = 0
  for (const round of rounds) {
    if (await deliverRuntimeRevocation(workspaceId, round._id.toString())) confirmed += 1
  }
  return { scanned: rounds.length, confirmed }
}

export async function retryPendingRuntimeRevocationsAcrossWorkspaces(
  limit = 50,
): Promise<{ scanned: number; confirmed: number; workspaces: number }> {
  const workspaceIds = await listHireWorkspaceIdsForSweep()
  let scanned = 0
  let confirmed = 0
  for (const workspaceId of workspaceIds) {
    if (scanned >= limit) break
    const outcome = await retryPendingRuntimeRevocations(
      workspaceId,
      limit - scanned,
    )
    scanned += outcome.scanned
    confirmed += outcome.confirmed
  }
  return { scanned, confirmed, workspaces: workspaceIds.length }
}

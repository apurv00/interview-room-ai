import { randomBytes } from 'node:crypto'
import { User } from '@shared/db/models/User'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import { HireRuntimeRevocation } from '../models/HireRuntimeRevocation'
import { connectHireRuntimeDB } from './runtimeBoundary'

export const HIRE_RUNTIME_INTERVIEW_LIMIT = 3
const PRINCIPAL_LEASE_MS = 60 * 1_000

export function runtimePrincipalEmail(roundId: string): string {
  return `round-${roundId.toLowerCase()}@guests.interviewprep.internal`
}

/**
 * Creates the schema-compatible engine principal in the isolated runtime DB.
 * It contains no candidate email, name, resume, phone, or B2C account id.
 */
export async function ensureRuntimePrincipal(binding: IHireRuntimeBinding) {
  await connectHireRuntimeDB()
  const now = new Date()
  const leaseToken = randomBytes(32).toString('hex')
  const claimed = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      status: { $in: ['provisioned', 'active'] },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
      $or: [
        { principalLeaseToken: { $exists: false } },
        { principalLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        principalLeaseToken: leaseToken,
        principalLeaseExpiresAt: new Date(now.getTime() + PRINCIPAL_LEASE_MS),
      },
    },
    { new: true },
  )
  if (!claimed) return null

  const email = runtimePrincipalEmail(binding.roundId.toString())
  const coordinates = {
    workspaceId: binding.workspaceId,
    applicationId: binding.applicationId,
    roundId: binding.roundId,
  }
  try {
    if (await HireRuntimeRevocation.exists(coordinates)) return null
    const principal = await User.findOneAndUpdate(
      {
        _id: binding.principalId,
        email,
        organizationId: binding.workspaceId,
      },
      {
        $setOnInsert: {
          _id: binding.principalId,
          email,
          name: 'Interview candidate',
          emailVerified: new Date(),
          role: 'candidate',
          plan: 'free',
          monthlyInterviewsUsed: 0,
          interviewCount: 0,
        },
        $set: {
          experienceLevel: binding.config.experience,
          entitlementSource: 'admin_grant',
          monthlyInterviewLimit: HIRE_RUNTIME_INTERVIEW_LIMIT,
          accountState: 'active',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    const [bindingStillCurrent, revoked] = await Promise.all([
      HireRuntimeBinding.exists({
        _id: binding._id,
        workspaceId: binding.workspaceId,
        principalLeaseToken: leaseToken,
        status: { $in: ['provisioned', 'active'] },
        revokedAt: { $exists: false },
        purgePersonalData: { $ne: true },
      }),
      HireRuntimeRevocation.exists(coordinates),
    ])
    if (!bindingStillCurrent || revoked) {
      const deleted = await User.deleteOne({
        _id: binding.principalId,
        email,
        organizationId: binding.workspaceId,
      })
      if (!deleted.acknowledged) {
        throw new Error('Late runtime principal cleanup was not acknowledged')
      }
      return null
    }
    return principal
  } finally {
    await HireRuntimeBinding.updateOne(
      {
        _id: binding._id,
        workspaceId: binding.workspaceId,
        principalLeaseToken: leaseToken,
      },
      { $unset: { principalLeaseToken: 1, principalLeaseExpiresAt: 1 } },
    )
  }
}

export const __runtimePrincipal = { PRINCIPAL_LEASE_MS }

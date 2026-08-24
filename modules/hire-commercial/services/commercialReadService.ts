import { ForbiddenError } from '@shared/errors'
import {
  connectHireControlDB,
  HireInterviewResult,
  type MembershipContext,
} from '@hire-operations-boundary'
import {
  HIRE_COMMERCIAL_CATALOG,
  HIRE_COMMERCIAL_CATALOG_VERSION,
  HIRE_COMMERCIAL_MODULE_IDS,
  HIRE_COMMERCIAL_SHADOW_MEASUREMENT_STARTED_AT,
  type HireCommercialModuleId,
} from '../catalog'
import { HireCommercialAccount } from '../models/HireCommercialAccount'

export interface HireCommercialWorkspaceView {
  catalogVersion: typeof HIRE_COMMERCIAL_CATALOG_VERSION
  enforcement: 'shadow'
  source: 'compatibility_default' | 'persisted_account'
  pilotStatus: 'not_requested' | 'requested' | 'active'
  usage: {
    screenAssessmentsCompleted: number
    measurementStartedAt: Date | null
    scope: 'shadow_era'
  }
  modules: Array<{
    id: HireCommercialModuleId
    name: string
    summary: string
    capabilities: string[]
    available: true
    commercialState: 'included' | 'not_selected'
  }>
}

/**
 * Admin-only commercial projection. Entitlements are observational while the
 * foundation is in shadow mode and never deny an existing Hire capability.
 */
export async function readHireCommercialWorkspace(
  ctx: MembershipContext,
): Promise<HireCommercialWorkspaceView> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Workspace administrator access required')
  }
  await connectHireControlDB()

  const workspaceId = ctx.workspace._id
  const measurementStartedAt = new Date(
    HIRE_COMMERCIAL_SHADOW_MEASUREMENT_STARTED_AT,
  )
  const [account, usageRows] = await Promise.all([
    // A stored selection is meaningful only for the catalog that authored it.
    // Unknown/legacy versions fail open to the compatibility default while an
    // operator performs the explicit catalog migration.
    HireCommercialAccount.findOne({
      workspaceId,
      catalogVersion: HIRE_COMMERCIAL_CATALOG_VERSION,
    }).lean(),
    HireInterviewResult.aggregate<{
      screenAssessmentsCompleted: number
    }>([
      {
        $match: {
          workspaceId,
          completedAt: { $gte: measurementStartedAt },
        },
      },
      { $count: 'screenAssessmentsCompleted' },
      { $project: { _id: 0 } },
    ]),
  ])
  const entitledModules = new Set<HireCommercialModuleId>(
    account
      ? ['core', ...account.entitledModules]
      : HIRE_COMMERCIAL_MODULE_IDS,
  )
  const usage = usageRows[0]

  return {
    catalogVersion: HIRE_COMMERCIAL_CATALOG_VERSION,
    enforcement: 'shadow',
    source: account ? 'persisted_account' : 'compatibility_default',
    pilotStatus: account?.pilotStatus ?? 'not_requested',
    usage: {
      screenAssessmentsCompleted: usage?.screenAssessmentsCompleted ?? 0,
      measurementStartedAt,
      scope: 'shadow_era',
    },
    modules: HIRE_COMMERCIAL_CATALOG.map((module) => ({
      ...module,
      capabilities: [...module.capabilities],
      available: true,
      commercialState: entitledModules.has(module.id)
        ? 'included'
        : 'not_selected',
    })),
  }
}

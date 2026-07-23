import { NextResponse } from 'next/server'
import { logger } from '@shared/logger'
import {
  JobIngestCycle,
  JobPosting,
  JobSourceControlAudit,
  JobsVerdictConfig,
} from '@shared/db/models'
import { requireCurrentPlatformAdmin } from '@jobs/services/adminAuth'
import { reconcileJobsFunnelTelemetry } from '@jobs/services/funnelReconciliation'
import { getJobSourceControlPlane } from '@jobs/services/sourceOperations'
import {
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
  JOB_SOURCE_CONTROL_WARN_POSTINGS,
} from '@jobs/config/sourceControlLimits'

export const dynamic = 'force-dynamic'

type SourceAction = 'enable' | 'pause' | 'update-settings' | 'run-now' | 'validate' | 'revoke' | 'restore'

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanOf(value: unknown): boolean {
  return value === true
}

function dateString(value: unknown): string | null {
  if (!value) return null
  const date = new Date(value as string | number | Date)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function adminLabel(actorUserId: unknown): string {
  const id = String(actorUserId ?? '')
  return id ? `Admin …${id.slice(-6)}` : 'Platform admin'
}

function displayReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const reason = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  return reason || undefined
}

function readinessResponse(
  authorization: Awaited<ReturnType<typeof requireCurrentPlatformAdmin>>,
) {
  if (authorization.ok) return null
  if (authorization.cause) {
    logger.error({
      error: authorization.cause,
      actorUserId: authorization.actorUserId,
    }, 'jobs operations authorization lookup failed')
  }
  return NextResponse.json({
    error: authorization.error,
    code: authorization.code,
    retryable: authorization.status === 503,
  }, { status: authorization.status })
}

/** GET /api/cms/jobs-ingest — authoritative Jobs operator state. */
export async function GET() {
  const authorization = await requireCurrentPlatformAdmin()
  const denied = readinessResponse(authorization)
  if (denied) return denied

  const [
    controlPlane,
    corpus,
    retained,
    verdictConfig,
    verdictCycles,
    verdictBacklog,
    verdictDist,
    tombstones,
    legalAudit,
    funnelReconciliation,
  ] = await Promise.all([
    getJobSourceControlPlane(),
    JobPosting.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    JobPosting.countDocuments({}),
    JobsVerdictConfig.getConfig(),
    JobIngestCycle.find({ kind: 'llm-verdict' }).sort({ createdAt: -1 }).limit(20).select('-__v').lean(),
    JobPosting.countDocuments({ status: 'open', 'llmVerdict.status': 'pending' }),
    JobPosting.aggregate([
      { $match: { 'llmVerdict.status': 'scored' } },
      { $group: { _id: '$llmVerdict.verdict', n: { $sum: 1 } } },
    ]),
    JobPosting.countDocuments({ closedReason: 'llm-verdict' }),
    JobSourceControlAudit.find({})
      .sort({ occurredAt: -1 })
      .limit(100)
      .select('sourceId operationId action actorUserId reason revision affectedPostings unknownLineagePostings occurredAt')
      .lean(),
    reconcileJobsFunnelTelemetry(),
  ])

  const corpusByStatus: Record<string, number> = {}
  for (const row of corpus as Array<{ _id: string; n: number }>) corpusByStatus[row._id] = row.n
  const sources = controlPlane.sources.map((rawSource) => {
    const config = recordOf(rawSource.config)
    const definition = rawSource.definition
    const budgetConfig = recordOf(config.requestBudget)
    const ceiling = definition?.requestBudget ?? {
      perRunRequestCap: numberOf(budgetConfig.perRunRequestCap),
      dailyRequestCap: numberOf(budgetConfig.dailyRequestCap),
      monthlyRequestCap: numberOf(budgetConfig.monthlyRequestCap),
    }
    const budget = {
      perRunRequestCap: numberOf(budgetConfig.perRunRequestCap),
      dailyRequestCap: numberOf(budgetConfig.dailyRequestCap),
      monthlyRequestCap: numberOf(budgetConfig.monthlyRequestCap),
    }
    const metrics24h = rawSource.metrics24h
    const metrics7d = rawSource.metrics7d
    const controlRevision = numberOf(config.controlRevision)
    const operationalRevision = numberOf(config.operationalRevision)
    const health = String(config.health ?? 'dead') as 'active' | 'degraded' | 'quarantined' | 'dead' | 'revoked'
    const enabled = booleanOf(config.enabled)
    const operationalPolicyReady = !!definition && config.operationalPolicyReady !== false
    const validation = recordOf(config.lastValidation)
    const lastOperation = recordOf(rawSource.lastOperation)
    const validationAt = dateString(validation.checkedAt)
    const operationAt = dateString(lastOperation.occurredAt)
    const operationTerminal = lastOperation.outcome === 'succeeded' || lastOperation.outcome === 'failed'
    const validationCurrent = validation.status === 'healthy' &&
      numberOf(validation.controlRevision, -1) === controlRevision &&
      numberOf(validation.operationalRevision, -1) === operationalRevision
    const validationPending = lastOperation.action === 'validate' && !!lastOperation.dispatchedAt && !operationTerminal &&
      (!validationAt || (operationAt != null && new Date(operationAt).getTime() > new Date(validationAt).getTime()))
    const rawCredential = recordOf(rawSource.credential)
    const legacyCredentialStatus = String(rawCredential.status ?? 'missing')
    const configurationStatus = ['not-required', 'missing', 'configured'].includes(String(rawCredential.configurationStatus))
      ? String(rawCredential.configurationStatus) as 'not-required' | 'missing' | 'configured'
      : legacyCredentialStatus === 'not-required'
        ? 'not-required' as const
        : legacyCredentialStatus === 'missing'
          ? 'missing' as const
          : 'configured' as const
    const lastValidationStatus = ['not-run', 'healthy', 'rejected', 'failed', 'stale'].includes(String(rawCredential.lastValidationStatus))
      ? String(rawCredential.lastValidationStatus) as 'not-run' | 'healthy' | 'rejected' | 'failed' | 'stale'
      : legacyCredentialStatus === 'verified'
        ? 'healthy' as const
        : legacyCredentialStatus === 'rejected'
          ? 'rejected' as const
          : validation.checkedAt
            ? validationCurrent ? 'healthy' as const : 'stale' as const
            : 'not-run' as const
    const credential = configurationStatus === 'not-required'
        ? { status: 'not-required' as const, label: 'Not required' }
        : configurationStatus === 'missing'
          ? {
              status: 'missing' as const,
              label: 'Missing',
              remediation: rawSource.credential.requiredEnv
                ? `Configure ${rawSource.credential.requiredEnv} in the deployment, then validate.`
                : 'Configure the required deployment credential, then validate.',
            }
          : lastValidationStatus === 'healthy' && validationCurrent
            ? { status: 'ready' as const, label: 'Validated' }
            : lastValidationStatus === 'rejected'
              ? {
                  status: 'configured-rejected' as const,
                  label: 'Configured; last validation rejected',
                  remediation: 'A credential is currently configured. If it was rotated, queue Validate again; the historical rejection does not block revalidation.',
                }
              : lastValidationStatus === 'failed'
                ? {
                    status: 'unknown' as const,
                    label: 'Configured; last validation failed',
                    remediation: 'Review the provider failure, then queue Validate again.',
                  }
                : lastValidationStatus === 'stale'
                  ? {
                      status: 'unknown' as const,
                      label: 'Configured; validation is stale',
                      remediation: 'Queue Validate at the current source revisions.',
                    }
                  : { status: 'unknown' as const, label: 'Configured; not validated' }

    const usedToday = rawSource.quota.usedToday
    const usedThisMonth = rawSource.quota.usedThisMonth
    const quotaAvailable = rawSource.quota.available && usedToday != null && usedThisMonth != null
    const dailyPercent = quotaAvailable && budget.dailyRequestCap > 0 ? usedToday / budget.dailyRequestCap : 0
    const monthlyPercent = quotaAvailable && budget.monthlyRequestCap > 0 ? usedThisMonth / budget.monthlyRequestCap : 0
    const budgetPercent = quotaAvailable
      ? Math.round(Math.max(dailyPercent, monthlyPercent) * 100)
      : null
    const capDisabled = budget.perRunRequestCap <= 0 || budget.dailyRequestCap <= 0 || budget.monthlyRequestCap <= 0
    const budgetExhausted = quotaAvailable && (
      usedToday >= budget.dailyRequestCap || usedThisMonth >= budget.monthlyRequestCap
    )
    const budgetBlocked = capDisabled || !quotaAvailable || budgetExhausted

    const commonBlockers = [
      ...(!controlPlane.readiness.transactionCapable ? ['Mongo transaction readiness is unavailable.'] : []),
      ...(!controlPlane.readiness.sourceControlReady ? ['Source-control lineage or audit readiness is incomplete.'] : []),
      ...(!controlPlane.readiness.inngestCredentialsConfigured ? ['Worker dispatch credentials are missing.'] : []),
      ...(!controlPlane.readiness.redisReachable ? ['Shared Redis request-meter state is unavailable.'] : []),
    ]
    const credentialBlockers = configurationStatus === 'missing'
      ? [credential.remediation ?? 'Source credential is not ready.']
      : []
    const budgetBlockers = [
      ...(capDisabled ? ['One or more source request caps are zero.'] : []),
      ...(!quotaAvailable ? ['Shared request-meter usage is unavailable.'] : []),
      ...(budgetExhausted ? ['The daily or monthly source request budget is exhausted.'] : []),
    ]
    const blockers: Partial<Record<SourceAction, string[]>> = {}
    const allowedActions: SourceAction[] = []

    if (health === 'revoked') {
      allowedActions.push('restore')
    } else {
      allowedActions.push('revoke')
      if (!operationalPolicyReady) {
        const repair = ['Bootstrap must repair this source catalog identity or policy before operational actions.']
        blockers['update-settings'] = repair
        blockers.pause = repair
        blockers['run-now'] = repair
        blockers.validate = repair
        blockers.enable = repair
      } else if (enabled) {
        allowedActions.push('update-settings', 'pause')
        const runBlockers = [
          ...commonBlockers,
          ...credentialBlockers,
          ...budgetBlockers,
          ...(!['active', 'degraded'].includes(health) ? [`Health ${health} is not eligible for sync.`] : []),
        ]
        if (runBlockers.length) blockers['run-now'] = runBlockers
        else allowedActions.unshift('run-now')
      } else {
        allowedActions.push('update-settings')
        const validationBlockers = [
          ...commonBlockers,
          ...credentialBlockers,
          ...budgetBlockers,
          ...(!definition ? ['Source is not in the reviewed catalog.'] : []),
        ]
        if (validationBlockers.length) blockers.validate = validationBlockers
        else allowedActions.unshift('validate')
        const enableBlockers = [
          ...commonBlockers,
          ...credentialBlockers,
          ...budgetBlockers,
          ...(!validationCurrent ? ['A current successful validation is required.'] : []),
        ]
        if (enableBlockers.length) blockers.enable = enableBlockers
        else allowedActions.unshift('enable')
      }
    }

    const lastSyncAt = dateString(config.lastSyncAt)
    const cadenceMinutes = numberOf(config.cadenceMinutes, definition?.cadenceMinutes ?? 1440)
    const nextSyncAt = lastSyncAt
      ? new Date(new Date(lastSyncAt).getTime() + cadenceMinutes * 60_000).toISOString()
      : null
    const lastControl = recordOf(config.lastControl)
    const lastControlAt = dateString(lastControl.at)
    const displayName = String(config.displayName ?? definition?.displayName ?? rawSource.sourceId)

    return {
      sourceId: rawSource.sourceId,
      displayName,
      kind: String(config.kind ?? definition?.kind ?? 'unknown'),
      enabled,
      health,
      state: health === 'revoked'
        ? 'revoked' as const
        : health === 'quarantined'
          ? 'quarantined' as const
          : health === 'dead'
            ? 'dead' as const
            : enabled && ['active', 'degraded'].includes(health)
              ? 'active' as const
              : validationPending
                ? 'validating' as const
                : 'paused' as const,
      operationalRevision,
      controlRevision,
      lastControl: lastControl.action && lastControlAt
        ? {
            revision: numberOf(lastControl.revision),
            action: String(lastControl.action) as 'revoke' | 'restore',
            at: lastControlAt,
          }
        : null,
      credential,
      settings: {
        cadenceMinutes,
        minIndiaPostings: config.minIndiaPostings == null ? null : numberOf(config.minIndiaPostings),
        perRunRequestCap: budget.perRunRequestCap,
        dailyRequestCap: budget.dailyRequestCap,
        monthlyRequestCap: budget.monthlyRequestCap,
        llmVerdictOptOut: booleanOf(config.llmVerdictOptOut),
        notes: typeof config.notes === 'string' ? config.notes : '',
      },
      limits: {
        cadenceMinutes: { min: 15, max: 10_080 },
        minIndiaPostings: { min: 0, max: 100_000 },
        perRunRequestCap: { min: 0, max: ceiling.perRunRequestCap },
        dailyRequestCap: { min: 0, max: ceiling.dailyRequestCap },
        monthlyRequestCap: { min: 0, max: ceiling.monthlyRequestCap },
      },
      postings: rawSource.supply,
      metrics24h,
      metrics7d,
      budget: {
        status: quotaAvailable ? 'available' as const : 'unavailable' as const,
        usedToday,
        usedThisMonth,
        dailyCap: budget.dailyRequestCap,
        monthlyCap: budget.monthlyRequestCap,
        percent: budgetPercent,
        blocked: budgetBlocked,
      },
      lastSyncAt,
      nextSyncAt,
      lastValidation: validationAt
        ? {
            status: !validationCurrent
              ? 'stale' as const
              : validation.status === 'healthy' ? 'passed' as const : 'failed' as const,
            at: validationAt,
            operationalRevision: numberOf(validation.operationalRevision),
            controlRevision: numberOf(validation.controlRevision),
            ...(!validationCurrent
              ? { detail: 'Evidence belongs to an earlier source revision.' }
              : validation.errorCode ? { detail: String(validation.errorCode) } : {}),
          }
        : validationPending && operationAt
          ? {
              status: 'pending' as const,
              at: operationAt,
              operationalRevision,
              controlRevision,
            }
          : null,
      lastOperation: operationAt
        ? {
            action: String(lastOperation.action ?? 'unknown'),
            at: operationAt,
            actorLabel: typeof lastOperation.actorLabel === 'string'
              ? lastOperation.actorLabel
              : adminLabel(lastOperation.actorUserId),
            operationId: typeof lastOperation.operationId === 'string' ? lastOperation.operationId : undefined,
            outcome: typeof lastOperation.outcome === 'string'
              ? String(lastOperation.outcome)
              : lastOperation.dispatchedAt ? 'queued' : 'committed',
            ...(typeof lastOperation.errorCode === 'string' ? { errorCode: lastOperation.errorCode } : {}),
            ...(dateString(lastOperation.completedAt) ? { completedAt: dateString(lastOperation.completedAt)! } : {}),
          }
        : null,
      allowedActions,
      blockers,
    }
  })

  const operationalAudit = controlPlane.audit.map((raw) => {
    const row = recordOf(raw)
    return {
      sourceId: typeof row.sourceId === 'string' ? row.sourceId : 'catalog',
      operationId: typeof row.operationId === 'string' ? row.operationId : undefined,
      action: String(row.action ?? 'unknown'),
      at: dateString(row.completedAt) ?? dateString(row.occurredAt) ?? new Date(0).toISOString(),
      actorLabel: typeof row.actorLabel === 'string' ? row.actorLabel : adminLabel(row.actorUserId),
      ...(displayReason(row.reason) ? { reason: displayReason(row.reason) } : {}),
      outcome: typeof row.outcome === 'string'
        ? `${row.outcome}${typeof row.errorCode === 'string' ? ` · ${row.errorCode}` : ''}`
        : row.dispatchedAt ? 'queued' : 'committed',
      changes: recordOf(row.changes),
    }
  })
  const legalAuditRows = (legalAudit as unknown[]).map((raw) => {
    const row = recordOf(raw)
    return {
      sourceId: String(row.sourceId ?? 'unknown'),
      operationId: typeof row.operationId === 'string' ? row.operationId : undefined,
      action: String(row.action ?? 'unknown'),
      at: dateString(row.occurredAt) ?? new Date(0).toISOString(),
      actorLabel: adminLabel(row.actorUserId),
      ...(displayReason(row.reason) ? { reason: displayReason(row.reason) } : {}),
      outcome: `committed · ${numberOf(row.affectedPostings)} affected`,
      revision: numberOf(row.revision),
    }
  })
  const audit = [...operationalAudit, ...legalAuditRows]
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, 100)

  const summary = {
    open: corpusByStatus.open ?? 0,
    closed: corpusByStatus.closed ?? 0,
    retained,
    retainedWarningAt: JOB_SOURCE_CONTROL_WARN_POSTINGS,
    retainedLimit: JOB_SOURCE_CONTROL_MAX_POSTINGS,
    retainedHeadroom: JOB_SOURCE_CONTROL_MAX_POSTINGS - retained,
    retainedWarning: retained >= JOB_SOURCE_CONTROL_WARN_POSTINGS,
    activeSources: sources.filter((source) => source.state === 'active').length,
    atRiskSources: sources.filter((source) => ['quarantined', 'dead', 'revoked'].includes(source.state) || source.budget.blocked).length,
    attempts24h: sources.reduce((sum, source) => sum + source.metrics24h.quotaSpent, 0),
    new24h: sources.reduce((sum, source) => sum + source.metrics24h.newCount, 0),
  }

  return NextResponse.json({
    bootstrap: controlPlane.bootstrap,
    readiness: {
      database: {
        status: controlPlane.readiness.transactionCapable ? 'ready' : 'blocked',
        label: 'Database authority',
        detail: controlPlane.readiness.transactionCapable
          ? 'Replica-set transaction capability is available.'
          : 'Mongo transaction capability has not been proven; source mutations remain blocked.',
      },
      dispatch: {
        status: controlPlane.readiness.inngestCredentialsConfigured ? 'warning' : 'blocked',
        label: 'Worker dispatch credentials',
        detail: controlPlane.readiness.inngestCredentialsConfigured
          ? 'Inngest credentials are configured; deployment function registration still requires the release smoke.'
          : 'Inngest event/signing credentials are missing.',
      },
      sourceControl: {
        status: !controlPlane.readiness.sourceControlReady
          ? 'blocked'
          : controlPlane.readiness.redisReachable ? 'ready' : 'blocked',
        label: 'Source control and budgets',
        detail: !controlPlane.readiness.sourceControlReady
          ? 'Durable lineage, audit, or retained-corpus readiness is incomplete.'
          : controlPlane.readiness.redisReachable
            ? 'Durable source authority and Redis request-budget enforcement are ready.'
            : 'Source authority is ready, but shared Redis request-meter state is unavailable. Activation and dispatch are blocked.',
      },
    },
    summary,
    funnelReconciliation,
    sources,
    audit,
    verdict: {
      config: verdictConfig,
      backlogPending: verdictBacklog,
      tombstones,
      distribution: Object.fromEntries((verdictDist as Array<{ _id: string; n: number }>).map((row) => [row._id, row.n])),
      cycles: verdictCycles.map((cycle) => ({
        startedAt: cycle.startedAt,
        finishedAt: cycle.finishedAt ?? null,
        llm: cycle.llm ?? null,
        healthTransitions: cycle.healthTransitions ?? [],
      })),
    },
  })
}

/** The unversioned verdict writer was retired by A09. All mutations now use
 * the audited, revision-fenced governance endpoint. */
export async function PATCH() {
  const authorization = await requireCurrentPlatformAdmin()
  const denied = readinessResponse(authorization)
  if (denied) return denied
  return NextResponse.json({
    error: 'use /api/cms/jobs-ingest/verdict-governance for audited verdict changes',
    code: 'VERDICT_GOVERNANCE_REQUIRED',
  }, { status: 410 })
}

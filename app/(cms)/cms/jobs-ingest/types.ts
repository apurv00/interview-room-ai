export type OperationalAction =
  | 'bootstrap'
  | 'enable'
  | 'pause'
  | 'update-settings'
  | 'run-now'
  | 'validate'

export type LegalAction = 'revoke' | 'restore'
export type JobsSourceAction = OperationalAction | LegalAction

export interface SourceWindowMetrics {
  fetched: number
  normalized: number
  newCount: number
  merged: number
  refreshed: number
  quotaSpent: number
  driftNulls: number
  storeErrors: number
  drops: number
  cycles: number
}

export interface SourceSettings {
  cadenceMinutes: number
  minIndiaPostings: number | null
  perRunRequestCap: number
  dailyRequestCap: number
  monthlyRequestCap: number
  llmVerdictOptOut: boolean
  notes: string
}

export interface SourceSettingLimits {
  cadenceMinutes: { min: number; max: number }
  minIndiaPostings: { min: number; max: number }
  perRunRequestCap: { min: number; max: number }
  dailyRequestCap: { min: number; max: number }
  monthlyRequestCap: { min: number; max: number }
}

export interface SourceOperationSummary {
  action: JobsSourceAction | string
  at: string
  actorLabel?: string
  operationId?: string
  outcome?: string
  errorCode?: string
  completedAt?: string
}

export interface SourceRow {
  sourceId: string
  displayName: string
  kind: string
  enabled: boolean
  health: 'active' | 'degraded' | 'quarantined' | 'dead' | 'revoked'
  state: 'active' | 'paused' | 'validating' | 'quarantined' | 'dead' | 'revoked'
  operationalRevision: number
  controlRevision: number
  lastControl: {
    revision: number
    action: LegalAction
    at: string
  } | null
  credential: {
    status: 'ready' | 'missing' | 'invalid' | 'not-required' | 'unknown' | 'configured-rejected'
    label: string
    remediation?: string
  }
  settings: SourceSettings
  limits: SourceSettingLimits
  postings: { open: number; retained: number }
  metrics24h: SourceWindowMetrics
  metrics7d: SourceWindowMetrics
  budget: {
    status: 'available' | 'unavailable'
    usedToday: number | null
    usedThisMonth: number | null
    dailyCap: number
    monthlyCap: number
    percent: number | null
    blocked: boolean
  }
  lastSyncAt: string | null
  nextSyncAt: string | null
  lastValidation: {
    status: 'passed' | 'failed' | 'pending' | 'stale'
    at: string
    operationalRevision: number
    controlRevision: number
    detail?: string
  } | null
  lastOperation: SourceOperationSummary | null
  allowedActions: JobsSourceAction[]
  blockers: Partial<Record<JobsSourceAction, string[]>>
}

export interface ReadinessItem {
  status: 'ready' | 'blocked' | 'warning' | 'unknown'
  label: string
  detail: string
}

export interface AuditRow extends SourceOperationSummary {
  sourceId: string
  revision?: number
  reason?: string
  changes?: Record<string, unknown>
}

export interface VerdictLlmBlock {
  requested: number
  scored: number
  cacheHits: number
  errors: number
  timeouts: number
  softClosed: number
  verdictDistribution: { genuine: number; suspicious: number; fraud: number }
  reasonCodeCounts: Record<string, number>
  llmFlaggedCleanRow: number
  llmClearedFlaggedRow: number
  costUsd: number
  epoch: string
  skips?: Record<string, number>
}

export interface JobsOperationsPayload {
  bootstrap: {
    required: boolean
    catalogSources: number
    configuredSources: number
    allowed: boolean
    blockers: string[]
    repairs: string[]
  }
  readiness: {
    database: ReadinessItem
    dispatch: ReadinessItem
    sourceControl: ReadinessItem
  }
  summary: {
    open: number
    closed: number
    retained: number
    retainedWarningAt: number
    retainedLimit: number
    retainedHeadroom: number
    retainedWarning: boolean
    activeSources: number
    atRiskSources: number
    attempts24h: number
    new24h: number
  }
  sources: SourceRow[]
  audit: AuditRow[]
  verdict: {
    config: {
      collectionEnabled: boolean
      enforceEnabled: boolean
      dailyVerdictCap: number
      dailyBudgetUsd: number
      monthlyBudgetUsd: number
    }
    backlogPending: number
    tombstones: number
    distribution: Record<string, number>
    cycles: Array<{
      startedAt: string
      finishedAt: string | null
      llm: VerdictLlmBlock | null
      healthTransitions: string[]
    }>
  }
}

export interface SourceOperationSubmission {
  action: JobsSourceAction
  reason?: string
  confirmation?: string
  settings?: Partial<SourceSettings>
}

export interface ApiFailure {
  error?: string
  code?: string
  retryable?: boolean
  currentControlRevision?: number
  currentOperationalRevision?: number
  issues?: unknown
}

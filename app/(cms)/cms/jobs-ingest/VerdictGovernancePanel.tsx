'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  JOBS_VERDICT_CONFIG_LIMITS,
  jobsVerdictConfigIssueOf,
  type JobsVerdictNumericKey,
} from '@shared/validators/jobsVerdictConfigLimits'

interface VerdictConfigState {
  collectionEnabled: boolean
  enforceEnabled: boolean
  rankingEnabled: false
  dailyVerdictCap: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  perCompanyDailyCap: number
  perSourceDailyCap: number
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  notes?: string
}

interface VerdictConfig extends VerdictConfigState {
  revision: number
}

interface ConfigHistoryRow {
  revision: number
  action: 'update' | 'rollback'
  reason: string
  actorUserId: string
  occurredAt: string
}

interface QualityDecisionRow {
  id: string
  decisionKey: string
  domain: 'hard-drop' | 'llm-verdict' | 'apply-link'
  outcome: 'drop' | 'demote' | 'restore' | 'close' | 'reopen'
  reviewStatus: 'unreviewed' | 'upheld'
  reviewRevision: number
  occurredAt: string
  lastSeenAt: string
  seenCount: number
  serviceActor: 'jobs-ingest' | 'jobs-verdict' | 'jobs-link-check' | 'jobs-link-quorum'
  inputHash: string
  policyRevision: string
  configRevision?: number
  sourceRevisions: Array<{ sourceId: string; controlRevision: number; operationalRevision: number }>
  postingId?: string
  posting?: {
    id: string
    title: string
    company: string
    locations: string[]
    isRemote: boolean
    status: string
    closedReason?: string
  }
  evidenceSummary: string
  reviewOverlay?: {
    title: string
    company: string
    city: string
    isRemote: boolean
    descriptionExcerpt: string
    viaSite: string
    domainHint?: string
  }
}

interface DecisionCursor {
  occurredAt: string
  id: string
}

interface ReviewHistoryRow {
  id: string
  operationId: string
  action: 'uphold' | 'restore'
  actorUserId: string
  reason: string
  fromReviewStatus: 'unreviewed' | 'upheld' | 'restored'
  toReviewStatus: 'upheld' | 'restored'
  previousReviewRevision: number
  resultingReviewRevision: number
  occurredAt: string
}

interface DecisionAudit {
  decision: QualityDecisionRow
  reviewHistory: ReviewHistoryRow[]
}

interface GovernancePayload {
  config: VerdictConfig
  history: ConfigHistoryRow[]
  reviewStatus: 'unreviewed' | 'upheld'
  decisions: QualityDecisionRow[]
  nextDecisionCursor?: DecisionCursor
}

const endpoint = '/api/cms/jobs-ingest/verdict-governance'

function reviewPageUrl(reviewStatus: 'unreviewed' | 'upheld', cursor?: DecisionCursor): string {
  const params = new URLSearchParams({ reviewStatus })
  if (cursor) {
    params.set('beforeAt', cursor.occurredAt)
    params.set('beforeId', cursor.id)
  }
  return `${endpoint}?${params.toString()}`
}

function configStateOf(config: VerdictConfig): VerdictConfigState {
  const { revision: _revision, ...state } = config
  return state
}

function when(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    return body.error || `Request failed with HTTP ${response.status}`
  } catch {
    return `Request failed with HTTP ${response.status}`
  }
}

export function VerdictGovernancePanel() {
  const [data, setData] = useState<GovernancePayload | null>(null)
  const [draft, setDraft] = useState<VerdictConfigState | null>(null)
  const [configReason, setConfigReason] = useState('')
  const [rollbackRevision, setRollbackRevision] = useState('0')
  const [reviewReason, setReviewReason] = useState('')
  const [reviewStatus, setReviewStatus] = useState<'unreviewed' | 'upheld'>('unreviewed')
  const [audit, setAudit] = useState<DecisionAudit | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal, statusFilter: 'unreviewed' | 'upheld' = 'unreviewed') => {
    setError(null)
    const response = await fetch(reviewPageUrl(statusFilter), { cache: 'no-store', signal })
    if (!response.ok) throw new Error(await failureMessage(response))
    const payload = await response.json() as GovernancePayload
    setData(payload)
    setDraft(configStateOf(payload.config))
    setReviewStatus(payload.reviewStatus)
    setAudit(null)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Failed to load verdict governance.')
    })
    return () => controller.abort()
  }, [load])

  const command = async (key: string, body: Record<string, unknown>, success: string) => {
    setBusy(key)
    setError(null)
    setStatus(null)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(await failureMessage(response))
      const payload = await response.json() as { result?: { effect?: string } }
      const effect = payload.result?.effect
      setStatus(effect ? `${success} (${effect.replaceAll('-', ' ')}).` : `${success}.`)
      setConfigReason('')
      setReviewReason('')
      await load(undefined, reviewStatus)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Verdict-governance command failed.')
    } finally {
      setBusy(null)
    }
  }

  const loadReviewPage = async (
    statusFilter: 'unreviewed' | 'upheld',
    cursor?: DecisionCursor,
  ) => {
    setBusy('review-page')
    setError(null)
    try {
      const response = await fetch(reviewPageUrl(statusFilter, cursor), { cache: 'no-store' })
      if (!response.ok) throw new Error(await failureMessage(response))
      const payload = await response.json() as GovernancePayload
      setReviewStatus(statusFilter)
      setAudit(null)
      setData((current) => current && cursor
        ? {
            ...current,
            reviewStatus: payload.reviewStatus,
            decisions: [...current.decisions, ...payload.decisions],
            nextDecisionCursor: payload.nextDecisionCursor,
          }
        : payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load quality decisions.')
    } finally {
      setBusy(null)
    }
  }

  const loadAudit = async (decisionId: string) => {
    setBusy(`audit-${decisionId}`)
    setError(null)
    try {
      const response = await fetch(`${endpoint}?decisionId=${encodeURIComponent(decisionId)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(await failureMessage(response))
      const payload = await response.json() as { audit: DecisionAudit }
      setAudit(payload.audit)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load decision audit history.')
    } finally {
      setBusy(null)
    }
  }

  if (!data || !draft) {
    return (
      <section aria-labelledby="verdict-governance-heading" className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 id="verdict-governance-heading" className="text-xl font-semibold text-slate-950">Verdict governance</h2>
        <p className="mt-2 text-sm text-slate-600">{error ?? 'Loading governed configuration and review queue…'}</p>
      </section>
    )
  }

  const reasonReady = configReason.trim().length >= 8
  const reviewReady = reviewReason.trim().length >= 8
  const configIssue = jobsVerdictConfigIssueOf(draft)
  const parsedRollbackRevision = Number(rollbackRevision)
  const rollbackReady = Number.isSafeInteger(parsedRollbackRevision) &&
    parsedRollbackRevision >= 0 && parsedRollbackRevision < data.config.revision
  const numberFields: Array<{ key: JobsVerdictNumericKey; label: string }> = [
    { key: 'dailyVerdictCap', label: 'Daily verdict cap' },
    { key: 'dailyBudgetUsd', label: 'Daily budget (USD)' },
    { key: 'monthlyBudgetUsd', label: 'Monthly budget (USD)' },
    { key: 'perCompanyDailyCap', label: 'Per-company daily cap' },
    { key: 'perSourceDailyCap', label: 'Per-source daily cap' },
    { key: 'inputUsdPerMTok', label: 'Minimum input USD / 1M tokens' },
    { key: 'outputUsdPerMTok', label: 'Minimum output USD / 1M tokens' },
  ]

  return (
    <section aria-labelledby="verdict-governance-heading" className="rounded-2xl border border-slate-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="verdict-governance-heading" className="text-xl font-semibold text-slate-950">Verdict governance</h2>
          <p className="mt-1 text-sm text-slate-600">Revision {data.config.revision}. Every change and quality decision is attributable and reversible.</p>
        </div>
        <button type="button" onClick={() => void load(undefined, reviewStatus).catch((caught) => setError(caught instanceof Error ? caught.message : 'Refresh failed.'))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Refresh
        </button>
      </div>

      {error ? <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {status ? <p role="status" className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{status}</p> : null}

      <form
        className="mt-6"
        aria-busy={busy === 'update-config'}
        onSubmit={(event) => {
          event.preventDefault()
          if (configIssue) {
            setError(configIssue)
            return
          }
          void command('update-config', {
            action: 'update-config',
            expectedRevision: data.config.revision,
            config: draft,
            reason: configReason,
          }, 'Verdict configuration updated')
        }}
      >
        <fieldset disabled={busy !== null}>
          <legend className="text-base font-semibold text-slate-950">Rollout and limits</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.collectionEnabled}
                onChange={(event) => setDraft({
                  ...draft,
                  collectionEnabled: event.target.checked,
                  ...(!event.target.checked ? { enforceEnabled: false } : {}),
                })}
                className="mt-0.5"
              />
              <span><span className="block font-medium text-slate-950">Collect verdicts</span><span className="text-slate-600">Score eligible live postings.</span></span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.enforceEnabled}
                onChange={(event) => setDraft({
                  ...draft,
                  enforceEnabled: event.target.checked,
                  ...(event.target.checked ? { collectionEnabled: true } : {}),
                })}
                className="mt-0.5"
              />
              <span><span className="block font-medium text-slate-950">Restrict confirmed fraud</span><span className="text-slate-600">May close a posting; ranking remains unchanged.</span></span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
              <input type="checkbox" checked={false} disabled className="mt-0.5" />
              <span><span className="block font-medium">Use verdicts in ranking — Off</span><span>Parked until post-GA calibration.</span></span>
            </label>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {numberFields.map((field) => {
              const limit = JOBS_VERDICT_CONFIG_LIMITS[field.key]
              const hintId = `verdict-limit-${field.key}`
              return (
                <label key={field.key} className="text-sm font-medium text-slate-700">
                  {field.label}
                  <input
                    type="number"
                    min={limit.min}
                    max={limit.max}
                    step={limit.step}
                    value={String(draft[field.key] ?? 0)}
                    aria-describedby={hintId}
                    aria-invalid={configIssue?.startsWith(field.key) || undefined}
                    onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-950"
                  />
                  <span id={hintId} className="mt-1 block text-xs font-normal text-slate-500">
                    Allowed: {limit.min.toLocaleString()}–{limit.max.toLocaleString()}
                  </span>
                </label>
              )
            })}
          </div>
          {configIssue ? <p role="alert" className="mt-3 text-sm text-red-700">{configIssue}</p> : null}
          <label className="mt-4 block text-sm font-medium text-slate-700">
            Operator notes
            <textarea value={draft.notes ?? ''} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-950" />
          </label>
          <label className="mt-3 block text-sm font-medium text-slate-700">
            Change reason (minimum 8 characters)
            <input value={configReason} onChange={(event) => setConfigReason(event.target.value)} minLength={8} maxLength={1000} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-950" />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" disabled={!reasonReady || busy !== null || !!configIssue} className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save as revision {data.config.revision + 1}</button>
            {data.config.revision > 0 ? <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2">
              <label className="text-xs font-medium text-slate-700">
                Exact revision to restore
                <input
                  type="number"
                  min={0}
                  max={data.config.revision - 1}
                  step={1}
                  value={rollbackRevision}
                  onChange={(event) => setRollbackRevision(event.target.value)}
                  className="mt-1 block w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-950"
                />
              </label>
              <button
                type="button"
                disabled={!reasonReady || !rollbackReady || busy !== null}
                onClick={() => void command(
                  `rollback-${parsedRollbackRevision}`,
                  {
                    action: 'rollback-config',
                    expectedRevision: data.config.revision,
                    targetRevision: parsedRollbackRevision,
                    reason: configReason,
                  },
                  `Revision ${parsedRollbackRevision} restored as a new revision`,
                )}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
              >Restore revision</button>
            </div> : null}
          </div>
        </fieldset>
      </form>

      <h3 className="mt-8 text-base font-semibold text-slate-950">Configuration history</h3>
      <p className="mt-1 text-sm text-slate-600">Latest 25 changes are shown. Use the exact-revision field above for an older revision. Rollback creates a new revision and does not undo spend, scores, or posting state.</p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[760px] text-left text-sm">
          <caption className="sr-only">Verdict configuration revision history</caption>
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600"><tr><th scope="col" className="px-3 py-2">Revision</th><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Action</th><th scope="col" className="px-3 py-2">Reason</th><th scope="col" className="px-3 py-2">Restore</th></tr></thead>
          <tbody className="divide-y divide-slate-200">
            {data.history.map((row) => <tr key={row.revision}><td className="px-3 py-2 tabular-nums">{row.revision}</td><td className="px-3 py-2 text-slate-600"><time dateTime={row.occurredAt}>{when(row.occurredAt)}</time></td><td className="px-3 py-2">{row.action}</td><td className="max-w-md px-3 py-2 text-slate-600">{row.reason}</td><td className="px-3 py-2"><button type="button" disabled={!reasonReady || busy !== null || row.revision === data.config.revision} onClick={() => void command(`rollback-${row.revision}`, { action: 'rollback-config', expectedRevision: data.config.revision, targetRevision: row.revision, reason: configReason }, `Revision ${row.revision} restored as a new revision`)} className="font-medium text-blue-700 disabled:text-slate-400">Restore values</button></td></tr>)}
            {!data.history.length ? <tr><td colSpan={5} className="px-3 py-5 text-center text-slate-500">No governed changes yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-950">Quality decision review</h3>
          <p className="mt-1 text-sm text-slate-600">Restore reopens an exact LLM closure, admits an exact hard drop on its next authorised sync, or requests verified link recovery.</p>
        </div>
        <div className="flex w-full flex-wrap items-end gap-3 lg:w-auto">
          <label className="text-sm font-medium text-slate-700">
            Queue
            <select
              value={reviewStatus}
              disabled={busy !== null}
              onChange={(event) => void loadReviewPage(event.target.value as 'unreviewed' | 'upheld')}
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-slate-950"
            >
              <option value="unreviewed">Awaiting review</option>
              <option value="upheld">Upheld · still restorable</option>
            </select>
          </label>
          <label className="min-w-[18rem] flex-1 text-sm font-medium text-slate-700">
            Review reason (minimum 8 characters)
            <input value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} minLength={8} maxLength={1000} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-950" />
          </label>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[1080px] text-left text-sm">
          <caption className="sr-only">{reviewStatus === 'unreviewed' ? 'Automatic Jobs decisions awaiting review' : 'Upheld Jobs decisions that remain restorable'}</caption>
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
            <tr><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Context</th><th scope="col" className="px-3 py-2">Decision</th><th scope="col" className="px-3 py-2">Evidence</th><th scope="col" className="px-3 py-2">Review</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {data.decisions.map((decision) => {
              const restrictive = decision.outcome === 'drop' || decision.outcome === 'demote' || decision.outcome === 'close'
              const title = decision.posting?.title || decision.reviewOverlay?.title || 'Posting title unavailable'
              const company = decision.posting?.company || decision.reviewOverlay?.company || 'Company unavailable'
              return (
                <tr key={decision.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600"><time dateTime={decision.occurredAt}>{when(decision.occurredAt)}</time></td>
                  <td className="max-w-xs px-3 py-2">
                    <p className="font-medium text-slate-950">{title}</p>
                    <p className="text-slate-600">{company}</p>
                    {decision.postingId ? <a href={`/jobs/${decision.postingId}`} className="mt-1 block text-xs font-medium text-blue-700">Open current posting</a> : null}
                    <code className="mt-1 block break-all text-[11px] text-slate-500">{decision.id}</code>
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{decision.domain} · {decision.outcome}</p>
                    <p className="text-xs text-slate-500">{decision.reviewStatus} · rev {decision.reviewRevision}</p>
                    {decision.posting ? <p className="mt-1 text-xs text-slate-500">Current row: {decision.posting.status}{decision.posting.closedReason ? ` (${decision.posting.closedReason})` : ''}</p> : null}
                  </td>
                  <td className="max-w-lg px-3 py-2 text-slate-600">
                    <p>{decision.evidenceSummary}</p>
                    {decision.reviewOverlay ? <details className="mt-2"><summary className="cursor-pointer font-medium text-slate-800">Review retained excerpt</summary><div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3"><p>{decision.reviewOverlay.city || 'Location unavailable'}{decision.reviewOverlay.isRemote ? ' · Remote' : ''}{decision.reviewOverlay.viaSite ? ` · ${decision.reviewOverlay.viaSite}` : ''}</p><p className="whitespace-pre-wrap text-xs">{decision.reviewOverlay.descriptionExcerpt || 'No description was retained.'}</p></div></details> : null}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-slate-700">Reproduction metadata</summary>
                      <div className="mt-1 space-y-1 break-all text-[11px] text-slate-500">
                        <p>Actor: {decision.serviceActor}</p>
                        <p>Policy: {decision.policyRevision}{decision.configRevision === undefined ? '' : ` · config rev ${decision.configRevision}`}</p>
                        <p>Input: {decision.inputHash}</p>
                        <p>Seen {decision.seenCount} time(s); latest {when(decision.lastSeenAt)}</p>
                        <p>Sources: {decision.sourceRevisions.map((source) => `${source.sourceId}@${source.controlRevision}/${source.operationalRevision}`).join(', ')}</p>
                      </div>
                    </details>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-2">
                      {decision.reviewStatus === 'unreviewed' ? <button type="button" disabled={!reviewReady || busy !== null} onClick={() => void command(`confirm-${decision.id}`, { action: 'review-decision', decisionId: decision.id, expectedReviewRevision: decision.reviewRevision, resolution: 'confirmed', reason: reviewReason }, 'Decision confirmed')} className="font-medium text-slate-700 disabled:text-slate-400">Confirm</button> : null}
                      {restrictive ? <button type="button" disabled={!reviewReady || busy !== null} onClick={() => void command(`restore-${decision.id}`, { action: 'review-decision', decisionId: decision.id, expectedReviewRevision: decision.reviewRevision, resolution: 'restored', reason: reviewReason }, 'Decision restoration committed')} className="font-medium text-blue-700 disabled:text-slate-400">Restore safely</button> : null}
                      <button type="button" disabled={busy !== null} onClick={() => void loadAudit(decision.id)} className="text-xs font-medium text-violet-700 disabled:text-slate-400">View audit history</button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!data.decisions.length ? <tr><td colSpan={5} className="px-3 py-5 text-center text-slate-500">{reviewStatus === 'unreviewed' ? 'No decisions are awaiting review.' : 'No upheld decisions are in this queue.'}</td></tr> : null}
          </tbody>
        </table>
      </div>
      {data.nextDecisionCursor ? <button type="button" disabled={busy !== null} onClick={() => void loadReviewPage(reviewStatus, data.nextDecisionCursor)} className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50">Load 50 more</button> : null}

      {audit ? <section aria-labelledby="decision-audit-heading" className="mt-6 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h4 id="decision-audit-heading" className="font-semibold text-slate-950">Decision audit history</h4><p className="mt-1 break-all text-xs text-slate-600">{audit.decision.id} · {audit.decision.decisionKey}</p></div>
          <button type="button" onClick={() => setAudit(null)} className="text-sm font-medium text-slate-700">Close</button>
        </div>
        <ol className="mt-3 space-y-2">
          {audit.reviewHistory.map((entry) => <li key={entry.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm"><p className="font-medium text-slate-950">{entry.action}: {entry.fromReviewStatus} → {entry.toReviewStatus}</p><p className="mt-1 text-slate-700">{entry.reason}</p><p className="mt-1 break-all text-xs text-slate-500"><time dateTime={entry.occurredAt}>{when(entry.occurredAt)}</time> · actor {entry.actorUserId} · operation {entry.operationId}</p></li>)}
          {!audit.reviewHistory.length ? <li className="text-sm text-slate-600">No human review has been recorded for this automatic decision.</li> : null}
        </ol>
      </section> : null}
    </section>
  )
}
